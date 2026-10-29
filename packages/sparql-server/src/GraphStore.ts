/**
 * The SPARQL 1.1 Graph Store HTTP Protocol: `GET`, `HEAD`, `PUT`, `POST` and
 * `DELETE` on graphs identified indirectly (`?default`, `?graph=<iri>`) or
 * directly (the request URL is the graph IRI), and `POST` to the graph store
 * itself to create a new graph (`201 Created` with its IRI in `Location`).
 *
 * Request bodies are parsed with the `Serialization.Formats` parser for their
 * `Content-Type` (`multipart/form-data` bodies are parsed part by part);
 * responses are serialised with the negotiated serializer.
 *
 * @since 0.1.0
 */
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import * as Errors from './Errors.ts';
import * as Formats from './Formats.ts';
import * as Options from './Options.ts';
import * as Protocol from './Protocol.ts';

/**
 * The graph a Graph Store request operates on.
 *
 * @since 0.1.0
 * @category models
 */
export type Target =
  | { readonly _tag: 'Default' }
  | { readonly _tag: 'Named'; readonly graph: Term.NamedNode }
  /** The graph store itself (a `POST` creates a new graph). */
  | { readonly _tag: 'Store' };

/**
 * Determines the target graph of a request to the graph store whose root URL
 * is `root`.
 *
 * @since 0.1.0
 * @category decoding
 */
export const target = (url: URL, root: string): Effect.Effect<Target, Errors.ProtocolError> => {
  const params = Protocol.searchParams(url.href);
  const graphs = params.getAll('graph');
  const isDefault = params.has('default');
  if (isDefault && Arr.isReadonlyArrayNonEmpty(graphs)) {
    return Effect.fail(Errors.badRequest("A request cannot have both 'default' and 'graph'"));
  }
  if (graphs.length > 1) return Effect.fail(Errors.badRequest("Exactly one 'graph' is allowed"));
  if (isDefault) return Effect.succeed({ _tag: 'Default' });
  const graph = graphs[0];
  if (graph !== undefined) {
    const iri = Iri.resolve(graph, url.href);
    if (!Iri.isAbsolute(iri) || /[\s<>"{}|^`\\]/.test(iri)) {
      return Effect.fail(Errors.badRequest(`Invalid graph IRI: ${graph}`));
    }
    return Effect.succeed({ _tag: 'Named', graph: Term.namedNode(iri) });
  }
  const direct = new URL(url.href);
  direct.search = '';
  direct.hash = '';
  const rootUrl = new URL(root, url);
  if (Options.requestPath(direct.pathname) === Options.requestPath(rootUrl.pathname)) {
    return Effect.succeed({ _tag: 'Store' });
  }
  return Effect.succeed({ _tag: 'Named', graph: Term.namedNode(direct.href) });
};

const graphOf = (t: Target): Term.Graph => (t._tag === 'Named' ? t.graph : Term.defaultGraph);

const describeTarget = (t: Target): string =>
  t._tag === 'Named' ? `<${t.graph.value}>` : 'the default graph';

const storeError = (e: Store.StoreError) => Errors.internal(e.message);

const exists = (store: Store.QuadStoreShape, t: Target) =>
  t._tag === 'Named' ? Effect.mapError(store.hasGraph(t.graph), storeError) : Effect.succeed(true);

const charsetUtf8 = (mediaType: string) => `${mediaType}; charset=utf-8`;

const parseDocument = (
  formats: Serialization.Formats['Service'],
  contentType: string,
  text: string,
  baseIri: string,
): Effect.Effect<ReadonlyArray<Term.Quad>, Errors.ProtocolError> => {
  const ct = Protocol.parseContentType(contentType);
  if (ct === undefined) {
    return Effect.fail(Errors.unsupportedMediaType('Missing Content-Type'));
  }
  if (Protocol.isNonUtf8(ct)) {
    return Effect.fail(
      Errors.unsupportedMediaType(`Unsupported charset '${ct.parameters['charset']}'`),
    );
  }
  const parser = Serialization.parserFor(formats, ct.mediaType);
  if (Option.isNone(parser)) {
    return Effect.fail(
      Errors.unsupportedMediaType(
        `Unsupported Content-Type '${ct.mediaType}'; supported: ${formats.parsers.map((p) => p.format.mediaType).join(', ')}`,
      ),
    );
  }
  return parser.value.parse(text, { baseIri }).pipe(
    Effect.map((r) => Array.from(r.dataset)),
    Effect.mapError((e) => Errors.badRequest(Serialization.formatError(e))),
  );
};

const partContentType = (
  formats: Serialization.Formats['Service'],
  contentType: string,
  name: string,
): string => {
  const ct = Protocol.parseContentType(contentType);
  if (ct !== undefined && Option.isSome(Serialization.parserFor(formats, ct.mediaType))) {
    return contentType;
  }
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const parser = Serialization.parserForExtension(formats, name.slice(dot + 1));
    if (Option.isSome(parser)) return parser.value.format.mediaType;
  }
  return contentType;
};

