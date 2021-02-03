import {
  GraphQLService,
  SchemaChangeCallback,
  Unsubscriber,
  GraphQLServiceEngineConfig,
} from 'apollo-server-core';
import {
  GraphQLExecutionResult,
  Logger,
  GraphQLRequestContextExecutionDidStart,
  ApolloConfig,
} from 'apollo-server-types';
import { InMemoryLRUCache } from 'apollo-server-caching';
import {
  isObjectType,
  isIntrospectionType,
  GraphQLSchema,
  VariableDefinitionNode,
  parse,
  visit,
  DocumentNode,
  print,
} from 'graphql';
import {
  composeAndValidate,
  compositionHasErrors,
  ServiceDefinition,
  findDirectivesOnNode,
  isStringValueNode,
} from '@apollo/federation';
import loglevel from 'loglevel';

import { buildQueryPlan, buildOperationContext } from './buildQueryPlan';
import {
  executeQueryPlan,
  ServiceMap,
  defaultFieldResolverWithAliasSupport,
} from './executeQueryPlan';

import { getServiceDefinitionsFromRemoteEndpoint } from './loadServicesFromRemoteEndpoint';
import { serializeQueryPlan, QueryPlan, OperationContext, WasmPointer } from './QueryPlan';
import { GraphQLDataSource } from './datasources/types';
import { RemoteGraphQLDataSource } from './datasources/RemoteGraphQLDataSource';
import { getVariableValues } from 'graphql/execution/values';
import fetcher, { Fetcher } from 'make-fetch-happen';
import { HttpRequestCache } from './cache';
import { fetch } from 'apollo-server-env';
import { getQueryPlanner } from '@apollo/query-planner-wasm';
import { csdlToSchema } from './csdlToSchema';
import {
  ServiceEndpointDefinition,
  Experimental_DidFailCompositionCallback,
  Experimental_DidResolveQueryPlanCallback,
  Experimental_DidUpdateCompositionCallback,
  Experimental_UpdateServiceDefinitions,
  CompositionInfo,
  GatewayConfig,
  StaticGatewayConfig,
  RemoteGatewayConfig,
  ManagedGatewayConfig,
  isManuallyManagedConfig,
  isLocalConfig,
  isRemoteConfig,
  isManagedConfig,
  isDynamicConfig,
  isStaticConfig,
  CompositionMetadata,
  UpdateReturnType,
  UpdatedServiceDefinitions,
  UpdatedCsdl,
} from './config';
import { loadCsdlFromStorage } from '@apollo/gateway/src/loadCsdlFromStorage';

type DataSourceMap = {
  [serviceName: string]: { url?: string; dataSource: GraphQLDataSource };
};

// Local state to track whether particular UX-improving warning messages have
// already been emitted.  This is particularly useful to prevent recurring
// warnings of the same type in, e.g. repeating timers, which don't provide
// additional value when they are repeated over and over during the life-time
// of a server.
type WarnedStates = {
  remoteWithLocalConfig?: boolean;
};

export function getDefaultFetcher(): Fetcher {
  return fetcher.defaults({
    cacheManager: new HttpRequestCache(),
    // All headers should be lower-cased here, as `make-fetch-happen`
    // treats differently cased headers as unique (unlike the `Headers` object).
    // @see: https://git.io/JvRUa
    headers: {
      'user-agent': `apollo-gateway/${require('../package.json').version}`,
    },
  });
}

export const HEALTH_CHECK_QUERY =
  'query __ApolloServiceHealthCheck__ { __typename }';
export const SERVICE_DEFINITION_QUERY =
  'query __ApolloGetServiceDefinition__ { _service { sdl } }';

