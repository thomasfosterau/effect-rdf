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
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Dataset from '../Dataset.ts';
import * as Term from '../Term.ts';
import { rdf } from '../Vocab.ts';
import * as Guards from './internal/guards.ts';
import * as Lists from './internal/lists.ts';
import { loop } from './internal/loop.ts';
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
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

const guard = <A>(f: () => A): Effect.Effect<A, UnrepresentableError> =>
  Effect.suspend(() =>
    Result.match(Result.try(f), {
      onSuccess: Effect.succeed,
      onFailure: (e) =>
        e instanceof Failure
          ? Effect.fail(new UnrepresentableError({ message: e.message }))
          : Effect.die(e),
    }),
  );

/**
 * @since 0.1.0
 * @category models
 */
export interface ToDatasetOptions {
  /** Prefix for the labels of blank nodes generated for formulas and lists. */
  readonly blankNodePrefix?: string | undefined;
}

/** The state of one `toQuadsUnsafe` conversion, threaded through `rdfTerm`. */
interface Conversion {
  readonly fresh: () => Term.BlankNode;
  readonly out: Array<Term.Quad>;
  readonly statements: (f: Model.Formula, graph: Term.Graph) => void;
}

// Plain refinements rather than `Match`: `toQuadsUnsafe` runs it for every term it converts.
const rdfTerm = (
  t: Model.N3Term,
  graph: Term.Graph,
  conversion: Conversion,
): Term.NamedNode | Term.BlankNode | Term.Literal => {
  if (t instanceof Model.Collection) {
    const items = t.items;
    if (!Arr.isReadonlyArrayNonEmpty(items)) return rdf.nil;
    const nodes = Arr.map(items, () => conversion.fresh());
    const head = nodes[0];
    items.forEach((item, i) => {
      const node = nodes[i] ?? head;
      conversion.out.push(new Term.Quad(node, rdf.first, rdfTerm(item, graph, conversion), graph));
      conversion.out.push(new Term.Quad(node, rdf.rest, nodes[i + 1] ?? rdf.nil, graph));
    });
    return head;
  }
  if (t instanceof Model.Formula) {
    const g = conversion.fresh();
    conversion.statements(t, g);
    return g;
  }
  if (Guards.isVariable(t)) throw new Failure(`Variable ${t.key} cannot be represented in RDF`);
  return t;
};

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
  const reserved = MutableHashSet.fromIterable(Model.blankNodes(self).map((b) => b.value));
  let counter = 0;
  let label = '';
  const nextLabel = (): boolean => {
    label = `${prefix}g${(counter++).toString(36)}`;
    return MutableHashSet.has(reserved, label);
  };
  const fresh = (): Term.BlankNode => {
    loop(nextLabel);
    return new Term.BlankNode(label);
  };
  const out: Array<Term.Quad> = [];
  const conversion: Conversion = { fresh, out, statements: (f, g) => statements(f, g) };
  const term = (t: Model.N3Term, graph: Term.Graph) => rdfTerm(t, graph, conversion);
  const statements = (f: Model.Formula, graph: Term.Graph) => {
    f.statements.forEach((s) => {
      const subject = term(s.subject, graph);
      const predicate = term(s.predicate, graph);
      const object = term(s.object, graph);
      if (Guards.isLiteral(subject)) {
        throw new Failure(`Literal ${subject.key} cannot be the subject of an RDF triple`);
      }
      if (!Guards.isNamedNode(predicate)) {
        throw new Failure(`${predicate.key} cannot be the predicate of an RDF triple`);
      }
      out.push(new Term.Quad(subject, predicate, object, graph));
    });
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
  const result = Result.try(() => toQuadsUnsafe(self));
  if (Result.isSuccess(result)) return true;
  if (result.failure instanceof Failure) return false;
  throw result.failure;
};

// -----------------------------------------------------------------------------
// RDF → N3
// -----------------------------------------------------------------------------

/** The quads of one graph, with its name. */
interface Graph {
  readonly name: Term.Graph;
  readonly quads: Array<Term.Quad>;
}

