/**
 * Mapping between the N3 model and core RDF datasets.
 *
 * ## N3 → RDF (`toDataset`)
 *
 * - Top-level statements become quads in the default graph.
 * - Every occurrence of a formula `{ … }` becomes a fresh blank node `_:g`
 *   used in place of the formula, and the formula's statements become quads
 *   in the named graph `_:g` (recursively for nested formulas).
 * - Collections become `rdf:first` / `rdf:rest` chains of fresh blank nodes
 *   (in the graph where the collection occurs); `()` is `rdf:nil`.
 * - IRIs, blank nodes and literals are kept as they are.
 *
 * Constructs with no RDF counterpart fail with `UnrepresentableError`:
 * variables anywhere, literals as subjects, and anything other than an IRI
 * as a predicate.
 *
 * ## RDF → N3 (`fromDataset`)
 *
 * The inverse mapping: a named graph whose name is a blank node that is also
 * used as a term (subject or object, in any graph) becomes a formula, which
 * replaces every occurrence of that blank node; well-formed `rdf:first` /
 * `rdf:rest` chains of blank nodes become collections. Graphs named by IRIs,
 * blank-node graphs that are never used as terms, cyclic graph references and
 * RDF 1.2 triple terms cannot be represented and fail with
 * `UnrepresentableError`.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf } from '@thomasfosterau/effect-rdf/Vocab';
import * as Model from './Model.ts';

/**
 * An N3 construct that has no representation in the target model (e.g. a
 * variable in an RDF dataset, or an IRI-named graph in N3).
 *
 * @since 0.1.0
 * @category errors
 */
export class UnrepresentableError extends Schema.TaggedError<UnrepresentableError>()(
  'N3UnrepresentableError',
  { message: Schema.String },
) {}

class Failure {
  constructor(readonly message: string) {}
}

const guard = <A>(f: () => A): Effect.Effect<A, UnrepresentableError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f());
    } catch (e) {
      if (e instanceof Failure)
        return Effect.fail(new UnrepresentableError({ message: e.message }));
      throw e;
    }
  });

/**
 * @since 0.1.0
 * @category models
 */
export interface ToDatasetOptions {
  /** Prefix for the labels of blank nodes generated for formulas and lists. */
  readonly blankNodePrefix?: string | undefined;
}

/**
 * Converts a formula (or document) to quads, failing with
 * `UnrepresentableError` for constructs that are not RDF. Throws the
 * internal failure; used by `toDataset` and the parser.
 *
 * @internal
 */
export const toQuadsUnsafe = (
  self: Model.Formula,
  options?: ToDatasetOptions,
): Array<Term.Quad> => {
  const prefix = options?.blankNodePrefix ?? '';
  const reserved = new Set(Model.blankNodes(self).map((b) => b.value));
  let counter = 0;
  const fresh = (): Term.BlankNode => {
    for (;;) {
      const label = `${prefix}g${(counter++).toString(36)}`;
      if (!reserved.has(label)) return new Term.BlankNode(label);
    }
  };
  const out: Array<Term.Quad> = [];
  const term = (
    t: Model.N3Term,
    graph: Term.Graph,
  ): Term.NamedNode | Term.BlankNode | Term.Literal => {
    switch (t._tag) {
      case 'Variable':
        throw new Failure(`Variable ${t.key} cannot be represented in RDF`);
      case 'Collection': {
        if (t.items.length === 0) return rdf.nil;
        const nodes = t.items.map(fresh);
        t.items.forEach((item, i) => {
          out.push(new Term.Quad(nodes[i]!, rdf.first, term(item, graph), graph));
          out.push(new Term.Quad(nodes[i]!, rdf.rest, nodes[i + 1] ?? rdf.nil, graph));
        });
        return nodes[0]!;
      }
      case 'Formula': {
        const g = fresh();
        statements(t, g);
        return g;
      }
      default:
        return t;
    }
  };
  const statements = (f: Model.Formula, graph: Term.Graph) => {
    for (const s of f.statements) {
      const subject = term(s.subject, graph);
      const predicate = term(s.predicate, graph);
      const object = term(s.object, graph);
      if (subject._tag === 'Literal') {
        throw new Failure(`Literal ${subject.key} cannot be the subject of an RDF triple`);
      }
      if (predicate._tag !== 'NamedNode') {
        throw new Failure(`${predicate.key} cannot be the predicate of an RDF triple`);
      }
      out.push(new Term.Quad(subject, predicate, object, graph));
    }
  };
  statements(self, Term.defaultGraph);
  return out;
};

/**
 * Converts an N3 formula or document to a core RDF `Dataset` (see the
 * module documentation for the mapping).
 *
 * @since 0.1.0
 * @category conversions
 */
export const toDataset = (
  self: Model.Formula | Model.Document,
  options?: ToDatasetOptions,
): Effect.Effect<Dataset.Dataset, UnrepresentableError> =>
  guard(() =>
    Dataset.fromIterable(toQuadsUnsafe(Model.isFormula(self) ? self : self.formula, options)),
  );