export class ApolloGateway implements GraphQLService {
  public schema?: GraphQLSchema;
  protected serviceMap: DataSourceMap = Object.create(null);
  protected config: GatewayConfig;
  private logger: Logger;
  protected queryPlanStore: InMemoryLRUCache<QueryPlan>;
  private apolloConfig?: ApolloConfig;
  private pollingTimer?: NodeJS.Timer;
  private onSchemaChangeListeners = new Set<SchemaChangeCallback>();
  private serviceDefinitions: ServiceDefinition[] = [];
  private compositionMetadata?: CompositionMetadata;
  private serviceSdlCache = new Map<string, string>();
  private warnedStates: WarnedStates = Object.create(null);
  private queryPlannerPointer?: WasmPointer;
  private parsedCsdl?: DocumentNode;
  private fetcher: typeof fetch;
  private compositionId?: string;
  private stopped: boolean = false;
  private stoppedPromise: Promise<void>;
  private resolveStoppedPromise: Function;

  // Observe query plan, service info, and operation info prior to execution.
  // The information made available here will give insight into the resulting
  // query plan and the inputs that generated it.
  protected experimental_didResolveQueryPlan?: Experimental_DidResolveQueryPlanCallback;
  // Observe composition failures and the ServiceList that caused them. This
  // enables reporting any issues that occur during composition. Implementors
  // will be interested in addressing these immediately.
  protected experimental_didFailComposition?: Experimental_DidFailCompositionCallback;
  // Used to communicated composition changes, and what definitions caused
  // those updates
  protected experimental_didUpdateComposition?: Experimental_DidUpdateCompositionCallback;
  // Used for overriding the default service list fetcher. This should return
  // an array of ServiceDefinition. *This function must be awaited.*
  protected updateServiceDefinitions: Experimental_UpdateServiceDefinitions;
  // how often service defs should be loaded/updated (in ms)
  protected experimental_pollInterval?: number;

  constructor(config?: GatewayConfig) {
    let resolve: Function;
    this.stoppedPromise = new Promise<void>((res) => (resolve = res));
    this.resolveStoppedPromise = () => {
      resolve();
    };

    this.config = {
      // TODO: expose the query plan in a more flexible JSON format in the future
      // and remove this config option in favor of `exposeQueryPlan`. Playground
      // should cutover to use the new option when it's built.
      __exposeQueryPlanExperimental: process.env.NODE_ENV !== 'production',
      ...config,
    };

    this.logger = this.initLogger();
    this.queryPlanStore = this.initQueryPlanStore(
      config?.experimental_approximateQueryPlanStoreMiB,
    );
    this.fetcher = config?.fetcher || getDefaultFetcher();

    // set up experimental observability callbacks and config settings
    this.experimental_didResolveQueryPlan =
      config?.experimental_didResolveQueryPlan;
    this.experimental_didFailComposition =
      config?.experimental_didFailComposition;
    this.experimental_didUpdateComposition =
      config?.experimental_didUpdateComposition;

    this.experimental_pollInterval = config?.experimental_pollInterval;

    // Use the provided updater function if provided by the user, else default
    this.updateServiceDefinitions = isManuallyManagedConfig(this.config)
      ? this.config.experimental_updateServiceDefinitions
      : this.loadServiceDefinitions;

    if (isDynamicConfig(this.config)) {
      this.issueDynamicWarningsIfApplicable();
    }
  }

  private initLogger() {
    // Setup logging facilities
    if (this.config.logger) {
      return this.config.logger;
    }

    // If the user didn't provide their own logger, we'll initialize one.
    const loglevelLogger = loglevel.getLogger(`apollo-gateway`);

    // And also support the `debug` option, if it's truthy.
    if (this.config.debug === true) {
      loglevelLogger.setLevel(loglevelLogger.levels.DEBUG);
    } else {
      loglevelLogger.setLevel(loglevelLogger.levels.WARN);
    }

    return loglevelLogger;
  }

  private initQueryPlanStore(approximateQueryPlanStoreMiB?: number) {
    return new InMemoryLRUCache<QueryPlan>({
      // Create ~about~ a 30MiB InMemoryLRUCache.  This is less than precise
      // since the technique to calculate the size of a DocumentNode is
      // only using JSON.stringify on the DocumentNode (and thus doesn't account
      // for unicode characters, etc.), but it should do a reasonable job at
      // providing a caching document store for most operations.
      maxSize: Math.pow(2, 20) * (approximateQueryPlanStoreMiB || 30),
      sizeCalculator: approximateObjectSize,
    });
  }

