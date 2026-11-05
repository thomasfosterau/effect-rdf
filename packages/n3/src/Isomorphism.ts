/**
 * Isomorphism of N3 formulas.
 *
 * Two formulas are isomorphic when they are equal up to a consistent
 * renaming of blank nodes and of variables (alpha-equivalence). Unlike the
 * core RDF isomorphism, blank nodes and variables may occur in any position
 * (including predicates), and the comparison recurses into nested formulas.
 *
 * Well-formed explicit RDF lists (`rdf:first`/`rdf:rest` chains of blank
 * nodes) are normalised to collections first, so `( 1 2 )` is isomorphic to
 * the equivalent blank node chain produced by RDF-only syntaxes such as
 * N-Triples.
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
import { rdf } from '@thomasfosterau/effect-rdf/Vocab';
import * as Guards from './internal/guards.ts';
import * as Lists from './internal/lists.ts';
import { loop } from './internal/loop.ts';
import * as Model from './Model.ts';

// A flattened formula: 4-tuples (subject, predicate, object, graph) of atoms.
// Atoms are either fixed (`=` + canonical key) or relabelable nodes
// (`b:` blank node, `v:` variable, `f:` formula, `l:` collection). Formulas
// and collections without blank nodes or variables are fixed atoms.
type Tuple = readonly [string, string, string, string];

const isNode = (atom: string): boolean => atom.charCodeAt(0) !== 0x3d; /* = */
const kindOf = (atom: string): string => atom.slice(0, 2);

const RDF_FIRST = rdf.first.value;
const RDF_REST = rdf.rest.value;
const RDF_NIL = `=${rdf.nil.key}`;

/** The separator of the atoms in a tuple's key (no atom contains it). */
const SEP = '\u0001';

/** Whether a term contains a blank node or a variable (in any nested formula or collection). */
const hasNodes = (t: Model.N3Term | Model.Statement): boolean =>
  t instanceof Model.Statement
    ? hasNodes(t.subject) || hasNodes(t.predicate) || hasNodes(t.object)
    : t instanceof Model.Formula
      ? t.statements.some(hasNodes)
      : t instanceof Model.Collection
        ? t.items.some(hasNodes)
        : Guards.isBlankNode(t) || Guards.isVariable(t);

/** Counts the occurrences of each blank node label (plain refinements: it visits every term). */
const countBlanks = (
  self: Model.N3Term | Model.Statement,
  out: MutableHashMap.MutableHashMap<string, number>,
): void => {
  if (self instanceof Model.Statement) {
    countBlanks(self.subject, out);
    countBlanks(self.predicate, out);
    countBlanks(self.object, out);
  } else if (self instanceof Model.Formula) {
    self.statements.forEach((st) => countBlanks(st, out));
  } else if (self instanceof Model.Collection) {
    self.items.forEach((i) => countBlanks(i, out));
  } else if (Guards.isBlankNode(self)) {
    Lists.increment(out, self.value);
  }
};

/**
 * Rewrites well-formed `rdf:first`/`rdf:rest` chains of blank nodes into
 * collections, so that explicit RDF lists compare equal to `( … )`.
 */
