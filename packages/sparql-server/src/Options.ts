/**
 * Server configuration.
 *
 * @since 0.1.0
 */
import * as Duration from 'effect/Duration';
import * as Result from 'effect/Result';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';

/**
 * CORS settings.
 *
 * @since 0.1.0
 * @category models
 */
export interface CorsOptions {
  /** Allowed origins (default: any, `*`). */
  readonly allowedOrigins?: ReadonlyArray<string> | undefined;
  /** Allowed request headers (default: whatever the preflight asks for). */
  readonly allowedHeaders?: ReadonlyArray<string> | undefined;
  /** Response headers exposed to scripts. */
  readonly exposedHeaders?: ReadonlyArray<string> | undefined;
  /** Preflight cache duration in seconds. */
  readonly maxAge?: number | undefined;
  /** Whether to allow credentials. */
  readonly credentials?: boolean | undefined;
}

/**
 * Server options. Every field is optional.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /** Path of the SPARQL query endpoint (default `/sparql`). */
  readonly path?: `/${string}` | undefined;
  /**
   * Path of the SPARQL update endpoint (default: the query endpoint, which
   * then accepts both).
   */
  readonly updatePath?: `/${string}` | undefined;
  /**
   * Path of the Graph Store Protocol endpoint (default `/rdf-graph-store`),
   * or `false` to disable it. Graphs are identified indirectly with
   * `?default` / `?graph=<iri>` on this path, or directly by any URL below it.
   */
  readonly graphStorePath?: `/${string}` | false | undefined;
  /**
   * The public origin of the server (e.g. `https://data.example.org`), used to
   * build the request URLs that serve as base IRIs and as directly
   * identified graph IRIs. Defaults to the request's `Host` header (and
   * `X-Forwarded-Proto`).
   */
  readonly baseUrl?: string | undefined;
  /**
   * The base IRI for queries and updates. Defaults to the endpoint URL, as
   * suggested by the protocol.
   */
  readonly baseIri?: string | undefined;
  /** Rejects updates and Graph Store writes (default `false`). */
  readonly readOnly?: boolean | undefined;
  /**
   * Time limit for evaluating a query. A query that produces no result in
   * time is answered with `503 Service Unavailable`; a streaming response
   * that exceeds it is aborted.
   */
  readonly queryTimeout?: Duration.Input | undefined;
  /** Time limit for an update request (`503` when exceeded). */
  readonly updateTimeout?: Duration.Input | undefined;
  /** The maximum number of solutions or triples returned by a query. */
  readonly maxResults?: number | undefined;
  /** Enables CORS (`true` for permissive defaults). */
  readonly cors?: boolean | CorsOptions | undefined;
  /** Logs every request with Effect logging (default `false` for the handler). */
  readonly logging?: boolean | undefined;
  /** Serve a service description on `GET` without a query (default `true`). */
  readonly serviceDescription?: boolean | undefined;
  /** Advertised in the service description: `sd:UnionDefaultGraph`. */
  readonly unionDefaultGraph?: boolean | undefined;
  /** Advertised in the service description: `sd:BasicFederatedQuery`. */
  readonly federation?: boolean | undefined;
  /** Prefixes used when serialising graphs in syntaxes that support them. */
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
}

/**
 * Options with defaults applied.
 *
 * @since 0.1.0
 * @category models
 */
export interface Resolved {
  readonly path: `/${string}`;
  readonly updatePath: `/${string}`;
  readonly graphStorePath: `/${string}` | undefined;
  readonly baseUrl: string | undefined;
  readonly baseIri: string | undefined;
  readonly readOnly: boolean;
  readonly queryTimeout: Duration.Duration | undefined;
  readonly updateTimeout: Duration.Duration | undefined;
  readonly maxResults: number | undefined;
  readonly cors: CorsOptions | undefined;
  readonly logging: boolean;
  readonly serviceDescription: boolean;
  readonly unionDefaultGraph: boolean;
  readonly federation: boolean;
  readonly prefixes: Readonly<Record<string, string>>;
}

// SAFETY: removing a trailing slash from a path that starts with `/` keeps it starting with `/`.
const trimSlash = <P extends `/${string}`>(path: P): P =>
  (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path) as P;

/**
 * Applies the defaults.
 *
 * @since 0.1.0
 * @category constructors
 */
export const resolve = (options: Options = {}): Resolved => {
  const path = trimSlash(options.path ?? '/sparql');
  return {
    path,
    updatePath: trimSlash(options.updatePath ?? path),
    graphStorePath:
      options.graphStorePath === false
        ? undefined
        : trimSlash(options.graphStorePath ?? '/rdf-graph-store'),
    baseUrl: options.baseUrl,
    baseIri: options.baseIri,
    readOnly: options.readOnly ?? false,
    queryTimeout:
      options.queryTimeout === undefined
        ? undefined
        : Duration.fromInputUnsafe(options.queryTimeout),
    updateTimeout:
      options.updateTimeout === undefined
        ? undefined
        : Duration.fromInputUnsafe(options.updateTimeout),
    maxResults: options.maxResults,
    cors: options.cors === true ? {} : options.cors === false ? undefined : options.cors,
    logging: options.logging ?? false,
    serviceDescription: options.serviceDescription ?? true,
    unionDefaultGraph: options.unionDefaultGraph ?? false,
    federation: options.federation ?? false,
    prefixes: options.prefixes ?? {},
  };
};

const stripTrailing = (path: string): string =>
  path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

/**
 * The absolute URL of a request (without fragment), using `baseUrl`, the
 * request's absolute URL, or its `Host` header.
 *
 * @since 0.1.0
 * @category utils
 */
export const requestUrl = (
  request: HttpServerRequest.HttpServerRequest,
  options: Resolved,
): URL => {
  const raw = request.originalUrl;
  const parsed = new URL(raw, 'http://localhost');
  if (options.baseUrl !== undefined) {
    return new URL(parsed.pathname + parsed.search, options.baseUrl);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return parsed;
  const host = request.headers['host'] ?? 'localhost';
  const proto = (request.headers['x-forwarded-proto'] ?? 'http').split(',')[0]!.trim();
  return new URL(parsed.pathname + parsed.search, `${proto}://${host}`);
};

/**
 * The path of a request URL, without query string and trailing slash.
 *
 * @since 0.1.0
 * @category utils
 */
export const requestPath = (url: string): string => {
  const pathname = new URL(url, 'http://localhost').pathname;
  // A malformed percent-encoding is matched as written.
  return stripTrailing(
    Result.getOrElse(
      Result.try(() => decodeURI(pathname)),
      () => pathname,
    ),
  );
};
