/**
 * The JSON-LD 1.1 processor: expansion, compaction, flattening, framing and
 * conversion to and from RDF, plus a `Serialization.Codec` for the
 * `application/ld+json` media type.
 *
 * Remote documents and contexts are loaded through the `DocumentLoader`
 * service when it is provided (or through `options.documentLoader`); without
 * one, any remote reference fails with `loading remote context failed` /
 * `loading document failed`.
 *
 * @since 0.1.0
 */
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as DocumentLoader from './DocumentLoader.ts';
import * as JsonLdError from './JsonLdError.ts';
import { compactElement, compactIri } from './internal/compact.ts';
import {
  type ActiveContext,
  type Env,
  type LoadedDocument,
  NeedDocument,
  type ProcessingMode,
  expandIri,
  initialContext,
  processContext,
} from './internal/context.ts';
import { expandElement } from './internal/expand.ts';
import { flattenExpanded } from './internal/flatten.ts';
import { cleanupNull, frame as frameAlgorithm } from './internal/frame.ts';
import * as Rdf from './internal/rdf.ts';
import { type Json, type JsonObject, fail, isObject, isString } from './internal/util.ts';

/**
 * Any JSON value.
 *
 * @since 0.1.0
 * @category models
 */
export type JsonValue = null | boolean | number | string | JsonArray | JsonObjectValue;

/**
 * @since 0.1.0
 * @category models
 */
export interface JsonArray extends ReadonlyArray<JsonValue> {}

/**
 * @since 0.1.0
 * @category models
 */
export interface JsonObjectValue {
  readonly [key: string]: JsonValue;
}

/**
 * The input of the JSON-LD algorithms: a JSON document (object or array), the
 * URL of a document to load, or an already loaded `RemoteDocument`.
 *
 * @since 0.1.0
 * @category models
 */
export type Input = JsonValue | DocumentLoader.RemoteDocument | object;

/**
 * Options shared by all JSON-LD algorithms (the `JsonLdOptions` of the
 * JSON-LD API).
 *
 * @since 0.1.0
 * @category options
 */
export interface Options {
  /** The base IRI. Defaults to the URL of the input document, if any. */
  readonly base?: string | null | undefined;
  /** `json-ld-1.1` (default) or `json-ld-1.0`. */
  readonly processingMode?: ProcessingMode | undefined;
  /** A context to apply before expanding the input. */
  readonly expandContext?: unknown;
  /** Process map entries in lexicographical order. Defaults to `false`. */
  readonly ordered?: boolean | undefined;
  /** Replace single-element arrays by their element. Defaults to `true`. */
  readonly compactArrays?: boolean | undefined;
  /** Make IRIs relative to the base IRI when compacting. Defaults to `true`. */
  readonly compactToRelative?: boolean | undefined;
  /** Extract all JSON-LD script elements from HTML input. */
  readonly extractAllScripts?: boolean | undefined;
  /**
   * A document loader to use instead of the `DocumentLoader` service from
   * the environment.
   */
  readonly documentLoader?: DocumentLoader.Loader | undefined;
}

/**
 * Options for `toRdf`.
 *
 * @since 0.1.0
 * @category options
 */
export interface ToRdfOptions extends Options {
  /**
   * How to represent `@direction`: as `i18n-datatype` literals, as
   * `compound-literal` blank nodes, or not at all (default).
   */
  readonly rdfDirection?: 'i18n-datatype' | 'compound-literal' | null | undefined;
  /**
   * Generalized RDF (blank node predicates) cannot be represented by the
   * core term model; such triples are always dropped.
   */
  readonly produceGeneralizedRdf?: boolean | undefined;
}

/**
 * Options for `fromRdf`.
 *
 * @since 0.1.0
 * @category options
 */
export interface FromRdfOptions {
  readonly processingMode?: ProcessingMode | undefined;
  readonly ordered?: boolean | undefined;
  /** Convert `xsd:boolean`, `xsd:integer` and `xsd:double` to native JSON values. */
  readonly useNativeTypes?: boolean | undefined;
  /** Keep `rdf:type` as a regular property instead of `@type`. */
  readonly useRdfType?: boolean | undefined;
  readonly rdfDirection?: 'i18n-datatype' | 'compound-literal' | null | undefined;
}

/**
 * Options for `frame`.
 *
 * @since 0.1.0
 * @category options
 */
