/**
 * A SPARQL 1.1 Protocol and Graph Store HTTP Protocol server built on
 * `effect/http`.
 *
 * The server needs the `SparqlEngine` and `QuadStore` services from
 * `@thomasfosterau/effect-sparql` and the core `Serialization.Formats`
 * service (see `Formats.layer` for the defaults). It is available as
 *
 * - `handler(options)`: a plain HTTP app (`Effect` of a response, given the
 *   `HttpServerRequest`) that routes the endpoint paths itself;
 * - `layerRoutes(options)`: routes registered on an `HttpRouter`, to mount
 *   into your own server;
 * - `layer(options)`: a complete Node HTTP server.
 *
 * @since 0.1.0
 */
import { createServer } from 'node:http';
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as Headers from 'effect/http/Headers';
import * as HttpMiddleware from 'effect/http/HttpMiddleware';
import * as HttpRouter from 'effect/http/HttpRouter';
import type * as HttpServer from 'effect/http/HttpServer';
import type * as HttpServerError from 'effect/http/HttpServerError';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import type * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as Ast from '@thomasfosterau/effect-sparql/Ast';
import * as Engine from '@thomasfosterau/effect-sparql/Engine';
import * as Parser from '@thomasfosterau/effect-sparql/Parser';
import * as Results from '@thomasfosterau/effect-sparql/Results';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import * as Errors from './Errors.ts';
import * as Formats from './Formats.ts';
import * as GraphStore from './GraphStore.ts';
import { prefetch, QueryTimeout } from './internal/prefetch.ts';
import * as Options from './Options.ts';
import * as Protocol from './Protocol.ts';
import * as ServiceDescription from './ServiceDescription.ts';

/**
 * The services a server needs.
 *
 * @since 0.1.0
 * @category models
 */
export type Requirements = Engine.SparqlEngine | Store.QuadStore | Serialization.Formats;

// -----------------------------------------------------------------------------
// Error mapping
// -----------------------------------------------------------------------------

const formatParseError = (e: Parser.SparqlParseError): string =>
  `Syntax error at line ${e.line}, column ${e.column}: ${e.message}`;

const fromEngineError = (e: Engine.SparqlError | QueryTimeout): Errors.ProtocolError => {
  return Match.value(e).pipe(
    Match.tag('SparqlParseError', (e) => Errors.badRequest(formatParseError(e))),
    Match.tag('UpdateError', (e) => Errors.badRequest(e.message)),
    Match.tag('EvaluationError', (e) => Errors.internal(e.message)),
    Match.tag('StoreError', (e) => Errors.internal(e.message)),
    Match.tag('QueryTimeout', () => Errors.timeout('The request exceeded the time limit')),
    Match.exhaustive,
  );
};

const withTimeout = <A, E>(
  effect: Effect.Effect<A, E>,
  timeout: Options.Resolved['queryTimeout'],
): Effect.Effect<A, E | QueryTimeout> =>
  timeout === undefined
    ? effect
    : Effect.timeoutOrElse(effect, {
        duration: timeout,
        orElse: () => Effect.fail(new QueryTimeout()),
      });

const charsetUtf8 = (mediaType: string) => `${mediaType}; charset=utf-8`;

// -----------------------------------------------------------------------------
// Query
// -----------------------------------------------------------------------------

const isGraphForm = (q: Ast.Query) => q._tag === 'Construct' || q._tag === 'Describe';

