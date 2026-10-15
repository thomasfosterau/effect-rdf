/**
 * Federation for the in-memory SPARQL engine: an `Engine.ServiceHandler`
 * that evaluates `SERVICE <endpoint> { … }` patterns remotely with the
 * SPARQL client, and an `Engine.Loader` that fetches documents for `LOAD`.
 *
 * ```ts
 * const EngineLive = Federation.layerEngine().pipe(
 *   Layer.provide(Store.layerMemory(data)),
 *   Layer.provide(FetchHttpClient.layer),
 * );
 * ```
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Engine from '@thomasfosterau/effect-sparql/Engine';
import { EvaluationError, UpdateError } from '@thomasfosterau/effect-sparql/Errors';
import * as Generator from '@thomasfosterau/effect-sparql/Generator';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import type * as Errors from './Errors.ts';
import * as Formats from './Formats.ts';
import * as SparqlClient from './SparqlClient.ts';

/**
 * Client settings used for remote endpoints (everything but the endpoint
 * URLs).
 *
 * @since 0.1.0
 * @category models
 */
export type RemoteConfig = Omit<
  SparqlClient.Config,
  'endpoint' | 'updateEndpoint' | 'graphStoreEndpoint'
>;

/**
 * The query sent to a remote endpoint for a `SERVICE` pattern:
 * `SELECT * WHERE { … }` with the prefixes of the original query.
 *
 * @since 0.1.0
 * @category federation
 */
export const serviceQuery = (service: Parameters<Engine.ServiceHandler>[1]): string => {
  const prologue = Object.entries(service.prefixes)
    .map(([prefix, iri]) => `PREFIX ${prefix}: <${iri}>\n`)
    .join('');
  return `${prologue}SELECT * WHERE ${Generator.printPattern(service.pattern, service.prefixes)}`;
};

const describeError = (e: Errors.SparqlClientError): string =>
  e._tag === 'HttpStatusError' ? e.message : `${e._tag}: ${e.message}`;

/**
 * Builds a `SERVICE` handler that sends each remote pattern to its endpoint
 * with the `HttpClient` from the context. Clients are cached per endpoint.
 *
 * @since 0.1.0
 * @category federation
 */
export const serviceHandler = (
  config: RemoteConfig = {},
): Effect.Effect<Engine.ServiceHandler, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    const clients = new Map<string, SparqlClient.SparqlClientShape>();
    const clientFor = (endpoint: Term.NamedNode) =>
      Effect.suspend(() => {
        const cached = clients.get(endpoint.value);
        if (cached !== undefined) return Effect.succeed(cached);
        return Effect.tap(
          Effect.provideContext(
            SparqlClient.make({ ...config, endpoint: endpoint.value }),
            context,
          ),
          (client) => Effect.sync(() => clients.set(endpoint.value, client)),
        );
      });
    return (endpoint, service) =>
      Stream.unwrap(
        Effect.map(clientFor(endpoint), (client) =>
          client.selectBindings(serviceQuery(service)).pipe(
            Stream.mapError(
              (e) =>
                new EvaluationError({
                  message: `SERVICE <${endpoint.value}> failed: ${describeError(e)}`,
                  cause: e,
                }),
            ),
          ),
        ),
      ).pipe(Stream.withSpan('Federation.service', { attributes: { endpoint: endpoint.value } }));
  });

/**
 * Builds a `LOAD` handler that fetches documents over HTTP and parses them
 * with the `Serialization.Formats` service (or the default formats), by
 * media type or, failing that, by file extension.
 *
 * @since 0.1.0
 * @category federation
 */
export const loader = (
  config: Pick<RemoteConfig, 'headers' | 'timeout'> = {},
): Effect.Effect<Engine.Loader, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const formats = Option.getOrElse(
      yield* Effect.serviceOption(Serialization.Formats),
      () => Formats.defaults,
    );
    const accept = Formats.acceptHeader(formats);
    const fail = (iri: Term.NamedNode, message: string, cause?: unknown) =>
      new UpdateError({ message: `LOAD <${iri.value}> failed: ${message}`, cause });
    return (iri: Term.NamedNode) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.get(iri.value, {
          headers: { ...config.headers, accept },
        });
        const exchange = Effect.flatMap(http.execute(request), (response) =>
          Effect.map(response.text, (text) => ({ response, text })),
        );
        const { response, text } = yield* (
          config.timeout === undefined
            ? exchange
            : Effect.timeoutOrElse(exchange, {
                duration: config.timeout,
                orElse: () => Effect.fail(fail(iri, 'timed out')),
              })
        ).pipe(Effect.mapError((e) => (e._tag === 'UpdateError' ? e : fail(iri, e.message, e))));
        if (response.status < 200 || response.status >= 300) {
          return yield* fail(iri, `status ${response.status}`);
        }
        const mediaType = (response.headers['content-type'] ?? '').split(';')[0]!.trim();
        const byType = Serialization.parserFor(formats, mediaType);
        const extension = new URL(iri.value).pathname.replace(/^.*\./, '');
        const parser = Option.isSome(byType)
          ? byType
          : Serialization.parserForExtension(formats, extension);
        if (Option.isNone(parser)) {
          return yield* fail(iri, `unsupported media type '${mediaType}'`);
        }
        const parsed = yield* parser.value
          .parse(text, { baseIri: iri.value })
          .pipe(Effect.mapError((e) => fail(iri, Serialization.formatError(e), e)));
        return parsed.dataset;
      }).pipe(Effect.withSpan('Federation.load', { attributes: { iri: iri.value } }));
  });

/**
 * A `SparqlEngine` layer whose `SERVICE` patterns are evaluated remotely and
 * whose `LOAD` fetches documents over HTTP.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerEngine = (
  options: Engine.EngineOptions = {},
  config: RemoteConfig = {},
): Layer.Layer<Engine.SparqlEngine, never, Store.QuadStore | HttpClient.HttpClient> =>
  Layer.effect(
    Engine.SparqlEngine,
    Effect.gen(function* () {
      const store = yield* Store.QuadStore;
      const service = yield* serviceHandler(config);
      const load = yield* loader(config);
      return Engine.make(store, {
        ...options,
        service: options.service ?? service,
        load: options.load ?? load,
      });
    }),
  );