  private issueDynamicWarningsIfApplicable() {
    // Warn against a pollInterval of < 10s in managed mode and reset it to 10s
    if (
      isManagedConfig(this.config) &&
      this.config.experimental_pollInterval &&
      this.config.experimental_pollInterval < 10000
    ) {
      this.experimental_pollInterval = 10000;
      this.logger.warn(
        'Polling Apollo services at a frequency of less than once per 10 ' +
          'seconds (10000) is disallowed. Instead, the minimum allowed ' +
          'pollInterval of 10000 will be used. Please reconfigure your ' +
          'experimental_pollInterval accordingly. If this is problematic for ' +
          'your team, please contact support.',
      );
    }

    // Warn against using the pollInterval and a serviceList simultaneously
    if (this.config.experimental_pollInterval && isRemoteConfig(this.config)) {
      this.logger.warn(
        'Polling running services is dangerous and not recommended in production. ' +
          'Polling should only be used against a registry. ' +
          'If you are polling running services, use with caution.',
      );
    }
  }

  public async load(options?: {
    apollo?: ApolloConfig;
    engine?: GraphQLServiceEngineConfig;
  }) {
    // Was the gateway previously stopped? If so reset the stopping mechanisms.
    if (this.stopped) {
      this.stopped = false;
      this.stoppedPromise = new Promise(
        (res) => (this.resolveStoppedPromise = res),
      );
    }

    if (options?.apollo) {
      this.apolloConfig = options.apollo;
    } else if (options?.engine) {
      // Older version of apollo-server-core that isn't passing 'apollo' yet.
      this.apolloConfig = {
        keyHash: options.engine.apiKeyHash,
        graphId: options.engine.graphId,
        graphVariant: options.engine.graphVariant || 'current',
      };
    }

    this.maybeWarnOnConflictingConfig();

    // Handles initial assignment of `this.schema`, `this.queryPlannerPointer`
    isStaticConfig(this.config)
      ? this.loadStatic(this.config)
      : await this.loadDynamic();

    const mode = isManagedConfig(this.config) ? 'managed' : 'unmanaged';
    this.logger.info(
      `Gateway successfully loaded schema.\n\t* Mode: ${mode}${
        this.apolloConfig && this.apolloConfig.graphId
          ? `\n\t* Service: ${this.apolloConfig.graphId}@${this.apolloConfig.graphVariant}`
          : ''
      }`,
    );

    return {
      schema: this.schema!,
      executor: this.executor
    };
  }

  // Synchronously load a statically configured schema, update class instance's
  // schema and query planner.
  private loadStatic(config: StaticGatewayConfig) {
    const schemaConstructionOpts = isLocalConfig(config)
      ? { serviceList: config.localServiceList }
      : { csdl: config.csdl };

    const { schema, composedSdl } = this.createSchema(schemaConstructionOpts);

    this.schema = schema;
    this.parsedCsdl = parse(composedSdl);
    this.queryPlannerPointer = getQueryPlanner(composedSdl);
  }

  // Asynchronously load a dynamically configured schema. `this.updateComposition`
  // is responsible for updating the class instance's schema and query planner.
  private async loadDynamic() {
    // This may throw, but it's expected on initial load to do so
    await this.updateComposition();
    if (this.shouldBeginPolling()) {
      this.pollServices();
    }
  }

  private shouldBeginPolling() {
    return (
      (isManagedConfig(this.config) || this.experimental_pollInterval) &&
      !this.pollingTimer &&
      !this.stopped
    );
  }

  protected async updateComposition(): Promise<void> {
    this.logger.debug('Checking for composition updates...');

    // This may throw, but an error here is caught and logged upstream
    const result = await this.updateServiceDefinitions(this.config);

    //TODO: proper predicates
    if ('csdl' in result) {
      await this.updateCsdl(result);
    } else {
      await this.updateServiceDefs(result);
    }
  }