const normalizeLists = (root: Model.Formula): Model.Formula => {
  const occ = MutableHashMap.empty<string, number>();
  countBlanks(root, occ);
  const normalizeFormula = (f: Model.Formula): Model.Formula => {
    const first = MutableHashMap.empty<string, Array<Model.Statement>>();
    const rest = MutableHashMap.empty<string, Array<Model.Statement>>();
    const other = MutableHashMap.empty<string, number>();
    const restTargets = MutableHashSet.empty<string>();
    f.statements.forEach((st) => {
      if (!Guards.isBlankNode(st.subject)) return;
      const b = st.subject.value;
      const p = Guards.isNamedNode(st.predicate) ? st.predicate.value : '';
      if (p === RDF_FIRST) Lists.append(first, b, st);
      else if (p === RDF_REST) Lists.append(rest, b, st);
      else Lists.increment(other, b);
      if (p === RDF_REST && Guards.isBlankNode(st.object)) {
        MutableHashSet.add(restTargets, st.object.value);
      }
    });
    // A cell: one `rdf:first` and one `rdf:rest`; after the head, used only by the list
    const cellOf = (label: string, isHead: boolean): Option.Option<Lists.Cell<Model.Statement>> =>
      !isHead && (Lists.count(other, label) > 0 || Lists.count(occ, label) !== 3)
        ? Option.none()
        : Option.zipWith(Lists.single(first, label), Lists.single(rest, label), (a, b) => [a, b]);
    const heads = MutableHashMap.empty<string, Array<Model.N3Term>>();
    const consumed = new WeakSet<Model.Statement>();
    MutableHashMap.forEach(first, (_, h) => {
      if (MutableHashSet.has(restTargets, h) || Option.isNone(cellOf(h, true))) return;
      const o = Lists.count(other, h);
      const total = Lists.count(occ, h);
      if (!(o === 0 ? total <= 3 : total === 2 + o)) return;
      const cells = Lists.followList(h, cellOf);
      if (Option.isSome(cells)) Lists.record(heads, consumed, h, cells.value);
    });
    const term = (t: Model.N3Term): Model.N3Term => normalizeTerm(t, heads);
    return new Model.Formula(
      f.statements
        .filter((st) => !consumed.has(st))
        .map((st) => new Model.Statement(term(st.subject), term(st.predicate), term(st.object))),
    );
  };
  // Plain refinements rather than `Match`: it runs for every term.
  const normalizeTerm = (
    t: Model.N3Term,
    heads: MutableHashMap.MutableHashMap<string, Array<Model.N3Term>>,
  ): Model.N3Term => {
    if (Guards.isBlankNode(t)) {
      const items = heads.backing.get(t.value);
      return items === undefined
        ? t
        : Arr.isReadonlyArrayEmpty(items)
          ? rdf.nil
          : new Model.Collection(items.map((i) => normalizeTerm(i, heads)));
    }
    if (t instanceof Model.Collection) {
      return Arr.isReadonlyArrayEmpty(t.items)
        ? rdf.nil
        : new Model.Collection(t.items.map((i) => normalizeTerm(i, heads)));
    }
    return t instanceof Model.Formula ? normalizeFormula(t) : t;
  };
  return normalizeFormula(root);
};

const flatten = (self: Model.Formula): Array<Tuple> => {
  const out = MutableHashMap.empty<string, Tuple>();
  let counter = 0;
  const formulaNodes = MutableHashMap.empty<string, string>();
  const add = (t: Tuple) => MutableHashMap.set(out, t.join(SEP), t);
  // Plain refinements rather than `Match`: it runs for every term.
  const atom = (t: Model.N3Term): string => {
    if (Guards.isBlankNode(t)) return `b:${t.value}`;
    if (Guards.isVariable(t)) return `v:${t.value}`;
    if (t instanceof Model.Collection) {
      if (Arr.isReadonlyArrayEmpty(t.items)) return RDF_NIL;
      if (!hasNodes(t)) return `=${t.key}`;
      const l = `l:${counter++}`;
      t.items.forEach((item, i) => add([l, `=#${i}`, atom(item), '=list']));
      add([l, '=length', `=${t.items.length}`, '=list']);
      return l;
    }
    if (t instanceof Model.Formula) {
      if (!hasNodes(t)) return `=${t.key}`;
      // Formulas are values: equal formulas share one node.
      const known = formulaNodes.backing.get(t.key);
      if (known !== undefined) return known;
      const g = `f:${counter++}`;
      MutableHashMap.set(formulaNodes, t.key, g);
      statements(t, g);
      return g;
    }
    return `=${t.key}`;
  };
  const statements = (f: Model.Formula, graph: string) => {
    f.statements.forEach((st) => {
      add([atom(st.subject), atom(st.predicate), atom(st.object), graph]);
    });
  };
  statements(normalizeLists(self), '=');
  return Arr.fromIterable(MutableHashMap.values(out));
};

