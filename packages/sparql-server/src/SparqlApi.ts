/**
 * The SPARQL 1.1 Protocol and Graph Store HTTP Protocol as an Effect
 * `HttpApi` definition: the endpoints, their parameters, request media types,
 * response media types and error statuses, shared by the server
 * (`SparqlApiBuilder`), the derived client in
 * `@thomasfosterau/effect-sparql-client` and the OpenAPI document
 * (`openApi`).
 *
 * The API has two groups:
 *
 * - `sparql`: `query` (`GET` with `?query=`, or without it for the service
 *   description) and `post` (`POST` with an
 *   `application/x-www-form-urlencoded`, `application/sparql-query` or
 *   `application/sparql-update` body);
 * - `graphStore`: `get`, `head`, `put`, `post` and `delete` on the graph store
 *   with `?graph=<iri>` or `?default`, with RDF bodies under every media type
 *   of the default `Formats`.
 *
 * Content negotiation (`Accept`) and `405 Method Not Allowed` are not part of
 * the definition: the server's handlers negotiate with the same code as
 * `SparqlServer`, and `SparqlApiBuilder` answers the methods the API does not
 * declare. A request whose parameters the API's schemas reject (a repeated
 * `query` or `graph`, say) is handed to the protocol handler too, by the
 * `SchemaFallback` middleware, so it gets the protocol's own `400` and
 * message. Error bodies are `text/plain` messages decoded into
 * `Errors.ProtocolError`.
 *
 * This module only describes the API, so a client can import it without the
 * server. `effect/http-api` is `@stability unstable` in Effect 4, and this
 * definition follows it.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Schema from 'effect/Schema';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as HttpApi from 'effect/http-api/HttpApi';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import type * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as Engine from '@thomasfosterau/effect-sparql/Engine';
import * as Results from '@thomasfosterau/effect-sparql/Results';
import type * as Store from '@thomasfosterau/effect-sparql/Store';
import * as Errors from './Errors.ts';
import * as Formats from './Formats.ts';
import * as Protocol from './Protocol.ts';

// -----------------------------------------------------------------------------
// Media types
// -----------------------------------------------------------------------------

/**
 * The media types of the default RDF formats (`Formats.codecs`), in order of
 * preference: Graph Store bodies and `CONSTRUCT` / `DESCRIBE` / service
 * description responses.
 *
 * @since 0.1.0
 * @category media types
 */
export const rdfMediaTypes: ReadonlyArray<string> = Arr.dedupe(
  Arr.flatMap(Formats.codecs, (codec) => codec.format.mediaTypes),
);

/**
 * The media types of SPARQL results (`Results.codecs`): JSON, XML, CSV and
 * TSV, in order of preference.
 *
 * @since 0.1.0
 * @category media types
 */
export const resultsMediaTypes: ReadonlyArray<string> = Arr.dedupe(
  Arr.flatMap(Results.codecs, (codec) => codec.format.mediaTypes),
);

/**
 * Every media type a query response can have: the results formats for
 * `SELECT` / `ASK`, then the RDF formats for `CONSTRUCT` / `DESCRIBE` and the
 * service description.
 *
 * @since 0.1.0
 * @category media types
 */
export const queryMediaTypes: ReadonlyArray<string> = Arr.dedupe(
  Arr.appendAll(resultsMediaTypes, rdfMediaTypes),
);

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/**
 * A query response body: a byte stream under any of `queryMediaTypes`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const QueryResponse: HttpApiSchema.StreamUint8Array = HttpApiSchema.StreamUint8Array({
  contentType: queryMediaTypes,
});

/**
 * An RDF document response body: a byte stream under any of `rdfMediaTypes`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const RdfResponse: HttpApiSchema.StreamUint8Array = HttpApiSchema.StreamUint8Array({
  contentType: rdfMediaTypes,
});

const iris = Schema.optionalKey(Schema.Array(Schema.String));

/**
 * The `Accept` request header, which selects the response format.
 *
 * @since 0.1.0
 * @category schemas
 */
export const AcceptHeader = Schema.Struct({ accept: Schema.optionalKey(Schema.String) });

/**
 * The decoded type of `AcceptHeader`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type AcceptHeader = typeof AcceptHeader.Type;

/**
 * The query string of a query: the query and its protocol dataset.
 *
 * @since 0.1.0
 * @category schemas
 */
export const QueryParams = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  'default-graph-uri': iris,
  'named-graph-uri': iris,
});

/**
 * The decoded type of `QueryParams`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type QueryParams = typeof QueryParams.Type;

/**
 * The query string of a `POST`: the protocol dataset of a query
 * (`default-graph-uri` / `named-graph-uri`) or of an update
 * (`using-graph-uri` / `using-named-graph-uri`).
 *
 * @since 0.1.0
 * @category schemas
 */
export const DatasetParams = Schema.Struct({
  'default-graph-uri': iris,
  'named-graph-uri': iris,
  'using-graph-uri': iris,
  'using-named-graph-uri': iris,
});

