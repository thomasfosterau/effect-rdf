/**
 * A strongly-typed SPARQL 1.1 Protocol and Graph Store HTTP Protocol client
 * built on the `effect/http` `HttpClient`.
 *
 * Queries can be strings, `Ast` values or `QueryBuilder` builders; the typed
 * rows of a `QueryBuilder.select(…)` flow through to `select`. `SELECT`
 * results are parsed incrementally (JSON, XML, TSV) and streamed;
 * `CONSTRUCT` / `DESCRIBE` results are parsed with the `Serialization.Formats`
 * parser for the response's media type (N-Triples is preferred and parsed
 * incrementally).
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Match from 'effect/Match';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import type * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import * as HttpClient from 'effect/http/HttpClient';
import type * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Dataset from '../Dataset.ts';
import * as Serialization from '../Serialization.ts';
import * as Term from '../Term.ts';
import type * as Ast from './Ast.ts';
import * as B from './Bindings.ts';
import * as Generator from './Generator.ts';
import * as QueryBuilder from './QueryBuilder.ts';
import type * as Results from './Results.ts';
import * as ClientErrors from './ClientErrors.ts';
import * as ClientFormats from './ClientFormats.ts';
import * as ResultsStream from './ResultsStream.ts';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * How queries are sent: `get` (URL query string), `post`
 * (`application/sparql-query` body) or `auto` (`GET` unless the URL would
 * exceed `maxGetLength`).
 *
 * @since 0.1.0
 * @category models
 */
export type Method = 'auto' | 'get' | 'post';

/**
 * Client configuration.
 *
 * @since 0.1.0
 * @category models
 */
export interface Config {
  /** The SPARQL query endpoint URL. */
  readonly endpoint: string;
  /** The SPARQL update endpoint URL (default: `endpoint`). */
  readonly updateEndpoint?: string | undefined;
  /** The Graph Store Protocol endpoint URL (required for graph operations). */
  readonly graphStoreEndpoint?: string | undefined;
  /** Headers sent with every request (e.g. `authorization`). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** How queries are sent (default `auto`). */
  readonly method?: Method | undefined;
  /** The longest URL sent with `GET` in `auto` mode (default 2048). */
  readonly maxGetLength?: number | undefined;
  /** Time limit for receiving a response (headers). */
  readonly timeout?: Duration.Input | undefined;
  /**
   * Retry policy for transient failures (transport errors, timeouts and the
   * statuses 408, 429, 502, 503 and 504; see `retryWhile`).
   */
  readonly retry?: Schedule.Schedule<unknown, ClientErrors.SparqlClientError> | undefined;
  /** Which errors are retried (default `ClientErrors.isTransient`). */
  readonly retryWhile?: ((error: ClientErrors.SparqlClientError) => boolean) | undefined;
  /** The `Accept` header of `SELECT` / `ASK` requests. */
  readonly resultsAccept?: string | undefined;
  /** The media type used to upload graphs (default `application/n-triples`). */
  readonly graphMediaType?: string | undefined;
}

/**
 * A query: SPARQL text, a parsed query or a `QueryBuilder` builder.
 *
 * @since 0.1.0
 * @category models
 */
export type QueryInput =
  | string
  | Ast.Query
  | QueryBuilder.Builder<'Select', any, any>
  | QueryBuilder.Builder<'Ask', any, any>
  | QueryBuilder.Builder<'Construct', any, any>
  | QueryBuilder.Builder<'Describe', any, any>;

/**
 * An update: SPARQL text or a parsed update.
 *
 * @since 0.1.0
 * @category models
 */
export type UpdateInput = string | Ast.Update;

/**
 * A graph IRI.
 *
 * @since 0.1.0
 * @category models
 */
export type GraphIri = string | Term.NamedNode;

/**
 * The graph of a Graph Store operation: `'default'` or a named graph.
 *
 * @since 0.1.0
 * @category models
 */
export type GraphTarget = 'default' | Term.NamedNode;

/**
 * Per-request options.
 *
 * @since 0.1.0
 * @category models
 */
export interface RequestOptions {
  /** Extra headers. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Overrides the configured timeout. */
  readonly timeout?: Duration.Input | undefined;
}

