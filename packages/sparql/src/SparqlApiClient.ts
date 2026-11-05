/**
 * A client derived with `HttpApiClient` from the `SparqlApi` definition,
 * alongside the hand-written `SparqlClient`.
 *
 * `make` returns the generated client: one method per endpoint
 * (`client.sparql.query`, `client.sparql.post`, `client.graphStore.get`, …)
 * taking the endpoint's typed `query`, `headers` and `payload` and returning
 * response bodies as byte streams. Error statuses decode into the server's
 * `ProtocolErrors.ProtocolError`. The helpers below (`query`, `results`,
 * `construct`, `update`, `readGraph`, `writeGraph`) send the common
 * requests and parse the bodies with the results parsers (`ResultsStream`)
 * and the default `Formats`.
 *
 * `effect/http-api` is `@stability unstable` in Effect 4, and so is this
 * client.
 *
 * @since 0.1.0
 */
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import type * as Schema from 'effect/Schema';
import type * as HttpClient from 'effect/http/HttpClient';
import type * as HttpClientError from 'effect/http/HttpClientError';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as HttpApiClient from 'effect/http-api/HttpApiClient';
import type * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as ProtocolErrors from './ProtocolErrors.ts';
import * as SparqlApi from './SparqlApi.ts';
import * as ClientErrors from './ClientErrors.ts';
import * as ClientFormats from './ClientFormats.ts';
import * as ResultsStream from './ResultsStream.ts';
import * as SparqlClient from './SparqlClient.ts';

// -----------------------------------------------------------------------------
// The client
// -----------------------------------------------------------------------------

/**
 * The generated client of the `SparqlApi`.
 *
 * @since 0.1.0
 * @category models
 */
export type Client = HttpApiClient.ForApi<SparqlApi.Api>;

/**
 * Options of the derived client.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /** The server's base URL (e.g. `https://example.org`); paths are appended to it. */
  readonly baseUrl?: string | URL | undefined;
  /** The endpoint paths, when the server does not use the defaults. */
  readonly paths?: SparqlApi.Paths | undefined;
  /** Transforms the `HttpClient` (retries, authentication, …). */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined;
}

/**
 * Derives the client from the API definition, using the `HttpClient` from
 * the context.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options?: Options): Effect.Effect<Client, never, HttpClient.HttpClient> =>
  HttpApiClient.make(SparqlApi.make(options?.paths), {
    baseUrl: options?.baseUrl,
    transformClient: options?.transformClient,
  });

/**
 * The derived client as a service.
 *
 * @since 0.1.0
 * @category services
 */
export class SparqlApiClient extends Context.Service<SparqlApiClient, Client>()(
  '@thomasfosterau/effect-sparql/SparqlApiClient',
) {}

/**
 * A layer providing the derived client.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  options?: Options,
): Layer.Layer<SparqlApiClient, never, HttpClient.HttpClient> =>
  Layer.effect(SparqlApiClient, make(options));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Any failure of a derived client call: a protocol error status, a transport
 * or decoding failure of the generated client, or an unreadable body.
 *
 * @since 0.1.0
 * @category errors
 */
export type ApiError =
  | ProtocolErrors.ProtocolError
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | ClientErrors.MalformedResponseError
  | ClientErrors.UnsupportedMediaTypeError;

/**
 * A response body and its media type.
 *
 * @since 0.1.0
 * @category models
 */
export interface Body {
  /** The media type of the body, without parameters. */
  readonly mediaType: string;
  readonly bytes: Stream.Stream<Uint8Array, ApiError>;
}

/**
 * The protocol dataset of a query (`default-graph-uri` / `named-graph-uri`).
 *
 * @since 0.1.0
 * @category models
 */
export interface QueryOptions {
  readonly defaultGraphs?: ReadonlyArray<string> | undefined;
  readonly namedGraphs?: ReadonlyArray<string> | undefined;
  /** The `Accept` header (default: every results and RDF format). */
  readonly accept?: string | undefined;
  /** `get` (default) sends `?query=`, `post` an `application/sparql-query` body. */
  readonly method?: 'get' | 'post' | undefined;
}

/**
 * The protocol dataset of an update (`using-graph-uri` /
 * `using-named-graph-uri`).
 *
 * @since 0.1.0
 * @category models
 */
export interface UpdateOptions {
  readonly usingGraphs?: ReadonlyArray<string> | undefined;
  readonly usingNamedGraphs?: ReadonlyArray<string> | undefined;
}

/**
 * The graph of a Graph Store request: the default graph or a graph IRI.
 *
 * @since 0.1.0
 * @category models
 */
export type GraphTarget = 'default' | { readonly graph: string };

