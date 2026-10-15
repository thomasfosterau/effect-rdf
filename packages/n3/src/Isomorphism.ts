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
import { dual } from 'effect/Function';
import * as Option from 'effect/Option';
import { rdf } from '@thomasfosterau/effect-rdf/Vocab';
import * as Term from '@thomasfosterau/effect-rdf/Term';
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

const hasNodes = (t: Model.N3Term): boolean =>
  Model.blankNodes(t).length > 0 || Model.variables(t).length > 0;

const countBlanks = (self: Model.N3Term | Model.Statement, out: Map<string, number>): void => {
  switch (self._tag) {
    case 'BlankNode':
      out.set(self.value, (out.get(self.value) ?? 0) + 1);
      return;
    case 'Collection':
      for (const i of self.items) countBlanks(i, out);
      return;
    case 'Formula':
      for (const st of self.statements) countBlanks(st, out);
      return;
    case 'Statement':
      countBlanks(self.subject, out);
      countBlanks(self.predicate, out);
      countBlanks(self.object, out);
      return;
    default:
      return;
  }
};

/**
 * Rewrites well-formed `rdf:first`/`rdf:rest` chains of blank nodes into
 * collections, so that explicit RDF lists compare equal to `( … )`.
 */
const normalizeLists = (root: Model.Formula): Model.Formula => {
  const occ = new Map<string, number>();
  countBlanks(root, occ);
  const normalizeFormula = (f: Model.Formula): Model.Formula => {
    const first = new Map<string, Array<Model.Statement>>();
    const rest = new Map<string, Array<Model.Statement>>();
    const other = new Map<string, number>();
    const restTargets = new Set<string>();
    for (const st of f.statements) {
      if (st.subject._tag === 'BlankNode') {
        const b = st.subject.value;
        const p = st.predicate._tag === 'NamedNode' ? st.predicate.value : '';
        const map = p === RDF_FIRST ? first : p === RDF_REST ? rest : undefined;
        if (map === undefined) other.set(b, (other.get(b) ?? 0) + 1);
        else map.set(b, [...(map.get(b) ?? []), st]);
        if (p === RDF_REST && st.object._tag === 'BlankNode') restTargets.add(st.object.value);
      }
    }
    const isCell = (b: string) => first.get(b)?.length === 1 && rest.get(b)?.length === 1;
    const heads = new Map<string, Array<Model.N3Term>>();
    const consumed = new Set<Model.Statement>();
    for (const h of first.keys()) {
      if (restTargets.has(h) || !isCell(h)) continue;
      const o = other.get(h) ?? 0;
      const total = occ.get(h) ?? 0;
      if (!(o === 0 ? total <= 3 : total === 2 + o)) continue;
      const items: Array<Model.N3Term> = [];
      const cells: Array<string> = [];
      let cur: Model.N3Term = new Term.BlankNode(h);
      let ok = true;
      while (!(cur._tag === 'NamedNode' && cur.value === rdf.nil.value)) {
        if (cur._tag !== 'BlankNode' || cells.includes(cur.value) || !isCell(cur.value)) {
          ok = false;
          break;
        }
        if (cur.value !== h && ((other.get(cur.value) ?? 0) > 0 || occ.get(cur.value) !== 3)) {
          ok = false;
          break;
        }
        cells.push(cur.value);
        items.push(first.get(cur.value)![0]!.object);
        cur = rest.get(cur.value)![0]!.object;
      }
      if (!ok) continue;
      heads.set(h, items);
      for (const c of cells) {
        consumed.add(first.get(c)![0]!);
        consumed.add(rest.get(c)![0]!);
      }
    }
    const term = (t: Model.N3Term): Model.N3Term => {
      switch (t._tag) {
        case 'BlankNode': {
          const items = heads.get(t.value);
          return items === undefined
            ? t
            : items.length === 0
              ? rdf.nil
              : new Model.Collection(items.map(term));
        }
        case 'Collection':
          return t.items.length === 0 ? rdf.nil : new Model.Collection(t.items.map(term));
        case 'Formula':
          return normalizeFormula(t);
        default:
          return t;
      }
    };
    return new Model.Formula(
      f.statements
        .filter((st) => !consumed.has(st))
        .map((st) => new Model.Statement(term(st.subject), term(st.predicate), term(st.object))),
    );
  };
  return normalizeFormula(root);
};