/**
 * Options of query requests.
 *
 * @since 0.1.0
 * @category models
 */
export interface QueryOptions extends RequestOptions {
  /** `default-graph-uri` parameters. */
  readonly defaultGraphs?: ReadonlyArray<GraphIri> | undefined;
  /** `named-graph-uri` parameters. */
  readonly namedGraphs?: ReadonlyArray<GraphIri> | undefined;
  /** Overrides the configured method. */
  readonly method?: Method | undefined;
}

/**
 * Options of update requests.
 *
 * @since 0.1.0
 * @category models
 */
export interface UpdateOptions extends RequestOptions {
  /** `using-graph-uri` parameters. */
  readonly usingGraphs?: ReadonlyArray<GraphIri> | undefined;
  /** `using-named-graph-uri` parameters. */
  readonly usingNamedGraphs?: ReadonlyArray<GraphIri> | undefined;
}

/**
 * Options of Graph Store uploads.
 *
 * @since 0.1.0
 * @category models
 */
export interface UploadOptions extends RequestOptions {
  /** The media type to upload with (default: the configured one). */
  readonly mediaType?: string | undefined;
}

/**
 * An untyped `SELECT` row.
 *
 * @since 0.1.0
 * @category models
 */
export type Row = Readonly<Record<string, Term.GroundTerm>>;

/**
 * The materialised result of any query.
 *
 * @since 0.1.0
 * @category models
 */
export type QueryResult =
  | Results.ResultSet
  | Results.BooleanResult
  | { readonly _tag: 'Graph'; readonly dataset: Dataset.Dataset };

/**
 * The client service.
 *
 * @since 0.1.0
 * @category models
 */
export interface SparqlClientShape {
  readonly config: Config;
  /** Streams the rows of a `SELECT` query (typed for builders). */
  readonly select: {
    <R extends string, O extends string>(
      query: QueryBuilder.Builder<'Select', R, O>,
      options?: QueryOptions,
    ): Stream.Stream<QueryBuilder.Row<R, O>, ClientErrors.SparqlClientError>;
    (
      query: string | Ast.Query,
      options?: QueryOptions,
    ): Stream.Stream<Row, ClientErrors.SparqlClientError>;
  };
  /** Streams the solutions of a `SELECT` query. */
  readonly selectBindings: (
    query: QueryInput,
    options?: QueryOptions,
  ) => Stream.Stream<B.Bindings, ClientErrors.SparqlClientError>;
  /** Streams the raw events (variables, solutions, boolean) of a results document. */
  readonly results: (
    query: QueryInput,
    options?: QueryOptions,
  ) => Stream.Stream<ResultsStream.ResultEvent, ClientErrors.SparqlClientError>;
  /** Collects a `SELECT` result, with its variables. */
  readonly selectAll: (
    query: QueryInput,
    options?: QueryOptions,
  ) => Effect.Effect<Results.ResultSet, ClientErrors.SparqlClientError>;
  /** Evaluates an `ASK` query. */
  readonly ask: (
    query: QueryInput,
    options?: QueryOptions,
  ) => Effect.Effect<boolean, ClientErrors.SparqlClientError>;
  /** Streams the triples of a `CONSTRUCT` (or `DESCRIBE`) query. */
  readonly construct: (
    query: QueryInput,
    options?: QueryOptions,
  ) => Stream.Stream<Term.Quad, ClientErrors.SparqlClientError>;
  /** Streams the triples of a `DESCRIBE` query. */
  readonly describe: (
    query: QueryInput,
    options?: QueryOptions,
  ) => Stream.Stream<Term.Quad, ClientErrors.SparqlClientError>;
  /** Collects the triples of a `CONSTRUCT` / `DESCRIBE` query. */
  readonly constructDataset: (
    query: QueryInput,
    options?: QueryOptions,
  ) => Effect.Effect<Dataset.Dataset, ClientErrors.SparqlClientError>;
  /** Evaluates a query of any form, dispatching on the response media type. */
  readonly query: (
    query: QueryInput,
    options?: QueryOptions,
  ) => Effect.Effect<QueryResult, ClientErrors.SparqlClientError>;
  /** Executes an update request. */
  readonly update: (
    update: UpdateInput,
    options?: UpdateOptions,
  ) => Effect.Effect<void, ClientErrors.SparqlClientError>;
  /** Streams the triples of a graph (Graph Store `GET`). */
  readonly getGraph: (
    graph: GraphTarget,
    options?: RequestOptions,
  ) => Stream.Stream<Term.Quad, ClientErrors.SparqlClientError>;
  /** Fetches a graph as a `Dataset` (triples in the default graph). */
  readonly getGraphDataset: (
    graph: GraphTarget,
    options?: RequestOptions,
  ) => Effect.Effect<Dataset.Dataset, ClientErrors.SparqlClientError>;
  /** Whether a graph exists (Graph Store `HEAD`). */
  readonly hasGraph: (
    graph: GraphTarget,
    options?: RequestOptions,
  ) => Effect.Effect<boolean, ClientErrors.SparqlClientError>;
  /** Replaces a graph (Graph Store `PUT`). */
  readonly putGraph: (
    graph: GraphTarget,
    triples: Iterable<Term.Quad>,
    options?: UploadOptions,
  ) => Effect.Effect<void, ClientErrors.SparqlClientError>;
  /** Adds triples to a graph (Graph Store `POST`). */
  readonly postGraph: (
    graph: GraphTarget,
    triples: Iterable<Term.Quad>,
    options?: UploadOptions,
  ) => Effect.Effect<void, ClientErrors.SparqlClientError>;
  /** Creates a new graph in the graph store and returns its IRI. */
  readonly createGraph: (
    triples: Iterable<Term.Quad>,
    options?: UploadOptions,
  ) => Effect.Effect<Term.NamedNode, ClientErrors.SparqlClientError>;
  /** Deletes a graph (Graph Store `DELETE`). */
  readonly deleteGraph: (
    graph: GraphTarget,
    options?: RequestOptions,
  ) => Effect.Effect<void, ClientErrors.SparqlClientError>;
}

