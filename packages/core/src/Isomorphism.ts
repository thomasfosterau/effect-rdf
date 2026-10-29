/**
 * Blank-node-aware dataset comparison (RDF graph isomorphism).
 *
 * Uses iterative signature refinement to partition blank nodes, then a
 * backtracking search over the (usually tiny) ambiguous classes.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import { dual } from 'effect/Function';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Dataset from './Dataset.ts';
import * as Term from './Term.ts';

const fnv = (s: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
};

const collectBlankNodes = (t: Term.Term, out: Set<string>) => {
  if (t._tag === 'BlankNode') out.add(t.value);
  else if (t._tag === 'Triple') {
    collectBlankNodes(t.subject, out);
    collectBlankNodes(t.object, out);
  }
};

const quadBlankNodes = (q: Term.Quad): Set<string> => {
  const out = new Set<string>();
  collectBlankNodes(q.subject, out);
  collectBlankNodes(q.object, out);
  collectBlankNodes(q.graph, out);
  return out;
};

const termSig = (t: Term.Term, self: string, labels: ReadonlyMap<string, string>): string => {
  switch (t._tag) {
    case 'BlankNode':
      return t.value === self ? '@self' : `@${labels.get(t.value) ?? ''}`;
    case 'Triple':
      return `<<${termSig(t.subject, self, labels)} ${t.predicate.key} ${termSig(t.object, self, labels)}>>`;
    default:
      return t.key;
  }
};

interface Partition {
  readonly nodes: ReadonlyArray<string>;
  readonly labels: Map<string, string>;
  readonly byNode: Map<string, Array<Term.Quad>>;
}

const refine = (quads: ReadonlyArray<Term.Quad>): Partition => {
  const byNode = new Map<string, Array<Term.Quad>>();
  for (const q of quads) {
    for (const b of quadBlankNodes(q)) {
      let list = byNode.get(b);
      if (list === undefined) byNode.set(b, (list = []));
      list.push(q);
    }
  }
  const nodes = Array.from(byNode.keys());
  let labels = new Map<string, string>(nodes.map((n) => [n, '']));
  let classes = 1;
  for (let round = 0; round <= nodes.length; round++) {
    const next = new Map<string, string>();
    for (const n of nodes) {
      const sigs = Arr.sort(
        byNode
          .get(n)!
          .map(
            (q) =>
              `${termSig(q.subject, n, labels)} ${q.predicate.key} ${termSig(q.object, n, labels)} ${termSig(q.graph, n, labels)}`,
          ),
        Order.String,
      );
      next.set(n, fnv(labels.get(n)! + '|' + sigs.join('\n')));
    }
    const nextClasses = new Set(next.values()).size;
    labels = next;
    if (nextClasses === classes) break;
    classes = nextClasses;
  }
  return { nodes, labels, byNode };
};

const rename = (q: Term.Quad, mapping: ReadonlyMap<string, string>): string =>
  Term.mapTerms(q, (t) =>
    t._tag === 'BlankNode' ? new Term.BlankNode(mapping.get(t.value) ?? t.value) : t,
  ).key;

/**
 * Finds a blank node bijection from `self` to `that` under which the two
 * datasets are equal, if one exists.
 *
 * @since 0.1.0
 * @category isomorphism
 */