  private async updateServiceDefs(result: UpdatedServiceDefinitions): Promise<void> {
    if (
      !result.serviceDefinitions ||
      JSON.stringify(this.serviceDefinitions) ===
        JSON.stringify(result.serviceDefinitions)
    ) {
      this.logger.debug('No change in service definitions since last check.');
      return;
    }

    const previousSchema = this.schema;
    const previousServiceDefinitions = this.serviceDefinitions;
    const previousCompositionMetadata = this.compositionMetadata;

    if (previousSchema) {
      this.logger.info('New service definitions were found.');
    }

    // Run service health checks before we commit and update the new schema.
    // This is the last chance to bail out of a schema update.
    if (this.config.serviceHealthCheck) {
      // Here we need to construct new datasources based on the new schema info
      // so we can check the health of the services we're _updating to_.
      const serviceMap = result.serviceDefinitions.reduce(
        (serviceMap, serviceDef) => {
          serviceMap[serviceDef.name] = {
            url: serviceDef.url,
            dataSource: this.createDataSource(serviceDef),
          };
          return serviceMap;
        },
        Object.create(null) as DataSourceMap,
      );

      try {
        await this.serviceHealthCheck(serviceMap);
      } catch (e) {
        this.logger.error(
          'The gateway did not update its schema due to failed service health checks.  ' +
            'The gateway will continue to operate with the previous schema and reattempt updates.' +
            e,
        );
        throw e;
      }
    }

    this.compositionMetadata = result.compositionMetadata;
    this.serviceDefinitions = result.serviceDefinitions;

    if (this.queryPlanStore) this.queryPlanStore.flush();

    const { schema, composedSdl } = this.createSchema({
      serviceList: result.serviceDefinitions,
    });

    if (!composedSdl) {
      this.logger.error(
        "A valid schema couldn't be composed. Falling back to previous schema.",
      );
    } else {
      this.schema = schema;
      this.queryPlannerPointer = getQueryPlanner(composedSdl);

      // Notify the schema listeners of the updated schema
      try {
        this.onSchemaChangeListeners.forEach((listener) =>
          listener(this.schema!),
        );
      } catch (e) {
        this.logger.error(
          "An error was thrown from an 'onSchemaChange' listener. " +
            'The schema will still update: ' +
            ((e && e.message) || e),
        );
      }

      if (this.experimental_didUpdateComposition) {
        this.experimental_didUpdateComposition(
          {
            serviceDefinitions: result.serviceDefinitions,
            schema: this.schema,
            ...(this.compositionMetadata && {
              compositionMetadata: this.compositionMetadata,
            }),
          },
          previousServiceDefinitions &&
            previousSchema && {
              serviceDefinitions: previousServiceDefinitions,
              schema: previousSchema,
              ...(previousCompositionMetadata && {
                compositionMetadata: previousCompositionMetadata,
              }),
            },
        );
      }
    }
  }

