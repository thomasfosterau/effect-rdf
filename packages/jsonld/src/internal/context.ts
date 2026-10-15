/**
 * Context processing and IRI expansion (JSON-LD 1.1 API §4.1, §4.2, §5.2).
 *
 * @internal
 */
import * as JsonLdError from '../JsonLdError.ts';
import { resolveIri } from './iri.ts';
import {
  type Json,
  type JsonObject,
  deepEqual,
  fail,
  hasKeywordForm,
  isAbsoluteIri,
  isBlankNodeId,
  isKeyword,
  isObject,
  isString,
  hasOwn,
} from './util.ts';

/** @internal */
export type ProcessingMode = 'json-ld-1.0' | 'json-ld-1.1';

/** @internal */
export interface LoadedDocument {
  readonly documentUrl: string;
  readonly document: Json;
  readonly contextUrl?: string | undefined;
  readonly contentType?: string | undefined;
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
  /** Cache of processed remote contexts (keyed by URL). */
  readonly contextCache: Map<string, Json>;
}

/** @internal */
export class NeedDocument {
  readonly url: string;
  readonly profile: string | undefined;
  constructor(url: string, profile: string | undefined) {
    this.url = url;
    this.profile = profile;
  }
}

/** @internal */
export interface DefineState {
  readonly defined: Map<string, boolean>;
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
  terms: Map<string, TermDefinition>;
  previous?: ActiveContext;
  inverse?: InverseContext;
}

/** @internal */
export type InverseContext = Map<string, Record<string, ContainerEntry>>;

/** @internal */
export interface ContainerEntry {
  '@language': Record<string, string>;
  '@type': Record<string, string>;
  '@any': Record<string, string>;
}

/** @internal */
export const initialContext = (base: string | null): ActiveContext => ({
  base,
  originalBase: base,
  terms: new Map(),
});

const cloneContext = (ctx: ActiveContext): ActiveContext => {
  const out: ActiveContext = {
    base: ctx.base,
    originalBase: ctx.originalBase,
    terms: new Map(ctx.terms),
  };
  if (ctx.vocab !== undefined) out.vocab = ctx.vocab;
  if (ctx.language !== undefined) out.language = ctx.language;
  if (ctx.direction !== undefined) out.direction = ctx.direction;
  if (ctx.previous !== undefined) out.previous = ctx.previous;
  return out;
};