const mediaTypeOf = (response: HttpClientResponse.HttpClientResponse): string =>
  (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

const graphParams = (target: GraphTarget) =>
  target === 'default' ? { default: '' } : { graph: target.graph };

// An empty list sends no parameter.
const queryDataset = (options: QueryOptions | undefined) => ({
  'default-graph-uri': options?.defaultGraphs ?? [],
  'named-graph-uri': options?.namedGraphs ?? [],
});

const updateDataset = (options: UpdateOptions | undefined) => ({
  'using-graph-uri': options?.usingGraphs ?? [],
  'using-named-graph-uri': options?.usingNamedGraphs ?? [],
});

const queryHeaders = (accept: string | undefined) => ({
  accept: accept ?? SparqlApi.queryMediaTypes.join(', '),
});

/**
 * Sends a query and returns the response body with its media type, without
 * parsing it.
 *
 * @since 0.1.0
 * @category queries
 */
export const query = (
  client: Client,
  sparql: string,
  options?: QueryOptions,
): Effect.Effect<Body, ApiError> => {
  const dataset = queryDataset(options);
  const headers = queryHeaders(options?.accept);
  const sent =
    options?.method === 'post'
      ? client.sparql.post({
          query: dataset,
          headers,
          payload: { _tag: 'DirectQuery', query: sparql },
          responseMode: 'decoded-and-response',
        })
      : client.sparql.query({
          query: { query: sparql, ...dataset },
          headers,
          responseMode: 'decoded-and-response',
        });
  return Effect.flatMap(sent, ([bytes, response]) =>
    bytes === undefined
      ? Effect.fail(
          new ClientErrors.MalformedResponseError({
            message: `Expected a query result, got status ${response.status}`,
          }),
        )
      : Effect.succeed({ mediaType: mediaTypeOf(response), bytes }),
  );
};

/**
 * Sends a `SELECT` or `ASK` query and parses the results incrementally with
 * `ResultsStream`.
 *
 * @since 0.1.0
 * @category queries
 */
export const results = (
  client: Client,
  sparql: string,
  options?: QueryOptions,
): Stream.Stream<ResultsStream.ResultEvent, ApiError> =>
  Stream.unwrap(
    Effect.flatMap(
      query(client, sparql, {
        ...options,
        accept: options?.accept ?? SparqlClient.DEFAULT_RESULTS_ACCEPT,
      }),
      (body) =>
        Option.match(ResultsStream.parse(body.mediaType, Stream.decodeText(body.bytes)), {
          onNone: () =>
            Effect.fail(
              new ClientErrors.UnsupportedMediaTypeError({
                contentType: body.mediaType,
                expected: SparqlApi.resultsMediaTypes,
              }),
            ),
          onSome: (events) =>
            Effect.succeed(
              Stream.mapError(events, (e) =>
                ClientErrors.isSparqlClientError(e)
                  ? e
                  : new ClientErrors.MalformedResponseError({
                      message: e.message,
                      contentType: body.mediaType,
                      cause: e,
                    }),
              ),
            ),
        }),
    ),
  );

const parseRdf = (body: Body, baseIri: string): Effect.Effect<Dataset.Dataset, ApiError> =>
  Option.match(Serialization.parserFor(ClientFormats.defaults, body.mediaType), {
    onNone: () =>
      Effect.fail(
        new ClientErrors.UnsupportedMediaTypeError({
          contentType: body.mediaType,
          expected: SparqlApi.rdfMediaTypes,
        }),
      ),
    onSome: (parser) =>
      Stream.mkString(Stream.decodeText(body.bytes)).pipe(
        Effect.flatMap((text) =>
          parser.parse(text, { baseIri }).pipe(
            Effect.mapError(
              (e) =>
                new ClientErrors.MalformedResponseError({
                  message: Serialization.formatError(e),
                  contentType: body.mediaType,
                  cause: e,
                }),
            ),
          ),
        ),
        Effect.map((parsed) => parsed.dataset),
      ),
  });

/**
 * Sends a `CONSTRUCT` or `DESCRIBE` query and parses the graph with the
 * default `Formats` (relative IRIs resolve against `baseIri`).
 *
 * @since 0.1.0
 * @category queries
 */
export const construct = (
  client: Client,
  sparql: string,
  options?: QueryOptions & { readonly baseIri?: string | undefined },
): Effect.Effect<Dataset.Dataset, ApiError> =>
  Effect.flatMap(
    query(client, sparql, {
      ...options,
      accept: options?.accept ?? ClientFormats.acceptHeader(ClientFormats.defaults),
    }),
    (body) => parseRdf(body, options?.baseIri ?? 'urn:x-base:'),
  );

/**
 * Sends an update as an `application/sparql-update` body.
 *
 * @since 0.1.0
 * @category updates
 */
export const update = (
  client: Client,
  sparql: string,
  options?: UpdateOptions,
): Effect.Effect<void, ApiError> =>
  Effect.asVoid(
    client.sparql.post({
      query: updateDataset(options),
      headers: {},
      payload: { _tag: 'DirectUpdate', update: sparql },
    }),
  );

/**
 * Reads a graph from the graph store and parses it with the default
 * `Formats`.
 *
 * @since 0.1.0
 * @category graph store
 */
export const readGraph = (
  client: Client,
  target: GraphTarget,
  options?: { readonly accept?: string | undefined; readonly baseIri?: string | undefined },
): Effect.Effect<Dataset.Dataset, ApiError> =>
  client.graphStore
    .get({
      query: graphParams(target),
      headers: { accept: options?.accept ?? ClientFormats.acceptHeader(ClientFormats.defaults) },
      responseMode: 'decoded-and-response',
    })
    .pipe(
      Effect.flatMap(([bytes, response]) =>
        parseRdf(
          { mediaType: mediaTypeOf(response), bytes },
          options?.baseIri ?? (target === 'default' ? 'urn:x-base:' : target.graph),
        ),
      ),
    );

/**
 * Writes an RDF document to a graph: `put` (default) replaces the graph,
 * `post` adds to it. The document's media type must be one of
 * `SparqlApi.rdfMediaTypes` (default `text/turtle`).
 *
 * @since 0.1.0
 * @category graph store
 */
export const writeGraph = (
  client: Client,
  target: GraphTarget,
  document: string,
  options?: {
    readonly mediaType?: string | undefined;
    readonly method?: 'put' | 'post' | undefined;
  },
): Effect.Effect<void, ApiError> => {
  const request = {
    query: graphParams(target),
    payload: { mediaType: options?.mediaType ?? 'text/turtle', document },
  };
  return Effect.asVoid(
    options?.method === 'post' ? client.graphStore.post(request) : client.graphStore.put(request),
  );
};
