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
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Iterable from 'effect/Iterable';
import * as Layer from 'effect/Layer';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Headers from 'effect/http/Headers';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Iri from '../Iri.ts';
import * as LinkHeader from './internal/linkHeader.ts';
import { parseJson } from './internal/json.ts';
import * as JsonLdError from './JsonLdError.ts';
import * as Predicate from 'effect/Predicate';

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
  '@thomasfosterau/effect-rdf/jsonld/DocumentLoader',
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
export const parseLinkHeader = (header: string | ReadonlyArray<string>): ReadonlyArray<Link> =>
  (Predicate.isString(header) ? [header] : header).flatMap(LinkHeader.parse);

/** The media type of a `Content-Type` value: lower-cased, without parameters. */
const mediaTypeOf = (contentType: Option.Option<string>): Option.Option<string> =>
  Option.map(contentType, (ct) => {
    const semicolon = ct.indexOf(';');
    return (semicolon === -1 ? ct : ct.slice(0, semicolon)).trim().toLowerCase();
  });

const PROFILE = /;\s*profile\s*=\s*("([^"]*)"|[^;\s]*)/i;

/** The `profile` parameter of a `Content-Type` value. */
const profileOf = (contentType: Option.Option<string>): Option.Option<string> =>
  Option.flatMap(contentType, (ct) => {
    const m = PROFILE.exec(ct);
    return m === null ? Option.none() : Option.fromUndefinedOr(m[2] ?? m[1]);
  });

const isJsonMediaType = (mt: Option.Option<string>): boolean =>
  Option.exists(
    mt,
    (t) => t === 'application/json' || t === 'application/ld+json' || t.endsWith('+json'),
  );

const isJsonLdMediaType = (mt: Option.Option<string>): boolean =>
  Option.exists(mt, (t) => t === 'application/ld+json');

const isHtmlMediaType = (mt: Option.Option<string>): boolean =>
  Option.exists(mt, (t) => t === 'text/html' || t === 'application/xhtml+xml');

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
    const contentType = Option.fromUndefinedOr(response.contentType);
    const mt = mediaTypeOf(contentType);
    const links = response.link === undefined ? [] : parseLinkHeader(response.link);
    if (!isJsonLdMediaType(mt) && !isJsonMediaType(mt)) {
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
    const contextLinks =
      !isJsonLdMediaType(mt) && isJsonMediaType(mt)
        ? links.filter((l) => l.params['rel']?.split(/\s+/).includes(CONTEXT_REL) === true)
        : [];
    if (contextLinks.length > 1) {
      return Effect.fail(JsonLdError.make('multiple context link headers', response.url));
    }
    const contextUrl = Option.getOrUndefined(
      Option.map(Arr.head(contextLinks), (l) => Iri.resolve(l.target, response.url)),
    );
    if (isHtmlMediaType(mt)) {
      return Effect.map(extractHtml(response.body, response.url, options), (r) => ({
        _tag: 'Document' as const,
        document: { ...r, contentType: Option.getOrUndefined(mt), contextUrl },
      }));
    }
    if (!isJsonMediaType(mt)) {
      return Effect.fail(
        loadingFailed(
          response.url,
          `unsupported content type ${String(Option.getOrUndefined(mt))}`,
        ),
      );
    }
    return Result.match(parseJson(response.body), {
      onFailure: (e) => Effect.fail(loadingFailed(response.url, `invalid JSON: ${String(e)}`)),
      onSuccess: (document) =>
        Effect.succeed({
          _tag: 'Document' as const,
          document: {
            documentUrl: response.url,
            document,
            contentType: Option.getOrUndefined(mt),
            contextUrl,
            profile: Option.getOrUndefined(profileOf(contentType)),
          },
        }),
    });
  });

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    // The pattern admits only the named entities in `ENTITIES`.
    return ENTITIES[e] ?? '';
  });

type Attributes = MutableHashMap.MutableHashMap<string, string>;