const MAX_REMOTE_CONTEXTS = 32;

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
    if (typeof localContext['@propagate'] !== 'boolean') fail('invalid @propagate value');
    propagate = localContext['@propagate'];
  }
  // 3
  if (!propagate && result.previous === undefined) result.previous = active;
  // 4
  const contexts = Array.isArray(localContext) ? localContext : [localContext];
  // 5
  for (let context of contexts) {
    // 5.1
    if (context === null) {
      if (!overrideProtected) {
        for (const def of result.terms.values()) {
          if (def.protected) fail('invalid context nullification');
        }
      }
      const prev = result;
      result = initialContext(active.originalBase);
      result.originalBase = active.originalBase;
      if (!propagate) result.previous = prev;
      continue;
    }
    // 5.2
    if (isString(context)) {
      const url = resolveIri(context, baseUrl);
      if (!validateScoped && remoteContexts.includes(url)) continue;
      if (remoteContexts.length > MAX_REMOTE_CONTEXTS) fail('context overflow');
      const nextRemote = [...remoteContexts, url];
      let loaded = env.contextCache.get(url);
      let documentUrl = url;
      if (loaded === undefined) {
        let doc: LoadedDocument;
        try {
          doc = env.load(url, 'http://www.w3.org/ns/json-ld#context');
        } catch (e) {
          if (JsonLdError.isJsonLdError(e)) {
            return fail('loading remote context failed', `${url}: ${e.message}`);
          }
          throw e;
        }
        if (!isObject(doc.document) || !('@context' in doc.document)) {
          fail('invalid remote context', url);
        }
        loaded = { context: doc.document['@context'], documentUrl: doc.documentUrl };
        env.contextCache.set(url, loaded);
      }
      documentUrl = loaded.documentUrl;
      result = processContext(
        env,
        result,
        loaded.context,
        documentUrl,
        nextRemote,
        overrideProtected,
        true,
        validateScoped,
      );
      continue;
    }
    // 5.3
    if (!isObject(context)) fail('invalid local context');
    // 5.5
    if ('@version' in context) {
      if (context['@version'] !== 1.1) fail('invalid @version value');
      if (env.processingMode === 'json-ld-1.0') fail('processing mode conflict');
    }
    // 5.6
    if ('@import' in context) {
      if (env.processingMode === 'json-ld-1.0') fail('invalid context entry');
      const imp = context['@import'];
      if (!isString(imp)) fail('invalid @import value');
      const url = resolveIri(imp, baseUrl);
      let doc: LoadedDocument;
      try {
        doc = env.load(url, 'http://www.w3.org/ns/json-ld#context');
      } catch (e) {
        if (JsonLdError.isJsonLdError(e)) {
          return fail('loading remote context failed', `${url}: ${e.message}`);
        }
        throw e;
      }
      if (!isObject(doc.document) || !isObject(doc.document['@context'])) {
        fail('invalid remote context', url);
      }
      const importContext = doc.document['@context'];
      if ('@import' in importContext) fail('invalid context entry');
      context = { ...importContext, ...context };
    }
    // 5.7
    if ('@base' in context && remoteContexts.length === 0) {
      const value = context['@base'];
      if (value === null) result.base = null;
      else if (!isString(value)) fail('invalid base IRI');
      else if (isAbsoluteIri(value)) result.base = value;
      else if (result.base !== null) result.base = resolveIri(value, result.base);
      else fail('invalid base IRI');
    }
    // 5.8
    if ('@vocab' in context) {
      const value = context['@vocab'];
      if (value === null) delete result.vocab;
      else if (!isString(value)) fail('invalid vocab mapping');
      else {
        if (
          env.processingMode === 'json-ld-1.0' &&
          !isAbsoluteIri(value) &&
          !isBlankNodeId(value)
        ) {
          fail('invalid vocab mapping');
        }
        const expanded = expandIri(env, result, value, true, true);
        if (expanded === null || (!isAbsoluteIri(expanded) && !isBlankNodeId(expanded))) {
          if (expanded === null || isKeyword(expanded)) fail('invalid vocab mapping');
        }
        result.vocab = expanded!;
      }
    }
    // 5.9
    if ('@language' in context) {
      const value = context['@language'];
      if (value === null) delete result.language;
      else if (!isString(value)) fail('invalid default language');
      else result.language = value;
    }
    // 5.10
    if ('@direction' in context) {
      if (env.processingMode === 'json-ld-1.0') fail('invalid context entry');
      const value = context['@direction'];
      if (value === null) delete result.direction;
      else if (value !== 'ltr' && value !== 'rtl') fail('invalid base direction');
      else result.direction = value;
    }
    // 5.11
    if ('@propagate' in context) {
      if (env.processingMode === 'json-ld-1.0') fail('invalid context entry');
      if (typeof context['@propagate'] !== 'boolean') fail('invalid @propagate value');
    }
    if ('@protected' in context && typeof context['@protected'] !== 'boolean') {
      fail('invalid @protected value');
    }
    // 5.12, 5.13
    const state: DefineState = {
      defined: new Map(),
      baseUrl,
      protected: context['@protected'] === true,
      overrideProtected,
      remoteContexts,
      validateScoped,
    };
    for (const key of Object.keys(context)) {
      if (CONTEXT_KEYWORDS.has(key)) continue;
      createTermDefinition(env, result, context, key, state);
    }
  }
  return result;
};

const CONTEXT_KEYWORDS = new Set([
  '@base',
  '@direction',
  '@import',
  '@language',
  '@propagate',
  '@protected',
  '@version',
  '@vocab',
]);

