/**
 * Serves the `SparqlApi` definition with `HttpApiBuilder`.
 *
 * Every endpoint is implemented with a raw handler (`handleRaw`) that runs
 * the same code as `SparqlServer`: the request body, `Accept` and
 * `Content-Type` are read by the protocol internals, so responses, statuses
 * and error messages are those of `SparqlServer.handler`. Routes the API does
 * not declare (other methods on the endpoints, which get `405` with
 * `Allow`; `OPTIONS` preflights when CORS is on; graphs identified directly
 * by a URL below the graph store) are registered as plain `HttpRouter`
 * fallback routes to `SparqlServer.handler`.
 *
 * `effect/http-api` is `@stability unstable` in Effect 4.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Scope from 'effect/Scope';
import type * as HttpClient from 'effect/http/HttpClient';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServer from 'effect/http/HttpServer';
import * as HttpServerError from 'effect/http/HttpServerError';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import type * as Options from '@thomasfosterau/effect-rdf/sparql/Options';
import * as SparqlApi from './SparqlApi.ts';
import * as SparqlServer from '@thomasfosterau/effect-rdf/sparql/SparqlServer';
import * as Testing from '@thomasfosterau/effect-rdf/sparql/Testing';

/**
 * Options of the API server: the server options, with the endpoint paths of
 * the API (the update endpoint is the query endpoint) and where to serve the
 * OpenAPI document.
 *
 * @since 0.1.0
 * @category models
 */
export interface ApiOptions
  extends Omit<Options.Options, 'path' | 'updatePath' | 'graphStorePath'>, SparqlApi.Paths {
  /** Serves the OpenAPI document (`SparqlApi.openApi`) as JSON at this path. */
  readonly openapiPath?: `/${string}` | undefined;
}

interface ServerPaths {
  readonly path: `/${string}`;
  readonly graphStorePath: `/${string}`;
}

const serverOptions = (options?: ApiOptions): Options.Options & ServerPaths => {
  const path = options?.path ?? '/sparql';
  return {
    ...options,
    path,
    updatePath: path,
    graphStorePath: options?.graphStorePath ?? '/rdf-graph-store',
  };
};

const handlersFor = (api: SparqlApi.Api, options: Options.Options) => {
  const sparql = SparqlServer.sparqlHandler(options);
  const graphStore = SparqlServer.graphStoreHandler(options);
  return Layer.mergeAll(
    HttpApiBuilder.group(api, 'sparql', (handlers) =>
      handlers.handleRaw('query', () => sparql).handleRaw('post', () => sparql),
    ),
    HttpApiBuilder.group(api, 'graphStore', (handlers) =>
      handlers
        .handleRaw('get', () => graphStore)
        .handleRaw('head', () => graphStore)
        .handleRaw('put', () => graphStore)
        .handleRaw('post', () => graphStore)
        .handleRaw('delete', () => graphStore),
    ),
  );
};

/**
 * The handlers of both API groups (`sparql` and `graphStore`) for the API at
 * the options' paths, using the server's services from the context.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerHandlers = (options?: ApiOptions) => {
  const resolved = serverOptions(options);
  return handlersFor(SparqlApi.make(resolved), resolved);
};

/**
 * The `SparqlApi.SchemaFallback` middleware: a request whose parameters or
 * headers fail the API's schemas is answered by `SparqlServer.handler`, so
 * it gets the protocol's own status and message (e.g. `400` "Exactly one
 * 'query' parameter is allowed"). Response encoding failures stay `500`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerSchemaFallback = (
  options?: ApiOptions,
): Layer.Layer<SparqlApi.SchemaFallback> => {
  const app = SparqlServer.handler(serverOptions(options));
  return HttpApiMiddleware.layerSchemaErrorTransform(SparqlApi.SchemaFallback, (error) =>
    error.kind === 'Body' || error.kind === 'ResponseHeaders' ? Effect.fail(error) : app,
  );
};

/**
 * The fallback routes: every method on `<path>*` and `<graphStorePath>*`
 * that the API does not declare, answered by `SparqlServer.handler` (`405`
 * with `Allow`, CORS preflights, direct graph identification, `404` for
 * other paths).
 *
 * @since 0.1.0
 * @category layers
 */
export const layerFallback = (
  options?: ApiOptions,
): Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | HttpRouter.Request.From<'Requires', SparqlServer.Requirements>
> => {
  const resolved = serverOptions(options);
  const app = SparqlServer.handler(resolved);
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      // A wildcard right after the path matches the path itself (for methods the API does not
      // declare) and everything below it, without clashing with the API's own routes.
      yield* router.add('*', `${resolved.path}*`, app);
      yield* router.add('*', `${resolved.graphStorePath}*`, app);
    }),
  );
};

/**
 * Registers the API on the `HttpRouter`: the `HttpApiBuilder` routes with
 * their handlers and the `SchemaFallback` middleware, the fallback routes and, with `openapiPath`, the OpenAPI
 * document.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerRoutes = (options?: ApiOptions) => {
  const resolved = serverOptions(options);
  const api = SparqlApi.make(resolved);
  const schemaFallback = layerSchemaFallback(options);
  return Layer.mergeAll(
    HttpApiBuilder.layer(api, { openapiPath: options?.openapiPath }).pipe(
      Layer.provide(handlersFor(api, resolved).pipe(Layer.provide(schemaFallback))),
    ),
    layerFallback(options),
  );
};

/**
 * Serves the API routes with `HttpRouter.serve` on an `HttpServer` from the
 * context (logging requests unless `logging: false`); the server layer (such
 * as `NodeHttpServer.layer`) also provides the platform services
 * `HttpApiBuilder` needs.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerServe = (options?: ApiOptions) =>
  HttpRouter.serve(layerRoutes({ ...options, logging: false }), {
    disableLogger: options?.logging === false,
  });

/**
 * In-process testing: builds a client for the `SparqlApi` routes
 * (`layerRoutes(options)`) using the server's services from
 * the context. The routes live as long as the surrounding scope.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeTestClient = (
  options?: ApiOptions,
): Effect.Effect<HttpClient.HttpClient, never, SparqlServer.Requirements | Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const context = yield* Effect.context<SparqlServer.Requirements>();
    const app = yield* HttpRouter.toHttpEffect(
      layerRoutes(options).pipe(Layer.provide(HttpServer.layerServices)),
    );
    return Testing.fromApp(
      app.pipe(
        Effect.catchCause((cause) =>
          Effect.map(HttpServerError.causeResponse(cause), ([response]) => response),
        ),
        Effect.provideService(Scope.Scope, scope),
        Effect.provideContext(context),
      ),
    );
  });