export interface FrameOptions extends Options {
  /** The default `@embed` flag: `@once` (default), `@always`, `@never` or `@link`. */
  readonly embed?: '@once' | '@always' | '@never' | '@link' | undefined;
  /** The default `@explicit` flag. */
  readonly explicit?: boolean | undefined;
  /** The default `@omitDefault` flag. */
  readonly omitDefault?: boolean | undefined;
  /** The default `@requireAll` flag. */
  readonly requireAll?: boolean | undefined;
  /** Omit `@graph` when the result is a single node. Defaults to `false` in 1.1. */
  readonly omitGraph?: boolean | undefined;
}

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------

type DocResult = Result.Result<LoadedDocument, JsonLdError.JsonLdError>;

const getLoader = (options: Options | undefined) =>
  options?.documentLoader !== undefined
    ? Effect.succeed(options.documentLoader)
    : Effect.map(Effect.serviceOption(DocumentLoader.DocumentLoader), (o) =>
        Option.getOrElse(o, () => DocumentLoader.none),
      );

/**
 * Runs a pure algorithm, loading documents on demand: when the algorithm
 * needs a document that has not been loaded yet it aborts with
 * `NeedDocument`, the document is loaded, and the algorithm is restarted.
 */
const run = <A>(
  options: Options | undefined,
  f: (env: Env) => A,
): Effect.Effect<A, JsonLdError.JsonLdError> =>
  Effect.gen(function* () {
    const loader = yield* getLoader(options);
    const docs = new Map<string, DocResult>();
    const env: Env = {
      processingMode: options?.processingMode ?? 'json-ld-1.1',
      contextCache: new Map(),
      load: (url) => {
        const hit = docs.get(url);
        if (hit === undefined) throw new NeedDocument(url, undefined);
        if (Result.isFailure(hit)) throw hit.failure;
        return hit.success;
      },
    };
    for (;;) {
      try {
        return f(env);
      } catch (e) {
        if (e instanceof NeedDocument) {
          const r = yield* Effect.result(
            loader.load(e.url, { profile: 'http://www.w3.org/ns/json-ld#context' }),
          );
          docs.set(e.url, r);
          continue;
        }
        if (JsonLdError.isJsonLdError(e)) return yield* Effect.fail(e);
        throw e;
      }
    }
  });

interface ResolvedInput {
  readonly document: Json;
  readonly documentUrl: string | null;
  readonly contextUrl: string | undefined;
}

const isRemoteDocument = (u: unknown): u is DocumentLoader.RemoteDocument =>
  isObject(u) && typeof u['documentUrl'] === 'string' && 'document' in u;

const resolveInput = (
  input: Input,
  options: Options | undefined,
): Effect.Effect<ResolvedInput, JsonLdError.JsonLdError> =>
  Effect.gen(function* () {
    if (isString(input)) {
      const loader = yield* getLoader(options);
      const doc = yield* loader
        .load(input, { extractAllScripts: options?.extractAllScripts })
        .pipe(
          Effect.mapError((e) =>
            e.code === 'loading document failed' || e.code === 'multiple context link headers'
              ? e
              : JsonLdError.make('loading document failed', e.message),
          ),
        );
      return { document: doc.document, documentUrl: doc.documentUrl, contextUrl: doc.contextUrl };
    }
    if (isRemoteDocument(input)) {
      return {
        document: input.document,
        documentUrl: input.documentUrl,
        contextUrl: input.contextUrl,
      };
    }
    return { document: input, documentUrl: null, contextUrl: undefined };
  });

const expandSync = (
  env: Env,
  input: ResolvedInput,
  options: Options | undefined,
  frameExpansion = false,
): Array<JsonObject> => {
  const base = options?.base !== undefined ? options.base : input.documentUrl;
  let active: ActiveContext = initialContext(base);
  if (options?.expandContext !== undefined && options.expandContext !== null) {
    let ctx = options.expandContext as Json;
    if (isObject(ctx) && '@context' in ctx) ctx = ctx['@context'];
    active = processContext(env, active, ctx, active.originalBase);
  }
  if (input.contextUrl !== undefined) {
    active = processContext(env, active, input.contextUrl, input.contextUrl);
  }
  let expanded = expandElement(env, active, null, input.document, input.documentUrl ?? base, {
    frameExpansion,
    ordered: options?.ordered ?? false,
  });
  if (isObject(expanded) && Object.keys(expanded).length === 1 && '@graph' in expanded) {
    expanded = expanded['@graph'];
  }
  if (expanded === null || expanded === undefined) expanded = [];
  if (!Array.isArray(expanded)) expanded = [expanded];
  return expanded;
};

