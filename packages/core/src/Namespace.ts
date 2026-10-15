/**
 * Namespaces and strongly-typed vocabularies.
 *
 * ```ts
 * import { Namespace } from "@thomasfosterau/effect-rdf"
 *
 * const ex = Namespace.make("http://example.org/")
 * ex("alice") // NamedNode<"http://example.org/alice">
 *
 * const foaf = Namespace.vocabulary("http://xmlns.com/foaf/0.1/", ["name", "knows"])
 * foaf.name // NamedNode<"http://xmlns.com/foaf/0.1/name">
 * ```
 *
 * @since 0.1.0
 */
import { NamedNode } from './Term.ts';

/**
 * A function that mints IRIs within a namespace.
 *
 * @since 0.1.0
 * @category models
 */
export interface Namespace<Base extends string> {
  <const Local extends string>(local: Local): NamedNode<`${Base}${Local}`>;
  readonly base: Base;
  readonly node: NamedNode<Base>;
  /** Whether an IRI belongs to this namespace. */
  readonly contains: (iri: string | NamedNode) => boolean;
  /** The local part of an IRI within this namespace, if it belongs to it. */
  readonly localName: (iri: string | NamedNode) => string | undefined;
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = <const Base extends string>(base: Base): Namespace<Base> => {
  const cache = new Map<string, NamedNode>();
  const ns = ((local: string) => {
    let node = cache.get(local);
    if (node === undefined) {
      node = new NamedNode(base + local);
      cache.set(local, node);
    }
    return node;
  }) as Namespace<Base>;
  const contains = (iri: string | NamedNode) =>
    (typeof iri === 'string' ? iri : iri.value).startsWith(base);
  return Object.assign(ns, {
    base,
    node: new NamedNode(base),
    contains,
    localName: (iri: string | NamedNode) => {
      const value = typeof iri === 'string' ? iri : iri.value;
      return value.startsWith(base) ? value.slice(base.length) : undefined;
    },
  });
};

/**
 * A closed vocabulary: a namespace plus a fixed set of typed terms.
 *
 * @since 0.1.0
 * @category models
 */
export type Vocabulary<Base extends string, Terms extends string> = Namespace<Base> & {
  readonly [K in Terms]: NamedNode<`${Base}${K}`>;
} & { readonly terms: ReadonlyArray<Terms> };

/**
 * Creates a closed vocabulary with statically-known terms.
 *
 * @since 0.1.0
 * @category constructors
 */
export const vocabulary = <const Base extends string, const Terms extends string>(
  base: Base,
  terms: ReadonlyArray<Terms>,
): Vocabulary<Base, Terms> => {
  const ns = make(base);
  const props: Record<string, PropertyDescriptor> = {
    terms: { value: terms, enumerable: false },
  };
  for (const term of terms) {
    props[term] = { value: ns(term), enumerable: true };
  }
  return Object.defineProperties(ns, props) as Vocabulary<Base, Terms>;
};
