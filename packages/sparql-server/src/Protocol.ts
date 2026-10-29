/**
 * Decoding of SPARQL 1.1 Protocol requests.
 *
 * A request to the SPARQL endpoint is one of
 *
 * - a query: `GET` with a `query` parameter, `POST` with an
 *   `application/x-www-form-urlencoded` body holding `query`, or `POST` with
 *   an `application/sparql-query` body;
 * - an update: `POST` with an `application/x-www-form-urlencoded` body
 *   holding `update`, or `POST` with an `application/sparql-update` body;
 * - a service description request: `GET` without `query`.
 *
 * The dataset parameters (`default-graph-uri` / `named-graph-uri` for
 * queries, `using-graph-uri` / `using-named-graph-uri` for updates) come from
 * the URL query string, and also from the body of a form request.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Store from '@thomasfosterau/effect-sparql/Store';
import * as Errors from './Errors.ts';

/**
 * The media type of a direct `POST` query body.
 *
 * @since 0.1.0
 * @category media types
 */
export const SPARQL_QUERY = 'application/sparql-query';

/**
 * The media type of a direct `POST` update body.
 *
 * @since 0.1.0
 * @category media types
 */
export const SPARQL_UPDATE = 'application/sparql-update';

/**
 * The media type of form-encoded requests.
 *
 * @since 0.1.0
 * @category media types
 */
export const FORM = 'application/x-www-form-urlencoded';

/**
 * A decoded protocol operation.
 *
 * @since 0.1.0
 * @category models
 */
export type Operation =
  | {
      readonly _tag: 'Query';
      readonly query: string;
      /** The protocol dataset (`default-graph-uri` / `named-graph-uri`), if any. */
      readonly dataset: Store.DatasetSpec | undefined;
    }
  | {
      readonly _tag: 'Update';
      readonly update: string;
      /** The protocol dataset (`using-graph-uri` / `using-named-graph-uri`), if any. */
      readonly using: Store.DatasetSpec | undefined;
    }
  | { readonly _tag: 'ServiceDescription' };

/**
 * A parsed `Content-Type` header.
 *
 * @since 0.1.0
 * @category models
 */
export interface ContentType {
  readonly mediaType: string;
  readonly parameters: Readonly<Record<string, string>>;
}

/**
 * Parses a `Content-Type` header (media type lower-cased, parameter names
 * lower-cased, quotes removed).
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseContentType = (header: string | undefined): ContentType | undefined => {
  if (header === undefined || header.trim() === '') return undefined;
  const [type, ...params] = header.split(';');
  const parameters: Record<string, string> = {};
  for (const p of params) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let value = p.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    parameters[key] = value;
  }
  return { mediaType: (type ?? '').trim().toLowerCase(), parameters };
};

/**
 * Whether a content type declares a charset other than UTF-8.
 *
 * @since 0.1.0
 * @category parsing
 */
export const isNonUtf8 = (contentType: ContentType): boolean => {
  const charset = contentType.parameters['charset'];
  return charset !== undefined && !/^utf-?8$/i.test(charset);
};

/**
 * The query string parameters of a request URL.
 *
 * @since 0.1.0
 * @category parsing
 */
export const searchParams = (url: string): URLSearchParams => {
  const q = url.indexOf('?');
  if (q < 0) return new URLSearchParams();
  const hash = url.indexOf('#', q);
  return new URLSearchParams(url.slice(q + 1, hash < 0 ? undefined : hash));
};

