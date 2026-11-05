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
import * as Iterable from 'effect/Iterable';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Dataset from './Dataset.ts';
import { loop } from './internal/loop.ts';
import * as Term from './Term.ts';

/** Blank node labels, by blank node label. */
type Labels = MutableHashMap.MutableHashMap<string, string>;

const fnv = (s: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  loop((i) => {
    if (i >= s.length) return false;
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    return true;
  });
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
};

/** Appends the blank nodes of `t` (and of the triple terms inside it) to `out`, each once. */
const collectBlankNodes = (t: Term.Term, out: Array<string>): void => {
  if (Term.isBlankNode(t)) {
    if (!out.includes(t.value)) out.push(t.value);
  } else if (Term.isTriple(t)) {
    collectBlankNodes(t.subject, out);
    collectBlankNodes(t.object, out);
  }
};

/** The distinct blank nodes of a quad, in order of first occurrence. */
const quadBlankNodes = (q: Term.Quad): ReadonlyArray<string> => {
  const out: Array<string> = [];
  collectBlankNodes(q.subject, out);
  collectBlankNodes(q.object, out);
  collectBlankNodes(q.graph, out);
  return out;
};

const labelOf = (labels: Labels, node: string): string =>
  Option.getOrElse(MutableHashMap.get(labels, node), () => '');

/**
 * A quad's signature for one of its blank nodes, compiled once: text, and in
 * between the indexes (into `Partition.nodes`) of the other blank nodes,
 * whose current labels each refinement round fills in. The node itself is
 * `@self`.
 */
type Template = ReadonlyArray<string | number>;

const compile = (
  t: Term.Term,
  self: string,
  index: MutableHashMap.MutableHashMap<string, number>,
  out: Array<string | number>,
): void => {
  if (Term.isBlankNode(t)) {
    if (t.value === self) out.push('@self');
    else out.push(Option.getOrElse(MutableHashMap.get(index, t.value), () => '@'));
  } else if (Term.isTriple(t)) {
    out.push('<<');
    compile(t.subject, self, index, out);
    out.push(` ${t.predicate.key} `);
    compile(t.object, self, index, out);
    out.push('>>');
  } else out.push(t.key);
};

const template = (
  q: Term.Quad,
  self: string,
  index: MutableHashMap.MutableHashMap<string, number>,
): Template => {
  const out: Array<string | number> = [];
  compile(q.subject, self, index, out);
  out.push(` ${q.predicate.key} `);
  compile(q.object, self, index, out);
  out.push(' ');
  compile(q.graph, self, index, out);
  return out;
};

/** A template with the blank nodes' labels filled in. */
const render = (t: Template, labels: ReadonlyArray<string>): string =>
  t.map((part) => (Predicate.isString(part) ? part : `@${labels[part] ?? ''}`)).join('');

interface Partition {
  readonly nodes: ReadonlyArray<string>;
  readonly labels: Labels;
  readonly byNode: MutableHashMap.MutableHashMap<string, Array<Term.Quad>>;
}

/** The quads a blank node occurs in. */
const quadsOf = (p: Partition, node: string): ReadonlyArray<Term.Quad> =>
  Option.getOrElse(MutableHashMap.get(p.byNode, node), () => []);

const refine = (quads: ReadonlyArray<Term.Quad>): Partition => {
  const byNode = MutableHashMap.empty<string, Array<Term.Quad>>();
  quads.forEach((q) => {
    quadBlankNodes(q).forEach((b) => {
      const list = MutableHashMap.get(byNode, b);
      if (Option.isSome(list)) list.value.push(q);
      else MutableHashMap.set(byNode, b, [q]);
    });
  });
  const nodes = Arr.fromIterable(MutableHashMap.keys(byNode));
  const index = MutableHashMap.fromIterable(nodes.map((n, i) => [n, i] as const));
  const templates = nodes.map((n) =>
    Option.getOrElse(MutableHashMap.get(byNode, n), () => []).map((q) => template(q, n, index)),
  );
  let labels: ReadonlyArray<string> = nodes.map(() => '');
  let classes = 1;
  // Refine until the number of classes stops growing (at most one round per node)
  loop((round) => {
    if (round > nodes.length) return false;
    const current = labels;
    const next = templates.map((ts, i) =>
      fnv(
        `${current[i] ?? ''}|${Arr.sort(
          ts.map((t) => render(t, current)),
          Order.String,
        ).join('\n')}`,
      ),
    );
    const nextClasses = MutableHashSet.size(MutableHashSet.fromIterable(next));
    labels = next;
    if (nextClasses === classes) return false;
    classes = nextClasses;
    return true;
  });
  const final = labels;
  return {
    nodes,
    labels: MutableHashMap.fromIterable(nodes.map((n, i) => [n, final[i] ?? ''] as const)),
    byNode,
  };
};