const runQuery = (
  options: Options.Resolved,
  operation: Extract<Protocol.Operation, { _tag: 'Query' }>,
  baseIri: string,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const engine = yield* Engine.SparqlEngine;
    const formats = yield* Serialization.Formats;
    const accept = request.headers['accept'];
    yield* Effect.annotateCurrentSpan({ 'sparql.query': operation.query });
    yield* Effect.logDebug('SPARQL query').pipe(Effect.annotateLogs({ query: operation.query }));

    const parsed = yield* Parser.parseQuery(operation.query, { baseIri }).pipe(
      Effect.mapError((e) => Errors.badRequest(formatParseError(e))),
    );
    // The protocol dataset overrides FROM / FROM NAMED.
    const query: Ast.Query =
      operation.dataset !== undefined ? { ...parsed, dataset: undefined } : parsed;
    const requestOptions: Engine.RequestOptions = { baseIri, dataset: operation.dataset };

    if (isGraphForm(query)) {
      const serializer = Formats.negotiateSerializer(formats, accept);
      if (serializer === undefined) {
        return yield* Errors.notAcceptable(accept ?? '', Formats.serializerMediaTypes(formats));
      }
      const constructed = Effect.flatMap(engine.construct(query, requestOptions), (s) =>
        prefetch(
          options.maxResults === undefined ? s : Stream.take(s, options.maxResults),
          options.queryTimeout,
        ),
      );
      const quads = yield* Effect.mapError(
        withTimeout(constructed, options.queryTimeout),
        fromEngineError,
      );
      const body = serializer.serializeStream(quads, {
        prefixes: PrefixMap.make(options.prefixes),
      });
      return HttpServerResponse.stream(Stream.encodeText(body), {
        contentType: charsetUtf8(serializer.format.mediaType),
      });
    }

    const codec = Results.negotiate(accept);
    if (Option.isNone(codec)) {
      return yield* Errors.notAcceptable(
        accept ?? '',
        Results.codecs.flatMap((c) => c.format.mediaTypes),
      );
    }
    const evaluated = Effect.flatMap(
      engine.query(query, requestOptions),
      (
        r,
      ): Effect.Effect<
        Results.SelectResult<Engine.SparqlError | QueryTimeout> | Results.AskResult | undefined,
        Engine.SparqlError | QueryTimeout
      > => {
        if (r._tag === 'Ask') return Effect.succeed(r);
        if (r._tag !== 'Select') return Effect.succeed(undefined);
        const bindings =
          options.maxResults === undefined
            ? r.bindings
            : Stream.take(r.bindings, options.maxResults);
        return Effect.map(prefetch(bindings, options.queryTimeout), (b) => ({
          ...r,
          bindings: b,
        }));
      },
    );
    const result = yield* Effect.mapError(
      withTimeout(evaluated, options.queryTimeout),
      fromEngineError,
    );
    if (result === undefined) return yield* Errors.internal('Unexpected graph result');
    const body = codec.value.serialize(result);
    return HttpServerResponse.stream(Stream.encodeText(body), {
      contentType: charsetUtf8(codec.value.format.mediaType),
    });
  }).pipe(Effect.withSpan('SparqlServer.query'));

// -----------------------------------------------------------------------------
// Update
// -----------------------------------------------------------------------------

const declaresDataset = (op: Ast.UpdateOperation): boolean =>
  op._tag === 'Modify' && (op.using !== undefined || op.with !== undefined);

const runUpdate = (
  options: Options.Resolved,
  operation: Extract<Protocol.Operation, { _tag: 'Update' }>,
  baseIri: string,
) =>
  Effect.gen(function* () {
    const engine = yield* Engine.SparqlEngine;
    yield* Effect.annotateCurrentSpan({ 'sparql.update': operation.update });
    yield* Effect.logDebug('SPARQL update').pipe(Effect.annotateLogs({ update: operation.update }));
    if (options.readOnly) {
      return yield* Errors.forbidden('This endpoint is read-only');
    }
    const update = yield* Parser.parseUpdate(operation.update, { baseIri }).pipe(
      Effect.mapError((e) => Errors.badRequest(formatParseError(e))),
    );
    if (operation.using !== undefined && update.operations.some(declaresDataset)) {
      return yield* Errors.badRequest(
        'using-graph-uri / using-named-graph-uri cannot be combined with USING, USING NAMED or WITH',
      );
    }
    yield* Effect.mapError(
      withTimeout(
        engine.update(update, { baseIri, dataset: operation.using }),
        options.updateTimeout,
      ),
      fromEngineError,
    );
    return HttpServerResponse.empty({ status: 204 });
  }).pipe(Effect.withSpan('SparqlServer.update'));

// -----------------------------------------------------------------------------
// Service description
// -----------------------------------------------------------------------------

const serviceDescription = (options: Options.Resolved, url: URL) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const store = yield* Store.QuadStore;
    const formats = yield* Serialization.Formats;
    const accept = request.headers['accept'];
    const serializer = Formats.negotiateSerializer(formats, accept);
    if (serializer === undefined) {
      return yield* Errors.notAcceptable(accept ?? '', Formats.serializerMediaTypes(formats));
    }
    const graphs = yield* Stream.runCollect(Stream.take(store.graphs, 1000)).pipe(
      Effect.mapError((e) => Errors.internal(e.message)),
    );
    const endpoint = new URL(options.path, url).href;
    const quads = ServiceDescription.describe({
      endpoint,
      updateEndpoint: options.readOnly ? undefined : new URL(options.updatePath, url).href,
      formats,
      unionDefaultGraph: options.unionDefaultGraph,
      federation: options.federation,
      namedGraphs: graphs.filter((g) => g._tag === 'NamedNode'),
    });
    const text = yield* serializer
      .serialize(quads, {
        prefixes: PrefixMap.make({ sd: ServiceDescription.SD, ...options.prefixes }),
      })
      .pipe(Effect.mapError((e) => Errors.internal(e.message)));
    const contentType = charsetUtf8(serializer.format.mediaType);
    return request.method === 'HEAD'
      ? HttpServerResponse.empty({ status: 200, headers: { 'content-type': contentType } })
      : HttpServerResponse.text(text, { contentType });
  }).pipe(Effect.withSpan('SparqlServer.serviceDescription'));

