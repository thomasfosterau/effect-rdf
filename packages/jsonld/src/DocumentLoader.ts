/**
 * Loading of remote JSON-LD documents and contexts.
 *
 * The `DocumentLoader` service retrieves documents by URL. Two layers are
 * provided: `layerHttp`, backed by the Effect `HttpClient` and implementing
 * the JSON-LD content-type and `Link` header rules, and `layerStatic`, which
 * serves documents from an in-memory map (useful for tests, offline use and
 * pinning well-known contexts).
 *
 * @since 0.1.0
 */
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Headers from 'effect/http/Headers';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as JsonLdError from './JsonLdError.ts';

/**
 * A loaded document (the `RemoteDocument` interface of the JSON-LD API).
 *
 * @since 0.1.0
 * @category models
 */
export interface RemoteDocument {
  /** The final URL of the document, after redirects. */
  readonly documentUrl: string;
  /** The parsed JSON document. */
  readonly document: unknown;
  /** The media type of the response, without parameters. */
  readonly contentType?: string | undefined;
  /** The URL of a context referenced by an HTTP `Link` header. */
  readonly contextUrl?: string | undefined;
  /** The `profile` media type parameter, if any. */
  readonly profile?: string | undefined;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface LoadOptions {
  /** A profile to request, e.g. `http://www.w3.org/ns/json-ld#context`. */
  readonly profile?: string | undefined;
  /** Extract all JSON-LD script elements from HTML documents. */
  readonly extractAllScripts?: boolean | undefined;
}

/**
 * The service shape.
 *
 * @since 0.1.0
 * @category models
 */
export interface Loader {
  readonly load: (
    url: string,
    options?: LoadOptions,
  ) => Effect.Effect<RemoteDocument, JsonLdError.JsonLdError>;
}

/**
 * The document loader used to dereference remote documents and contexts.
 *
 * @since 0.1.0
 * @category services
 */
export class DocumentLoader extends Context.Service<DocumentLoader, Loader>()(
  '@thomasfosterau/effect-jsonld/DocumentLoader',
) {}

/**
 * A raw HTTP-like response, interpreted with `fromResponse`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Response {
  /** The final URL after redirects. */
  readonly url: string;
  readonly status?: number | undefined;
  /** The `Content-Type` header. */
  readonly contentType?: string | undefined;
  /** The `Link` header value(s). */
  readonly link?: string | ReadonlyArray<string> | undefined;
  readonly body: string;
}

const CONTEXT_REL = 'http://www.w3.org/ns/json-ld#context';

/**
 * A parsed entry of an HTTP `Link` header.
 *
 * @since 0.1.0
 * @category models
 */