const TERM_KEYS = new Set([
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

const VALID_CONTAINERS = new Set([
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
  if (c.length === 0) return false;
  if (!c.every((x) => isString(x) && VALID_CONTAINERS.has(x))) return false;
  if (new Set(c).size !== c.length) return false;
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
  const status = defined.get(term);
  if (status === true) return;
  if (status === false) fail('cyclic IRI mapping', term);
  // 2
  if (term === '') fail('invalid term definition', 'empty term');
  defined.set(term, false);
  // 3
  let value = local[term];
  // 4, 5
  if (term === '@type' && env.processingMode !== 'json-ld-1.0' && isObject(value)) {
    const keys = Object.keys(value);
    if (
      keys.length === 0 ||
      keys.some((k) => k !== '@container' && k !== '@protected') ||
      ('@container' in value && value['@container'] !== '@set')
    ) {
      fail('keyword redefinition', term);
    }
  } else if (isKeyword(term)) {
    fail('keyword redefinition', term);
  } else if (hasKeywordForm(term)) {
    defined.set(term, true);
    return;
  }
  // 6
  const previous = active.terms.get(term);
  active.terms.delete(term);
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
    if (typeof value['@protected'] !== 'boolean') fail('invalid @protected value');
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
      fail('invalid type mapping', String(type));
    }
    def.type = expanded!;
  }
  // 13
  if ('@reverse' in value) {
    if ('@id' in value || '@nest' in value) fail('invalid reverse property');
    const rev = value['@reverse'];
    if (!isString(rev)) fail('invalid IRI mapping');
    if (hasKeywordForm(rev)) {
      defined.set(term, true);
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
        defined.set(term, true);
        return;
      }
      const iri = expandIri(env, active, id, true, false, local, state);
      if (iri === null || (!isKeyword(iri) && !isAbsoluteIri(iri) && !isBlankNodeId(iri))) {
        fail('invalid IRI mapping', id);
      }
      if (iri === '@context') fail('invalid keyword alias');
      def.iri = iri;
      if (term.slice(1, -1).includes(':') || term.includes('/')) {
        defined.set(term, true);
        const termIri = expandIri(env, active, term, true, false, local, state);
        if (termIri !== iri) fail('invalid IRI mapping', term);
      }
      if (!term.includes(':') && !term.includes('/') && simpleTerm) {
        if (GEN_DELIMS.test(iri!) || isBlankNodeId(iri)) def.prefix = true;
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
    const prefixDef = active.terms.get(prefix);
    if (prefixDef !== undefined && prefixDef.iri !== null && prefix !== '_') {
      def.iri = prefixDef.iri + suffix;
    } else {
      def.iri = term;
    }
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
    try {
      processContext(env, active, ctx, baseUrl, remoteContexts, true, true, false);
    } catch (e) {
      if (JsonLdError.isJsonLdError(e)) {
        return fail('invalid scoped context', e.message);
      }
      throw e;
    }
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
    if (typeof p !== 'boolean') fail('invalid @prefix value');
    def.prefix = p;
    if (p && def.iri !== null && isKeyword(def.iri)) fail('invalid term definition');
  }
  // 27
  checkTermKeys(value);
  finishDefinition(active, term, def, previous, overrideProtected, defined);
};

const checkTermKeys = (value: JsonObject): void => {
  for (const k of Object.keys(value)) {
    if (!TERM_KEYS.has(k)) fail('invalid term definition', k);
  }
};

const finishDefinition = (
  active: ActiveContext,
  term: string,
  def: TermDefinition,
  previous: TermDefinition | undefined,
  overrideProtected: boolean,
  defined: Map<string, boolean>,
): void => {
  // 28
  if (!overrideProtected && previous !== undefined && previous.protected) {
    if (!sameDefinition(def, previous)) fail('protected term redefinition', term);
    def = previous;
  }
  // 29
  active.terms.set(term, def);
  defined.set(term, true);
};

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
  local: JsonObject | null = null,
  state: DefineState | null = null,
): string | null => {
  const defined = state?.defined;
  // 1
  if (value === null || isKeyword(value)) return value;
  // 2
  if (hasKeywordForm(value)) return null;
  // 3
  if (local !== null && state !== null && hasOwn(local, value) && defined!.get(value) !== true) {
    createTermDefinition(env, active, local, value, state);
  }
  const def = active.terms.get(value);
  // 4
  if (def !== undefined && def.iri !== null && isKeyword(def.iri)) return def.iri;
  // 5
  if (vocab && active.terms.has(value)) return def!.iri;
  // 6
  const colon = value.indexOf(':', 1);
  if (colon !== -1) {
    const prefix = value.slice(0, colon);
    const suffix = value.slice(colon + 1);
    if (prefix === '_' || suffix.startsWith('//')) return value;
    if (
      local !== null &&
      state !== null &&
      hasOwn(local, prefix) &&
      defined!.get(prefix) !== true
    ) {
      createTermDefinition(env, active, local, prefix, state);
    }
    const prefixDef = active.terms.get(prefix);
    if (prefixDef !== undefined && prefixDef.iri !== null && prefixDef.prefix) {
      return prefixDef.iri + suffix;
    }
    if (isAbsoluteIri(value)) return value;
  }
  // 7
  if (vocab && active.vocab !== undefined) return active.vocab + value;
  // 8
  if (documentRelative) return resolveIri(value, active.base);
  return value;
};