/** @internal */
export const fromQuadsUnsafe = (quads: Iterable<Term.Quad>): Model.Formula => {
  const all = Arr.sort(quads, Term.compareQuads);
  const graphs = MutableHashMap.empty<string, Graph>();
  // Occurrences of blank nodes as subject/object, per graph and in total.
  const occurrences = MutableHashMap.empty<string, MutableHashMap.MutableHashMap<string, number>>();
  const note = (t: Term.Term, graph: string) => {
    if (Guards.isTriple(t)) {
      throw new Failure(`Triple term ${t.key} cannot be represented in N3`);
    }
    if (!Guards.isBlankNode(t)) return;
    let m = occurrences.backing.get(t.value);
    if (m === undefined) {
      m = MutableHashMap.empty();
      MutableHashMap.set(occurrences, t.value, m);
    }
    Lists.increment(m, graph);
  };
  all.forEach((q) => {
    const g = q.graph.key;
    const graph = graphs.backing.get(g);
    if (graph === undefined) MutableHashMap.set(graphs, g, { name: q.graph, quads: [q] });
    else graph.quads.push(q);
    note(q.subject, g);
    note(q.object, g);
  });
  const formulaGraphs = MutableHashSet.empty<string>();
  MutableHashMap.forEach(graphs, ({ name }, key) => {
    if (key === '') return;
    if (!Guards.isBlankNode(name) || !MutableHashMap.has(occurrences, name.value)) {
      throw new Failure(
        `Named graph ${name.key} cannot be represented in N3: only graphs named by blank nodes that are used as terms map to formulas`,
      );
    }
    MutableHashSet.add(formulaGraphs, name.value);
  });

  const formulas = MutableHashMap.empty<string, Model.Formula>();
  const building = MutableHashSet.empty<string>();

  const buildGraph = (key: string): Model.Formula => {
    const graphQuads = graphs.backing.get(key)?.quads ?? [];
    const lists = foldLists(graphQuads, key);
    const term = (t: Term.Subject | Term.Object): Model.N3Term => {
      // `note` has rejected triple terms
      if (Guards.isTriple(t)) throw new Failure(`Triple term ${t.key} cannot be represented in N3`);
      if (!Guards.isBlankNode(t)) return t;
      const list = lists.heads.backing.get(t.value);
      if (list !== undefined) return new Model.Collection(list.map(term));
      if (MutableHashSet.has(formulaGraphs, t.value)) return formulaOf(t.value);
      return t;
    };
    return new Model.Formula(
      graphQuads
        .filter((q) => !lists.consumed.has(q))
        .map((q) => new Model.Statement(term(q.subject), q.predicate, term(q.object))),
    );
  };

  const formulaOf = (label: string): Model.Formula => {
    const cached = formulas.backing.get(label);
    if (cached !== undefined) return cached;
    if (MutableHashSet.has(building, label)) {
      throw new Failure(`Graph _:${label} contains a reference to itself`);
    }
    MutableHashSet.add(building, label);
    const f = buildGraph(`_:${label}`);
    MutableHashSet.remove(building, label);
    MutableHashMap.set(formulas, label, f);
    return f;
  };

  const foldLists = (graphQuads: ReadonlyArray<Term.Quad>, graphKey: string) => {
    const first = MutableHashMap.empty<string, Array<Term.Quad>>();
    const rest = MutableHashMap.empty<string, Array<Term.Quad>>();
    const other = MutableHashMap.empty<string, number>();
    const asObject = MutableHashMap.empty<string, number>();
    const restTargets = MutableHashSet.empty<string>();
    graphQuads.forEach((q) => {
      if (Guards.isBlankNode(q.subject)) {
        const s = q.subject.value;
        if (q.predicate.value === rdf.first.value) Lists.append(first, s, q);
        else if (q.predicate.value === rdf.rest.value) Lists.append(rest, s, q);
        else Lists.increment(other, s);
      }
      if (Guards.isBlankNode(q.object)) {
        Lists.increment(asObject, q.object.value);
        if (q.predicate.value === rdf.rest.value) MutableHashSet.add(restTargets, q.object.value);
      }
    });
    const local = (label: string) => {
      const occ = occurrences.backing.get(label);
      return (
        occ !== undefined &&
        MutableHashMap.size(occ) === 1 &&
        MutableHashMap.has(occ, graphKey) &&
        !MutableHashSet.has(formulaGraphs, label)
      );
    };
    // A cell: one `rdf:first` and one `rdf:rest`, in this graph only; after the head, referenced
    // only by the list
    const cellOf = (label: string, isHead: boolean): Option.Option<Lists.Cell<Term.Quad>> =>
      !local(label) ||
      (!isHead && (Lists.count(other, label) > 0 || Lists.count(asObject, label) !== 1))
        ? Option.none()
        : Option.zipWith(Lists.single(first, label), Lists.single(rest, label), (f, r) => [f, r]);
    const heads = MutableHashMap.empty<string, Array<Term.Object>>();
    const consumed = new WeakSet<Term.Quad>();
    MutableHashMap.forEach(first, (_, label) => {
      if (MutableHashSet.has(restTargets, label) || Option.isNone(cellOf(label, true))) return;
      const otherCount = Lists.count(other, label);
      const refs = Lists.count(asObject, label);
      if (!(otherCount === 0 ? refs <= 1 : refs === 0)) return;
      const cells = Lists.followList(label, cellOf);
      if (Option.isSome(cells)) Lists.record(heads, consumed, label, cells.value);
    });
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