export const bijection = (
  self: Dataset.Dataset,
  that: Dataset.Dataset,
): Option.Option<ReadonlyMap<string, string>> => {
  if (self.size !== that.size) return Option.none();
  const aBlank: Array<Term.Quad> = [];
  const bBlank: Array<Term.Quad> = [];
  for (const q of self) {
    if (Term.hasBlankNodes(q)) aBlank.push(q);
    else if (!Dataset.has(that, q)) return Option.none();
  }
  for (const q of that) if (Term.hasBlankNodes(q)) bBlank.push(q);
  if (aBlank.length !== bBlank.length) return Option.none();
  if (Arr.isReadonlyArrayEmpty(aBlank)) return Option.some(new Map());

  const a = refine(aBlank);
  const b = refine(bBlank);
  if (a.nodes.length !== b.nodes.length) return Option.none();

  const groupsB = new Map<string, Array<string>>();
  for (const n of b.nodes) {
    const l = b.labels.get(n)!;
    let g = groupsB.get(l);
    if (g === undefined) groupsB.set(l, (g = []));
    g.push(n);
  }
  const groupsA = new Map<string, Array<string>>();
  for (const n of a.nodes) {
    const l = a.labels.get(n)!;
    let g = groupsA.get(l);
    if (g === undefined) groupsA.set(l, (g = []));
    g.push(n);
  }
  for (const [l, g] of groupsA) if (groupsB.get(l)?.length !== g.length) return Option.none();

  const target = new Set(bBlank.map((q) => q.key));
  const mapping = new Map<string, string>();
  const used = new Set<string>();
  // Assign unambiguous nodes first, then search the rest smallest class first.
  const order = Arr.sort(
    a.nodes,
    Order.mapInput(Order.Number, (x: string) => groupsA.get(a.labels.get(x)!)!.length),
  );

  const consistent = (node: string): boolean => {
    for (const q of a.byNode.get(node)!) {
      const bs = quadBlankNodes(q);
      let complete = true;
      for (const x of bs) if (!mapping.has(x)) complete = false;
      if (complete && !target.has(rename(q, mapping))) return false;
    }
    return true;
  };

  // Iterative depth-first search (graphs can have many thousands of blank nodes).
  const cursors: Array<number> = [0];
  while (Arr.isReadonlyArrayNonEmpty(cursors)) {
    const i = cursors.length - 1;
    if (i === order.length) return Option.some(mapping);
    const node = order[i]!;
    const candidates = groupsB.get(a.labels.get(node)!)!;
    const previous = mapping.get(node);
    if (previous !== undefined) {
      mapping.delete(node);
      used.delete(previous);
    }
    let next = cursors[i]!;
    let advanced = false;
    while (next < candidates.length) {
      const candidate = candidates[next++]!;
      if (used.has(candidate)) continue;
      mapping.set(node, candidate);
      used.add(candidate);
      if (consistent(node)) {
        advanced = true;
        break;
      }
      mapping.delete(node);
      used.delete(candidate);
    }
    cursors[i] = next;
    if (advanced) cursors.push(0);
    else cursors.pop();
  }
  return Option.none();
};

/**
 * Whether two datasets are isomorphic: equal up to a consistent renaming of
 * blank nodes.
 *
 * @since 0.1.0
 * @category isomorphism
 */
export const isomorphic: {
  (that: Dataset.Dataset): (self: Dataset.Dataset) => boolean;
  (self: Dataset.Dataset, that: Dataset.Dataset): boolean;
} = dual(2, (self: Dataset.Dataset, that: Dataset.Dataset): boolean =>
  Option.isSome(bijection(self, that)),
);

/**
 * Relabels blank nodes in a dataset with fresh labels `prefix0`, `prefix1`,
 * … in a deterministic order derived from their structural signatures.
 *
 * Isomorphic datasets without automorphic blank nodes yield identical
 * results; this is not a full canonicalisation algorithm.
 *
 * @since 0.1.0
 * @category isomorphism
 */
export const relabel = (self: Dataset.Dataset, prefix = 'c'): Dataset.Dataset => {
  const blank = Array.from(self).filter(Term.hasBlankNodes);
  if (Arr.isReadonlyArrayEmpty(blank)) return self;
  const { nodes, labels } = refine(blank);
  const sorted = Arr.sort(
    nodes,
    Order.mapInput(Order.String, (x: string) => labels.get(x)!),
  );
  const mapping = new Map(sorted.map((n, i) => [n, `${prefix}${i}`]));
  return Dataset.map(self, (q) =>
    Term.mapTerms(q, (t) =>
      t._tag === 'BlankNode' ? new Term.BlankNode(mapping.get(t.value)!) : t,
    ),
  );
};
