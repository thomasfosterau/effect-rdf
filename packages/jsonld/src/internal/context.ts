/**
 * Context processing and IRI expansion (JSON-LD 1.1 API §4.1, §4.2, §5.2).
 *
 * @internal
 */
import { resolveIri } from './iri.ts';
import {
  type Json,
  type JsonObject,
  deepEqual,
  mapJsonLdError,
  fail,
  hasKeywordForm,
  isAbsoluteIri,
  isBlankNodeId,
  isKeyword,
  isObject,
  isString,
  hasOwn,
  stringSet,
} from './util.ts';
import * as Arr from 'effect/Array';
import * as Iterable from 'effect/Iterable';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';

/** @internal */
export type ProcessingMode = 'json-ld-1.0' | 'json-ld-1.1';

/**
 * What the algorithms read of a loaded document.
 *
 * @internal
 */
export interface LoadedDocument {
  readonly documentUrl: string;
  readonly document: Json;
}

/** A remote context, as cached by URL. */
interface LoadedContext {
  readonly context: Json;
  readonly documentUrl: string;
}

/**
 * Synchronous loader used by the pure algorithms. It either returns an
 * already-loaded document, throws a `JsonLdError`, or throws `NeedDocument`
 * to ask the effectful driver to load the document and retry.
 *
 * @internal
 */
export interface Env {
  readonly processingMode: ProcessingMode;
  readonly load: (url: string, profile?: string) => LoadedDocument;
  /** Cache of remote contexts (keyed by URL). */
  readonly contextCache: MutableHashMap.MutableHashMap<string, LoadedContext>;
}