/** An element's attributes, by lower-cased name. */
const attributes = (tag: string): Attributes => {
  const out: Attributes = MutableHashMap.empty();
  const body = tag.replace(/^<\s*[^\s>]+/, '').replace(/\/?>$/, '');
  Iterable.forEach(
    body.matchAll(/([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g),
    (m) => {
      const name = m[1];
      if (name !== undefined) {
        MutableHashMap.set(out, name.toLowerCase(), decodeEntities(m[3] ?? m[4] ?? m[5] ?? ''));
      }
    },
  );
  return out;
};

const attribute = (attrs: Attributes, name: string): Option.Option<string> =>
  MutableHashMap.get(attrs, name);

const parseScript = (content: string) =>
  Result.mapError(parseJson(content), (e) => JsonLdError.make('invalid script element', String(e)));

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
    const base = /<base\s[^>]*>/i.exec(html);
    const documentUrl = Option.getOrElse(
      Option.map(
        Option.flatMap(Option.fromNullOr(base), (b) => attribute(attributes(b[0]), 'href')),
        (href) => Iri.resolve(href, url),
      ),
      () => url,
    );
    const hash = url.indexOf('#');
    const fragment = hash === -1 ? '' : decodeURIComponent(url.slice(hash + 1));
    const scripts: Array<{ attrs: Attributes; content: string }> = [];
    Iterable.forEach(html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi), (m) => {
      const attrs = attributes(`<script${m[1] ?? ''}>`);
      if (isJsonLdMediaType(mediaTypeOf(attribute(attrs, 'type')))) {
        scripts.push({ attrs, content: m[2] ?? '' });
      }
    });
    const remote = (document: Result.Result<unknown, JsonLdError.JsonLdError>) =>
      Effect.fromResult(
        Result.map(document, (d): RemoteDocument => ({ documentUrl, document: d })),
      );
    if (fragment !== '') {
      const script = scripts.find((s) =>
        Option.exists(attribute(s.attrs, 'id'), (id) => id === fragment),
      );
      if (script === undefined) {
        return Effect.fail(loadingFailed(url, `no script element with id ${fragment}`));
      }
      return remote(parseScript(script.content));
    }
    if (options?.extractAllScripts === true) {
      return remote(
        Result.map(Result.all(scripts.map((s) => parseScript(s.content))), (values) =>
          values.flatMap((v) => (Array.isArray(v) ? v : [v])),
        ),
      );
    }
    return Option.match(Arr.head(scripts), {
      onNone: () => Effect.fail(loadingFailed(url, 'no JSON-LD script element')),
      onSome: (script) => remote(parseScript(script.content)),
    });
  });

/**
 * Builds a loader from a function fetching raw responses. Responses are
 * interpreted with `fromResponse`; alternate links are followed.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromFetch = (
  fetchResponse: (
    url: string,
    options?: LoadOptions,
  ) => Effect.Effect<Response, JsonLdError.JsonLdError>,
): Loader => {
  const load = (
    url: string,
    depth: number,
    options?: LoadOptions,
  ): Effect.Effect<RemoteDocument, JsonLdError.JsonLdError> =>
    fetchResponse(url, options).pipe(
      Effect.flatMap((response) => fromResponse(response, options)),
      Effect.flatMap((r) => {
        if (Predicate.isTagged(r, 'Document')) return Effect.succeed(r.document);
        if (depth > 5) return Effect.fail(loadingFailed(url, 'too many alternate links'));
        return load(r.url, depth + 1, options);
      }),
    );
  return {
    load: (url, options) =>
      load(url, 0, options).pipe(
        Effect.withSpan('DocumentLoader.load', { attributes: { 'url.full': url } }),
      ),
  };
};

/**
 * Wraps a loader with an in-memory cache of successfully loaded documents.
 *
 * @since 0.1.0
 * @category combinators
 */
export const cached = (loader: Loader): Loader => {
  const cache = MutableHashMap.empty<string, RemoteDocument>();
  return {
    load: (url, options) =>
      Effect.suspend(() => {
        const key = `${options?.extractAllScripts === true ? '*' : ''}${url}`;
        return Option.match(MutableHashMap.get(cache, key), {
          onSome: (hit) => Effect.succeed(hit),
          onNone: () =>
            Effect.tap(loader.load(url, options), (doc) =>
              Effect.sync(() => MutableHashMap.set(cache, key, doc)),
            ),
        });
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
  // A `Map` is read as one; any other value as a record of URL to document.
  const lookup = (key: string): Option.Option<unknown> => {
    if (isMap(documents))
      return documents.has(key) ? Option.some(documents.get(key)) : Option.none();
    return Object.hasOwn(documents, key) ? Option.some(documents[key]) : Option.none();
  };
  return {
    load: (url) =>
      Effect.suspend(() => {
        const found = lookup(Iri.withoutFragment(url));
        if (Option.isNone(found)) return Effect.fail(loadingFailed(url, 'not found'));
        const value = found.value;
        if (isRemoteDocument(value)) return Effect.succeed(value);
        if (Predicate.isString(value)) {
          return Result.match(parseJson(value), {
            onFailure: (e) => Effect.fail(loadingFailed(url, `invalid JSON: ${String(e)}`)),
            onSuccess: (document) =>
              Effect.succeed({ documentUrl: url, document, contentType: 'application/ld+json' }),
          });
        }
        return Effect.succeed({
          documentUrl: url,
          document: value,
          contentType: 'application/ld+json',
        });
      }),
  };
};

const isMap = (
  documents: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>,
): documents is ReadonlyMap<string, unknown> => documents instanceof Map;

const isRemoteDocument = (u: unknown): u is RemoteDocument =>
  Predicate.hasProperty(u, 'documentUrl') &&
  Predicate.hasProperty(u, 'document') &&
  Predicate.isString(u.documentUrl);

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
export const makeHttp: Effect.Effect<Loader, never, HttpClient.HttpClient> = Effect.map(
  HttpClient.HttpClient,
  (client) => {
    const fetchResponse = (url: string, options?: LoadOptions) =>
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
    return cached(fromFetch(fetchResponse));
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