// -----------------------------------------------------------------------------
// Endpoint
// -----------------------------------------------------------------------------

const endpoint = (options: Options.Resolved, kind: Protocol.EndpointKind) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = Options.requestUrl(request, options);
    const base = new URL(url.href);
    base.search = '';
    const baseIri = options.baseIri ?? base.href;
    const operation = yield* Protocol.decode(request, kind, baseIri);
    return yield* Match.value(operation).pipe(
      Match.tag('Query', (operation) =>
        Effect.gen(function* () {
          return yield* runQuery(options, operation, baseIri);
        }),
      ),
      Match.tag('Update', (operation) =>
        Effect.gen(function* () {
          return yield* runUpdate(options, operation, baseIri);
        }),
      ),
      Match.tag('ServiceDescription', () =>
        Effect.gen(function* () {
          if (!options.serviceDescription) {
            return yield* Errors.badRequest("Missing 'query' parameter");
          }
          return yield* serviceDescription(options, url);
        }),
      ),
      Match.exhaustive,
    );
  });

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------

const corsHeaders = (
  cors: Options.CorsOptions,
  request: HttpServerRequest.HttpServerRequest,
  preflight: boolean,
) => {
  const headers: Record<string, string> = {};
  const origin = request.headers['origin'];
  const allowed = cors.allowedOrigins;
  if (allowed === undefined || Arr.isReadonlyArrayEmpty(allowed)) {
    headers['access-control-allow-origin'] = '*';
  } else if (origin !== undefined && allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  } else {
    headers['vary'] = 'Origin';
  }
  if (cors.credentials === true) headers['access-control-allow-credentials'] = 'true';
  if (cors.exposedHeaders !== undefined && Arr.isReadonlyArrayNonEmpty(cors.exposedHeaders)) {
    headers['access-control-expose-headers'] = cors.exposedHeaders.join(', ');
  }
  if (preflight) {
    headers['access-control-allow-methods'] = 'GET, HEAD, POST, PUT, DELETE, OPTIONS';
    const requested = request.headers['access-control-request-headers'];
    if (cors.allowedHeaders !== undefined && Arr.isReadonlyArrayNonEmpty(cors.allowedHeaders)) {
      headers['access-control-allow-headers'] = cors.allowedHeaders.join(', ');
    } else if (requested !== undefined) {
      headers['access-control-allow-headers'] = requested;
    }
    if (cors.maxAge !== undefined) headers['access-control-max-age'] = String(cors.maxAge);
  }
  return headers;
};

const withCors =
  (options: Options.Resolved) =>
  <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > => {
    const cors = options.cors;
    if (cors === undefined) return app;
    return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      request.method === 'OPTIONS'
        ? Effect.succeed(
            HttpServerResponse.empty({ status: 204, headers: corsHeaders(cors, request, true) }),
          )
        : Effect.map(app, (response) =>
            HttpServerResponse.setHeaders(
              response,
              Headers.fromInput(corsHeaders(cors, request, false)),
            ),
          ),
    );
  };

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

const recover = <R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, Errors.ProtocolError, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  Effect.catchTag(app, 'ProtocolError', (e) =>
    Effect.as(
      e.status >= 500
        ? Effect.logError('SPARQL request failed', e.message)
        : Effect.logDebug('SPARQL request rejected', e.status, e.message),
      Errors.toResponse(e),
    ),
  );

const finish =
  (options: Options.Resolved) =>
  <R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, Errors.ProtocolError, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    R | HttpServerRequest.HttpServerRequest
  > => {
    const handled = withCors(options)(recover(app));
    return options.logging ? HttpMiddleware.logger(handled) : handled;
  };

/**
 * The SPARQL endpoint (query, update and service description) as an HTTP
 * app.
 *
 * @since 0.1.0
 * @category handlers
 */
