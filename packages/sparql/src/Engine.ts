/**
 * The SPARQL engine service: parses, translates, optimises and evaluates
 * queries and updates against the `QuadStore` service.
 *
 * Query evaluation is streaming: `SELECT` results are a lazy `Stream` of
 * solutions, `CONSTRUCT`/`DESCRIBE` a lazy stream of triples, and `ASK`
 * stops at the first solution. Operators that need all solutions
 * (`ORDER BY`, `GROUP BY`, the right side of joins) materialise as needed.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Match from 'effect/Match';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Algebra from './Algebra.ts';
import type * as Ast from './Ast.ts';
import * as B from './Bindings.ts';
import { EvaluationError, UpdateError } from './Errors.ts';
import * as Expression from './Expression.ts';
import type * as Functions from './Functions.ts';
import * as Evaluator from './internal/evaluator.ts';
import * as Optimizer from './Optimizer.ts';
import * as Parser from './Parser.ts';
import type * as Results from './Results.ts';
import * as Store from './Store.ts';
import * as Translate from './Translate.ts';
import * as Predicate from 'effect/Predicate';

/**
 * Any error produced by the engine.
 *
 * @since 0.1.0
 * @category errors
 */
export type SparqlError =
  | Parser.SparqlParseError
  | EvaluationError
  | UpdateError
  | Store.StoreError;

/**
 * Evaluates `SERVICE` patterns (federation). Receives the endpoint, the
 * algebra node (whose `pattern` holds the original syntax) and must return
 * the solutions of the remote pattern.
 *
 * @since 0.1.0
 * @category models
 */
export type ServiceHandler = (
  endpoint: Term.NamedNode,
  service: Algebra.Service,
) => Stream.Stream<B.Bindings, EvaluationError | Store.StoreError>;

/**
 * Loads a remote document for `LOAD`.
 *
 * @since 0.1.0
 * @category models
 */
export type Loader = (iri: Term.NamedNode) => Effect.Effect<Iterable<Term.Quad>, UpdateError>;

/**
 * Engine configuration.
 *
 * @since 0.1.0
 * @category models
 */
export interface EngineOptions {
  /**
   * When `true`, the default graph (absent `FROM`) is the union of all
   * graphs in the store; otherwise it is the store's default graph.
   */
  readonly unionDefaultGraph?: boolean | undefined;
  /** Base IRI for parsing and for `IRI()`. */
  readonly baseIri?: string | undefined;
  /** Extension functions. */
  readonly functions?: Functions.Registry | undefined;
  /** Federation support for `SERVICE`. */
  readonly service?: ServiceHandler | undefined;
  /** Document loader for `LOAD`. */
  readonly load?: Loader | undefined;
  /** Whether to run the algebra optimizer (default `true`). */
  readonly optimize?: boolean | undefined;
}

/**
 * Per-request options.
 *
 * @since 0.1.0
 * @category models
 */
export interface RequestOptions {
  /** Base IRI used when parsing a query string. */
  readonly baseIri?: string | undefined;
  /** Prefixes available without declaration when parsing. */
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
  /**
   * Overrides the dataset (e.g. the `default-graph-uri` / `named-graph-uri`
   * protocol parameters). A `FROM` / `FROM NAMED` clause in the query takes
   * precedence.
   */
  readonly dataset?: Store.DatasetSpec | undefined;
  /**
   * Pre-bound variables (initial bindings). The solution is inserted into
   * every basic graph pattern, property path and `GRAPH ?var` pattern of the
   * query as described by `Algebra.prebind`, so the values are visible to
   * every `FILTER` and `BIND` of the query — the pre-binding semantics of
   * SHACL-SPARQL and of SPARQL `EXISTS`.
   */
  readonly bindings?: B.Bindings | undefined;
}

/**
 * The engine service.
 *
 * @since 0.1.0
 * @category models
 */
