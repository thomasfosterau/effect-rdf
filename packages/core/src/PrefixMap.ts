/**
 * Immutable prefix ↔ namespace mappings used to expand and compact IRIs.
 *
 * @since 0.1.0
 */
import * as Option from 'effect/Option';
import { NamedNode } from './Term.ts';
import { commonPrefixes } from './Vocab.ts';

/**
 * @since 0.1.0
 * @category models
 */
export interface PrefixMap {
  readonly prefixes: ReadonlyMap<string, string>;
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const empty: PrefixMap = { prefixes: new Map() };

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  prefixes: Readonly<Record<string, string>> | Iterable<readonly [string, string]>,
): PrefixMap => ({
  prefixes: new Map(
    Symbol.iterator in prefixes
      ? (prefixes as Iterable<readonly [string, string]>)
      : Object.entries(prefixes),
  ),
});

/**
 * A prefix map containing `rdf`, `rdfs`, `xsd` and `owl`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const common: PrefixMap = make(commonPrefixes);

/**
 * @since 0.1.0
 * @category combinators
 */
export const set = (self: PrefixMap, prefix: string, namespace: string): PrefixMap => {
  const prefixes = new Map(self.prefixes);
  prefixes.set(prefix, namespace);
  return { prefixes };
};

/**
 * Merges two prefix maps; entries in `that` win.
 *
 * @since 0.1.0
 * @category combinators
 */
export const merge = (self: PrefixMap, that: PrefixMap): PrefixMap => ({
  prefixes: new Map([...self.prefixes, ...that.prefixes]),
});

/**
 * @since 0.1.0
 * @category getters
 */
export const get = (self: PrefixMap, prefix: string): Option.Option<string> =>
  Option.fromNullishOr(self.prefixes.get(prefix));

/**
 * Expands a prefixed name (`prefix:local`) to an IRI.
 *
 * @since 0.1.0
 * @category combinators
 */
export const expand = (self: PrefixMap, curie: string): Option.Option<NamedNode> => {
  const i = curie.indexOf(':');
  if (i === -1) return Option.none();
  const ns = self.prefixes.get(curie.slice(0, i));
  return ns === undefined ? Option.none() : Option.some(new NamedNode(ns + curie.slice(i + 1)));
};

const PN_LOCAL_SIMPLE =
  /^(?:[A-Za-z0-9_À-�:]|%[0-9A-Fa-f]{2})(?:(?:[A-Za-z0-9_\-.·À-�:]|%[0-9A-Fa-f]{2})*(?:[A-Za-z0-9_\-·À-�:]|%[0-9A-Fa-f]{2}))?$/;

/**
 * Compacts an IRI to `[prefix, local]` using the longest matching namespace,
 * if the local part is a valid Turtle/SPARQL `PN_LOCAL` without escapes.
 *
 * @since 0.1.0
 * @category combinators
 */
export const compact = (
  self: PrefixMap,
  iri: string | NamedNode,
): Option.Option<readonly [string, string]> => {
  const value = typeof iri === 'string' ? iri : iri.value;
  let best: readonly [string, string] | undefined;
  let bestLength = -1;
  for (const [prefix, ns] of self.prefixes) {
    if (ns.length > bestLength && value.startsWith(ns)) {
      const local = value.slice(ns.length);
      if (local === '' || PN_LOCAL_SIMPLE.test(local)) {
        best = [prefix, local];
        bestLength = ns.length;
      }
    }
  }
  return Option.fromNullishOr(best);
};