const readQuads = (
  request: HttpServerRequest.HttpServerRequest,
  formats: Serialization.Formats['Service'],
  baseIri: string,
): Effect.Effect<ReadonlyArray<Term.Quad>, Errors.ProtocolError> =>
  Effect.gen(function* () {
    const contentType = request.headers['content-type'];
    const ct = Protocol.parseContentType(contentType);
    if (ct !== undefined && ct.mediaType === 'multipart/form-data') {
      const parts = yield* Stream.runCollect(request.multipartStream).pipe(
        Effect.mapError((e) => Errors.badRequest(`Invalid multipart body: ${e.message}`)),
      );
      const perPart = yield* Effect.forEach(
        parts,
        Effect.fnUntraced(function* (part) {
          if (part._tag === 'Field') {
            if (part.value.trim() === '') return [];
            return yield* parseDocument(
              formats,
              partContentType(formats, part.contentType, part.key),
              part.value,
              baseIri,
            );
          }
          if (part._tag === 'File') {
            const bytes = yield* part.contentEffect.pipe(
              Effect.mapError((e) => Errors.badRequest(`Invalid multipart body: ${e.message}`)),
            );
            return yield* parseDocument(
              formats,
              partContentType(formats, part.contentType, part.name),
              new TextDecoder().decode(bytes),
              baseIri,
            );
          }
          return [];
        }),
        { concurrency: 1 },
      );
      return perPart.flat();
    }
    const text = yield* Effect.mapError(request.text, (e) =>
      Errors.badRequest(`Could not read the request body: ${e.message}`),
    );
    if (contentType === undefined && text.trim() === '') return [];
    return yield* parseDocument(formats, contentType ?? '', text, baseIri);
  });

const intoGraph = (quads: ReadonlyArray<Term.Quad>, graph: Term.Graph): Array<Term.Quad> =>
  quads.map((q) => new Term.Quad(q.subject, q.predicate, q.object, graph));

/**
 * Handles a Graph Store Protocol request. `root` is the path of the graph
 * store.
 *
 * @since 0.1.0
 * @category handlers
 */