const hashString = (s: string): number => {
  let h = 0x811c9dc5;
  loop((i) => {
    if (i >= s.length) return false;
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return true;
  });
  return h >>> 0;
};

const mix = (h: number, v: number): number => {
  let x = Math.imul(h ^ v, 0x5bd1e995);
  x ^= x >>> 15;
  return Math.imul(x, 0x27d4eb2d) >>> 0;
};

/** The tuples' nodes, indexed in order of first occurrence, with their stable colours. */
interface Partition {
  readonly tuples: ReadonlyArray<Tuple>;
  readonly nodes: ReadonlyArray<string>;
  readonly colour: Uint32Array;
  /** Per node: the indices of the tuples it occurs in. */
  readonly byNode: ReadonlyArray<ReadonlyArray<number>>;
  /** Per tuple position: the index of its node (>= 0), or -1 for a fixed atom. */
  readonly nodeAt: Int32Array;
}

/** The number of distinct colours in a colouring. */
const countClasses = (c: Uint32Array): number => {
  const sorted = c.toSorted();
  return sorted.reduce((count, v, k) => (k === 0 || v !== sorted[k - 1] ? count + 1 : count), 0);
};

/**
 * Iterative colour refinement: a node's colour is repeatedly refined by the
 * (multiset of) tuples it occurs in, and its positions in them, until the
 * partition is stable.
 */
const refine = (tuples: ReadonlyArray<Tuple>): Partition => {
  const index = MutableHashMap.empty<string, number>();
  const nodes: Array<string> = [];
  const byNode: Array<Array<number>> = [];
  const fixed = MutableHashMap.empty<string, number>();
  const nT = tuples.length;
  // Per tuple position: node index (>= 0) or -1, and the fixed hash.
  const nodeAt = new Int32Array(nT * 4);
  const fixedAt = new Uint32Array(nT * 4);
  // Per node: the tuples it occurs in, with the bitmask of its positions in each.
  const occurrences: Array<Array<readonly [tuple: number, mask: number]>> = [];
  tuples.forEach((t, ti) => {
    // The distinct nodes of the tuple, in order, with their position masks.
    const seen: Array<number> = [];
    const masks: Array<number> = [];
    t.forEach((a, k) => {
      if (!isNode(a)) {
        let h = fixed.backing.get(a);
        if (h === undefined) {
          h = hashString(a);
          MutableHashMap.set(fixed, a, h);
        }
        nodeAt[ti * 4 + k] = -1;
        fixedAt[ti * 4 + k] = h;
        return;
      }
      let n = index.backing.get(a);
      if (n === undefined) {
        n = nodes.length;
        MutableHashMap.set(index, a, n);
        nodes.push(a);
        byNode.push([]);
        occurrences.push([]);
      }
      nodeAt[ti * 4 + k] = n;
      const j = seen.indexOf(n);
      if (j < 0) {
        seen.push(n);
        masks.push(1 << k);
      } else masks[j] = (masks[j] ?? 0) | (1 << k);
    });
    seen.forEach((n, j) => {
      byNode[n]?.push(ti);
      occurrences[n]?.push([ti, masks[j] ?? 0]);
    });
  });
  const nN = nodes.length;
  let colour = Uint32Array.from(nodes, (a) => hashString(kindOf(a)));
  let classes = countClasses(colour);
  const tupleHash = new Uint32Array(nT);
  const valueAt = (p: number): number => {
    const n = nodeAt[p] ?? -1;
    return n >= 0 ? (colour[n] ?? 0) : (fixedAt[p] ?? 0);
  };
  loop((round) => {
    if (round > nN || classes >= nN) return false;
    tupleHash.forEach((_, ti) => {
      const at = ti * 4;
      tupleHash[ti] = mix(
        mix(mix(mix(7, valueAt(at)), valueAt(at + 1)), valueAt(at + 2)),
        valueAt(at + 3),
      );
    });
    const next = Uint32Array.from(occurrences, (occ, n) =>
      mix(
        colour[n] ?? 0,
        occ.reduce((acc, [ti, mask]) => (acc + mix(tupleHash[ti] ?? 0, mask)) >>> 0, 0),
      ),
    );
    const nextClasses = countClasses(next);
    colour = next;
    if (nextClasses === classes) return false;
    classes = nextClasses;
    return true;
  });
  return { tuples, nodes, colour, byNode, nodeAt };
};