/**
 * The SPARQL client service.
 *
 * @since 0.1.0
 * @category services
 */
export class SparqlClient extends Context.Service<SparqlClient, SparqlClientShape>()(
  '@thomasfosterau/effect-rdf/sparql/SparqlClient',
) {}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * The default `Accept` header of `SELECT` / `ASK` requests.
 *
 * @since 0.1.0
 * @category constants
 */
export const DEFAULT_RESULTS_ACCEPT =
  'application/sparql-results+json, application/sparql-results+xml;q=0.9, text/tab-separated-values;q=0.8, text/csv;q=0.5';

/**
 * The SPARQL text of a query or update input.
 *
 * @since 0.1.0
 * @category utils
 */
export const toSparql = (input: QueryInput | UpdateInput): string =>
  Predicate.isString(input)
    ? input
    : input instanceof QueryBuilder.Builder
      ? input.toString()
      : Generator.print(input);

const iriOf = (g: GraphIri): string => (Predicate.isString(g) ? g : g.value);

/** The media type of a `Content-Type` value: what precedes its parameters. */
const essence = (contentType: string): string => (contentType.split(';', 1)[0] ?? '').trim();

const mediaTypeOf = (response: HttpClientResponse.HttpClientResponse): string =>
  essence(response.headers['content-type'] ?? '').toLowerCase();

const isResultsParseError = Predicate.isTagged('ResultsParseError');
const isRdfParseError = Predicate.isTagged('RdfParseError');
type EventOf<K extends ResultsStream.ResultEvent['_tag']> = Extract<
  ResultsStream.ResultEvent,
  { readonly _tag: K }
>;
const isVariablesEvent = (e: ResultsStream.ResultEvent): e is EventOf<'Variables'> =>
  Predicate.isTagged(e, 'Variables');
const isSolutionEvent = (e: ResultsStream.ResultEvent): e is EventOf<'Solution'> =>
  Predicate.isTagged(e, 'Solution');
const isBooleanEvent = (e: ResultsStream.ResultEvent): e is EventOf<'Boolean'> =>
  Predicate.isTagged(e, 'Boolean');