/** `q` with its blank nodes renamed by `mapping` (those it does not map are kept). */
const renameBlankNodes = (q: Term.Quad, mapping: Labels): Term.Quad =>
  Term.mapTerms(q, (t) =>
    Term.isBlankNode(t)
      ? new Term.BlankNode(Option.getOrElse(MutableHashMap.get(mapping, t.value), () => t.value))
      : t,
  );

const rename = (q: Term.Quad, mapping: Labels): string => renameBlankNodes(q, mapping).key;

/** The blank nodes of a partition grouped by label, in order. */
const groupsOf = (p: Partition): MutableHashMap.MutableHashMap<string, Array<string>> => {
  const groups = MutableHashMap.empty<string, Array<string>>();
  p.nodes.forEach((n) => {
    const l = labelOf(p.labels, n);
    const group = MutableHashMap.get(groups, l);
    if (Option.isSome(group)) group.value.push(n);
    else MutableHashMap.set(groups, l, [n]);
  });
  return groups;
};

/** The class of `node`: the nodes of `groups` with its label in `labels`. */
const classOf = (
  groups: MutableHashMap.MutableHashMap<string, ReadonlyArray<string>>,
  labels: Labels,
  node: string,
): ReadonlyArray<string> =>
  Option.getOrElse(MutableHashMap.get(groups, labelOf(labels, node)), () => []);

/**
 * The public result of `bijection`: a native `ReadonlyMap`, copied once
 * from the search's map at the end.
 */
const toReadonlyMap = (mapping: Labels): ReadonlyMap<string, string> => new Map(mapping);

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
  const groundMissing = Iterable.some(self, (q) => {
    if (!Term.hasBlankNodes(q)) return !Dataset.has(that, q);
    aBlank.push(q);
    return false;
  });
  if (groundMissing) return Option.none();
  const bBlank = Arr.filter(Arr.fromIterable(that), (q) => Term.hasBlankNodes(q));
  if (aBlank.length !== bBlank.length) return Option.none();
  if (Arr.isReadonlyArrayEmpty(aBlank)) return Option.some(toReadonlyMap(MutableHashMap.empty()));

  const a = refine(aBlank);
  const b = refine(bBlank);
  if (a.nodes.length !== b.nodes.length) return Option.none();

  const groupsB = groupsOf(b);
  const groupsA = groupsOf(a);
  const sameClasses = !Iterable.some(
    groupsA,
    ([l, g]) => !Option.exists(MutableHashMap.get(groupsB, l), (gb) => gb.length === g.length),
  );
  if (!sameClasses) return Option.none();

  const target = MutableHashSet.fromIterable(bBlank.map((q) => q.key));
  const mapping: Labels = MutableHashMap.empty();
  const used = MutableHashSet.empty<string>();
  // Assign unambiguous nodes first, then search the rest smallest class first.
  const order = Arr.sort(
    a.nodes,
    Order.mapInput(Order.Number, (x: string) => classOf(groupsA, a.labels, x).length),
  );

  const consistent = (node: string): boolean =>
    !quadsOf(a, node).some((q) => {
      const complete = quadBlankNodes(q).every((x) => MutableHashMap.has(mapping, x));
      return complete && !MutableHashSet.has(target, rename(q, mapping));
    });

  // Iterative depth-first search (graphs can have many thousands of blank nodes).
  const cursors: Array<number> = [0];
  let found = false;
  loop(() => {
    const i = cursors.length - 1;
    const node = order[i];
    if (i < 0 || node === undefined) {
      // The search is exhausted, or every node is assigned
      found = i === order.length;
      return false;
    }
    const candidates = classOf(groupsB, a.labels, node);
    const previous = MutableHashMap.get(mapping, node);
    if (Option.isSome(previous)) {
      MutableHashMap.remove(mapping, node);
      MutableHashSet.remove(used, previous.value);
    }
    let next = cursors[i] ?? 0;
    let advanced = false;
    loop(() => {
      const candidate = candidates[next];
      if (candidate === undefined) return false;
      next++;
      if (MutableHashSet.has(used, candidate)) return true;
      MutableHashMap.set(mapping, node, candidate);
      MutableHashSet.add(used, candidate);
      if (consistent(node)) {
        advanced = true;
        return false;
      }
      MutableHashMap.remove(mapping, node);
      MutableHashSet.remove(used, candidate);
      return true;
    });
    cursors[i] = next;
    if (advanced) cursors.push(0);
    else cursors.pop();
    return true;
  });
  return found ? Option.some(toReadonlyMap(mapping)) : Option.none();
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
    Order.mapInput(Order.String, (x: string) => labelOf(labels, x)),
  );
  const mapping: Labels = MutableHashMap.fromIterable(
    sorted.map((n, i) => [n, `${prefix}${i}`] as const),
  );
  return Dataset.map(self, (q) => renameBlankNodes(q, mapping));
};