const tupleKey = (t: Tuple): string => t.join(SEP);

/** Groups a partition's nodes (by index, in order) by their colour. */
const groupByColour = (p: Partition): MutableHashMap.MutableHashMap<number, Array<number>> => {
  const groups = MutableHashMap.empty<number, Array<number>>();
  p.colour.forEach((c, n) => {
    const g = groups.backing.get(c);
    if (g === undefined) MutableHashMap.set(groups, c, [n]);
    else g.push(n);
  });
  return groups;
};

const noNodes: ReadonlyArray<number> = [];

/**
 * A renaming of the nodes of `a` to those of `b` under which the tuples are
 * the same, as `[node of a, node of b]` pairs: those mapped directly, in
 * order of first occurrence, then those found by backtracking.
 */
const bijectionTuples = (
  a: ReadonlyArray<Tuple>,
  b: ReadonlyArray<Tuple>,
): Option.Option<ReadonlyArray<readonly [string, string]>> => {
  if (a.length !== b.length) return Option.none();
  const target = MutableHashMap.empty<string, boolean>();
  b.forEach((t) => MutableHashMap.set(target, tupleKey(t), true));
  const targets = target.backing;
  const aNodes: Array<Tuple> = [];
  const fixedFound = a.every((t) => {
    if (!t.some(isNode)) return targets.has(tupleKey(t));
    aNodes.push(t);
    return true;
  });
  if (!fixedFound) return Option.none();
  const bNodes = b.filter((t) => t.some(isNode));
  if (aNodes.length !== bNodes.length) return Option.none();
  if (Arr.isReadonlyArrayEmpty(aNodes)) return Option.some([]);

  const pa = refine(aNodes);
  const pb = refine(bNodes);
  if (pa.nodes.length !== pb.nodes.length) return Option.none();
  const groupsA = groupByColour(pa);
  const groupsB = groupByColour(pb);
  const candidatesOf = (n: number): ReadonlyArray<number> =>
    groupsB.backing.get(pa.colour[n] ?? 0) ?? noNodes;
  if (Iterable.some(groupsA, ([c, g]) => groupsB.backing.get(c)?.length !== g.length)) {
    return Option.none();
  }

  // Per node of `a`: the index of the node of `b` it is mapped to, or -1.
  const mapping = new Int32Array(pa.nodes.length).fill(-1);
  const used = new Uint8Array(pb.nodes.length);
  /** Position `p` of tuple `t` under the mapping (`''` while its node is unmapped). */
  const mapped = (t: Tuple, p: number): string => {
    const n = pa.nodeAt[p] ?? -1;
    const atom = t[p & 3] ?? '';
    if (n < 0) return atom;
    const m = mapping[n] ?? -1;
    return m < 0 ? '' : (pb.nodes[m] ?? '');
  };
  const consistent = (node: number): boolean =>
    (pa.byNode[node] ?? noNodes).every((ti) => {
      const t = pa.tuples[ti] ?? emptyTuple;
      const at = ti * 4;
      const s = mapped(t, at);
      const p = mapped(t, at + 1);
      const o = mapped(t, at + 2);
      const g = mapped(t, at + 3);
      // Tuples with a node still unmapped are checked once it is
      if (s === '' || p === '' || o === '' || g === '') return true;
      return targets.has(`${s}${SEP}${p}${SEP}${o}${SEP}${g}`);
    });
  // Nodes in singleton classes are mapped directly.
  const direct: Array<number> = [];
  const ambiguous: Array<number> = [];
  pa.nodes.forEach((_, n) => {
    const candidates = candidatesOf(n);
    const only = candidates[0] ?? 0;
    if (candidates.length === 1) {
      mapping[n] = only;
      used[only] = 1;
      direct.push(n);
    } else ambiguous.push(n);
  });
  if (!direct.every(consistent)) return Option.none();
  // Iterative backtracking over the ambiguous nodes, smallest classes first.
  const order = Arr.sort(
    ambiguous,
    Order.mapInput(
      Order.Number,
      (n: number) => groupsA.backing.get(pa.colour[n] ?? 0)?.length ?? 0,
    ),
  );
  const next = new Int32Array(order.length);
  let i = 0;
  // The node being placed, its candidates, and whether one was found
  let node = 0;
  let candidates = noNodes;
  let found = false;
  const tryNext = (): boolean => {
    const k = next[i] ?? 0;
    if (k >= candidates.length) return false;
    next[i] = k + 1;
    const candidate = candidates[k] ?? 0;
    if (used[candidate] === 1) return true;
    mapping[node] = candidate;
    used[candidate] = 1;
    if (consistent(node)) {
      found = true;
      return false;
    }
    mapping[node] = -1;
    used[candidate] = 0;
    return true;
  };
  loop(() => {
    if (i < 0 || i >= order.length) return false;
    node = order[i] ?? 0;
    const previous = mapping[node] ?? -1;
    if (previous >= 0) {
      mapping[node] = -1;
      used[previous] = 0;
    }
    candidates = candidatesOf(node);
    found = false;
    loop(tryNext);
    if (found) i++;
    else {
      next[i] = 0;
      i--;
    }
    return true;
  });
  if (i !== order.length) return Option.none();
  const pair = (n: number): readonly [string, string] => [
    pa.nodes[n] ?? '',
    pb.nodes[mapping[n] ?? 0] ?? '',
  ];
  return Option.some(Arr.appendAll(direct.map(pair), order.map(pair)));
};