export interface Link {
  readonly target: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Parses HTTP `Link` header values (RFC 8288).
 *
 * @since 0.1.0
 * @category utils
 */
export const parseLinkHeader = (header: string | ReadonlyArray<string>): ReadonlyArray<Link> => {
  const values = typeof header === 'string' ? [header] : header;
  const links: Array<Link> = [];
  for (const value of values) {
    const re =
      /\s*<([^>]*)>((?:\s*;\s*[^;,=\s]+\s*(?:=\s*(?:"(?:[^"\\]|\\.)*"|[^;,\s]*))?)*)\s*,?/gy;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null && m[0] !== '') {
      const params: Record<string, string> = {};
      const paramRe = /;\s*([^;,=\s]+)\s*(?:=\s*("(?:[^"\\]|\\.)*"|[^;,\s]*))?/g;
      let p: RegExpExecArray | null;
      while ((p = paramRe.exec(m[2] ?? '')) !== null) {
        let v = p[2] ?? '';
        if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
        params[p[1]!.toLowerCase()] = v;
      }
      links.push({ target: m[1]!, params });
    }
  }
  return links;
};

const mediaTypeOf = (contentType: string | undefined): string | undefined =>
  contentType === undefined ? undefined : contentType.split(';')[0]!.trim().toLowerCase();

const profileOf = (contentType: string | undefined): string | undefined => {
  if (contentType === undefined) return undefined;
  const m = /;\s*profile\s*=\s*("([^"]*)"|[^;\s]*)/i.exec(contentType);
  return m === null ? undefined : (m[2] ?? m[1]);
};

const isJsonMediaType = (mt: string | undefined): boolean =>
  mt === 'application/json' || mt === 'application/ld+json' || (mt?.endsWith('+json') ?? false);

const isHtmlMediaType = (mt: string | undefined): boolean =>
  mt === 'text/html' || mt === 'application/xhtml+xml';

const loadingFailed = (url: string, reason: string) =>
  JsonLdError.make('loading document failed', `${url}: ${reason}`);

/**
 * The result of interpreting a response: either a document, or a redirect
 * to an alternate JSON-LD representation.
 *
 * @since 0.1.0
 * @category models
 */
export type Interpreted =
  | { readonly _tag: 'Document'; readonly document: RemoteDocument }
  | { readonly _tag: 'Alternate'; readonly url: string };

/**
 * Interprets a response following the JSON-LD rules for media types and
 * `Link` headers (JSON-LD 1.1 API §9.4, LoadDocumentCallback).
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromResponse = (
  response: Response,
  options?: LoadOptions,
): Effect.Effect<Interpreted, JsonLdError.JsonLdError> =>
  Effect.suspend((): Effect.Effect<Interpreted, JsonLdError.JsonLdError> => {
    if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
      return Effect.fail(loadingFailed(response.url, `HTTP status ${response.status}`));
    }
    const mt = mediaTypeOf(response.contentType);
    const links = response.link === undefined ? [] : parseLinkHeader(response.link);
    if (mt !== 'application/ld+json' && !isJsonMediaType(mt)) {
      const alternate = links.find(
        (l) =>
          l.params['rel']?.split(/\s+/).includes('alternate') === true &&
          l.params['type'] === 'application/ld+json',
      );
      if (alternate !== undefined) {
        return Effect.succeed({
          _tag: 'Alternate' as const,
          url: Iri.resolve(alternate.target, response.url),
        });
      }
    }
    let contextUrl: string | undefined;
    if (mt !== 'application/ld+json' && isJsonMediaType(mt)) {
      const contextLinks = links.filter(
        (l) => l.params['rel']?.split(/\s+/).includes(CONTEXT_REL) === true,
      );
      if (contextLinks.length > 1) {
        return Effect.fail(JsonLdError.make('multiple context link headers', response.url));
      }
      if (contextLinks.length === 1) {
        contextUrl = Iri.resolve(contextLinks[0]!.target, response.url);
      }
    }
    if (isHtmlMediaType(mt)) {
      return Effect.map(extractHtml(response.body, response.url, options), (r) => ({
        _tag: 'Document' as const,
        document: { ...r, contentType: mt, contextUrl },
      }));
    }
    if (!isJsonMediaType(mt)) {
      return Effect.fail(loadingFailed(response.url, `unsupported content type ${String(mt)}`));
    }
    let document: unknown;
    try {
      document = JSON.parse(response.body);
    } catch (e) {
      return Effect.fail(loadingFailed(response.url, `invalid JSON: ${String(e)}`));
    }
    return Effect.succeed({
      _tag: 'Document' as const,
      document: {
        documentUrl: response.url,
        document,
        contentType: mt,
        contextUrl,
        profile: profileOf(response.contentType),
      },
    });
  });

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });

const attributes = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  const body = tag.replace(/^<\s*[^\s>]+/, '').replace(/\/?>$/, '');
  while ((m = re.exec(body)) !== null) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
};

/**
 * Extracts embedded JSON-LD from an HTML document (`<script
 * type="application/ld+json">` elements), honouring a fragment identifier
 * that selects a script by `id`, and the HTML `<base>` element.
 *
 * @since 0.1.0
 * @category utils
 */
export const extractHtml = (
  html: string,
  url: string,
  options?: LoadOptions,
): Effect.Effect<RemoteDocument, JsonLdError.JsonLdError> =>
  Effect.suspend(() => {
    let documentUrl = url;
    const base = /<base\s[^>]*>/i.exec(html);
    if (base !== null) {
      const href = attributes(base[0])['href'];
      if (href !== undefined) documentUrl = Iri.resolve(href, url);
    }
    const hash = url.indexOf('#');
    const fragment = hash === -1 ? undefined : decodeURIComponent(url.slice(hash + 1));
    const scripts: Array<{ attrs: Record<string, string>; content: string }> = [];
    const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const attrs = attributes(`<script${m[1] ?? ''}>`);
      const type = mediaTypeOf(attrs['type']);
      if (type !== 'application/ld+json') continue;
      scripts.push({ attrs, content: m[2] ?? '' });
    }
    const parse = (content: string): unknown => {
      try {
        return JSON.parse(content);
      } catch (e) {
        throw JsonLdError.make('invalid script element', String(e));
      }
    };
    try {
      if (fragment !== undefined && fragment !== '') {
        const script = scripts.find((s) => s.attrs['id'] === fragment);
        if (script === undefined) {
          return Effect.fail(loadingFailed(url, `no script element with id ${fragment}`));
        }
        return Effect.succeed({ documentUrl, document: parse(script.content) });
      }
      if (options?.extractAllScripts === true) {
        const all: Array<unknown> = [];
        for (const s of scripts) {
          const v = parse(s.content);
          if (Array.isArray(v)) all.push(...v);
          else all.push(v);
        }
        return Effect.succeed({ documentUrl, document: all });
      }
      if (scripts.length === 0) {
        return Effect.fail(loadingFailed(url, 'no JSON-LD script element'));
      }
      return Effect.succeed({ documentUrl, document: parse(scripts[0]!.content) });
    } catch (e) {
      return Effect.fail(e as JsonLdError.JsonLdError);
    }
  });

