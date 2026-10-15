/**
 * In-process testing: an `HttpClient` whose requests are answered by an HTTP
 * app (such as `SparqlServer.handler`) without opening a socket.
 *
 * @since 0.1.0
 */
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as HttpClient from 'effect/http/HttpClient';
import type * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as SparqlServer from './SparqlServer.ts';
import type * as Options from './Options.ts';

/**
 * Builds an `HttpClient` that answers every request with `app` (whose
 * remaining requirements are already provided).
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromApp = (
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
): HttpClient.HttpClient =>
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.map(
      Effect.provideService(
        app,
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromClientRequest(request),
      ),
      (response) => HttpServerResponse.toClientResponse(response, { request }),
    ),
  );

/**
 * Routes requests to apps by URL origin (e.g. `http://example.org`), so that
 * several in-process servers can be reached through one client. Requests to
 * unknown origins are answered with `502 Bad Gateway`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromApps = (
  apps: Readonly<
    Record<
      string,
      Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        HttpServerRequest.HttpServerRequest
      >
    >
  >,
): HttpClient.HttpClient =>
  fromApp(
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      let origin: string | undefined;
      try {
        origin = new URL(request.originalUrl).origin;
      } catch {
        origin = undefined;
      }
      const app = origin === undefined ? undefined : apps[origin];
      return app ?? Effect.succeed(HttpServerResponse.text('Unknown host\n', { status: 502 }));
    }),
  );

/**
 * Builds an in-process client for `SparqlServer.handler(options)` using the
 * server's services from the context.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeClient = (
  options?: Options.Options,
): Effect.Effect<HttpClient.HttpClient, never, SparqlServer.Requirements> =>
  Effect.map(Effect.context<SparqlServer.Requirements>(), (context) =>
    fromApp(Effect.provideContext(SparqlServer.handler(options), context)),
  );

/**
 * A layer providing an in-process `HttpClient` talking to a server built
 * from the services in the context.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerClient = (
  options?: Options.Options,
): Layer.Layer<HttpClient.HttpClient, never, SparqlServer.Requirements> =>
  Layer.effect(HttpClient.HttpClient, makeClient(options));

/**
 * Provides an app with an already-built context of server services.
 *
 * @since 0.1.0
 * @category utils
 */
export const provideServices = (
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | SparqlServer.Requirements
  >,
  context: Context.Context<SparqlServer.Requirements>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> => Effect.provideContext(app, context) as any;
