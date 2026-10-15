/**
 * Error handling against a mocked `HttpClient`.
 */
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schedule from 'effect/Schedule';
import * as Stream from 'effect/Stream';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientError from 'effect/http/HttpClientError';
import type * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Errors from '../src/Errors.ts';
import * as SparqlClient from '../src/SparqlClient.ts';

const ENDPOINT = 'http://mock.test/sparql';

type Handler = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const respond =
  (body: string, init: { status?: number; contentType?: string } = {}): Handler =>
  (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: init.status ?? 200,
          headers: init.contentType === undefined ? {} : { 'content-type': init.contentType },
        }),
      ),
    );

const withMock = <A, E>(
  handler: Handler,
  effect: Effect.Effect<A, E, SparqlClient.SparqlClient>,
  config: Partial<SparqlClient.Config> = {},
) =>
  Effect.provide(
    effect,
    SparqlClient.layer({
      endpoint: ENDPOINT,
      graphStoreEndpoint: `${ENDPOINT}/gsp`,
      ...config,
    }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler)))),
  );

const selectAll = Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) =>
  Stream.runCollect(c.select('SELECT * {}')),
);

const JSON_RESULTS = 'application/sparql-results+json';

describe('SparqlClient errors', () => {
  it.effect('maps transport failures', () =>
    withMock(
      (request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: 'connection refused',
            }),
          }),
        ),
      Effect.gen(function* () {
        const error = yield* Effect.flip(selectAll);
        expect(error._tag).toBe('TransportError');
        expect(error.message).toContain('connection refused');
        expect(Errors.isSparqlClientError(error)).toBe(true);
        expect(Errors.isTransient(error)).toBe(true);
      }),
    ),
  );

  it.effect('keeps the status and body of HTTP errors', () =>
    withMock(
      respond('Query timed out on the server', { status: 500, contentType: 'text/plain' }),
      Effect.gen(function* () {
        const error = yield* Effect.flip(selectAll);
        expect(error).toMatchObject({
          _tag: 'HttpStatusError',
          status: 500,
          method: 'GET',
          body: 'Query timed out on the server',
        });
        expect(Errors.isTransient(error)).toBe(false);
      }),
    ),
  );

  it.effect('reports malformed responses', () =>
    Effect.gen(function* () {
      const json = yield* withMock(
        respond('{"head":{"vars":["x"]},"results":{"bindings":[{"x":', {
          contentType: JSON_RESULTS,
        }),
        Effect.flip(selectAll),
      );
      expect(json).toMatchObject({ _tag: 'MalformedResponseError', contentType: JSON_RESULTS });
      const turtle = yield* withMock(
        respond('<a> <b> .', { contentType: 'text/turtle' }),
        Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) =>
          Effect.flip(c.constructDataset('CONSTRUCT WHERE { ?s ?p ?o }')),
        ),
      );
      expect(turtle._tag).toBe('MalformedResponseError');
      const notBoolean = yield* withMock(
        respond('{"head":{"vars":[]},"results":{"bindings":[]}}', { contentType: JSON_RESULTS }),
        Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) =>
          Effect.flip(c.ask('ASK {}')),
        ),
      );
      expect(notBoolean._tag).toBe('MalformedResponseError');
      const notSolutions = yield* withMock(
        respond('{"head":{},"boolean":true}', { contentType: JSON_RESULTS }),
        Effect.flip(selectAll),
      );
      expect(notSolutions._tag).toBe('MalformedResponseError');
      const noLocation = yield* withMock(
        respond('', { status: 201 }),
        Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) =>
          Effect.flip(c.createGraph([])),
        ),
      );
      expect(noLocation._tag).toBe('MalformedResponseError');
    }),
  );

  it.effect('rejects unsupported media types', () =>
    Effect.gen(function* () {
      const select = yield* withMock(
        respond('<html></html>', { contentType: 'text/html' }),
        Effect.flip(selectAll),
      );
      expect(select).toMatchObject({ _tag: 'UnsupportedMediaTypeError', contentType: 'text/html' });
      const graph = yield* withMock(
        respond('<html></html>', { contentType: 'text/html' }),
        Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) =>
          Effect.flip(c.constructDataset('CONSTRUCT WHERE { ?s ?p ?o }')),
        ),
      );
      expect(graph._tag).toBe('UnsupportedMediaTypeError');
    }),
  );

  it.live('times out', () =>
    withMock(
      () => Effect.never,
      Effect.gen(function* () {
        const error = yield* Effect.flip(selectAll);
        expect(error._tag).toBe('TimeoutError');
        expect(error.message).toContain('timed out');
      }),
      { timeout: '20 millis' },
    ),
  );

  it.effect('retries transient failures with the configured schedule', () =>
    Effect.gen(function* () {
      let attempts = 0;
      const flaky: Handler = (request) => {
        attempts++;
        return attempts < 3
          ? respond('busy', { status: 503 })(request)
          : respond('{"head":{},"boolean":true}', { contentType: JSON_RESULTS })(request);
      };
      const value = yield* withMock(
        flaky,
        Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) => c.ask('ASK {}')),
        { retry: Schedule.recurs(5) },
      );
      expect(value).toBe(true);
      expect(attempts).toBe(3);

      // Non-transient errors are not retried.
      let badAttempts = 0;
      const bad: Handler = (request) => {
        badAttempts++;
        return respond('syntax error', { status: 400 })(request);
      };
      const error = yield* withMock(
        bad,
        Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) =>
          Effect.flip(c.ask('ASK {')),
        ),
        { retry: Schedule.recurs(5) },
      );
      expect(error._tag).toBe('HttpStatusError');
      expect(badAttempts).toBe(1);

      // Giving up after the schedule is exhausted.
      let always = 0;
      const down: Handler = (request) => {
        always++;
        return respond('down', { status: 503 })(request);
      };
      const last = yield* withMock(
        down,
        Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) =>
          Effect.flip(c.ask('ASK {}')),
        ),
        { retry: Schedule.recurs(2) },
      );
      expect(last._tag === 'HttpStatusError' && last.status).toBe(503);
      expect(always).toBe(3);
    }),
  );

  it.effect('sends configured and per-request headers', () =>
    Effect.gen(function* () {
      let seen: Record<string, string> = {};
      let url = '';
      const capture: Handler = (request) => {
        seen = { ...request.headers };
        url = request.url;
        return respond('{"head":{},"boolean":true}', { contentType: JSON_RESULTS })(request);
      };
      yield* withMock(
        capture,
        Effect.flatMap(Effect.service(SparqlClient.SparqlClient), (c) =>
          c.ask('ASK {}', { headers: { 'x-request': '1' } }),
        ),
        { headers: { authorization: 'Bearer token' } },
      );
      expect(seen['authorization']).toBe('Bearer token');
      expect(seen['x-request']).toBe('1');
      expect(seen['accept']).toContain('application/sparql-results+json');
      expect(url).toBe(ENDPOINT);
    }),
  );
});