  private async updateCsdl(result: UpdatedCsdl): Promise<void> {
    // TODO: better logging message
    // TODO: test code path
    if (result.id === this.compositionId) {
      this.logger.debug('No change in composition since last check.');
      return;
    }

    const previousSchema = this.schema;
    const previousCsdl = this.parsedCsdl;
    const previousCompositionId = this.compositionId;

    if (previousSchema) {
      this.logger.info('New service definitions were found.');
    }

    // Run service health checks before we commit and update the new schema.
    // This is the last chance to bail out of a schema update.
    const parsedCsdl = parse(result.csdl);
    if (this.config.serviceHealthCheck) {
      const serviceList = this.serviceListFromCsdl(parsedCsdl);
      const serviceMap = serviceList.reduce((serviceMap, serviceDef) => {
        serviceMap[serviceDef.name] = {
          url: serviceDef.url,
          dataSource: this.createDataSource(serviceDef),
        };
        return serviceMap;
      }, Object.create(null) as DataSourceMap);

      try {
        await this.serviceHealthCheck(serviceMap);
      } catch (e) {
        this.logger.error(
          'The gateway did not update its schema due to failed service health checks.  ' +
            'The gateway will continue to operate with the previous schema and reattempt updates.' +
            e,
        );
        throw e;
      }
    }

    this.compositionId = result.id;
    this.parsedCsdl = parsedCsdl;

    if (this.queryPlanStore) this.queryPlanStore.flush();

    const { schema, composedSdl } = this.createSchema({
      csdl: result.csdl,
    });

    if (!composedSdl) {
      this.logger.error(
        "A valid schema couldn't be composed. Falling back to previous schema.",
      );
    } else {
      this.schema = schema;
      this.queryPlannerPointer = getQueryPlanner(composedSdl);

      // Notify the schema listeners of the updated schema
      try {
        this.onSchemaChangeListeners.forEach((listener) =>
          listener(this.schema!),
        );
      } catch (e) {
        this.logger.error(
          "An error was thrown from an 'onSchemaChange' listener. " +
            'The schema will still update: ' +
            ((e && e.message) || e),
        );
      }

      if (this.experimental_didUpdateComposition) {
        this.experimental_didUpdateComposition(
          {
            compositionId: result.id,
            csdl: result.csdl,
            schema: this.schema,
          },
          previousCompositionId && previousCsdl && previousSchema
            ? {
                compositionId: previousCompositionId,
                csdl: print(previousCsdl),
                schema: previousSchema,
              }
            : undefined,
        );
      }
    }
  }

  /**
   * This can be used without an argument in order to perform an ad-hoc health check
   * of the downstream services like so:
   *
   * @example
   * ```
   * try {
   *   await gateway.serviceHealthCheck();
   * } catch(e) {
   *   /* your error handling here *\/
   * }
   * ```
   * @throws
   * @param serviceMap {DataSourceMap}
   */
  public serviceHealthCheck(serviceMap: DataSourceMap = this.serviceMap) {
    return Promise.all(
      Object.entries(serviceMap).map(([name, { dataSource }]) =>
        dataSource
          .process({ request: { query: HEALTH_CHECK_QUERY }, context: {} })
          .then((response) => ({ name, response })),
      ),
    );
  }

  protected createSchema(
    input: { serviceList: ServiceDefinition[] } | { csdl: string },
  ) {
    if ('serviceList' in input) {
      return this.createSchemaFromServiceList(input.serviceList);
    } else {
      return this.createSchemaFromCsdl(input.csdl);
    }
  }

  protected createSchemaFromServiceList(serviceList: ServiceDefinition[]) {
    this.logger.debug(
      `Composing schema from service list: \n${serviceList
        .map(({ name, url }) => `  ${url || 'local'}: ${name}`)
        .join('\n')}`,
    );

    const compositionResult = composeAndValidate(serviceList);

    if (compositionHasErrors(compositionResult)) {
      const { errors } = compositionResult;
      if (this.experimental_didFailComposition) {
        this.experimental_didFailComposition({
          errors,
          serviceList,
          ...(this.compositionMetadata && {
            compositionMetadata: this.compositionMetadata,
          }),
        });
      }
      throw Error(
        "A valid schema couldn't be composed. The following composition errors were found:\n" +
          errors.map(e => '\t' + e.message).join('\n'),
      );
    } else {
      const { composedSdl } = compositionResult;
      this.createServices(serviceList);

      this.logger.debug('Schema loaded and ready for execution');

      // This is a workaround for automatic wrapping of all fields, which Apollo
      // Server does in the case of implementing resolver wrapping for plugins.
      // Here we wrap all fields with support for resolving aliases as part of the
      // root value which happens because aliases are resolved by sub services and
      // the shape of the root value already contains the aliased fields as
      // responseNames
      return {
        schema: wrapSchemaWithAliasResolver(csdlToSchema(composedSdl)),
        composedSdl,
      };
    }
  }