const emptyTuple: Tuple = ['', '', '', ''];

/** Renders an internal `b:` / `v:` node key as `_:label` / `?name`. */
const renderNode = (a: string) => (a.startsWith('b:') ? `_:${a.slice(2)}` : `?${a.slice(2)}`);

/**
 * Finds a renaming of blank nodes and variables from `self` to `that` under
 * which the two formulas are equal. Keys of the returned map are
 * `_:label` / `?name` of `self`, values those of `that` (nodes generated for
 * collections and nested formulas are omitted).
 *
 * @since 0.1.0
 * @category isomorphism
 */
export const bijection = (
  self: Model.Formula,
  that: Model.Formula,
): Option.Option<ReadonlyMap<string, string>> =>
  Option.map(bijectionTuples(flatten(self), flatten(that)), (pairs) => {
    const out = MutableHashMap.empty<string, string>();
    pairs.forEach(([k, v]) => {
      if (!k.startsWith('l:') && !k.startsWith('f:'))
        MutableHashMap.set(out, renderNode(k), renderNode(v));
    });
    return out.backing;
  });

/**
 * Whether two formulas are isomorphic: equal up to a consistent renaming of
 * blank nodes and variables, recursively through nested formulas.
 *
 * @since 0.1.0
 * @category isomorphism
 */
export const isomorphic: {
  (that: Model.Formula): (self: Model.Formula) => boolean;
  (self: Model.Formula, that: Model.Formula): boolean;
} = dual(2, (self: Model.Formula, that: Model.Formula): boolean =>
  Option.isSome(bijectionTuples(flatten(self), flatten(that))),
);