export const sparqlHandler = (
  options?: Options.Options,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Requirements
> => {
  const resolved = Options.resolve(options);
  return endpointFor(resolved, resolved.path);
};

const endpointFor = (resolved: Options.Resolved, path: string) =>
  finish(resolved)(
    endpoint(resolved, {
      query: path === resolved.path,
      update: path === resolved.updatePath,
    }),
  );

/**
 * The Graph Store Protocol endpoint as an HTTP app.
 *
 * @since 0.1.0
 * @category handlers
 */
export const graphStoreHandler = (
  options?: Options.Options,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Store.QuadStore | Serialization.Formats
> => {
  const resolved = Options.resolve(options);
  return finish(resolved)(GraphStore.handle(resolved, resolved.graphStorePath ?? '/'));
};

/**
 * The whole server as one HTTP app: routes requests to the SPARQL endpoint(s)
 * and the graph store by path, and answers `404` otherwise.
 *
 * @since 0.1.0
 * @category handlers
 */
export const handler = (
  options?: Options.Options,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Requirements
> => {
  const resolved = Options.resolve(options);
  const query = endpointFor(resolved, resolved.path);
  const update =
    resolved.updatePath === resolved.path ? query : endpointFor(resolved, resolved.updatePath);
  const gsp =
    resolved.graphStorePath === undefined
      ? undefined
      : finish(resolved)(GraphStore.handle(resolved, resolved.graphStorePath));
  const notFound = finish(resolved)(Effect.fail(Errors.notFound('Not found')));
  return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const path = Options.requestPath(request.url);
    if (path === resolved.path) return query;
    if (path === resolved.updatePath) return update;
    if (
      gsp !== undefined &&
      resolved.graphStorePath !== undefined &&
      (path === resolved.graphStorePath || path.startsWith(`${resolved.graphStorePath}/`))
    ) {
      return gsp;
    }
    return notFound;
  });
};

/**
 * Registers the server's routes on the `HttpRouter`: the SPARQL endpoint(s),
 * the graph store root and everything below it (direct graph
 * identification).
 *
 * @since 0.1.0
 * @category layers
 */
export const layerRoutes = (
  options?: Options.Options,
): Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | HttpRouter.Request.From<'Requires', Requirements>
> => {
  const resolved = Options.resolve(options);
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add('*', resolved.path, endpointFor(resolved, resolved.path));
      if (resolved.updatePath !== resolved.path) {
        yield* router.add('*', resolved.updatePath, endpointFor(resolved, resolved.updatePath));
      }
      if (resolved.graphStorePath !== undefined) {
        const gsp = finish(resolved)(GraphStore.handle(resolved, resolved.graphStorePath));
        // `/path/*` also matches `/path` itself.
        yield* router.add('*', `${resolved.graphStorePath}/*`, gsp);
      }
    }),
  );
};

/**
 * Serves the routes with `HttpRouter.serve` on an `HttpServer` from the
 * context (logging requests unless `logging: false`).
 *
 * @since 0.1.0
 * @category layers
 */
// SAFETY: the routes' own requirements are `Requirements`; the cast restates them without the
// router internals.
export const layerServe = (
  options?: Options.Options,
): Layer.Layer<never, never, HttpServer.HttpServer | Requirements> =>
  HttpRouter.serve(layerRoutes({ ...options, logging: false }), {
    disableLogger: options?.logging === false,
  }) as Layer.Layer<never, never, HttpServer.HttpServer | Requirements>;

/**
 * Options of the Node server.
 *
 * @since 0.1.0
 * @category models
 */
export interface ServeOptions extends Options.Options {
  /** The port to listen on (`0` for an ephemeral port). */
  readonly port: number;
  /** The host to bind (default: all interfaces). */
  readonly host?: string | undefined;
}

/**
 * A Node HTTP server serving the SPARQL endpoint and graph store.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  options: ServeOptions,
): Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError, Requirements> => {
  const { port, host, ...rest } = options;
  // SAFETY: providing the Node HTTP server leaves `HttpServer` and `Requirements`; the cast
  // restates the layer type.
  return layerServe(rest).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, host === undefined ? { port } : { port, host }),
    ),
  ) as Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError, Requirements>;
};

/**
 * The services of an in-memory server: the engine over an in-memory store
 * (optionally pre-loaded) and the default formats.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerMemoryServices = (
  data?: Dataset.Dataset,
  engineOptions?: Engine.EngineOptions,
): Layer.Layer<Requirements> =>
  Layer.mergeAll(
    Engine.layer(engineOptions).pipe(Layer.provideMerge(Store.layerMemory(data))),
    Formats.layer,
  );

/**
 * A Node server over an in-memory store.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerMemory = (
  options: ServeOptions & {
    readonly data?: Dataset.Dataset | undefined;
    readonly engine?: Engine.EngineOptions | undefined;
  },
): Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError> => {
  const { data, engine, ...rest } = options;
  return layer({
    ...rest,
    unionDefaultGraph: rest.unionDefaultGraph ?? engine?.unionDefaultGraph,
    federation: rest.federation ?? engine?.service !== undefined,
  }).pipe(Layer.provide(layerMemoryServices(data, engine)));
};