const compactSync = (
  env: Env,
  expanded: Json,
  context: Json,
  documentUrl: string | null,
  options: Options | undefined,
): JsonObject => {
  if (isObject(context) && '@context' in context) context = context['@context'];
  const compactToRelative = options?.compactToRelative ?? true;
  const base =
    options?.base !== undefined && options.base !== null
      ? options.base
      : compactToRelative
        ? documentUrl
        : null;
  const contextBase = isString(context) ? context : (options?.base ?? documentUrl ?? null);
  let active = initialContext(base);
  active = processContext(env, active, context ?? null, contextBase);
  const compactOptions = {
    compactArrays: options?.compactArrays ?? true,
    ordered: options?.ordered ?? false,
    compactToRelative,
  };
  let compacted = compactElement(env, active, null, expanded, compactOptions);
  if (Array.isArray(compacted)) {
    compacted =
      compacted.length === 0
        ? {}
        : { [compactIri(env, active, '@graph', null, true, false, compactOptions)]: compacted };
  }
  if (compacted === null || compacted === undefined) compacted = {};
  if (
    context !== null &&
    context !== undefined &&
    !(isObject(context) && Object.keys(context).length === 0) &&
    !(Array.isArray(context) && context.length === 0)
  ) {
    compacted = { '@context': context, ...compacted };
  }
  return compacted;
};

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

/**
 * Expands a JSON-LD document (JSON-LD 1.1 API, Expansion Algorithm).
 *
 * @since 0.1.0
 * @category algorithms
 */
export const expand = (
  input: Input,
  options?: Options,
): Effect.Effect<Array<JsonObjectValue>, JsonLdError.JsonLdError> =>
  Effect.flatMap(resolveInput(input, options), (resolved) =>
    run(options, (env) => expandSync(env, resolved, options)),
  );

/**
 * Compacts a JSON-LD document against a context (JSON-LD 1.1 API,
 * Compaction Algorithm). The context may be a context definition, an array
 * of contexts, an IRI, or a document with an `@context` entry.
 *
 * @since 0.1.0
 * @category algorithms
 */
export const compact = (
  input: Input,
  context: unknown,
  options?: Options,
): Effect.Effect<JsonObjectValue, JsonLdError.JsonLdError> =>
  Effect.flatMap(resolveInput(input, options), (resolved) =>
    run(options, (env) => {
      const expanded = expandSync(env, resolved, { ...options, ordered: false });
      return compactSync(env, expanded, context, resolved.documentUrl, options);
    }),
  );

/**
 * Flattens a JSON-LD document (JSON-LD 1.1 API, Flattening Algorithm),
 * optionally compacting the result.
 *
 * @since 0.1.0
 * @category algorithms
 */
export const flatten = (
  input: Input,
  context?: unknown,
  options?: Options,
): Effect.Effect<JsonValue, JsonLdError.JsonLdError> =>
  Effect.flatMap(resolveInput(input, options), (resolved) =>
    run(options, (env) => {
      const expanded = expandSync(env, resolved, options);
      const flattened = flattenExpanded(expanded, options?.ordered ?? false);
      if (context === undefined || context === null) return flattened;
      const compacted = compactSync(env, flattened, context, resolved.documentUrl, options);
      return compacted;
    }),
  );

/**
 * Frames a JSON-LD document (JSON-LD 1.1 Framing).
 *
 * @since 0.1.0
 * @category algorithms
 */
export const frame = (
  input: Input,
  frame: unknown,
  options?: FrameOptions,
): Effect.Effect<JsonObjectValue, JsonLdError.JsonLdError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveInput(input, options);
    const resolvedFrame = yield* resolveInput(frame as Input, options);
    return yield* run(options, (env) => frameSync(env, resolved, resolvedFrame, options));
  });