/**
 * The decoded type of `DatasetParams`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type DatasetParams = typeof DatasetParams.Type;

/**
 * An `application/x-www-form-urlencoded` `POST` body holding a `query` or an
 * `update` and its protocol dataset.
 *
 * @since 0.1.0
 * @category schemas
 */
export const FormBody = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  update: Schema.optionalKey(Schema.String),
  'default-graph-uri': iris,
  'named-graph-uri': iris,
  'using-graph-uri': iris,
  'using-named-graph-uri': iris,
}).pipe(HttpApiSchema.asFormUrlEncoded());

/**
 * The decoded type of `FormBody`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type FormBody = typeof FormBody.Type;

/**
 * An `application/sparql-query` `POST` body, decoded as
 * `{ _tag: 'DirectQuery', query }`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const DirectQueryBody = Schema.String.pipe(
  Schema.decodeTo(
    Schema.TaggedStruct('DirectQuery', { query: Schema.String }),
    SchemaTransformation.transform({
      decode: (query) => ({ _tag: 'DirectQuery' as const, query }),
      encode: (body) => body.query,
    }),
  ),
  HttpApiSchema.asText({ contentType: Protocol.SPARQL_QUERY }),
);

/**
 * The decoded type of `DirectQueryBody`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type DirectQueryBody = typeof DirectQueryBody.Type;

/**
 * An `application/sparql-update` `POST` body, decoded as
 * `{ _tag: 'DirectUpdate', update }`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const DirectUpdateBody = Schema.String.pipe(
  Schema.decodeTo(
    Schema.TaggedStruct('DirectUpdate', { update: Schema.String }),
    SchemaTransformation.transform({
      decode: (update) => ({ _tag: 'DirectUpdate' as const, update }),
      encode: (body) => body.update,
    }),
  ),
  HttpApiSchema.asText({ contentType: Protocol.SPARQL_UPDATE }),
);

/**
 * The decoded type of `DirectUpdateBody`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type DirectUpdateBody = typeof DirectUpdateBody.Type;

const rdfDocument = (mediaType: string) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Struct({ mediaType: Schema.Literal(mediaType), document: Schema.String }),
      SchemaTransformation.transform({
        decode: (document) => ({ mediaType, document }),
        encode: (body) => body.document,
      }),
    ),
    HttpApiSchema.asText({ contentType: mediaType }),
  );

/**
 * Graph Store request bodies: an RDF document under one of `rdfMediaTypes`,
 * decoded as `{ mediaType, document }` (the media type selects the request's
 * `Content-Type`).
 *
 * @since 0.1.0
 * @category schemas
 */
export const RdfDocumentBody = Arr.map(rdfMediaTypes, rdfDocument);

/**
 * The query string of a Graph Store request: `graph=<iri>` (indirect
 * identification) or `default` (the default graph).
 *
 * @since 0.1.0
 * @category schemas
 */
export const GraphParams = Schema.Struct({
  graph: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.String),
});

/**
 * The decoded type of `GraphParams`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type GraphParams = typeof GraphParams.Type;

/**
 * The error response of a status: a `text/plain` message, decoded as an
 * `Errors.ProtocolError` with that status.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ProtocolErrorResponse = (status: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Errors.ProtocolError.pipe(
        Schema.check(
          Schema.makeFilter((error: Errors.ProtocolError) => error.status === status, {
            identifier: `ProtocolError${status}`,
            title: `ProtocolError (${status})`,
            description: `A protocol error with status ${status}`,
          }),
        ),
      ),
      SchemaTransformation.transform({
        decode: (message) => ({
          _tag: 'ProtocolError' as const,
          status,
          message: message.trimEnd(),
        }),
        encode: (error) => `${error.message}\n`,
      }),
    ),
    HttpApiSchema.asText({ contentType: 'text/plain' }),
    HttpApiSchema.status(status),
  );

const BadRequest = ProtocolErrorResponse(400);
const Forbidden = ProtocolErrorResponse(403);
const NotFound = ProtocolErrorResponse(404);
const MethodNotAllowed = ProtocolErrorResponse(405);
const NotAcceptable = ProtocolErrorResponse(406);
const UnsupportedMediaType = ProtocolErrorResponse(415);
const InternalServerError = ProtocolErrorResponse(500);
const ServiceUnavailable = ProtocolErrorResponse(503);

// -----------------------------------------------------------------------------
// The API
// -----------------------------------------------------------------------------

/**
 * Middleware on every endpoint that answers a request whose parameters or
 * headers fail the API's schemas with the protocol handler instead of an
 * empty `400` (see `SparqlApiBuilder.layerSchemaFallback`). It needs the
 * server's services and nothing on the client side.
 *
 * @since 0.1.0
 * @category middleware
 */
export class SchemaFallback extends HttpApiMiddleware.Service<
  SchemaFallback,
  { requires: Engine.SparqlEngine | Store.QuadStore | Serialization.Formats }
>()('@thomasfosterau/effect-sparql-server/SparqlApi/SchemaFallback') {}

/**
 * The paths an API is served at.
 *
 * @since 0.1.0
 * @category models
 */