/** @internal */
export class NeedDocument {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

/** @internal */
export interface DefineState {
  readonly defined: MutableHashMap.MutableHashMap<string, boolean>;
  readonly baseUrl: string | null;
  readonly protected: boolean;
  readonly overrideProtected: boolean;
  readonly remoteContexts: ReadonlyArray<string>;
  readonly validateScoped: boolean;
}

/** @internal */
export interface TermDefinition {
  iri: string | null;
  reverse: boolean;
  type?: string;
  /** `undefined` = no language mapping, `null` = explicitly no language. */
  language?: string | null;
  direction?: 'ltr' | 'rtl' | null;
  context?: Json;
  hasContext: boolean;
  baseUrl?: string | null;
  container: Array<string>;
  index?: string;
  nest?: string;
  prefix: boolean;
  protected: boolean;
  /** The term contains a colon (it is a compact IRI or absolute IRI). */
  hasColon: boolean;
}

/** @internal */
export interface ActiveContext {
  base: string | null;
  originalBase: string | null;
  vocab?: string;
  language?: string;
  direction?: 'ltr' | 'rtl';
  terms: MutableHashMap.MutableHashMap<string, TermDefinition>;
  previous?: ActiveContext;
  inverse?: InverseContext;
}

/** @internal */
export type InverseContext = MutableHashMap.MutableHashMap<
  string,
  globalThis.Record<string, ContainerEntry>
>;

/** @internal */
export interface ContainerEntry {
  '@language': globalThis.Record<string, string>;
  '@type': globalThis.Record<string, string>;
  '@any': globalThis.Record<string, string>;
}

/** @internal */
export const initialContext = (base: string | null): ActiveContext => ({
  base,
  originalBase: base,
  terms: MutableHashMap.empty(),
});

/**
 * The definition of `term` in the active context.
 *
 * @internal
 */
export const termOf = (active: ActiveContext, term: string): Option.Option<TermDefinition> =>
  // Terms are strings, which a `MutableHashMap` keeps in its `backing` map: one lookup there
  // is the whole of `MutableHashMap.get` for them (this runs for every key expanded).
  Option.fromUndefinedOr(active.terms.backing.get(term));

/**
 * The definition of `term`, when it carries a scoped context.
 *
 * @internal
 */
export const scopedTermOf = (active: ActiveContext, term: string): Option.Option<TermDefinition> =>
  Option.filter(termOf(active, term), (def) => def.hasContext);

const cloneContext = (ctx: ActiveContext): ActiveContext => {
  const out: ActiveContext = {
    base: ctx.base,
    originalBase: ctx.originalBase,
    terms: MutableHashMap.fromIterable(ctx.terms),
  };
  if (ctx.vocab !== undefined) out.vocab = ctx.vocab;
  if (ctx.language !== undefined) out.language = ctx.language;
  if (ctx.direction !== undefined) out.direction = ctx.direction;
  if (ctx.previous !== undefined) out.previous = ctx.previous;
  return out;
};

const MAX_REMOTE_CONTEXTS = 32;

/** Loads a remote context document, failing with `loading remote context failed`. */
const loadContextDocument = (env: Env, url: string): LoadedDocument =>
  mapJsonLdError(
    () => env.load(url, 'http://www.w3.org/ns/json-ld#context'),
    (e) => fail('loading remote context failed', `${url}: ${e.message}`),
  );

/**
 * Applies the type-scoped context of each term (in the given order) that
 * defines one, as expansion step 11 and compaction step 11 do.
 *
 * @internal
 */
export const applyTypeScopedContexts = (
  env: Env,
  active: ActiveContext,
  typeScoped: ActiveContext,
  terms: ReadonlyArray<string>,
): ActiveContext =>
  terms.reduce(
    (result, term) =>
      Option.match(scopedTermOf(typeScoped, term), {
        onNone: () => result,
        onSome: (def) =>
          processContext(env, result, def.context, def.baseUrl ?? null, [], false, false),
      }),
    active,
  );

/** Loads a remote context (once per run), failing with `invalid remote context`. */
const remoteContext = (env: Env, url: string): LoadedContext =>
  Option.getOrElse(MutableHashMap.get(env.contextCache, url), () => {
    const doc = loadContextDocument(env, url);
    if (!isObject(doc.document) || !('@context' in doc.document)) {
      fail('invalid remote context', url);
    }
    const loaded: LoadedContext = {
      context: doc.document['@context'],
      documentUrl: doc.documentUrl,
    };
    MutableHashMap.set(env.contextCache, url, loaded);
    return loaded;
  });

/**
 * Context Processing Algorithm.
 *
 * @internal
 */
export const processContext = (
  env: Env,
  active: ActiveContext,
  localContext: Json,
  baseUrl: string | null,
  remoteContexts: ReadonlyArray<string> = [],
  overrideProtected = false,
  propagate = true,
  validateScoped = true,
): ActiveContext => {
  // 1
  let result = cloneContext(active);
  // 2
  if (isObject(localContext) && '@propagate' in localContext) {
    if (!Predicate.isBoolean(localContext['@propagate'])) fail('invalid @propagate value');
    propagate = localContext['@propagate'];
  }
  // 3
  if (!propagate && result.previous === undefined) result.previous = active;
  // 4
  const contexts = Array.isArray(localContext) ? localContext : [localContext];
  // 5
  contexts.forEach((context: Json) => {
    // 5.1
    if (context === null) {
      result = nullified(active, result, overrideProtected, propagate);
      return;
    }
    // 5.2
    if (isString(context)) {
      const url = resolveIri(context, baseUrl);
      if (!validateScoped && remoteContexts.includes(url)) return;
      if (remoteContexts.length > MAX_REMOTE_CONTEXTS) fail('context overflow');
      const loaded = remoteContext(env, url);
      result = processContext(
        env,
        result,
        loaded.context,
        loaded.documentUrl,
        [...remoteContexts, url],
        overrideProtected,
        true,
        validateScoped,
      );
      return;
    }
    // 5.3 - 5.13
    processLocalContext(
      env,
      result,
      context,
      baseUrl,
      remoteContexts,
      overrideProtected,
      validateScoped,
    );
  });
  return result;
};

/** Context processing step 5.1: a `null` context resets the active context. */
const nullified = (
  active: ActiveContext,
  result: ActiveContext,
  overrideProtected: boolean,
  propagate: boolean,
): ActiveContext => {
  if (
    !overrideProtected &&
    Iterable.some(MutableHashMap.values(result.terms), (def) => def.protected)
  ) {
    fail('invalid context nullification');
  }
  const reset = initialContext(active.originalBase);
  if (!propagate) reset.previous = result;
  return reset;
};

/** Steps 5.3 - 5.13: a context definition (an object) updates `result` in place. */
const processLocalContext = (
  env: Env,
  result: ActiveContext,
  definition: Json,
  baseUrl: string | null,
  remoteContexts: ReadonlyArray<string>,
  overrideProtected: boolean,
  validateScoped: boolean,
): void => {
  // 5.3
  if (!isObject(definition)) fail('invalid local context');
  // 5.5
  checkVersion(env, definition);
  // 5.6
  const context = withImport(env, definition, baseUrl);
  // 5.7
  if ('@base' in context && Arr.isReadonlyArrayEmpty(remoteContexts)) {
    setBase(result, context['@base']);
  }
  // 5.8
  if ('@vocab' in context) setVocab(env, result, context['@vocab']);
  // 5.9, 5.10
  setLanguageAndDirection(env, result, context);
  // 5.11
  checkFlags(env, context);
  // 5.12, 5.13
  const state: DefineState = {
    defined: MutableHashMap.empty(),
    baseUrl,
    protected: context['@protected'] === true,
    overrideProtected,
    remoteContexts,
    validateScoped,
  };
  Record.keys(context).forEach((key) => {
    if (!isContextKeyword(key)) createTermDefinition(env, result, context, key, state);
  });
};

/** Step 5.5: `@version`. */
const checkVersion = (env: Env, context: JsonObject): void => {
  if (!('@version' in context)) return;
  if (context['@version'] !== 1.1) fail('invalid @version value');
  if (env.processingMode === 'json-ld-1.0') fail('processing mode conflict');
};

/** Step 5.6: the context merged over the one its `@import` names. */
const withImport = (env: Env, context: JsonObject, baseUrl: string | null): JsonObject => {
  if (!('@import' in context)) return context;
  if (env.processingMode === 'json-ld-1.0') fail('invalid context entry');
  const imp = context['@import'];
  if (!isString(imp)) fail('invalid @import value');
  const url = resolveIri(imp, baseUrl);
  const doc = loadContextDocument(env, url);
  if (!isObject(doc.document) || !isObject(doc.document['@context'])) {
    fail('invalid remote context', url);
  }
  const importContext = doc.document['@context'];
  if ('@import' in importContext) fail('invalid context entry');
  return { ...importContext, ...context };
};

/** Step 5.7: `@base`. */
const setBase = (result: ActiveContext, value: Json): void => {
  if (value === null) result.base = null;
  else if (!isString(value)) fail('invalid base IRI');
  else if (isAbsoluteIri(value)) result.base = value;
  else if (result.base !== null) result.base = resolveIri(value, result.base);
  else fail('invalid base IRI');
};

/** Step 5.8: `@vocab`. */
const setVocab = (env: Env, result: ActiveContext, value: Json): void => {
  if (value === null) {
    delete result.vocab;
    return;
  }
  if (!isString(value)) fail('invalid vocab mapping');
  if (env.processingMode === 'json-ld-1.0' && !isAbsoluteIri(value) && !isBlankNodeId(value)) {
    fail('invalid vocab mapping');
  }
  const expanded = expandIri(env, result, value, true, true);
  if (expanded === null || isKeyword(expanded)) fail('invalid vocab mapping');
  result.vocab = expanded;
};

/** Steps 5.9 and 5.10: `@language` and `@direction`. */
const setLanguageAndDirection = (env: Env, result: ActiveContext, context: JsonObject): void => {
  if ('@language' in context) {
    const value = context['@language'];
    if (value === null) delete result.language;
    else if (!isString(value)) fail('invalid default language');
    else result.language = value;
  }
  if ('@direction' in context) {
    if (env.processingMode === 'json-ld-1.0') fail('invalid context entry');
    const value = context['@direction'];
    if (value === null) delete result.direction;
    else if (value !== 'ltr' && value !== 'rtl') fail('invalid base direction');
    else result.direction = value;
  }
};

/** Step 5.11, and the `@protected` flag. */
const checkFlags = (env: Env, context: JsonObject): void => {
  if ('@propagate' in context) {
    if (env.processingMode === 'json-ld-1.0') fail('invalid context entry');
    if (!Predicate.isBoolean(context['@propagate'])) fail('invalid @propagate value');
  }
  if ('@protected' in context && !Predicate.isBoolean(context['@protected'])) {
    fail('invalid @protected value');
  }
};

const isContextKeyword = stringSet([
  '@base',
  '@direction',
  '@import',
  '@language',
  '@propagate',
  '@protected',
  '@version',
  '@vocab',
]);

const isTermKey = stringSet([
  '@id',
  '@reverse',
  '@container',
  '@context',
  '@direction',
  '@index',
  '@language',
  '@nest',
  '@prefix',
  '@protected',
  '@type',
]);

const GEN_DELIMS = /[:/?#[\]@]$/;

const isContainerKeyword = stringSet([
  '@graph',
  '@id',
  '@index',
  '@language',
  '@list',
  '@set',
  '@type',
]);

const validContainer = (env: Env, value: Json): boolean => {
  if (env.processingMode === 'json-ld-1.0') {
    return isString(value) && ['@list', '@set', '@index', '@language'].includes(value);
  }
  const c = Array.isArray(value) ? value : [value];
  if (Arr.isReadonlyArrayEmpty(c)) return false;
  if (!c.every((x) => isString(x) && isContainerKeyword(x))) return false;
  if (c.some((x, i) => c.indexOf(x) !== i)) return false;
  if (c.includes('@list')) return c.length === 1;
  if (c.includes('@graph')) {
    if (c.includes('@id') && c.includes('@index')) return false;
    return c.every((x) => x === '@graph' || x === '@id' || x === '@index' || x === '@set');
  }
  if (c.length === 1) return true;
  return c.length === 2 && c.includes('@set');
};

/**
 * Create Term Definition algorithm.
 *
 * @internal
 */
export const createTermDefinition = (
  env: Env,
  active: ActiveContext,
  local: JsonObject,
  term: string,
  state: DefineState,
): void => {
  const { defined, baseUrl, overrideProtected, remoteContexts } = state;
  // 1
  const status = MutableHashMap.get(defined, term);
  if (Option.isSome(status)) {
    if (status.value) return;
    fail('cyclic IRI mapping', term);
  }
  // 2
  if (term === '') fail('invalid term definition', 'empty term');
  MutableHashMap.set(defined, term, false);
  // 3
  let value = local[term];
  // 4, 5
  if (term === '@type' && env.processingMode !== 'json-ld-1.0' && isObject(value)) {
    const keys = Record.keys(value);
    if (
      Arr.isReadonlyArrayEmpty(keys) ||
      keys.some((k) => k !== '@container' && k !== '@protected') ||
      ('@container' in value && value['@container'] !== '@set')
    ) {
      fail('keyword redefinition', term);
    }
  } else if (isKeyword(term)) {
    fail('keyword redefinition', term);
  } else if (hasKeywordForm(term)) {
    MutableHashMap.set(defined, term, true);
    return;
  }
  // 6
  const previous = termOf(active, term);
  MutableHashMap.remove(active.terms, term);
  // 7, 8, 9
  let simpleTerm = false;
  if (value === null) value = { '@id': null };
  else if (isString(value)) {
    value = { '@id': value };
    simpleTerm = true;
  } else if (!isObject(value)) {
    fail('invalid term definition', term);
  }
  // 10
  const def: TermDefinition = {
    iri: null,
    reverse: false,
    hasContext: false,
    container: [],
    prefix: false,
    protected: state.protected,
    hasColon: term.indexOf(':', 1) !== -1,
  };
  // 11
  if ('@protected' in value) {
    if (env.processingMode === 'json-ld-1.0') fail('invalid term definition');
    if (!Predicate.isBoolean(value['@protected'])) fail('invalid @protected value');
    def.protected = value['@protected'];
  }
  // 12
  if ('@type' in value) {
    const type = value['@type'];
    if (!isString(type)) fail('invalid type mapping');
    const expanded = expandIri(env, active, type, true, false, local, state);
    if (expanded === '@json' || expanded === '@none') {
      if (env.processingMode === 'json-ld-1.0') fail('invalid type mapping');
    } else if (
      expanded === null ||
      (expanded !== '@id' && expanded !== '@vocab' && !isAbsoluteIri(expanded)) ||
      isBlankNodeId(expanded)
    ) {
      fail('invalid type mapping', type);
    }
    def.type = expanded;
  }
  // 13
  if ('@reverse' in value) {
    if ('@id' in value || '@nest' in value) fail('invalid reverse property');
    const rev = value['@reverse'];
    if (!isString(rev)) fail('invalid IRI mapping');
    if (hasKeywordForm(rev)) {
      MutableHashMap.set(defined, term, true);
      return;
    }
    const iri = expandIri(env, active, rev, true, false, local, state);
    if (iri === null || (!isAbsoluteIri(iri) && !isBlankNodeId(iri))) fail('invalid IRI mapping');
    def.iri = iri;
    if ('@container' in value) {
      const c = value['@container'];
      if (c !== null && c !== '@set' && c !== '@index') fail('invalid reverse property');
      if (c !== null) def.container = [c];
    }
    def.reverse = true;
  } else if ('@id' in value && value['@id'] !== term) {
    // 15
    const id = value['@id'];
    if (id === null) {
      def.iri = null;
    } else {
      if (!isString(id)) fail('invalid IRI mapping');
      if (!isKeyword(id) && hasKeywordForm(id)) {
        MutableHashMap.set(defined, term, true);
        return;
      }
      const iri = expandIri(env, active, id, true, false, local, state);
      if (iri === null || (!isKeyword(iri) && !isAbsoluteIri(iri) && !isBlankNodeId(iri))) {
        fail('invalid IRI mapping', id);
      }
      if (iri === '@context') fail('invalid keyword alias');
      def.iri = iri;
      if (term.slice(1, -1).includes(':') || term.includes('/')) {
        MutableHashMap.set(defined, term, true);
        const termIri = expandIri(env, active, term, true, false, local, state);
        if (termIri !== iri) fail('invalid IRI mapping', term);
      }
      if (!term.includes(':') && !term.includes('/') && simpleTerm) {
        if (GEN_DELIMS.test(iri) || isBlankNodeId(iri)) def.prefix = true;
      }
    }
  } else if (term.indexOf(':', 1) !== -1) {
    // 16
    const i = term.indexOf(':');
    const prefix = term.slice(0, i);
    const suffix = term.slice(i + 1);
    if (prefix !== '_' && !suffix.startsWith('//') && hasOwn(local, prefix)) {
      createTermDefinition(env, active, local, prefix, state);
    }
    const prefixIri =
      prefix === '_' ? null : Option.getOrNull(Option.map(termOf(active, prefix), (d) => d.iri));
    def.iri = prefixIri === null ? term : prefixIri + suffix;
  } else if (term.includes('/')) {
    // 17
    const iri = expandIri(env, active, term, true);
    if (iri === null || !isAbsoluteIri(iri)) fail('invalid IRI mapping', term);
    def.iri = iri;
  } else if (term === '@type') {
    // 18
    def.iri = '@type';
  } else if (active.vocab !== undefined) {
    // 19
    def.iri = active.vocab + term;
  } else {
    fail('invalid IRI mapping', term);
  }
  // 20
  if ('@container' in value && !def.reverse) {
    const c = value['@container'];
    if (!validContainer(env, c)) fail('invalid container mapping');
    def.container = Array.isArray(c) ? [...c] : [c];
    if (def.container.includes('@type')) {
      if (def.type === undefined) def.type = '@id';
      if (def.type !== '@id' && def.type !== '@vocab') fail('invalid type mapping');
    }
  }
  // 21
  if ('@index' in value) {
    if (env.processingMode === 'json-ld-1.0' || !def.container.includes('@index')) {
      fail('invalid term definition');
    }
    const index = value['@index'];
    if (!isString(index)) fail('invalid term definition');
    const expanded = expandIri(env, active, index, true, false, local, state);
    if (expanded === null || isKeyword(expanded) || !isAbsoluteIri(expanded)) {
      fail('invalid term definition');
    }
    def.index = index;
  }
  // 22
  if ('@context' in value) {
    if (env.processingMode === 'json-ld-1.0') fail('invalid term definition');
    const ctx = value['@context'];
    mapJsonLdError(
      () => processContext(env, active, ctx, baseUrl, remoteContexts, true, true, false),
      (e) => fail('invalid scoped context', e.message),
    );
    def.context = ctx;
    def.hasContext = true;
    def.baseUrl = baseUrl;
  }
  // 23
  if ('@language' in value && !('@type' in value)) {
    const lang = value['@language'];
    if (lang !== null && !isString(lang)) fail('invalid language mapping');
    def.language = lang;
  }
  // 24
  if ('@direction' in value && !('@type' in value)) {
    const dir = value['@direction'];
    if (dir !== null && dir !== 'ltr' && dir !== 'rtl') fail('invalid base direction');
    def.direction = dir;
  }
  // 25
  if ('@nest' in value) {
    if (env.processingMode === 'json-ld-1.0') fail('invalid term definition');
    const nest = value['@nest'];
    if (!isString(nest) || (isKeyword(nest) && nest !== '@nest')) fail('invalid @nest value');
    def.nest = nest;
  }
  // 26
  if ('@prefix' in value) {
    if (env.processingMode === 'json-ld-1.0' || term.includes(':') || term.includes('/')) {
      fail('invalid term definition');
    }
    const p = value['@prefix'];
    if (!Predicate.isBoolean(p)) fail('invalid @prefix value');
    def.prefix = p;
    if (p && def.iri !== null && isKeyword(def.iri)) fail('invalid term definition');
  }
  // 27
  checkTermKeys(value);
  finishDefinition(active, term, def, previous, overrideProtected, defined);
};

const checkTermKeys = (value: JsonObject): void => {
  Record.keys(value).forEach((k) => {
    if (!isTermKey(k)) fail('invalid term definition', k);
  });
};

const finishDefinition = (
  active: ActiveContext,
  term: string,
  def: TermDefinition,
  previous: Option.Option<TermDefinition>,
  overrideProtected: boolean,
  defined: MutableHashMap.MutableHashMap<string, boolean>,
): void => {
  // 28
  const kept = Option.filter(previous, (p) => !overrideProtected && p.protected);
  if (Option.isSome(kept) && !sameDefinition(def, kept.value)) {
    fail('protected term redefinition', term);
  }
  // 29
  MutableHashMap.set(
    active.terms,
    term,
    Option.getOrElse(kept, () => def),
  );
  MutableHashMap.set(defined, term, true);
};

/** Whether the definition of `term` is still to be created from `local` (§4.2, step 3). */
const isPending = (local: JsonObject, state: DefineState, term: string): boolean =>
  hasOwn(local, term) && !Option.getOrElse(MutableHashMap.get(state.defined, term), () => false);

const sameDefinition = (a: TermDefinition, b: TermDefinition): boolean =>
  a.iri === b.iri &&
  a.reverse === b.reverse &&
  a.type === b.type &&
  a.language === b.language &&
  'language' in a === 'language' in b &&
  a.direction === b.direction &&
  'direction' in a === 'direction' in b &&
  a.hasContext === b.hasContext &&
  deepEqual(a.context, b.context) &&
  a.container.length === b.container.length &&
  a.container.every((c) => b.container.includes(c)) &&
  a.index === b.index &&
  a.nest === b.nest &&
  a.prefix === b.prefix;

/**
 * IRI Expansion algorithm.
 *
 * @internal
 */
export const expandIri = (
  env: Env,
  active: ActiveContext,
  value: string | null,
  vocab = false,
  documentRelative = false,
  local?: JsonObject,
  state?: DefineState,
): string | null => {
  // 1
  if (value === null || isKeyword(value)) return value;
  // 2
  if (hasKeywordForm(value)) return null;
  // 3
  if (local !== undefined && state !== undefined && isPending(local, state, value)) {
    createTermDefinition(env, active, local, value, state);
  }
  const def = termOf(active, value);
  if (Option.isSome(def)) {
    const iri = def.value.iri;
    // 4
    if (iri !== null && isKeyword(iri)) return iri;
    // 5
    if (vocab) return iri;
  }
  // 6
  const colon = value.indexOf(':', 1);
  if (colon !== -1) {
    const prefix = value.slice(0, colon);
    const suffix = value.slice(colon + 1);
    if (prefix === '_' || suffix.startsWith('//')) return value;
    if (local !== undefined && state !== undefined && isPending(local, state, prefix)) {
      createTermDefinition(env, active, local, prefix, state);
    }
    const prefixDef = termOf(active, prefix);
    if (Option.isSome(prefixDef) && prefixDef.value.iri !== null && prefixDef.value.prefix) {
      return prefixDef.value.iri + suffix;
    }
    if (isAbsoluteIri(value)) return value;
  }
  // 7
  if (vocab && active.vocab !== undefined) return active.vocab + value;
  // 8
  if (documentRelative) return resolveIri(value, active.base);
  return value;
};