/**
 * Whether a formula is in the RDF-compatible subset of N3 (no variables, no
 * literal subjects, only IRI predicates).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isRdfCompatible = (self: Model.Formula): boolean => {
  try {
    toQuadsUnsafe(self);
    return true;
  } catch (e) {
    if (e instanceof Failure) return false;
    throw e;
  }
};

// -----------------------------------------------------------------------------
// RDF → N3
// -----------------------------------------------------------------------------

type Ground = Term.NamedNode | Term.BlankNode | Term.Literal;

/** @internal */
export const fromQuadsUnsafe = (quads: Iterable<Term.Quad>): Model.Formula => {
  const all = Array.from(quads).sort(Term.compareQuads);
  const graphs = new Map<string, Array<Term.Quad>>();
  // Occurrences of blank nodes as subject/object, per graph and in total.
  const occurrences = new Map<string, Map<string, number>>();
  const note = (t: Term.Term, graph: string) => {
    if (t._tag === 'Triple') {
      throw new Failure(`Triple term ${t.key} cannot be represented in N3`);
    }
    if (t._tag !== 'BlankNode') return;
    let m = occurrences.get(t.value);
    if (m === undefined) occurrences.set(t.value, (m = new Map()));
    m.set(graph, (m.get(graph) ?? 0) + 1);
  };
  for (const q of all) {
    const g = q.graph.key;
    let list = graphs.get(g);
    if (list === undefined) graphs.set(g, (list = []));
    list.push(q);
    note(q.subject, g);
    note(q.object, g);
  }
  const formulaGraphs = new Set<string>();
  for (const [key, list] of graphs) {
    if (key === '') continue;
    const name = list[0]!.graph;
    if (name._tag !== 'BlankNode' || !occurrences.has(name.value)) {
      throw new Failure(
        `Named graph ${name.key} cannot be represented in N3: only graphs named by blank nodes that are used as terms map to formulas`,
      );
    }
    formulaGraphs.add(name.value);
  }

  const formulas = new Map<string, Model.Formula>();
  const building = new Set<string>();

  const buildGraph = (key: string): Model.Formula => {
    const quads = graphs.get(key) ?? [];
    const lists = foldLists(quads, key);
    const term = (t: Ground): Model.N3Term => {
      if (t._tag !== 'BlankNode') return t;
      const list = lists.heads.get(t.value);
      if (list !== undefined) return new Model.Collection(list.map(term));
      if (formulaGraphs.has(t.value)) return formulaOf(t.value);
      return t;
    };
    return new Model.Formula(
      quads
        .filter((q) => !lists.consumed.has(q))
        .map(
          (q) =>
            new Model.Statement(term(q.subject as Ground), q.predicate, term(q.object as Ground)),
        ),
    );
  };

  const formulaOf = (label: string): Model.Formula => {
    const cached = formulas.get(label);
    if (cached !== undefined) return cached;
    if (building.has(label)) {
      throw new Failure(`Graph _:${label} contains a reference to itself`);
    }
    building.add(label);
    const f = buildGraph(`_:${label}`);
    building.delete(label);
    formulas.set(label, f);
    return f;
  };

  const foldLists = (quads: ReadonlyArray<Term.Quad>, graphKey: string) => {
    const first = new Map<string, Array<Term.Quad>>();
    const rest = new Map<string, Array<Term.Quad>>();
    const other = new Map<string, number>();
    const asObject = new Map<string, number>();
    const restTargets = new Set<string>();
    for (const q of quads) {
      if (q.subject._tag === 'BlankNode') {
        const s = q.subject.value;
        const map =
          q.predicate.value === rdf.first.value
            ? first
            : q.predicate.value === rdf.rest.value
              ? rest
              : undefined;
        if (map === undefined) other.set(s, (other.get(s) ?? 0) + 1);
        else {
          let l = map.get(s);
          if (l === undefined) map.set(s, (l = []));
          l.push(q);
        }
      }
      if (q.object._tag === 'BlankNode') {
        asObject.set(q.object.value, (asObject.get(q.object.value) ?? 0) + 1);
        if (q.predicate.value === rdf.rest.value) restTargets.add(q.object.value);
      }
    }
    const local = (label: string) => {
      const occ = occurrences.get(label)!;
      return occ.size === 1 && occ.has(graphKey) && !formulaGraphs.has(label);
    };
    const isCell = (label: string) =>
      first.get(label)?.length === 1 && rest.get(label)?.length === 1 && local(label);
    const heads = new Map<string, Array<Ground>>();
    const consumed = new Set<Term.Quad>();
    for (const label of first.keys()) {
      if (restTargets.has(label) || !isCell(label)) continue;
      const otherCount = other.get(label) ?? 0;
      const refs = asObject.get(label) ?? 0;
      if (!(otherCount === 0 ? refs <= 1 : refs === 0)) continue;
      const items: Array<Ground> = [];
      const cells: Array<string> = [];
      const seen = new Set<string>();
      let cur: Ground = new Term.BlankNode(label);
      let ok = true;
      while (!(cur._tag === 'NamedNode' && cur.value === rdf.nil.value)) {
        if (cur._tag !== 'BlankNode' || seen.has(cur.value) || !isCell(cur.value)) {
          ok = false;
          break;
        }
        if (
          cur.value !== label &&
          ((other.get(cur.value) ?? 0) > 0 || asObject.get(cur.value) !== 1)
        ) {
          ok = false;
          break;
        }
        seen.add(cur.value);
        cells.push(cur.value);
        items.push(first.get(cur.value)![0]!.object as Ground);
        cur = rest.get(cur.value)![0]!.object as Ground;
      }
      if (!ok) continue;
      heads.set(label, items);
      for (const c of cells) {
        consumed.add(first.get(c)![0]!);
        consumed.add(rest.get(c)![0]!);
      }
    }
    return { heads, consumed };
  };

  return buildGraph('');
};

/**
 * Converts RDF quads to an N3 formula (see the module documentation for the
 * mapping). Statements are sorted for deterministic output.
 *
 * @since 0.1.0
 * @category conversions
 */
export const fromDataset = (
  quads: Iterable<Term.Quad>,
): Effect.Effect<Model.Formula, UnrepresentableError> => guard(() => fromQuadsUnsafe(quads));