const flatten = (self: Model.Formula): Array<Tuple> => {
  const out = new Map<string, Tuple>();
  let counter = 0;
  const formulaNodes = new Map<string, string>();
  const add = (t: Tuple) => out.set(t.join('\u0001'), t);
  const atom = (t: Model.N3Term): string => {
    switch (t._tag) {
      case 'BlankNode':
        return `b:${t.value}`;
      case 'Variable':
        return `v:${t.value}`;
      case 'Collection': {
        if (t.items.length === 0) return RDF_NIL;
        if (!hasNodes(t)) return `=${t.key}`;
        const l = `l:${counter++}`;
        t.items.forEach((item, i) => add([l, `=#${i}`, atom(item), '=list']));
        add([l, '=length', `=${t.items.length}`, '=list']);
        return l;
      }
      case 'Formula': {
        if (!hasNodes(t)) return `=${t.key}`;
        // Formulas are values: equal formulas share one node.
        const known = formulaNodes.get(t.key);
        if (known !== undefined) return known;
        const g = `f:${counter++}`;
        formulaNodes.set(t.key, g);
        statements(t, g);
        return g;
      }
      default:
        return `=${t.key}`;
    }
  };
  const statements = (f: Model.Formula, graph: string) => {
    for (const st of f.statements) {
      add([atom(st.subject), atom(st.predicate), atom(st.object), graph]);
    }
  };
  statements(normalizeLists(self), '=');
  return Array.from(out.values());
};

const hashString = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

const mix = (h: number, v: number): number => {
  let x = Math.imul(h ^ v, 0x5bd1e995);
  x ^= x >>> 15;
  return Math.imul(x, 0x27d4eb2d) >>> 0;
};

interface Partition {
  readonly nodes: ReadonlyArray<string>;
  readonly labels: Map<string, string>;
  readonly byNode: Map<string, Array<Tuple>>;
}

/**
 * Iterative colour refinement: a node's colour is repeatedly refined by the
 * (multiset of) tuples it occurs in, and its positions in them, until the
 * partition is stable.
 */
const refine = (tuples: ReadonlyArray<Tuple>): Partition => {
  const byNode = new Map<string, Array<Tuple>>();
  const index = new Map<string, number>();
  const nodes: Array<string> = [];
  const fixed = new Map<string, number>();
  const nT = tuples.length;
  // Per tuple position: node index (>= 0) or -1, and the fixed hash.
  const nodeAt = new Int32Array(nT * 4);
  const fixedAt = new Uint32Array(nT * 4);
  // Per tuple: bitmask of the positions of each node in it.
  const occurrences: Array<Array<readonly [node: number, tuple: number, mask: number]>> = [];
  for (let ti = 0; ti < nT; ti++) {
    const t = tuples[ti]!;
    const masks = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      const a = t[k]!;
      if (!isNode(a)) {
        let h = fixed.get(a);
        if (h === undefined) fixed.set(a, (h = hashString(a)));
        nodeAt[ti * 4 + k] = -1;
        fixedAt[ti * 4 + k] = h;
        continue;
      }
      let n = index.get(a);
      if (n === undefined) {
        n = nodes.length;
        index.set(a, n);
        nodes.push(a);
        byNode.set(a, []);
        occurrences.push([]);
      }
      nodeAt[ti * 4 + k] = n;
      masks.set(n, (masks.get(n) ?? 0) | (1 << k));
    }
    for (const [n, mask] of masks) {
      byNode.get(nodes[n]!)!.push(t);
      occurrences[n]!.push([n, ti, mask]);
    }
  }
  const nN = nodes.length;
  let colour = new Uint32Array(nN);
  for (let n = 0; n < nN; n++) colour[n] = hashString(kindOf(nodes[n]!));
  const countClasses = (c: Uint32Array) => {
    const sorted = c.slice().sort();
    let count = sorted.length > 0 ? 1 : 0;
    for (let k = 1; k < sorted.length; k++) if (sorted[k] !== sorted[k - 1]) count++;
    return count;
  };
  let classes = countClasses(colour);
  const tupleHash = new Uint32Array(nT);
  for (let round = 0; round <= nN && classes < nN; round++) {
    for (let ti = 0; ti < nT; ti++) {
      let h = 7;
      for (let k = 0; k < 4; k++) {
        const n = nodeAt[ti * 4 + k]!;
        h = mix(h, n >= 0 ? colour[n]! : fixedAt[ti * 4 + k]!);
      }
      tupleHash[ti] = h;
    }
    const next = new Uint32Array(nN);
    for (let n = 0; n < nN; n++) {
      let acc = 0;
      for (const [, ti, mask] of occurrences[n]!) acc = (acc + mix(tupleHash[ti]!, mask)) >>> 0;
      next[n] = mix(colour[n]!, acc);
    }
    const nextClasses = countClasses(next);
    colour = next;
    if (nextClasses === classes) break;
    classes = nextClasses;
  }
  const labels = new Map<string, string>();
  for (let n = 0; n < nN; n++) labels.set(nodes[n]!, colour[n]!.toString(36));
  return { nodes, labels, byNode };
};