  protected serviceListFromCsdl(csdl?: DocumentNode) {
    const serviceList: Omit<ServiceDefinition, 'typeDefs'>[] = [];

    visit(csdl || this.parsedCsdl!, {
      SchemaDefinition(node) {
        findDirectivesOnNode(node, 'graph').forEach((directive) => {
          const name = directive.arguments?.find(
            (arg) => arg.name.value === 'name',
          );
          const url = directive.arguments?.find(
            (arg) => arg.name.value === 'url',
          );

          if (
            name &&
            isStringValueNode(name.value) &&
            url &&
            isStringValueNode(url.value)
          ) {
            serviceList.push({
              name: name.value.value,
              url: url.value.value,
            });
          }
        });
      },
    });

    return serviceList;
  }

  protected createSchemaFromCsdl(csdl: string) {
    this.parsedCsdl = parse(csdl);
    const serviceList = this.serviceListFromCsdl();

    this.createServices(serviceList);

    return {
      schema: wrapSchemaWithAliasResolver(csdlToSchema(csdl)),
      composedSdl: csdl,
    };
  }

  public onSchemaChange(callback: SchemaChangeCallback): Unsubscriber {
    this.onSchemaChangeListeners.add(callback);

    return () => {
      this.onSchemaChangeListeners.delete(callback);
    };
  }

  private async pollServices() {
    if (this.pollingTimer) clearTimeout(this.pollingTimer);

    // Sleep for the specified pollInterval before kicking off another round of polling
    await new Promise<void>((res) => {
      this.pollingTimer = setTimeout(
        () => res(),
        this.experimental_pollInterval || 10000,
      );
      // Prevent the Node.js event loop from remaining active (and preventing,
      // e.g. process shutdown) by calling `unref` on the `Timeout`.  For more
      // information, see https://nodejs.org/api/timers.html#timers_timeout_unref.
      this.pollingTimer?.unref();
    });

    try {
      await this.updateComposition();
    } catch (err) {
      this.logger.error((err && err.message) || err);
    }

    if (this.stopped) {
      clearTimeout(this.pollingTimer!);
      this.pollingTimer = undefined;
      this.resolveStoppedPromise();
      return;
    }

    this.pollServices();
  }

  private createAndCacheDataSource(
    serviceDef: ServiceEndpointDefinition,
  ): GraphQLDataSource {
    // If the DataSource has already been created, early return
    if (
      this.serviceMap[serviceDef.name] &&
      serviceDef.url === this.serviceMap[serviceDef.name].url
    )
      return this.serviceMap[serviceDef.name].dataSource;

    const dataSource = this.createDataSource(serviceDef);

    // Cache the created DataSource
    this.serviceMap[serviceDef.name] = { url: serviceDef.url, dataSource };

    return dataSource;
  }

  private createDataSource(
    serviceDef: ServiceEndpointDefinition,
  ): GraphQLDataSource {
    if (!serviceDef.url && !isLocalConfig(this.config)) {
      this.logger.error(
        `Service definition for service ${serviceDef.name} is missing a url`,
      );
    }

    return this.config.buildService
      ? this.config.buildService(serviceDef)
      : new RemoteGraphQLDataSource({
          url: serviceDef.url,
        });
  }

  protected createServices(services: ServiceEndpointDefinition[]) {
    for (const serviceDef of services) {
      this.createAndCacheDataSource(serviceDef);
    }
  }