export interface SparqlEngineShape {
  /** Evaluates a query of any form. */
  readonly query: (
    query: string | Ast.Query,
    options?: RequestOptions,
  ) => Effect.Effect<Results.QueryResult<SparqlError>, SparqlError>;
  /** Evaluates a `SELECT` query (fails for other forms). */
  readonly select: (
    query: string | Ast.Query,
    options?: RequestOptions,
  ) => Effect.Effect<Results.SelectResult<SparqlError>, SparqlError>;
  /** Evaluates an `ASK` query. */
  readonly ask: (
    query: string | Ast.Query,
    options?: RequestOptions,
  ) => Effect.Effect<boolean, SparqlError>;
  /** Evaluates a `CONSTRUCT` or `DESCRIBE` query. */
  readonly construct: (
    query: string | Ast.Query,
    options?: RequestOptions,
  ) => Effect.Effect<Stream.Stream<Term.Quad, SparqlError>, SparqlError>;
  /** Executes an update request atomically. */
  readonly update: (
    update: string | Ast.Update,
    options?: RequestOptions,
  ) => Effect.Effect<void, SparqlError>;
  /** Evaluates an algebra expression directly. */
  readonly evaluate: (
    op: Algebra.Operation,
    options?: RequestOptions,
  ) => Stream.Stream<B.Bindings, SparqlError>;
}

/**
 * The SPARQL engine service.
 *
 * @since 0.1.0
 * @category services
 */
export class SparqlEngine extends Context.Service<SparqlEngine, SparqlEngineShape>()(
  '@thomasfosterau/effect-sparql/SparqlEngine',
) {}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

const groundTemplateTerm = (
  t: Ast.TermPattern,
  b: B.Bindings,
  bnodes: Map<string, Term.BlankNode>,
): Term.Term | undefined => {
  return Match.value(t).pipe(
    Match.tag('Variable', (v) => b.map.get(v.value)),
    Match.tag('BlankNode', (blank) => {
      let n = bnodes.get(blank.value);
      if (n === undefined) bnodes.set(blank.value, (n = Term.blankNode()));
      return n;
    }),
    Match.tag('Triple', (x) => {
      const s = groundTemplateTerm(x.subject, b, bnodes);
      const p = groundTemplateTerm(x.predicate, b, bnodes);
      const o = groundTemplateTerm(x.object, b, bnodes);
      if (s === undefined || p === undefined || o === undefined) return undefined;
      if (!isValidTriple(s, p, o)) return undefined;
      // SAFETY: `isValidTriple` checked the subject, predicate and object positions.
      return Term.triple(s as Term.Subject, p as Term.Predicate, o as Term.Object);
    }),
    Match.orElse((x) => x),
  );
};

const isValidTriple = (s: Term.Term, p: Term.Term, o: Term.Term): boolean =>
  (s._tag === 'NamedNode' || s._tag === 'BlankNode' || s._tag === 'Triple') &&
  p._tag === 'NamedNode' &&
  (o._tag === 'NamedNode' || o._tag === 'BlankNode' || o._tag === 'Literal' || o._tag === 'Triple');

const instantiate = (
  template: ReadonlyArray<Ast.QuadPattern>,
  b: B.Bindings,
  defaultGraph: Term.Graph,
): Array<Term.Quad> => {
  const bnodes = new Map<string, Term.BlankNode>();
  const out: Array<Term.Quad> = [];
  for (const t of template) {
    const s = groundTemplateTerm(t.subject, b, bnodes);
    const p = groundTemplateTerm(t.predicate, b, bnodes);
    const o = groundTemplateTerm(t.object, b, bnodes);
    const g =
      t.graph._tag === 'DefaultGraph' ? defaultGraph : groundTemplateTerm(t.graph, b, bnodes);
    if (s === undefined || p === undefined || o === undefined || g === undefined) continue;
    if (!isValidTriple(s, p, o)) continue;
    if (g._tag !== 'NamedNode' && g._tag !== 'DefaultGraph') continue;
    // SAFETY: `isValidTriple` checked the subject, predicate and object positions.
    out.push(new Term.Quad(s as Term.Subject, p as Term.Predicate, o as Term.Object, g));
  }
  return out;
};