export interface Paths {
  /** The SPARQL endpoint, for queries and updates (default `/sparql`). */
  readonly path?: `/${string}` | undefined;
  /** The Graph Store endpoint (default `/rdf-graph-store`). */
  readonly graphStorePath?: `/${string}` | undefined;
}

const sparqlGroup = (path: `/${string}`) =>
  HttpApiGroup.make('sparql')
    .add(
      HttpApiEndpoint.get('query', path, {
        query: QueryParams,
        headers: AcceptHeader,
        success: QueryResponse,
        error: [BadRequest, NotAcceptable, InternalServerError, ServiceUnavailable],
      }).annotateMerge(
        OpenApi.annotations({
          summary: 'Query, or read the service description',
          description:
            'A SPARQL query in `query`, with its dataset in `default-graph-uri` / `named-graph-uri`. Without `query`, answers the service description. The response format is negotiated from `Accept`.',
        }),
      ),
      HttpApiEndpoint.post('post', path, {
        query: DatasetParams,
        headers: AcceptHeader,
        payload: [DirectQueryBody, DirectUpdateBody, FormBody],
        success: [QueryResponse, HttpApiSchema.NoContent],
        error: [
          BadRequest,
          Forbidden,
          NotAcceptable,
          UnsupportedMediaType,
          InternalServerError,
          ServiceUnavailable,
        ],
      }).annotateMerge(
        OpenApi.annotations({
          summary: 'Query or update',
          description:
            'A query (`200` with the results) or an update (`204`), as a form or as an `application/sparql-query` / `application/sparql-update` body. A read-only endpoint answers updates with `403`.',
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: 'SPARQL', description: 'The SPARQL 1.1 Protocol' }),
    );

const writeErrors = [
  BadRequest,
  NotFound,
  MethodNotAllowed,
  UnsupportedMediaType,
  InternalServerError,
] as const;

const graphStoreGroup = (path: `/${string}`) =>
  HttpApiGroup.make('graphStore')
    .add(
      HttpApiEndpoint.get('get', path, {
        query: GraphParams,
        headers: AcceptHeader,
        success: RdfResponse,
        error: [BadRequest, NotFound, NotAcceptable, InternalServerError],
      }).annotateMerge(OpenApi.annotations({ summary: 'Read a graph' })),
      HttpApiEndpoint.head('head', path, {
        query: GraphParams,
        headers: AcceptHeader,
        success: HttpApiSchema.Empty(200),
        error: [BadRequest, NotFound, NotAcceptable, InternalServerError],
      }).annotateMerge(OpenApi.annotations({ summary: 'Check that a graph exists' })),
      HttpApiEndpoint.put('put', path, {
        query: GraphParams,
        payload: RdfDocumentBody,
        success: [HttpApiSchema.NoContent, HttpApiSchema.Created],
        error: writeErrors,
      }).annotateMerge(
        OpenApi.annotations({
          summary: 'Replace a graph',
          description: '`201` when the graph is new, `204` when it existed.',
        }),
      ),
      HttpApiEndpoint.post('post', path, {
        query: GraphParams,
        payload: RdfDocumentBody,
        success: [HttpApiSchema.NoContent, HttpApiSchema.Created],
        error: writeErrors,
      }).annotateMerge(
        OpenApi.annotations({
          summary: 'Add to a graph, or create one',
          description:
            'Merges the document into the graph (`201` when it is new). Without `graph` or `default`, creates a new graph and answers `201` with its IRI in `Location`.',
        }),
      ),
      HttpApiEndpoint.delete('delete', path, {
        query: GraphParams,
        success: HttpApiSchema.NoContent,
        error: [BadRequest, NotFound, MethodNotAllowed, InternalServerError],
      }).annotateMerge(OpenApi.annotations({ summary: 'Delete a graph' })),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: 'Graph Store',
        description:
          'The SPARQL 1.1 Graph Store HTTP Protocol (indirect identification; URLs below the graph store identify graphs directly)',
      }),
    );

/**
 * Builds the API at the given paths.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (paths?: Paths) =>
  HttpApi.make('effect-sparql')
    .add(sparqlGroup(paths?.path ?? '/sparql'))
    .add(graphStoreGroup(paths?.graphStorePath ?? '/rdf-graph-store'))
    .middleware(SchemaFallback)
    .annotateMerge(
      OpenApi.annotations({
        title: 'SPARQL 1.1 Protocol and Graph Store HTTP Protocol',
        description:
          'Every response format is negotiated from `Accept`; methods an endpoint does not support are answered with `405` and `Allow`.',
      }),
    );

/**
 * The type of an API built by `make`.
 *
 * @since 0.1.0
 * @category models
 */
export type Api = ReturnType<typeof make>;

/**
 * The API at the default paths, `/sparql` and `/rdf-graph-store`.
 *
 * @since 0.1.0
 * @category api
 */
export const SparqlApi: Api = make();

/**
 * The OpenAPI document of an API (the default one when omitted).
 *
 * @since 0.1.0
 * @category openapi
 */
export const openApi = (api: Api = SparqlApi): OpenApi.OpenAPISpec => OpenApi.fromApi(api);