const frameSync = (
  env: Env,
  resolved: ResolvedInput,
  resolvedFrame: ResolvedInput,
  options: FrameOptions | undefined,
): JsonObject => {
  const frameDocument: Json = resolvedFrame.document;
  if (!isObject(frameDocument) && !Array.isArray(frameDocument)) {
    return fail('invalid frame', 'a frame must be a JSON object');
  }
  const context: Json = isObject(frameDocument)
    ? ((frameDocument as JsonObject)['@context'] ?? null)
    : null;
  const base = options?.base !== undefined ? options.base : resolved.documentUrl;
  const frameBase = resolvedFrame.documentUrl ?? base;
  const frameContext = processContext(env, initialContext(frameBase), context, frameBase);
  const merged = !(
    isObject(frameDocument) &&
    Object.keys(frameDocument).some((k) => expandIri(env, frameContext, k, true) === '@graph')
  );
  const expanded = expandSync(env, resolved, { ...options, ordered: false });
  const expandedFrame = expandSync(env, resolvedFrame, { ...options, ordered: false }, true);
  const is11 = env.processingMode !== 'json-ld-1.0';
  const framed = frameAlgorithm(expanded, expandedFrame, {
    embed: options?.embed ?? '@once',
    explicit: options?.explicit ?? false,
    omitDefault: options?.omitDefault ?? false,
    requireAll: options?.requireAll ?? false,
    ordered: options?.ordered ?? false,
    merged,
    is11,
  });
  const compactToRelative = options?.compactToRelative ?? true;
  let active = initialContext(
    options?.base != null ? options.base : compactToRelative ? resolved.documentUrl : null,
  );
  active = processContext(env, active, context, frameBase);
  const compactOptions = {
    compactArrays: options?.compactArrays ?? true,
    ordered: options?.ordered ?? false,
    compactToRelative,
  };
  const omitGraph = options?.omitGraph ?? is11;
  let compacted = compactElement(env, active, null, framed, compactOptions);
  if (omitGraph && Array.isArray(compacted)) {
    if (compacted.length === 1 && compactOptions.compactArrays) compacted = compacted[0];
  } else if (!omitGraph && isObject(compacted)) {
    compacted = [compacted];
  }
  if (Array.isArray(compacted)) {
    const graphKey = compactIri(env, active, '@graph', null, true, false, compactOptions);
    compacted = { [graphKey]: compacted };
  }
  if (compacted === null || compacted === undefined) compacted = {};
  if (
    context !== null &&
    !(isObject(context) && Object.keys(context).length === 0) &&
    !(Array.isArray(context) && context.length === 0)
  ) {
    compacted = { '@context': context, ...compacted };
  }
  return cleanupNull(compacted);
};

/**
 * Converts a JSON-LD document to an RDF dataset (Deserialize JSON-LD to RDF
 * Algorithm).
 *
 * @since 0.1.0
 * @category algorithms
 */
export const toRdf = (
  input: Input,
  options?: ToRdfOptions,
): Effect.Effect<Dataset.Dataset, JsonLdError.JsonLdError> =>
  Effect.map(toQuads(input, options), Dataset.fromIterable);

/**
 * Like `toRdf`, but returns the quads in document order.
 *
 * @since 0.1.0
 * @category algorithms
 */
export const toQuads = (
  input: Input,
  options?: ToRdfOptions,
): Effect.Effect<ReadonlyArray<Term.Quad>, JsonLdError.JsonLdError> =>
  Effect.flatMap(resolveInput(input, options), (resolved) =>
    run(options, (env) => {
      const expanded = expandSync(env, resolved, options);
      return Rdf.toRdf(expanded, {
        produceGeneralizedRdf: options?.produceGeneralizedRdf ?? false,
        rdfDirection: options?.rdfDirection ?? null,
      });
    }),
  );

/**
 * Converts RDF quads to expanded JSON-LD (Serialize RDF as JSON-LD
 * Algorithm).
 *
 * @since 0.1.0
 * @category algorithms
 */
export const fromRdf = (
  quads: Iterable<Term.Quad>,
  options?: FromRdfOptions,
): Effect.Effect<Array<JsonObjectValue>, JsonLdError.JsonLdError> =>
  Effect.try({
    try: () =>
      Rdf.fromRdf(quads, {
        rdfDirection: options?.rdfDirection ?? null,
        useNativeTypes: options?.useNativeTypes ?? false,
        useRdfType: options?.useRdfType ?? false,
        ordered: options?.ordered ?? false,
        processingMode: options?.processingMode ?? 'json-ld-1.1',
      }),
    catch: (e) =>
      JsonLdError.isJsonLdError(e) ? e : JsonLdError.make('invalid JSON literal', String(e)),
  });

// -----------------------------------------------------------------------------
// Codec
// -----------------------------------------------------------------------------

/**
 * The JSON-LD format.
 *
 * @since 0.1.0
 * @category formats
 */
export const format: Serialization.Format = Serialization.makeFormat({
  name: 'JSON-LD',
  mediaType: 'application/ld+json',
  extensions: ['jsonld'],
  datasets: true,
});

/**
 * Options for parsing JSON-LD documents to RDF.
 *
 * @since 0.1.0
 * @category options
 */
export interface ParseOptions extends Serialization.ParseOptions, ToRdfOptions {}

/**
 * Options for serialising RDF as JSON-LD.
 *
 * @since 0.1.0
 * @category options
 */
export interface SerializeOptions extends Serialization.SerializeOptions, FromRdfOptions {
  /** A context to compact the output with. */
  readonly context?: unknown;
  /** Replace single-element arrays by their element. Defaults to `true`. */
  readonly compactArrays?: boolean | undefined;
  /** JSON indentation. Defaults to 2; use 0 for compact output. */
  readonly indent?: number | undefined;
  readonly documentLoader?: DocumentLoader.Loader | undefined;
}

