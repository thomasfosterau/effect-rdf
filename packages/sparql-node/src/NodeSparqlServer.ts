/**
 * The SPARQL 1.1 Protocol and Graph Store HTTP Protocol server of
 * `@thomasfosterau/effect-rdf/sparql` (`SparqlServer`) on a Node
 * `node:http` server, through `@effect/platform-node`'s `NodeHttpServer`.
 *
 * `SparqlServer` itself is platform-neutral (`handler`, `layerRoutes`,
 * `layerServe`); this module adds the listening socket.
 *
 * @since 0.1.0
 */
import { createServer } from 'node:http';
import * as Layer from 'effect/Layer';
import type * as HttpServer from 'effect/http/HttpServer';
import type * as HttpServerError from 'effect/http/HttpServerError';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import type * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import type * as Engine from '@thomasfosterau/effect-rdf/sparql/Engine';
import type * as Options from '@thomasfosterau/effect-rdf/sparql/Options';
import * as SparqlServer from '@thomasfosterau/effect-rdf/sparql/SparqlServer';

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
): Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError, SparqlServer.Requirements> => {
  const { port, host, ...rest } = options;
  // SAFETY: providing the Node HTTP server leaves `HttpServer` and `SparqlServer.Requirements`; the cast
  // restates the layer type.
  return SparqlServer.layerServe(rest).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, host === undefined ? { port } : { port, host }),
    ),
  );
};

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
  }).pipe(Layer.provide(SparqlServer.layerMemoryServices(data, engine)));
};
