/**
 * Immutable prefix ↔ namespace mappings used to expand and compact IRIs.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import { NamedNode } from './Term.ts';
import { commonPrefixes } from './Vocab.ts';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';

/**
 * @since 0.1.0
 * @category models
 */
export interface PrefixMap {
  readonly prefixes: HashMap.HashMap<string, string>;
}

/**
 * The `prefixes` of a prefix map: a `HashMap`, as the public field is typed;
 * a later entry for a prefix replaces an earlier one.
 */
function prefixMap(entries: Iterable<readonly [string, string]>): HashMap.HashMap<string, string> {
  return HashMap.fromIterable(entries);
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const empty: PrefixMap = { prefixes: prefixMap([]) };

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  prefixes: Record.ReadonlyRecord<string, string> | Iterable<readonly [string, string]>,
): PrefixMap => ({
  prefixes: prefixMap(Symbol.iterator in prefixes ? prefixes : Record.toEntries(prefixes)),
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
  return { prefixes: HashMap.set(self.prefixes, prefix, namespace) };
};

/**
 * Merges two prefix maps; entries in `that` win.
 *
 * @since 0.1.0
 * @category combinators
 */
export const merge = (self: PrefixMap, that: PrefixMap): PrefixMap => ({
  prefixes: HashMap.union(self.prefixes, that.prefixes),
});

/**
 * @since 0.1.0
 * @category getters
 */
export const get = (self: PrefixMap, prefix: string): Option.Option<string> =>
  HashMap.get(self.prefixes, prefix);

/**
 * The `[prefix, namespace]` entries of a prefix map in a deterministic order
 * (by prefix), since a `HashMap` has no insertion order.
 *
 * @since 0.1.0
 * @category getters
 */
export const entries = (self: PrefixMap): ReadonlyArray<readonly [string, string]> =>
  Arr.sort(
    HashMap.toEntries(self.prefixes),
    Order.mapInput(Order.String, (entry: readonly [string, string]) => entry[0]),
  );

/**
 * Expands a prefixed name (`prefix:local`) to an IRI.
 *
 * @since 0.1.0
 * @category combinators
 */
export const expand = (self: PrefixMap, curie: string): Option.Option<NamedNode> => {
  const i = curie.indexOf(':');
  if (i === -1) return Option.none();
  return Option.map(
    HashMap.get(self.prefixes, curie.slice(0, i)),
    (ns) => new NamedNode(ns + curie.slice(i + 1)),
  );
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
  const value = Predicate.isString(iri) ? iri : iri.value;
  let best: Option.Option<readonly [string, string]> = Option.none();
  let bestLength = -1;
  let bestPrefix = '';
  HashMap.forEach(self.prefixes, (ns, prefix) => {
    // Equally long namespaces: the smaller prefix wins, whatever the map's order
    if (
      (ns.length > bestLength || (ns.length === bestLength && prefix < bestPrefix)) &&
      value.startsWith(ns)
    ) {
      const local = value.slice(ns.length);
      if (local === '' || PN_LOCAL_SIMPLE.test(local)) {
        best = Option.some([prefix, local]);
        bestLength = ns.length;
        bestPrefix = prefix;
      }
    }
  });
  return best;
};