  protected async loadServiceDefinitions(
    config: RemoteGatewayConfig | ManagedGatewayConfig,
  ): Promise<UpdateReturnType> {
    if (isRemoteConfig(config)) {
      const serviceList = config.serviceList.map((serviceDefinition) => ({
        ...serviceDefinition,
        dataSource: this.createAndCacheDataSource(serviceDefinition),
      }));

      return getServiceDefinitionsFromRemoteEndpoint({
        serviceList,
        ...(config.introspectionHeaders
          ? { headers: config.introspectionHeaders }
          : {}),
        serviceSdlCache: this.serviceSdlCache,
      });
    }

    const canUseManagedConfig =
      this.apolloConfig?.graphId && this.apolloConfig?.keyHash;
    if (!canUseManagedConfig) {
      throw new Error(
        'When a manual configuration is not provided, gateway requires an Apollo ' +
        'configuration. See https://www.apollographql.com/docs/apollo-server/federation/managed-federation/ ' +
        'for more information. Manual configuration options include: ' +
        '`serviceList`, `csdl`, and `experimental_updateServiceDefinitions`.',
      );
    }

    return loadCsdlFromStorage({
      graphId: this.apolloConfig!.graphId!,
      // TODO: remove TS !
      apiKey: this.apolloConfig!.key!,
      graphVariant: this.apolloConfig!.graphVariant,
      fetcher: this.fetcher,
    });
  }

  private maybeWarnOnConflictingConfig() {
    const canUseManagedConfig =
      this.apolloConfig?.graphId && this.apolloConfig?.keyHash;

    // This might be a bit confusing just by reading, but `!isManagedConfig` just
    // means it's any of the other types of config. If it's any other config _and_
    // we have a studio config available (`canUseManagedConfig`) then we have a
    // conflict.
    if (
      !isManagedConfig(this.config) &&
      canUseManagedConfig &&
      !this.warnedStates.remoteWithLocalConfig
    ) {
      // Only display this warning once per start-up.
      this.warnedStates.remoteWithLocalConfig = true;
      // This error helps avoid common misconfiguration.
      // We don't await this because a local configuration should assume
      // remote is unavailable for one reason or another.
      this.logger.warn(
        'A local gateway configuration is overriding a managed federation ' +
          'configuration.  To use the managed ' +
          'configuration, do not specify a service list or csdl locally.',
      );
    }
  }

  // XXX Nothing guarantees that the only errors thrown or returned in
  // result.errors are GraphQLErrors, even though other code (eg
  // ApolloServerPluginUsageReporting) assumes that. In fact, errors talking to backends
  // are unlikely to show up as GraphQLErrors. Do we need to use
  // formatApolloErrors or something?
  public executor = async <TContext>(
    requestContext: GraphQLRequestContextExecutionDidStart<TContext>,
  ): Promise<GraphQLExecutionResult> => {
    const { request, document, queryHash, source } = requestContext;
    const queryPlanStoreKey = queryHash + (request.operationName || '');
    const operationContext = buildOperationContext({
      schema: this.schema!,
      operationDocument: document,
      operationString: source,
      queryPlannerPointer: this.queryPlannerPointer!,
      operationName: request.operationName,
    });

    // No need to build a query plan if we know the request is invalid beforehand
    // In the future, this should be controlled by the requestPipeline
    const validationErrors = this.validateIncomingRequest(
      requestContext,
      operationContext,
    );

    if (validationErrors.length > 0) {
      return { errors: validationErrors };
    }

    let queryPlan: QueryPlan | undefined;
    if (this.queryPlanStore) {
      queryPlan = await this.queryPlanStore.get(queryPlanStoreKey);
    }

    if (!queryPlan) {
      queryPlan = buildQueryPlan(operationContext, {
        autoFragmentization: Boolean(
          this.config.experimental_autoFragmentization,
        ),
      });
      if (this.queryPlanStore) {
        // The underlying cache store behind the `documentStore` returns a
        // `Promise` which is resolved (or rejected), eventually, based on the
        // success or failure (respectively) of the cache save attempt.  While
        // it's certainly possible to `await` this `Promise`, we don't care about
        // whether or not it's successful at this point.  We'll instead proceed
        // to serve the rest of the request and just hope that this works out.
        // If it doesn't work, the next request will have another opportunity to
        // try again.  Errors will surface as warnings, as appropriate.
        //
        // While it shouldn't normally be necessary to wrap this `Promise` in a
        // `Promise.resolve` invocation, it seems that the underlying cache store
        // is returning a non-native `Promise` (e.g. Bluebird, etc.).
        Promise.resolve(
          this.queryPlanStore.set(queryPlanStoreKey, queryPlan),
        ).catch((err) =>
          this.logger.warn(
            'Could not store queryPlan' + ((err && err.message) || err),
          ),
        );
      }
    }

    const serviceMap: ServiceMap = Object.entries(this.serviceMap).reduce(
      (serviceDataSources, [serviceName, { dataSource }]) => {
        serviceDataSources[serviceName] = dataSource;
        return serviceDataSources;
      },
      Object.create(null) as ServiceMap,
    );

    if (this.experimental_didResolveQueryPlan) {
      this.experimental_didResolveQueryPlan({
        queryPlan,
        serviceMap,
        requestContext,
        operationContext,
      });
    }

    const response = await executeQueryPlan<TContext>(
      queryPlan,
      serviceMap,
      requestContext,
      operationContext,
    );

    const shouldShowQueryPlan =
      this.config.__exposeQueryPlanExperimental &&
      request.http &&
      request.http.headers &&
      request.http.headers.get('Apollo-Query-Plan-Experimental');

    // We only want to serialize the query plan if we're going to use it, which is
    // in two cases:
    // 1) non-empty query plan and config.debug === true
    // 2) non-empty query plan and shouldShowQueryPlan === true
    const serializedQueryPlan =
      queryPlan.node && (this.config.debug || shouldShowQueryPlan)
        ? serializeQueryPlan(queryPlan)
        : null;

    if (this.config.debug && serializedQueryPlan) {
      this.logger.debug(serializedQueryPlan);
    }

    if (shouldShowQueryPlan) {
      // TODO: expose the query plan in a more flexible JSON format in the future
      // and rename this to `queryPlan`. Playground should cutover to use the new
      // option once we've built a way to print that representation.

      // In the case that `serializedQueryPlan` is null (on introspection), we
      // still want to respond to Playground with something truthy since it depends
      // on this to decide that query plans are supported by this gateway.
      response.extensions = {
        __queryPlanExperimental: serializedQueryPlan || true,
      };
    }
    return response;
  };