const positionOf = (input: string, error: unknown): { line?: number; column?: number } => {
  const m = /position (\d+)/.exec(String(error));
  if (m === null) return {};
  const pos = Number(m[1]);
  const before = input.slice(0, pos);
  const line = before.split('\n').length;
  return { line, column: pos - before.lastIndexOf('\n') };
};

/**
 * Parses a JSON-LD document into RDF.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.gen(function* () {
    let json: unknown;
    try {
      json = JSON.parse(input);
    } catch (e) {
      return yield* Effect.fail(
        new Serialization.RdfParseError({
          format: format.name,
          message: `invalid JSON: ${String(e)}`,
          ...positionOf(input, e),
        }),
      );
    }
    const base = options?.base !== undefined ? options.base : (options?.baseIri ?? null);
    const quads = yield* toQuads(json as Input, { ...options, base }).pipe(
      Effect.mapError(
        (e) => new Serialization.RdfParseError({ format: format.name, message: e.message }),
      ),
    );
    const prefix = options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix();
    const graph = options?.graph;
    const relabel = (t: Term.Term): Term.Term =>
      t._tag === 'BlankNode' ? Term.blankNode(`${prefix}${t.value}`) : t;
    const dataset = Dataset.fromIterable(
      quads.map((q) => {
        const relabelled = Term.mapTerms(q, relabel);
        return graph !== undefined && relabelled.graph._tag === 'DefaultGraph'
          ? Term.quad(relabelled.subject, relabelled.predicate, relabelled.object, graph)
          : relabelled;
      }),
    );
    return {
      dataset,
      prefixes: prefixesOf(json),
      baseIri: base ?? undefined,
    };
  });

const prefixesOf = (json: unknown): PrefixMap.PrefixMap => {
  const entries: Array<[string, string]> = [];
  const visit = (ctx: unknown): void => {
    if (Array.isArray(ctx)) ctx.forEach(visit);
    else if (isObject(ctx)) {
      for (const [k, v] of Object.entries(ctx)) {
        if (k.startsWith('@') || k.includes(':')) continue;
        const iri = isString(v) ? v : isObject(v) && isString(v['@id']) ? v['@id'] : undefined;
        if (iri !== undefined && /[/#:]$/.test(iri) && /^[a-z][a-z0-9+.-]*:/i.test(iri)) {
          entries.push([k, iri]);
        }
      }
    }
  };
  if (isObject(json)) visit(json['@context']);
  return PrefixMap.make(entries);
};

/**
 * Serialises quads as a JSON-LD document. Without a context (and without
 * prefixes) the output is expanded JSON-LD; otherwise it is compacted with
 * the given context, extended with one term per prefix.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serialize = (
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  Effect.gen(function* () {
    const expanded = yield* fromRdf(quads, options);
    let context: Json = options?.context ?? null;
    if (isObject(context) && '@context' in context) context = context['@context'];
    if (options?.prefixes !== undefined && options.prefixes.prefixes.size > 0) {
      const prefixContext: JsonObject = {};
      for (const [prefix, namespace] of options.prefixes.prefixes) {
        prefixContext[prefix] = namespace;
      }
      if (options.baseIri !== undefined) prefixContext['@base'] = options.baseIri;
      context =
        context === null
          ? prefixContext
          : Array.isArray(context)
            ? [prefixContext, ...context]
            : [prefixContext, context];
    }
    const output: Json =
      context === null
        ? expanded
        : yield* compact(expanded, context, {
            base: options?.baseIri ?? null,
            compactArrays: options?.compactArrays,
            processingMode: options?.processingMode,
            documentLoader: options?.documentLoader,
          });
    return JSON.stringify(output, null, options?.indent ?? 2);
  }).pipe(
    Effect.mapError(
      (e) => new Serialization.RdfSerializeError({ format: format.name, message: e.message }),
    ),
  );

/**
 * The JSON-LD parser.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parser: Serialization.Parser<ParseOptions> = Serialization.makeParser({
  format,
  parse,
});

/**
 * The JSON-LD serializer.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializer: Serialization.Serializer<SerializeOptions> = Serialization.makeSerializer({
  format,
  serialize,
});

/**
 * The JSON-LD codec.
 *
 * @since 0.1.0
 * @category codecs
 */
export const codec: Serialization.Codec<ParseOptions, SerializeOptions> = Serialization.makeCodec(
  parser,
  serializer,
);