export const handle = (
  options: Options.Resolved,
  root: string,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Errors.ProtocolError,
  HttpServerRequest.HttpServerRequest | Store.QuadStore | Serialization.Formats
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const store = yield* Store.QuadStore;
    const formats = yield* Serialization.Formats;
    const url = Options.requestUrl(request, options);
    const t = yield* target(url, root);
    const method = request.method;
    const writes = ['PUT', 'POST', 'DELETE'];
    const allowed = options.readOnly
      ? ['GET', 'HEAD', 'OPTIONS']
      : t._tag === 'Store'
        ? ['POST', 'OPTIONS']
        : ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'OPTIONS'];
    if (options.readOnly && writes.includes(method)) {
      return yield* Errors.methodNotAllowed(method, allowed);
    }
    yield* Effect.annotateCurrentSpan({ 'sparql.graph': describeTarget(t) });

    return yield* Match.value(method).pipe(
      Match.when(Match.is('GET', 'HEAD'), () =>
        Effect.gen(function* () {
          if (t._tag === 'Store') {
            return yield* Errors.badRequest(
              "Identify a graph with '?default', '?graph=<iri>' or a URL below the graph store",
            );
          }
          if (!(yield* exists(store, t))) {
            return yield* Errors.notFound(`No such graph: ${describeTarget(t)}`);
          }
          const accept = request.headers['accept'];
          const serializer = Formats.negotiateSerializer(formats, accept);
          if (serializer === undefined) {
            return yield* Errors.notAcceptable(accept ?? '', Formats.serializerMediaTypes(formats));
          }
          const headers = { 'content-type': charsetUtf8(serializer.format.mediaType) };
          if (method === 'HEAD') return HttpServerResponse.empty({ status: 200, headers });
          const quads = Stream.map(
            store.match({ graph: graphOf(t) }),
            (q) => new Term.Quad(q.subject, q.predicate, q.object, Term.defaultGraph),
          );
          const body = serializer.serializeStream(quads, {
            prefixes: PrefixMap.make(options.prefixes),
          });
          return HttpServerResponse.stream(Stream.encodeText(body), {
            status: 200,
            headers,
            contentType: charsetUtf8(serializer.format.mediaType),
          });
        }),
      ),
      Match.when('PUT', () =>
        Effect.gen(function* () {
          if (t._tag === 'Store') return yield* Errors.methodNotAllowed(method, allowed);
          const base = t._tag === 'Named' ? t.graph.value : url.href;
          const quads = yield* readQuads(request, formats, base);
          const existed = t._tag === 'Named' ? yield* exists(store, t) : true;
          yield* store
            .transaction(
              Effect.gen(function* () {
                if (t._tag === 'Named') {
                  yield* store.dropGraph(t.graph);
                  yield* store.createGraph(t.graph);
                } else {
                  yield* store.clear(Term.defaultGraph);
                }
                yield* store.insert(intoGraph(quads, graphOf(t)));
              }),
            )
            .pipe(Effect.mapError(storeError));
          return HttpServerResponse.empty({ status: existed ? 204 : 201 });
        }),
      ),
      Match.when('POST', () =>
        Effect.gen(function* () {
          if (t._tag === 'Store') {
            const id = globalThis.crypto.randomUUID();
            const rootUrl = new URL(root, url);
            const graph = Term.namedNode(`${rootUrl.href.replace(/\/$/, '')}/${id}`);
            const quads = yield* readQuads(request, formats, graph.value);
            yield* store
              .transaction(
                Effect.andThen(store.createGraph(graph), store.insert(intoGraph(quads, graph))),
              )
              .pipe(Effect.mapError(storeError));
            return HttpServerResponse.empty({ status: 201, headers: { location: graph.value } });
          }
          const base = t._tag === 'Named' ? t.graph.value : url.href;
          const quads = yield* readQuads(request, formats, base);
          const existed = yield* exists(store, t);
          yield* store
            .transaction(
              Effect.gen(function* () {
                if (t._tag === 'Named' && !existed) yield* store.createGraph(t.graph);
                yield* store.insert(intoGraph(quads, graphOf(t)));
              }),
            )
            .pipe(Effect.mapError(storeError));
          return HttpServerResponse.empty({ status: existed ? 204 : 201 });
        }),
      ),
      Match.when('DELETE', () =>
        Effect.gen(function* () {
          if (t._tag === 'Store') return yield* Errors.methodNotAllowed(method, allowed);
          if (t._tag === 'Default') {
            yield* Effect.mapError(store.clear(Term.defaultGraph), storeError);
            return HttpServerResponse.empty({ status: 204 });
          }
          if (!(yield* exists(store, t))) {
            return yield* Errors.notFound(`No such graph: ${describeTarget(t)}`);
          }
          yield* Effect.mapError(store.dropGraph(t.graph), storeError);
          return HttpServerResponse.empty({ status: 204 });
        }),
      ),
      Match.orElse(() =>
        Effect.gen(function* () {
          return yield* Errors.methodNotAllowed(method, allowed);
        }),
      ),
    );
  }).pipe(Effect.withSpan('SparqlServer.graphStore'));
