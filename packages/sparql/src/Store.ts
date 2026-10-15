/**
 * The storage abstraction of the SPARQL engine.
 *
 * A backend implements `QuadStore`: streaming quad pattern matching, named
 * graph management, updates and transactions. Optionally it can
 *
 * - give cardinality estimates (`estimate`) used by the optimizer to order
 *   joins, and
 * - evaluate algebra natively through a `QueryCapability` (e.g. a SQL backend
 *   translating SPARQL algebra to SQL): the engine offers every algebra node
 *   to `QueryCapability.evaluate` top-down before evaluating it generically,
 *   so a backend can take over whole subtrees and fall back to the engine for
 *   anything it does not support.
 *
 * `MemoryStore` is an in-memory implementation based on the core
 * `Dataset`.
 *
 * @since 0.1.0
 */
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Algebra from './Algebra.ts';
import type { Bindings } from './Bindings.ts';

// -----------------------------------------------------------------------------
// Errors and models
// -----------------------------------------------------------------------------

/**
 * A failure of the storage backend.
 *
 * @since 0.1.0
 * @category errors
 */
export class StoreError extends Schema.TaggedError<StoreError>()('StoreError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A quad pattern: `undefined` positions match anything. `graph` may be the
 * default graph.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuadPattern {
  readonly subject?: Term.GroundTerm | undefined;
  readonly predicate?: Term.GroundTerm | undefined;
  readonly object?: Term.GroundTerm | undefined;
  readonly graph?: Term.Graph | undefined;
}

/**
 * The RDF dataset a query is evaluated against.
 *
 * - `defaultGraph`: `'default'` uses the store's default graph, `'union'` the
 *   merge of all graphs (default and named), or an explicit list of graphs
 *   whose merge forms the default graph (`FROM`).
 * - `namedGraphs`: `'all'` uses every named graph of the store, or an
 *   explicit list (`FROM NAMED`).
 *
 * @since 0.1.0
 * @category models
 */
export interface DatasetSpec {
  readonly defaultGraph: 'default' | 'union' | ReadonlyArray<Term.Graph>;
  readonly namedGraphs: 'all' | ReadonlyArray<Term.NamedNode | Term.BlankNode>;
}

/**
 * The graph that patterns are matched against.
 *
 * @since 0.1.0
 * @category models
 */
export type ActiveGraph =
  | { readonly _tag: 'DefaultGraph' }
  | { readonly _tag: 'NamedGraph'; readonly graph: Term.NamedNode | Term.BlankNode };

/**
 * What a `QueryCapability` receives with an algebra node.
 *
 * @since 0.1.0
 * @category models
 */
export interface EvaluationContext {
  readonly dataset: DatasetSpec;
  readonly activeGraph: ActiveGraph;
  /**
   * Evaluates a sub-operator with the generic engine (which offers it to the
   * capability again), so that a backend can handle a node itself while
   * delegating some of its children.
   */
  readonly evaluate: (
    op: Algebra.Operation,
    activeGraph?: ActiveGraph,
  ) => Stream.Stream<Bindings, unknown>;
}

/**
 * Native algebra evaluation offered by a backend.
 *
 * @since 0.1.0
 * @category models
 */
export interface QueryCapability {
  /**
   * Returns `Some(stream)` to evaluate `op` natively, or `None` to let the
   * engine evaluate it (offering its children again).
   */
  readonly evaluate: (
    op: Algebra.Operation,
    context: EvaluationContext,
  ) => Option.Option<Stream.Stream<Bindings, StoreError>>;
}

/**
 * The interface implemented by storage backends.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuadStoreShape {
  /** Streams the quads matching a pattern. */
  readonly match: (pattern: QuadPattern) => Stream.Stream<Term.Quad, StoreError>;
  /**
   * An estimate of the number of quads matching a pattern, used by the
   * optimizer to order joins. Should be cheap.
   */
  readonly estimate?: ((pattern: QuadPattern) => Effect.Effect<number, StoreError>) | undefined;
  /** The named graphs of the store (including empty graphs it tracks). */
  readonly graphs: Stream.Stream<Term.NamedNode | Term.BlankNode, StoreError>;
  /** Whether a named graph exists. */
  readonly hasGraph: (graph: Term.NamedNode | Term.BlankNode) => Effect.Effect<boolean, StoreError>;
  /** Adds quads (duplicates are ignored). */
  readonly insert: (quads: Iterable<Term.Quad>) => Effect.Effect<void, StoreError>;
  /** Removes quads (missing quads are ignored). */
  readonly delete: (quads: Iterable<Term.Quad>) => Effect.Effect<void, StoreError>;
  /** Creates an empty named graph. */
  readonly createGraph: (graph: Term.NamedNode | Term.BlankNode) => Effect.Effect<void, StoreError>;
  /** Removes a named graph and all its quads. */
  readonly dropGraph: (graph: Term.NamedNode | Term.BlankNode) => Effect.Effect<void, StoreError>;
  /** Removes all quads of a graph (the graph itself, if named, is kept). */
  readonly clear: (graph: Term.Graph) => Effect.Effect<void, StoreError>;
  /**
   * Runs an effect atomically: if it fails, all changes made through this
   * store during the effect are rolled back.
   */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreError, R>;
  /** Native algebra evaluation, if supported. */
  readonly query?: QueryCapability | undefined;
}