const prebind = (op: Algebra.Operation, request: RequestOptions | undefined): Algebra.Operation =>
  request?.bindings === undefined ? op : Algebra.prebind(op, request.bindings);

const dedupeQuads = <E>(quads: Stream.Stream<Term.Quad, E>): Stream.Stream<Term.Quad, E> =>
  Stream.suspend(() => {
    const seen = new Set<string>();
    return Stream.filter(quads, (q) => {
      if (seen.has(q.key)) return false;
      seen.add(q.key);
      return true;
    });
  });

/**
 * Creates the engine over a quad store.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  store: Store.QuadStoreShape,
  options: EngineOptions = {},
): SparqlEngineShape => {
  const defaultDataset: Store.DatasetSpec = {
    defaultGraph: options.unionDefaultGraph === true ? 'union' : 'default',
    namedGraphs: 'all',
  };

  const datasetFor = (
    clause: Ast.DatasetClause | undefined,
    request: RequestOptions | undefined,
  ): Store.DatasetSpec =>
    clause !== undefined
      ? { defaultGraph: clause.default, namedGraphs: clause.named }
      : (request?.dataset ?? defaultDataset);

  const makeEnv = (dataset: Store.DatasetSpec, baseIri: string | undefined): Evaluator.Env => {
    const service = options.service;
    return {
      store,
      dataset,
      graph: { _tag: 'DefaultGraph' },
      context: B.empty,
      expr: Expression.makeContext({ baseIri, functions: options.functions }),
      service: service === undefined ? undefined : (endpoint, op) => service(endpoint, op),
    };
  };

  const parseQuery = (query: string | Ast.Query, request: RequestOptions | undefined) =>
    Predicate.isString(query)
      ? Parser.parseQuery(query, {
          baseIri: request?.baseIri ?? options.baseIri,
          prefixes: request?.prefixes,
        })
      : Effect.succeed(query);

  const optimize = (op: Algebra.Operation, env: Evaluator.Env) =>
    options.optimize === false
      ? Effect.succeed(op)
      : Optimizer.optimize(op, { store, dataset: env.dataset, graph: env.graph });

  const run = (query: Ast.Query, request: RequestOptions | undefined) =>
    Effect.gen(function* () {
      const algebra = Translate.translateQuery(query);
      const env = makeEnv(
        datasetFor(algebra.dataset, request),
        query.prologue.base ?? request?.baseIri ?? options.baseIri,
      );
      const input = yield* optimize(prebind(algebra.input, request), env);
      return { algebra, env, input };
    });

  const query: SparqlEngineShape['query'] = (q, request) =>
    Effect.gen(function* () {
      const ast = yield* parseQuery(q, request);
      const { algebra, env, input } = yield* run(ast, request);
      const solutions = Evaluator.evaluate(input, env);
      return yield* Match.value(algebra).pipe(
        Match.tag('Select', (s) =>
          Effect.succeed({
            _tag: 'Select',
            variables: s.variables,
            bindings: solutions,
          } as const),
        ),
        Match.tag('Ask', () =>
          Effect.map(
            Stream.runHead(solutions),
            (head) =>
              ({
                _tag: 'Ask',
                value: Option.isSome(head),
              }) as const,
          ),
        ),
        Match.tag('Construct', (c) => {
          const template = c.template.map(
            (t) =>
              ({
                _tag: 'QuadPattern',
                subject: t.subject,
                predicate: t.predicate,
                object: t.object,
                graph: Term.defaultGraph,
              }) satisfies Ast.QuadPattern,
          );
          return Effect.succeed({
            _tag: 'Graph',
            quads: dedupeQuads(
              Stream.flatMap(solutions, (b) =>
                Stream.fromIterable(instantiate(template, b, Term.defaultGraph)),
              ),
            ),
          } as const);
        }),
        Match.tag('Describe', (d) =>
          Effect.succeed({ _tag: 'Graph', quads: describe(d.terms, solutions, env) } as const),
        ),
        Match.exhaustive,
      );
    });

  const describe = (
    terms: ReadonlyArray<Term.NamedNode | Term.Variable>,
    solutions: Stream.Stream<B.Bindings, SparqlError>,
    env: Evaluator.Env,
  ): Stream.Stream<Term.Quad, SparqlError> => {
    const constants = terms.filter((t): t is Term.NamedNode => t._tag === 'NamedNode');
    const vars = terms.filter((t): t is Term.Variable => t._tag === 'Variable');
    const resources: Stream.Stream<Term.GroundTerm, SparqlError> = Stream.concat(
      Stream.fromIterable(constants),
      Arr.isReadonlyArrayEmpty(vars)
        ? Stream.empty
        : Stream.flatMap(solutions, (b) =>
            Stream.fromIterable(
              vars.flatMap((v) => {
                const t = b.map.get(v.value);
                return t === undefined ? [] : [t];
              }),
            ),
          ),
    );
    // Concise bounded description: outgoing triples, recursively through
    // blank node objects.
    const cbd = (
      resource: Term.GroundTerm,
      seen: Set<string>,
    ): Stream.Stream<Term.Quad, SparqlError> =>
      Stream.flatMap(Evaluator.matchQuads(env, { subject: resource }), (q) => {
        const quad = new Term.Quad(q.subject, q.predicate, q.object, Term.defaultGraph);
        if (q.object._tag === 'BlankNode' && !seen.has(q.object.key)) {
          seen.add(q.object.key);
          return Stream.concat(Stream.succeed(quad), cbd(q.object, seen));
        }
        return Stream.succeed(quad);
      });
    return dedupeQuads(
      Stream.suspend(() => {
        const described = new Set<string>();
        return Stream.flatMap(resources, (r) => {
          if (described.has(r.key)) return Stream.empty;
          described.add(r.key);
          return cbd(r, new Set([r.key]));
        });
      }),
    );
  };

  const select: SparqlEngineShape['select'] = (q, request) =>
    Effect.flatMap(query(q, request), (r) =>
      r._tag === 'Select'
        ? Effect.succeed(r)
        : Effect.fail(new EvaluationError({ message: 'Not a SELECT query' })),
    );

  const ask: SparqlEngineShape['ask'] = (q, request) =>
    Effect.flatMap(query(q, request), (r) =>
      r._tag === 'Ask'
        ? Effect.succeed(r.value)
        : Effect.fail(new EvaluationError({ message: 'Not an ASK query' })),
    );

  const construct: SparqlEngineShape['construct'] = (q, request) =>
    Effect.flatMap(query(q, request), (r) =>
      r._tag === 'Graph'
        ? Effect.succeed(r.quads)
        : Effect.fail(new EvaluationError({ message: 'Not a CONSTRUCT or DESCRIBE query' })),
    );

  // --- updates ---------------------------------------------------------------

  const fail = (message: string) => Effect.fail(new UpdateError({ message }));

  const graphExists = (g: Ast.GraphOrDefault) =>
    g._tag === 'DefaultGraph' ? Effect.succeed(true) : store.hasGraph(g);

  const graphQuads = (g: Term.Graph) => Stream.runCollect(store.match({ graph: g }));

  const clearTarget = (target: Ast.GraphTarget, silent: boolean, drop: boolean) =>
    Effect.gen(function* () {
      return yield* Match.value(target).pipe(
        Match.tag('Default', (): Effect.Effect<void, SparqlError> =>
          store.clear(Term.defaultGraph),
        ),
        Match.tag('NamedNode', (graph) =>
          Effect.flatMap(store.hasGraph(graph), (exists): Effect.Effect<void, SparqlError> => {
            if (!exists)
              return silent ? Effect.void : fail(`Graph <${graph.value}> does not exist`);
            return drop ? store.dropGraph(graph) : store.clear(graph);
          }),
        ),
        Match.tag('Named', 'All', (which) =>
          Effect.gen(function* () {
            const graphs = yield* Stream.runCollect(store.graphs);
            yield* Effect.forEach(graphs, (g) => (drop ? store.dropGraph(g) : store.clear(g)), {
              concurrency: 1,
              discard: true,
            });
            if (which._tag === 'All') yield* store.clear(Term.defaultGraph);
          }),
        ),
        Match.exhaustive,
      );
    });

  const transfer = (op: Ast.TransferOperation) =>
    Effect.gen(function* () {
      if (op.source.key === op.destination.key) return;
      if (!(yield* graphExists(op.source))) {
        if (op.silent) return;
        return yield* fail(`Graph <${op.source.value}> does not exist`);
      }
      const quads = yield* graphQuads(op.source);
      if (op._tag !== 'Add') {
        if (op.destination._tag === 'DefaultGraph') yield* store.clear(Term.defaultGraph);
        else yield* store.dropGraph(op.destination);
      }
      if (op.destination._tag === 'NamedNode') yield* store.createGraph(op.destination);
      yield* store.insert(
        quads.map((q) => new Term.Quad(q.subject, q.predicate, q.object, op.destination)),
      );
      if (op._tag === 'Move') {
        if (op.source._tag === 'DefaultGraph') yield* store.clear(Term.defaultGraph);
        else yield* store.dropGraph(op.source);
      }
    });

  const freshBlankNodes = (quads: ReadonlyArray<Term.Quad>): Array<Term.Quad> => {
    const map = new Map<string, Term.BlankNode>();
    return quads.map((q) =>
      Term.mapTerms(q, (t) => {
        if (t._tag !== 'BlankNode') return t;
        let n = map.get(t.value);
        if (n === undefined) map.set(t.value, (n = Term.blankNode()));
        return n;
      }),
    );
  };

  const modify = (
    op: Ast.ModifyOperation,
    where: Algebra.Operation,
    baseIri: string | undefined,
    request: RequestOptions | undefined,
  ) =>
    Effect.gen(function* () {
      const dataset: Store.DatasetSpec =
        op.using !== undefined
          ? { defaultGraph: op.using.default, namedGraphs: op.using.named }
          : op.with !== undefined
            ? { defaultGraph: [op.with], namedGraphs: 'all' }
            : (request?.dataset ?? defaultDataset);
      const env = makeEnv(dataset, baseIri);
      const input = yield* optimize(prebind(where, request), env);
      const solutions = yield* Stream.runCollect(Evaluator.evaluate(input, env));
      const target: Term.Graph = op.with ?? Term.defaultGraph;
      const deletes = solutions.flatMap((b) => instantiate(op.delete, b, target));
      const inserts = solutions.flatMap((b) => instantiate(op.insert, b, target));
      yield* store.delete(deletes);
      yield* store.insert(inserts);
    });

  const quadPatternsToAlgebra = (patterns: ReadonlyArray<Ast.QuadPattern>): Algebra.Operation => {
    const byGraph = new Map<
      string,
      { graph: Ast.QuadPattern['graph']; triples: Array<Ast.TriplePattern> }
    >();
    for (const p of patterns) {
      let entry = byGraph.get(p.graph.key);
      if (entry === undefined) byGraph.set(p.graph.key, (entry = { graph: p.graph, triples: [] }));
      entry.triples.push({
        _tag: 'TriplePattern',
        subject: p.subject,
        predicate: p.predicate,
        object: p.object,
      });
    }
    const parts = Array.from(byGraph.values()).map(({ graph, triples }): Algebra.Operation =>
      graph._tag === 'DefaultGraph'
        ? Algebra.bgp(triples)
        : { _tag: 'Graph', name: graph, input: Algebra.bgp(triples) },
    );
    return Arr.isReadonlyArrayEmpty(parts)
      ? Algebra.unit
      : parts.reduce((a, b) => Algebra.join(a, b));
  };

  const executeOperation = (
    op: Ast.UpdateOperation,
    baseIri: string | undefined,
    request: RequestOptions | undefined,
  ): Effect.Effect<void, SparqlError> => {
    return Match.value(op).pipe(
      Match.tag('InsertData', (o): Effect.Effect<void, SparqlError> =>
        store.insert(freshBlankNodes(o.quads)),
      ),
      Match.tag('DeleteData', (o) => store.delete(o.quads)),
      Match.tag('DeleteWhere', (o) =>
        modify(
          {
            _tag: 'Modify',
            delete: o.patterns,
            insert: [],
            where: { _tag: 'Group', patterns: [] },
          },
          quadPatternsToAlgebra(o.patterns),
          baseIri,
          request,
        ),
      ),
      Match.tag('Modify', (o) => modify(o, Translate.translatePattern(o.where), baseIri, request)),
      Match.tag('Load', (o) => {
        const loader = options.load;
        if (loader === undefined) {
          return o.silent ? Effect.void : fail('LOAD is not supported (no loader configured)');
        }
        const destination: Term.Graph = o.destination ?? Term.defaultGraph;
        const load = Effect.flatMap(loader(o.source), (quads) =>
          store.insert(
            Array.from(quads, (q) => new Term.Quad(q.subject, q.predicate, q.object, destination)),
          ),
        );
        return o.silent ? Effect.ignore(load) : load;
      }),
      Match.tag('Clear', (o) => clearTarget(o.target, o.silent, false)),
      Match.tag('Drop', (o) => clearTarget(o.target, o.silent, true)),
      Match.tag('Create', (o) =>
        Effect.flatMap(store.hasGraph(o.graph), (exists): Effect.Effect<void, SparqlError> =>
          exists
            ? o.silent
              ? Effect.void
              : fail(`Graph <${o.graph.value}> already exists`)
            : store.createGraph(o.graph),
        ),
      ),
      Match.tag('Add', 'Move', 'Copy', (o) => transfer(o)),
      Match.exhaustive,
    );
  };

  const update: SparqlEngineShape['update'] = (u, request) =>
    Effect.gen(function* () {
      const ast = Predicate.isString(u)
        ? yield* Parser.parseUpdate(u, {
            baseIri: request?.baseIri ?? options.baseIri,
            prefixes: request?.prefixes,
          })
        : u;
      const baseIri = ast.prologue.base ?? request?.baseIri ?? options.baseIri;
      yield* store.transaction(
        Effect.forEach(ast.operations, (op) => executeOperation(op, baseIri, request), {
          concurrency: 1,
          discard: true,
        }),
      );
    });

  const evaluate: SparqlEngineShape['evaluate'] = (op, request) =>
    Evaluator.evaluate(
      prebind(op, request),
      makeEnv(request?.dataset ?? defaultDataset, request?.baseIri ?? options.baseIri),
    );

  return { query, select, ask, construct, update, evaluate };
};

/**
 * A layer providing the engine over the `QuadStore` service.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options?: EngineOptions): Layer.Layer<SparqlEngine, never, Store.QuadStore> =>
  Layer.effect(
    SparqlEngine,
    Effect.map(Effect.service(Store.QuadStore), (store) => make(store, options)),
  );

/**
 * A layer providing the engine together with an in-memory store.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerMemory = (options?: EngineOptions): Layer.Layer<SparqlEngine | Store.QuadStore> =>
  layer(options).pipe(Layer.provideMerge(Store.layerMemory()));