/**
 * Builds a loader from a function fetching raw responses. Responses are
 * interpreted with `fromResponse`; alternate links are followed.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromFetch = (
  fetch: (url: string, options?: LoadOptions) => Effect.Effect<Response, JsonLdError.JsonLdError>,
): Loader => {
  const load = (
    url: string,
    options: LoadOptions | undefined,
    depth: number,
  ): Effect.Effect<RemoteDocument, JsonLdError.JsonLdError> =>
    fetch(url, options).pipe(
      Effect.flatMap((response) => fromResponse(response, options)),
      Effect.flatMap((r) => {
        if (r._tag === 'Document') return Effect.succeed(r.document);
        if (depth > 5) return Effect.fail(loadingFailed(url, 'too many alternate links'));
        return load(r.url, options, depth + 1);
      }),
    );
  return { load: (url, options) => load(url, options, 0) };
};

/**
 * Wraps a loader with an in-memory cache of successfully loaded documents.
 *
 * @since 0.1.0
 * @category combinators
 */
export const cached = (loader: Loader): Loader => {
  const cache = new Map<string, RemoteDocument>();
  return {
    load: (url, options) =>
      Effect.suspend(() => {
        const key = `${options?.extractAllScripts === true ? '*' : ''}${url}`;
        const hit = cache.get(key);
        if (hit !== undefined) return Effect.succeed(hit);
        return Effect.tap(loader.load(url, options), (doc) =>
          Effect.sync(() => cache.set(key, doc)),
        );
      }),
  };
};

/**
 * A loader serving documents from a map of URL to document. Values may be
 * parsed JSON, JSON text, or complete `RemoteDocument`s. Unknown URLs fail
 * with `loading document failed`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeStatic = (
  documents: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>,
): Loader => {
  const map: ReadonlyMap<string, unknown> =
    documents instanceof Map ? documents : new Map(Object.entries(documents));
  return {
    load: (url) =>
      Effect.suspend(() => {
        const key = Iri.withoutFragment(url);
        if (!map.has(key)) return Effect.fail(loadingFailed(url, 'not found'));
        const value = map.get(key);
        if (isRemoteDocument(value)) return Effect.succeed(value);
        if (typeof value === 'string') {
          try {
            return Effect.succeed({
              documentUrl: url,
              document: JSON.parse(value),
              contentType: 'application/ld+json',
            });
          } catch (e) {
            return Effect.fail(loadingFailed(url, `invalid JSON: ${String(e)}`));
          }
        }
        return Effect.succeed({
          documentUrl: url,
          document: value,
          contentType: 'application/ld+json',
        });
      }),
  };
};

const isRemoteDocument = (u: unknown): u is RemoteDocument =>
  typeof u === 'object' &&
  u !== null &&
  'documentUrl' in u &&
  'document' in u &&
  typeof (u as RemoteDocument).documentUrl === 'string';

/**
 * A loader that fails for every URL (no remote loading).
 *
 * @since 0.1.0
 * @category constructors
 */
export const none: Loader = {
  load: (url) => Effect.fail(loadingFailed(url, 'remote documents are disabled')),
};

/**
 * Provides a static, in-memory `DocumentLoader`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerStatic = (
  documents: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>,
): Layer.Layer<DocumentLoader> => Layer.succeed(DocumentLoader, makeStatic(documents));

/**
 * Provides a `DocumentLoader` from a loader implementation.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (loader: Loader): Layer.Layer<DocumentLoader> =>
  Layer.succeed(DocumentLoader, loader);

const ACCEPT =
  'application/ld+json, application/json;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8, */*;q=0.1';

/**
 * Builds a loader on top of an `HttpClient`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeHttp: Effect.Effect<Loader, never, HttpClient.HttpClient> = Effect.gen(
  function* () {
    const client = yield* HttpClient.HttpClient;
    const fetch = (url: string, options?: LoadOptions) =>
      Effect.gen(function* () {
        const accept =
          options?.profile !== undefined
            ? `application/ld+json;profile="${options.profile}", ${ACCEPT}`
            : ACCEPT;
        const request = HttpClientRequest.get(Iri.withoutFragment(url)).pipe(
          HttpClientRequest.setHeader('accept', accept),
        );
        const response = yield* client.execute(request);
        const body = yield* response.text;
        const finalUrl = response.url === '' ? url : response.url;
        const hash = url.indexOf('#');
        return {
          url: hash === -1 ? finalUrl : finalUrl + url.slice(hash),
          status: response.status,
          contentType: Option.getOrUndefined(Headers.get(response.headers, 'content-type')),
          link: Option.getOrUndefined(Headers.get(response.headers, 'link')),
          body,
        } satisfies Response;
      }).pipe(Effect.mapError((e) => loadingFailed(url, String(e))));
    return cached(fromFetch(fetch));
  },
);

/**
 * A caching `DocumentLoader` backed by the Effect `HttpClient`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerHttp: Layer.Layer<DocumentLoader, never, HttpClient.HttpClient> = Layer.effect(
  DocumentLoader,
  makeHttp,
);