const tupleKey = (t: Tuple): string => t.join('\u0001');

const bijectionTuples = (
  a: ReadonlyArray<Tuple>,
  b: ReadonlyArray<Tuple>,
): Option.Option<ReadonlyMap<string, string>> => {
  if (a.length !== b.length) return Option.none();
  const target = new Set(b.map(tupleKey));
  const aNodes: Array<Tuple> = [];
  const bNodes: Array<Tuple> = [];
  for (const t of a) {
    if (t.some(isNode)) aNodes.push(t);
    else if (!target.has(tupleKey(t))) return Option.none();
  }
  for (const t of b) if (t.some(isNode)) bNodes.push(t);
  if (aNodes.length !== bNodes.length) return Option.none();
  if (aNodes.length === 0) return Option.some(new Map());

  const pa = refine(aNodes);
  const pb = refine(bNodes);
  if (pa.nodes.length !== pb.nodes.length) return Option.none();
  const group = (p: Partition) => {
    const groups = new Map<string, Array<string>>();
    for (const n of p.nodes) {
      const l = p.labels.get(n)!;
      let g = groups.get(l);
      if (g === undefined) groups.set(l, (g = []));
      g.push(n);
    }
    return groups;
  };
  const groupsA = group(pa);
  const groupsB = group(pb);
  for (const [l, g] of groupsA) if (groupsB.get(l)?.length !== g.length) return Option.none();

  const mapping = new Map<string, string>();
  const used = new Set<string>();
  const consistent = (node: string): boolean => {
    for (const t of pa.byNode.get(node)!) {
      let complete = true;
      for (const x of t) if (isNode(x) && !mapping.has(x)) complete = false;
      if (complete && !target.has(t.map((x) => (isNode(x) ? mapping.get(x)! : x)).join('\u0001'))) {
        return false;
      }
    }
    return true;
  };
  // Nodes in singleton classes are mapped directly.
  const ambiguous: Array<string> = [];
  for (const n of pa.nodes) {
    const candidates = groupsB.get(pa.labels.get(n)!)!;
    if (candidates.length === 1) {
      mapping.set(n, candidates[0]!);
      used.add(candidates[0]!);
    } else ambiguous.push(n);
  }
  for (const n of mapping.keys()) if (!consistent(n)) return Option.none();
  // Iterative backtracking over the ambiguous nodes, smallest classes first.
  const order = ambiguous.sort(
    (x, y) => groupsA.get(pa.labels.get(x)!)!.length - groupsA.get(pa.labels.get(y)!)!.length,
  );
  const next = new Array<number>(order.length).fill(0);
  let i = 0;
  while (i >= 0 && i < order.length) {
    const node = order[i]!;
    const previous = mapping.get(node);
    if (previous !== undefined) {
      mapping.delete(node);
      used.delete(previous);
    }
    const candidates = groupsB.get(pa.labels.get(node)!)!;
    let found = false;
    while (next[i]! < candidates.length) {
      const candidate = candidates[next[i]!++]!;
      if (used.has(candidate)) continue;
      mapping.set(node, candidate);
      used.add(candidate);
      if (consistent(node)) {
        found = true;
        break;
      }
      mapping.delete(node);
      used.delete(candidate);
    }
    if (found) i++;
    else {
      next[i] = 0;
      i--;
    }
  }
  return i === order.length ? Option.some(mapping) : Option.none();
};

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
  Option.map(bijectionTuples(flatten(self), flatten(that)), (m) => {
    const out = new Map<string, string>();
    for (const [k, v] of m) {
      if (k.startsWith('l:') || k.startsWith('f:')) continue;
      const render = (a: string) => (a.startsWith('b:') ? `_:${a.slice(2)}` : `?${a.slice(2)}`);
      out.set(render(k), render(v));
    }
    return out;
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