  protected validateIncomingRequest<TContext>(
    requestContext: GraphQLRequestContextExecutionDidStart<TContext>,
    operationContext: OperationContext,
  ) {
    // casting out of `readonly`
    const variableDefinitions = operationContext.operation
      .variableDefinitions as VariableDefinitionNode[] | undefined;

    if (!variableDefinitions) return [];

    const { errors } = getVariableValues(
      operationContext.schema,
      variableDefinitions,
      requestContext.request.variables || {},
    );

    return errors || [];
  }

  public stop() {
    this.stopped = true;
    if (!this.pollingTimer) {
      // Already wasn't polling, so we just resolve the promise immediately
      this.resolveStoppedPromise();
    }

    return this.stoppedPromise;
  }
}

function approximateObjectSize<T>(obj: T): number {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

// We can't use transformSchema here because the extension data for query
// planning would be lost. Instead we set a resolver for each field
// in order to counteract GraphQLExtensions preventing a defaultFieldResolver
// from doing the same job
function wrapSchemaWithAliasResolver(
  schema: GraphQLSchema,
): GraphQLSchema {
  const typeMap = schema.getTypeMap();
  Object.keys(typeMap).forEach(typeName => {
    const type = typeMap[typeName];

    if (isObjectType(type) && !isIntrospectionType(type)) {
      const fields = type.getFields();
      Object.keys(fields).forEach(fieldName => {
        const field = fields[fieldName];
        field.resolve = defaultFieldResolverWithAliasSupport;
      });
    }
  });
  return schema;
}

export {
  buildQueryPlan,
  executeQueryPlan,
  serializeQueryPlan,
  buildOperationContext,
  QueryPlan,
  ServiceMap,
  Experimental_DidFailCompositionCallback,
  Experimental_DidResolveQueryPlanCallback,
  Experimental_DidUpdateCompositionCallback,
  Experimental_UpdateServiceDefinitions,
  GatewayConfig,
  ServiceEndpointDefinition,
  CompositionInfo,
};

export * from './datasources';