/**
 * The quad store service used by the SPARQL engine.
 *
 * @since 0.1.0
 * @category services
 */
export class QuadStore extends Context.Service<QuadStore, QuadStoreShape>()(
  '@thomasfosterau/effect-sparql/QuadStore',
) {}

// -----------------------------------------------------------------------------
// In-memory store
// -----------------------------------------------------------------------------

interface MemoryState {
  readonly dataset: Dataset.Dataset;
  /** Explicitly created (possibly empty) named graphs, by key. */
  readonly graphs: ReadonlyMap<string, Term.NamedNode | Term.BlankNode>;
}

const InTransaction = Context.Reference<boolean>(
  '@thomasfosterau/effect-sparql/Store/InTransaction',
  {
    defaultValue: () => false,
  },
);

const toDatasetPattern = (pattern: QuadPattern): Dataset.Pattern | undefined => {
  if (pattern.predicate !== undefined && pattern.predicate._tag !== 'NamedNode') return undefined;
  if (pattern.subject !== undefined && pattern.subject._tag === 'Literal') return undefined;
  if (
    pattern.graph !== undefined &&
    pattern.graph._tag !== 'NamedNode' &&
    pattern.graph._tag !== 'BlankNode' &&
    pattern.graph._tag !== 'DefaultGraph'
  ) {
    return undefined;
  }
  return pattern as Dataset.Pattern;
};

/**
 * Builds an in-memory `QuadStore` backed by an immutable core `Dataset`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeMemory = (
  initial: Dataset.Dataset = Dataset.empty,
): Effect.Effect<QuadStoreShape & { readonly snapshot: Effect.Effect<Dataset.Dataset> }> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<MemoryState>({ dataset: initial, graphs: new Map() });
    const lock = Semaphore.makeUnsafe(1);

    const write = <A>(f: (s: MemoryState) => readonly [A, MemoryState]) =>
      Effect.flatMap(Effect.service(InTransaction), (inTx) => {
        const run = Ref.modify(state, f);
        return inTx ? run : lock.withPermits(1)(run);
      });

    const namedGraphs = (s: MemoryState): ReadonlyArray<Term.NamedNode | Term.BlankNode> => {
      const out = new Map(s.graphs);
      for (const g of Dataset.graphs(s.dataset)) {
        if (g._tag !== 'DefaultGraph' && !out.has(g.key)) out.set(g.key, g);
      }
      return Array.from(out.values());
    };

    const store: QuadStoreShape & { readonly snapshot: Effect.Effect<Dataset.Dataset> } = {
      snapshot: Effect.map(Ref.get(state), (s) => s.dataset),
      match: (pattern) =>
        Stream.suspend(() => {
          const p = toDatasetPattern(pattern);
          if (p === undefined) return Stream.empty;
          return Stream.fromIterableEffect(
            Effect.map(Ref.get(state), (s) => Dataset.match(s.dataset, p)),
          );
        }),
      estimate: (pattern) =>
        Effect.map(Ref.get(state), (s) => {
          const p = toDatasetPattern(pattern);
          return p === undefined ? 0 : Dataset.count(s.dataset, p);
        }),
      graphs: Stream.fromIterableEffect(Effect.map(Ref.get(state), namedGraphs)),
      hasGraph: (graph) =>
        Effect.map(Ref.get(state), (s) => namedGraphs(s).some((g) => g.key === graph.key)),
      insert: (quads) =>
        write((s) => [undefined, { ...s, dataset: Dataset.addAll(s.dataset, quads) }]),
      delete: (quads) =>
        write((s) => [
          undefined,
          {
            ...s,
            dataset: Dataset.mutate(s.dataset, (b) => {
              for (const q of quads) b.remove(q);
            }),
          },
        ]),
      createGraph: (graph) =>
        write((s) => {
          const graphs = new Map(s.graphs);
          graphs.set(graph.key, graph);
          return [undefined, { ...s, graphs }];
        }),
      dropGraph: (graph) =>
        write((s) => {
          const graphs = new Map(s.graphs);
          graphs.delete(graph.key);
          return [undefined, { graphs, dataset: Dataset.removeMatches(s.dataset, { graph }) }];
        }),
      clear: (graph) =>
        write((s) => [undefined, { ...s, dataset: Dataset.removeMatches(s.dataset, { graph }) }]),
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(Effect.service(InTransaction), (inTx) => {
          if (inTx) return effect;
          return lock.withPermits(1)(
            Effect.flatMap(Ref.get(state), (before) =>
              effect.pipe(
                Effect.provideService(InTransaction, true),
                Effect.onError(() => Ref.set(state, before)),
              ),
            ),
          );
        }),
    };
    return store;
  });

/**
 * A layer providing an in-memory `QuadStore`, optionally pre-loaded with a
 * dataset.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerMemory = (initial: Dataset.Dataset = Dataset.empty): Layer.Layer<QuadStore> =>
  Layer.effect(QuadStore, makeMemory(initial));

/**
 * Collects all quads of a store into a `Dataset`.
 *
 * @since 0.1.0
 * @category utils
 */
export const toDataset = (store: QuadStoreShape): Effect.Effect<Dataset.Dataset, StoreError> =>
  Effect.map(Stream.runCollect(store.match({})), (quads) => Dataset.fromIterable(quads));