const MAX_ERROR_BODY = 64 * 1024;

/** What `selectAll` collects from the results events. */
interface SelectAccumulator {
  variables: ReadonlyArray<string>;
  bindings: Array<B.Bindings>;
  boolean: boolean;
}

const fromHttpClientError = (
  e: HttpClientError.HttpClientError,
): ClientErrors.SparqlClientError => {
  return Match.value(e.reason._tag).pipe(
    Match.when(
      Match.is('DecodeError', 'EmptyBodyError'),
      () => new ClientErrors.MalformedResponseError({ message: e.message, cause: e }),
    ),
    Match.orElse(() => new ClientErrors.TransportError({ message: e.message, cause: e })),
  );
};

const bodyText = (
  response: HttpClientResponse.HttpClientResponse,
): Stream.Stream<string, ClientErrors.SparqlClientError> =>
  Stream.decodeText(Stream.mapError(response.stream, fromHttpClientError));

// -----------------------------------------------------------------------------
// Constructor
// -----------------------------------------------------------------------------

const graphBase = (graph: GraphTarget, endpoint: string) =>
  graph === 'default' ? endpoint : graph.value;

/**
 * Builds a client from configuration, using the `HttpClient` from the context
 * and the `Serialization.Formats` service when provided (the default formats
 * otherwise).
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  config: Config,
): Effect.Effect<SparqlClientShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const formats = Option.getOrElse(
      yield* Effect.serviceOption(Serialization.Formats),
      () => ClientFormats.defaults,
    );
    const graphAccept = ClientFormats.acceptHeader(formats);
    const resultsAccept = config.resultsAccept ?? DEFAULT_RESULTS_ACCEPT;
    const anyAccept = `${resultsAccept}, ${graphAccept
      .split(', ')
      .map((t) => (t.includes(';q=') ? t : `${t};q=0.9`))
      .join(', ')}`;
    const maxGetLength = config.maxGetLength ?? 2048;
    const retryWhile = config.retryWhile ?? ClientErrors.isTransient;

    /** Sends a request: applies headers, timeout and retries, checks the status. */
    const send = (
      request: HttpClientRequest.HttpClientRequest,
      options?: RequestOptions,
      accept: ReadonlyArray<number> = [],
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, ClientErrors.SparqlClientError> => {
      const withHeaders = HttpClientRequest.setHeaders(request, {
        ...config.headers,
        ...options?.headers,
      });
      const timeout = options?.timeout ?? config.timeout;
      const attempt = http.execute(withHeaders).pipe(
        Effect.mapError(fromHttpClientError),
        Effect.filterOrElse(
          (response) =>
            (response.status >= 200 && response.status < 300) || accept.includes(response.status),
          (response) =>
            response.text.pipe(
              Effect.orElseSucceed(() => ''),
              Effect.flatMap((body) =>
                Effect.fail(
                  new ClientErrors.HttpStatusError({
                    method: withHeaders.method,
                    url: withHeaders.url,
                    status: response.status,
                    body: body.slice(0, MAX_ERROR_BODY),
                  }),
                ),
              ),
            ),
        ),
      );
      const timed =
        timeout === undefined
          ? attempt
          : Effect.timeoutOrElse(attempt, {
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  new ClientErrors.TimeoutError({
                    message: `${withHeaders.method} ${withHeaders.url} timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
                  }),
                ),
            });
      const retried =
        config.retry === undefined
          ? timed
          : Effect.retry(timed, { schedule: config.retry, while: retryWhile });
      return retried.pipe(
        Effect.withSpan('SparqlClient.request', {
          attributes: { 'http.method': withHeaders.method, 'http.url': withHeaders.url },
        }),
      );
    };

    const queryRequest = (
      query: QueryInput,
      accept: string,
      options?: QueryOptions,
    ): HttpClientRequest.HttpClientRequest => {
      const text = toSparql(query);
      const params: Array<[string, string]> = [
        ...(options?.defaultGraphs ?? []).map((g): [string, string] => [
          'default-graph-uri',
          iriOf(g),
        ]),
        ...(options?.namedGraphs ?? []).map((g): [string, string] => ['named-graph-uri', iriOf(g)]),
      ];
      const method = options?.method ?? config.method ?? 'auto';
      const getUrlLength =
        config.endpoint.length +
        7 +
        encodeURIComponent(text).length +
        params.reduce((n, [k, v]) => n + k.length + encodeURIComponent(v).length + 2, 0);
      const useGet = method === 'get' || (method === 'auto' && getUrlLength <= maxGetLength);
      const base = useGet
        ? HttpClientRequest.get(config.endpoint).pipe(
            HttpClientRequest.appendUrlParams([['query', text], ...params]),
          )
        : HttpClientRequest.post(config.endpoint).pipe(
            HttpClientRequest.appendUrlParams(params),
            HttpClientRequest.bodyText(text, 'application/sparql-query; charset=utf-8'),
          );
      return HttpClientRequest.setHeader(base, 'accept', accept);
    };

    const resultEvents = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<
      Stream.Stream<ResultsStream.ResultEvent, ClientErrors.SparqlClientError>,
      ClientErrors.SparqlClientError
    > => {
      const mediaType = mediaTypeOf(response);
      const parsed = ResultsStream.parse(mediaType, bodyText(response));
      if (Option.isNone(parsed)) {
        return Effect.fail(
          new ClientErrors.UnsupportedMediaTypeError({
            contentType: mediaType,
            expected: resultsAccept.split(',').map(essence),
          }),
        );
      }
      return Effect.succeed(
        Stream.mapError(parsed.value, (e) =>
          isResultsParseError(e)
            ? new ClientErrors.MalformedResponseError({
                message: `Invalid ${e.format} results: ${e.message}`,
                contentType: mediaType,
              })
            : e,
        ),
      );
    };

    const graphQuads = (
      response: HttpClientResponse.HttpClientResponse,
      baseIri: string,
    ): Effect.Effect<
      Stream.Stream<Term.Quad, ClientErrors.SparqlClientError>,
      ClientErrors.SparqlClientError
    > => {
      const mediaType = mediaTypeOf(response);
      const parser = Serialization.parserFor(formats, mediaType);
      if (Option.isNone(parser)) {
        return Effect.fail(
          new ClientErrors.UnsupportedMediaTypeError({
            contentType: mediaType,
            expected: formats.parsers.map((p) => p.format.mediaType),
          }),
        );
      }
      return Effect.succeed(
        parser.value.parseStream(bodyText(response), { baseIri }).pipe(
          Stream.mapError((e) =>
            isRdfParseError(e)
              ? new ClientErrors.MalformedResponseError({
                  message: Serialization.formatError(e),
                  contentType: mediaType,
                })
              : e,
          ),
          Stream.map((q) =>
            Term.isDefaultGraph(q.graph)
              ? q
              : new Term.Quad(q.subject, q.predicate, q.object, Term.defaultGraph),
          ),
        ),
      );
    };

    const results: SparqlClientShape['results'] = (query, options) =>
      Stream.unwrap(
        Effect.flatMap(send(queryRequest(query, resultsAccept, options), options), resultEvents),
      ).pipe(Stream.withSpan('SparqlClient.results'));

    const selectBindings: SparqlClientShape['selectBindings'] = (query, options) =>
      Stream.flatMap(results(query, options), (item) => {
        return Match.value(item).pipe(
          Match.tag('Solution', (event) => Stream.succeed(event.bindings)),
          Match.tag('Variables', () => Stream.empty),
          Match.tag('Boolean', () =>
            Stream.fail(
              new ClientErrors.MalformedResponseError({
                message: 'Expected solutions but received a boolean result',
              }),
            ),
          ),
          Match.exhaustive,
        );
      });

    // Both overloads of `select` are this one implementation over `QueryInput`.
    function select<R extends string, O extends string>(
      query: QueryBuilder.Builder<'Select', R, O>,
      options?: QueryOptions,
    ): Stream.Stream<QueryBuilder.Row<R, O>, ClientErrors.SparqlClientError>;
    function select(
      query: string | Ast.Query,
      options?: QueryOptions,
    ): Stream.Stream<Row, ClientErrors.SparqlClientError>;
    function select(
      query: QueryInput,
      options?: QueryOptions,
    ): Stream.Stream<Partial<Row>, ClientErrors.SparqlClientError> {
      return Stream.map(selectBindings(query, options), B.toRecord);
    }

    const selectAll: SparqlClientShape['selectAll'] = (query, options) =>
      Effect.map(
        Stream.runFold(
          results(query, options),
          (): SelectAccumulator => ({ variables: [], bindings: [], boolean: false }),
          (acc, event) => {
            if (isVariablesEvent(event)) acc.variables = event.variables;
            else if (isSolutionEvent(event)) acc.bindings.push(event.bindings);
            else acc.boolean = true;
            return acc;
          },
        ),
        (acc): Results.ResultSet => ({
          _tag: 'ResultSet',
          variables: acc.variables,
          bindings: acc.bindings,
        }),
      );

    const ask: SparqlClientShape['ask'] = (query, options) =>
      Effect.flatMap(
        Stream.runHead(Stream.filter(results(query, options), isBooleanEvent)),
        (event) =>
          Option.isSome(event)
            ? Effect.succeed(event.value.value)
            : Effect.fail(
                new ClientErrors.MalformedResponseError({ message: 'Expected a boolean result' }),
              ),
      ).pipe(Effect.withSpan('SparqlClient.ask'));

    const construct: SparqlClientShape['construct'] = (query, options) =>
      Stream.unwrap(
        Effect.flatMap(send(queryRequest(query, graphAccept, options), options), (response) =>
          graphQuads(response, config.endpoint),
        ),
      ).pipe(Stream.withSpan('SparqlClient.construct'));

    const constructDataset: SparqlClientShape['constructDataset'] = (query, options) =>
      Effect.map(Stream.runCollect(construct(query, options)), Dataset.fromIterable);

    const query: SparqlClientShape['query'] = (q, options) =>
      Effect.gen(function* () {
        const response = yield* send(queryRequest(q, anyAccept, options), options);
        const mediaType = mediaTypeOf(response);
        if (Option.isSome(ResultsStream.parserFor(mediaType))) {
          const events = yield* Stream.runCollect(yield* resultEvents(response));
          const boolean = Arr.findFirst(events, isBooleanEvent);
          if (Option.isSome(boolean)) {
            return { _tag: 'Boolean', value: boolean.value.value } as const;
          }
          return {
            _tag: 'ResultSet',
            variables: Option.match(Arr.findFirst(events, isVariablesEvent), {
              onNone: () => [],
              onSome: (e) => e.variables,
            }),
            bindings: Arr.filterMap(events, (e) =>
              isSolutionEvent(e) ? Result.succeed(e.bindings) : Result.failVoid,
            ),
          } as const;
        }
        const quads = yield* Stream.runCollect(yield* graphQuads(response, config.endpoint));
        return { _tag: 'Graph', dataset: Dataset.fromIterable(quads) } as const;
      }).pipe(Effect.withSpan('SparqlClient.query'));

    const update: SparqlClientShape['update'] = (u, options) => {
      const params: Array<[string, string]> = [
        ...(options?.usingGraphs ?? []).map((g): [string, string] => ['using-graph-uri', iriOf(g)]),
        ...(options?.usingNamedGraphs ?? []).map((g): [string, string] => [
          'using-named-graph-uri',
          iriOf(g),
        ]),
      ];
      const request = HttpClientRequest.post(config.updateEndpoint ?? config.endpoint).pipe(
        HttpClientRequest.appendUrlParams(params),
        HttpClientRequest.bodyText(toSparql(u), 'application/sparql-update; charset=utf-8'),
      );
      return Effect.flatMap(send(request, options), (response) =>
        Effect.mapError(Effect.asVoid(response.arrayBuffer), fromHttpClientError),
      ).pipe(Effect.withSpan('SparqlClient.update'));
    };

    // --- Graph Store -----------------------------------------------------------

    const graphStore = Effect.suspend(() =>
      config.graphStoreEndpoint === undefined
        ? Effect.fail(
            new ClientErrors.ConfigurationError({
              message: 'Graph Store operations need a graphStoreEndpoint',
            }),
          )
        : Effect.succeed(config.graphStoreEndpoint),
    );

    const graphRequest = (method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE', graph: GraphTarget) =>
      Effect.map(graphStore, (endpoint) =>
        HttpClientRequest.make(method)(endpoint).pipe(
          HttpClientRequest.appendUrlParams(
            graph === 'default' ? [['default', '']] : [['graph', graph.value]],
          ),
        ),
      );

    const getGraph: SparqlClientShape['getGraph'] = (graph, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const endpoint = yield* graphStore;
          const request = HttpClientRequest.setHeader(
            yield* graphRequest('GET', graph),
            'accept',
            graphAccept,
          );
          const response = yield* send(request, options);
          return yield* graphQuads(response, graphBase(graph, endpoint));
        }),
      ).pipe(Stream.withSpan('SparqlClient.getGraph'));

    const getGraphDataset: SparqlClientShape['getGraphDataset'] = (graph, options) =>
      Effect.map(Stream.runCollect(getGraph(graph, options)), Dataset.fromIterable);

    const hasGraph: SparqlClientShape['hasGraph'] = (graph, options) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.setHeader(
          yield* graphRequest('HEAD', graph),
          'accept',
          graphAccept,
        );
        const response = yield* send(request, options, [404]);
        return response.status !== 404;
      }).pipe(Effect.withSpan('SparqlClient.hasGraph'));

    const serialize = (triples: Iterable<Term.Quad>, mediaType: string) =>
      Effect.gen(function* () {
        const serializer = Serialization.serializerFor(formats, mediaType);
        if (Option.isNone(serializer)) {
          return yield* new ClientErrors.ConfigurationError({
            message: `No serializer for ${mediaType}`,
          });
        }
        const quads = Array.from(triples, (q) =>
          q.graph._tag === 'DefaultGraph'
            ? q
            : new Term.Quad(q.subject, q.predicate, q.object, Term.defaultGraph),
        );
        return yield* serializer.value
          .serialize(quads)
          .pipe(
            Effect.mapError(
              (e) =>
                new ClientErrors.ConfigurationError({ message: `Cannot serialise: ${e.message}` }),
            ),
          );
      });

    const upload = (
      method: 'PUT' | 'POST',
      graph: GraphTarget,
      triples: Iterable<Term.Quad>,
      options?: UploadOptions,
    ) =>
      Effect.gen(function* () {
        const mediaType = options?.mediaType ?? config.graphMediaType ?? 'application/n-triples';
        const body = yield* serialize(triples, mediaType);
        const request = HttpClientRequest.bodyText(
          yield* graphRequest(method, graph),
          body,
          `${mediaType}; charset=utf-8`,
        );
        const response = yield* send(request, options);
        yield* Effect.mapError(response.arrayBuffer, fromHttpClientError);
      });

    const putGraph: SparqlClientShape['putGraph'] = (graph, triples, options) =>
      upload('PUT', graph, triples, options).pipe(Effect.withSpan('SparqlClient.putGraph'));

    const postGraph: SparqlClientShape['postGraph'] = (graph, triples, options) =>
      upload('POST', graph, triples, options).pipe(Effect.withSpan('SparqlClient.postGraph'));

    const createGraph: SparqlClientShape['createGraph'] = (triples, options) =>
      Effect.gen(function* () {
        const endpoint = yield* graphStore;
        const mediaType = options?.mediaType ?? config.graphMediaType ?? 'application/n-triples';
        const body = yield* serialize(triples, mediaType);
        const response = yield* send(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.bodyText(body, `${mediaType}; charset=utf-8`),
          ),
          options,
        );
        yield* Effect.mapError(response.arrayBuffer, fromHttpClientError);
        const location = response.headers['location'];
        if (location === undefined) {
          return yield* new ClientErrors.MalformedResponseError({
            message: 'The graph store did not return a Location header',
          });
        }
        return Term.namedNode(new URL(location, endpoint).href);
      }).pipe(Effect.withSpan('SparqlClient.createGraph'));

    const deleteGraph: SparqlClientShape['deleteGraph'] = (graph, options) =>
      Effect.gen(function* () {
        const response = yield* send(yield* graphRequest('DELETE', graph), options);
        yield* Effect.mapError(response.arrayBuffer, fromHttpClientError);
      }).pipe(Effect.withSpan('SparqlClient.deleteGraph'));

    return SparqlClient.of({
      config,
      select,
      selectBindings,
      results,
      selectAll,
      ask,
      construct,
      describe: construct,
      constructDataset,
      query,
      update,
      getGraph,
      getGraphDataset,
      hasGraph,
      putGraph,
      postGraph,
      createGraph,
      deleteGraph,
    });
  });

/**
 * A layer providing the client (requires an `HttpClient`, e.g.
 * `FetchHttpClient.layer`).
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (config: Config): Layer.Layer<SparqlClient, never, HttpClient.HttpClient> =>
  Layer.effect(SparqlClient, make(config));

// -----------------------------------------------------------------------------
// Accessors
// -----------------------------------------------------------------------------

/**
 * The type of the {@link select} accessor: `SparqlClientShape['select']`
 * with the `SparqlClient` taken from the context.
 *
 * @since 0.1.0
 * @category accessors
 */
export interface SelectAccessor {
  <R extends string, O extends string>(
    query: QueryBuilder.Builder<'Select', R, O>,
    options?: QueryOptions,
  ): Stream.Stream<QueryBuilder.Row<R, O>, ClientErrors.SparqlClientError, SparqlClient>;
  (
    query: string | Ast.Query,
    options?: QueryOptions,
  ): Stream.Stream<Row, ClientErrors.SparqlClientError, SparqlClient>;
}

/**
 * Streams the rows of a `SELECT` query with the `SparqlClient` from the
 * context. Builder queries produce typed rows.
 *
 * @since 0.1.0
 * @category accessors
 */
export const select: SelectAccessor = (
  query: QueryBuilder.Builder<'Select', string, string> | string | Ast.Query,
  options?: QueryOptions,
) =>
  Stream.unwrap(
    Effect.map(Effect.service(SparqlClient), (c) =>
      !(query instanceof QueryBuilder.Builder)
        ? c.select(query, options)
        : c.select(query, options),
    ),
  );

/**
 * Streams the rows of a `SELECT` query decoded with a schema (whose fields
 * are typically `TermSchema` codecs).
 *
 * @since 0.1.0
 * @category accessors
 */
export const decode = <A, RD>(
  query: QueryInput,
  schema: Schema.Decoder<A, RD>,
  options?: QueryOptions,
): Stream.Stream<A, ClientErrors.SparqlClientError | Schema.SchemaError, SparqlClient | RD> =>
  Stream.mapEffect(
    Stream.unwrap(
      Effect.map(Effect.service(SparqlClient), (c) => c.selectBindings(query, options)),
    ),
    (b) => Schema.decodeEffect(schema)(B.toRecord(b)),
  );

/**
 * Evaluates an `ASK` query with the `SparqlClient` from the context.
 *
 * @since 0.1.0
 * @category accessors
 */
export const ask = (
  query: QueryInput,
  options?: QueryOptions,
): Effect.Effect<boolean, ClientErrors.SparqlClientError, SparqlClient> =>
  Effect.flatMap(Effect.service(SparqlClient), (c) => c.ask(query, options));

/**
 * Streams the triples of a `CONSTRUCT` / `DESCRIBE` query with the
 * `SparqlClient` from the context.
 *
 * @since 0.1.0
 * @category accessors
 */
export const construct = (
  query: QueryInput,
  options?: QueryOptions,
): Stream.Stream<Term.Quad, ClientErrors.SparqlClientError, SparqlClient> =>
  Stream.unwrap(Effect.map(Effect.service(SparqlClient), (c) => c.construct(query, options)));

/**
 * Executes an update with the `SparqlClient` from the context.
 *
 * @since 0.1.0
 * @category accessors
 */
export const update = (
  input: UpdateInput,
  options?: UpdateOptions,
): Effect.Effect<void, ClientErrors.SparqlClientError, SparqlClient> =>
  Effect.flatMap(Effect.service(SparqlClient), (c) => c.update(input, options));