const graphList = (
  values: ReadonlyArray<string>,
  baseIri: string,
): Effect.Effect<Array<Term.NamedNode>, Errors.ProtocolError> =>
  Effect.forEach(
    values,
    (value) => {
      const iri = Iri.resolve(value, baseIri);
      return Iri.isAbsolute(iri) && !/[\s<>"{}|^`\\]/.test(iri)
        ? Effect.succeed(Term.namedNode(iri))
        : Effect.fail(Errors.badRequest(`Invalid graph IRI: ${value}`));
    },
    { concurrency: 1 },
  );

/**
 * Builds the dataset described by protocol parameters (`undefined` when no
 * parameter is present). When only named graphs are given the default graph
 * is empty, as for `FROM NAMED` in a query.
 *
 * @since 0.1.0
 * @category parsing
 */
export const datasetFromParams = (
  params: URLSearchParams,
  defaultName: string,
  namedName: string,
  baseIri: string,
): Effect.Effect<Store.DatasetSpec | undefined, Errors.ProtocolError> =>
  Effect.gen(function* () {
    const defaults = params.getAll(defaultName);
    const named = params.getAll(namedName);
    if (Arr.isReadonlyArrayEmpty(defaults) && Arr.isReadonlyArrayEmpty(named)) return undefined;
    return {
      defaultGraph: yield* graphList(defaults, baseIri),
      namedGraphs: yield* graphList(named, baseIri),
    };
  });

const merge = (a: URLSearchParams, b: URLSearchParams): URLSearchParams => {
  const out = new URLSearchParams(a);
  for (const [k, v] of b) out.append(k, v);
  return out;
};

const single = (
  params: URLSearchParams,
  name: string,
): Effect.Effect<string | undefined, Errors.ProtocolError> => {
  const values = params.getAll(name);
  if (values.length > 1) {
    return Effect.fail(Errors.badRequest(`Exactly one '${name}' parameter is allowed`));
  }
  return Effect.succeed(values[0]);
};

const readBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<string, Errors.ProtocolError> =>
  Effect.mapError(request.text, (e) =>
    Errors.badRequest(`Could not read the request body: ${e.message}`),
  );

/**
 * What a SPARQL endpoint accepts.
 *
 * @since 0.1.0
 * @category models
 */
export interface EndpointKind {
  readonly query: boolean;
  readonly update: boolean;
}

const fromParams = (
  params: URLSearchParams,
  kind: EndpointKind,
  method: string,
  baseIri: string,
): Effect.Effect<Operation, Errors.ProtocolError> =>
  Effect.gen(function* () {
    const query = yield* single(params, 'query');
    const update = yield* single(params, 'update');
    if (query !== undefined && update !== undefined) {
      return yield* Errors.badRequest("A request cannot have both 'query' and 'update'");
    }
    if (update !== undefined) {
      if (method !== 'POST') {
        return yield* Errors.badRequest('Updates must be sent with POST');
      }
      if (!kind.update) return yield* Errors.badRequest('This endpoint does not accept updates');
      const using = yield* datasetFromParams(
        params,
        'using-graph-uri',
        'using-named-graph-uri',
        baseIri,
      );
      return { _tag: 'Update', update, using } as const;
    }
    if (query !== undefined) {
      if (!kind.query) return yield* Errors.badRequest('This endpoint does not accept queries');
      const dataset = yield* datasetFromParams(
        params,
        'default-graph-uri',
        'named-graph-uri',
        baseIri,
      );
      return { _tag: 'Query', query, dataset } as const;
    }
    if (method === 'GET' || method === 'HEAD') return { _tag: 'ServiceDescription' } as const;
    return yield* Errors.badRequest("Missing 'query' or 'update' parameter");
  });

/**
 * Decodes a request to the SPARQL endpoint. `baseIri` resolves relative
 * graph IRIs in the dataset parameters.
 *
 * @since 0.1.0
 * @category decoding
 */
export const decode = (
  request: HttpServerRequest.HttpServerRequest,
  kind: EndpointKind,
  baseIri: string,
): Effect.Effect<Operation, Errors.ProtocolError> =>
  Effect.gen(function* () {
    const method = request.method;
    const urlParams = searchParams(request.url);
    if (method === 'GET' || method === 'HEAD') {
      return yield* fromParams(urlParams, kind, method, baseIri);
    }
    if (method !== 'POST') {
      return yield* Errors.methodNotAllowed(method, ['GET', 'POST']);
    }
    const contentType = parseContentType(request.headers['content-type']);
    if (contentType === undefined) {
      return yield* Errors.unsupportedMediaType(
        `A POST request needs a Content-Type of ${FORM}, ${SPARQL_QUERY} or ${SPARQL_UPDATE}`,
      );
    }
    if (isNonUtf8(contentType)) {
      return yield* Errors.unsupportedMediaType(
        `Unsupported charset '${contentType.parameters['charset']}' (only UTF-8 is accepted)`,
      );
    }
    switch (contentType.mediaType) {
      case FORM: {
        const body = yield* readBody(request);
        return yield* fromParams(
          merge(urlParams, new URLSearchParams(body)),
          kind,
          method,
          baseIri,
        );
      }
      case SPARQL_QUERY: {
        if (!kind.query) {
          return yield* Errors.unsupportedMediaType('This endpoint does not accept queries');
        }
        if (urlParams.has('query') || urlParams.has('update')) {
          return yield* Errors.badRequest(
            `A ${SPARQL_QUERY} request cannot also have a 'query' or 'update' parameter`,
          );
        }
        const query = yield* readBody(request);
        const dataset = yield* datasetFromParams(
          urlParams,
          'default-graph-uri',
          'named-graph-uri',
          baseIri,
        );
        return { _tag: 'Query', query, dataset } as const;
      }
      case SPARQL_UPDATE: {
        if (!kind.update) {
          return yield* Errors.unsupportedMediaType('This endpoint does not accept updates');
        }
        if (urlParams.has('query') || urlParams.has('update')) {
          return yield* Errors.badRequest(
            `A ${SPARQL_UPDATE} request cannot also have a 'query' or 'update' parameter`,
          );
        }
        const update = yield* readBody(request);
        const using = yield* datasetFromParams(
          urlParams,
          'using-graph-uri',
          'using-named-graph-uri',
          baseIri,
        );
        return { _tag: 'Update', update, using } as const;
      }
      default:
        return yield* Errors.unsupportedMediaType(
          `Unsupported Content-Type '${contentType.mediaType}'; expected ${FORM}, ${SPARQL_QUERY} or ${SPARQL_UPDATE}`,
        );
    }
  });
