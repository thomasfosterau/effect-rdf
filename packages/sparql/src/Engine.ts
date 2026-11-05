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
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Stream from 'effect/Stream';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Algebra from './Algebra.ts';
import type * as Ast from './Ast.ts';
import * as B from './Bindings.ts';
import { EvaluationError, UpdateError } from './Errors.ts';
import * as Expression from './Expression.ts';
import type * as Functions from './Functions.ts';
import * as Evaluator from './internal/evaluator.ts';
import * as StringMap from './internal/stringMap.ts';
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
  /**
   * Record the text of string queries and updates on their spans
   * (`sparql.query.text`). Off by default: query text may contain user data.
   */
  readonly traceQueryText?: boolean | undefined;
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

/**
 * A template term instantiated for a solution; `None` where a variable is
 * unbound or a triple term would be ill-formed. Plain branches rather than
 * `Match`: it runs for every template term per solution.
 */
const groundTemplateTerm = (
  t: Ast.TermPattern,
  b: B.Bindings,
  bnodes: Map<string, Term.BlankNode>,
): Option.Option<Term.Term> => {
  if (Term.isVariable(t)) return Option.fromUndefinedOr(b.map.get(t.value));
  if (Term.isBlankNode(t)) {
    const existing = bnodes.get(t.value);
    if (existing !== undefined) return Option.some(existing);
    const n = Term.blankNode();
    bnodes.set(t.value, n);
    return Option.some(n);
  }
  if (Term.isTriple(t)) {
    return Option.map(groundTriple(t.subject, t.predicate, t.object, b, bnodes), ([s, p, o]) =>
      Term.triple(s, p, o),
    );
  }
  return Option.some(t);
};

/** The instantiated subject, predicate and object, if they form a well-formed triple. */
const groundTriple = (
  subject: Ast.TermPattern,
  predicate: Ast.TermPattern,
  object: Ast.TermPattern,
  b: B.Bindings,
  bnodes: Map<string, Term.BlankNode>,
): Option.Option<readonly [Term.Subject, Term.Predicate, Term.Object]> => {
  const s = groundTemplateTerm(subject, b, bnodes);
  const p = groundTemplateTerm(predicate, b, bnodes);
  const o = groundTemplateTerm(object, b, bnodes);
  if (Option.isNone(s) || Option.isNone(p) || Option.isNone(o)) return Option.none();
  const [sv, pv, ov] = [s.value, p.value, o.value];
  return Term.isSubject(sv) && Term.isNamedNode(pv) && Term.isObject(ov)
    ? Option.some([sv, pv, ov] as const)
    : Option.none();
};

/** The graph of a template quad for a solution: an IRI or the default graph. */
const groundGraph = (
  t: Ast.QuadPattern,
  b: B.Bindings,
  bnodes: Map<string, Term.BlankNode>,
  defaultGraph: Term.Graph,
): Option.Option<Term.Graph> => {
  if (Term.isDefaultGraph(t.graph)) return Option.some(defaultGraph);
  const g = groundTemplateTerm(t.graph, b, bnodes);
  return Option.isSome(g) && (Term.isNamedNode(g.value) || Term.isDefaultGraph(g.value))
    ? Option.some(g.value)
    : Option.none();
};

const instantiate = (
  template: ReadonlyArray<Ast.QuadPattern>,
  b: B.Bindings,
  defaultGraph: Term.Graph,
): Array<Term.Quad> => {
  const bnodes = StringMap.empty<Term.BlankNode>();
  return Arr.filterMap(template, (t) => {
    const triple = groundTriple(t.subject, t.predicate, t.object, b, bnodes);
    const g = groundGraph(t, b, bnodes, defaultGraph);
    if (Option.isNone(triple) || Option.isNone(g)) return Result.failVoid;
    const [s, p, o] = triple.value;
    return Result.succeed(new Term.Quad(s, p, o, g.value));
  });
};

/** The options of a request that gave none. */
const noRequest: RequestOptions = {};

const prebind = (op: Algebra.Operation, request: RequestOptions): Algebra.Operation =>
  request.bindings === undefined ? op : Algebra.prebind(op, request.bindings);

const dedupeQuads = <E>(quads: Stream.Stream<Term.Quad, E>): Stream.Stream<Term.Quad, E> =>
  Stream.suspend(() => {
    const seen = StringMap.emptySet();
    return Stream.filter(quads, (q) => {
      const k = q.key;
      if (seen.has(k)) return false;
      seen.set(k, true);
      return true;
    });
  });

const describeResources = (
  terms: ReadonlyArray<Term.NamedNode | Term.Variable>,
  solutions: Stream.Stream<B.Bindings, SparqlError>,
  env: Evaluator.Env,
): Stream.Stream<Term.Quad, SparqlError> => {
  const constants = terms.filter(Term.isNamedNode);
  const vars = terms.filter(Term.isVariable);
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
    seen: Map<string, true>,
  ): Stream.Stream<Term.Quad, SparqlError> =>
    Stream.flatMap(Evaluator.matchQuads(env, { subject: resource }), (q) => {
      const quad = new Term.Quad(q.subject, q.predicate, q.object, Term.defaultGraph);
      const object = q.object;
      if (Term.isBlankNode(object) && !seen.has(object.key)) {
        seen.set(object.key, true);
        return Stream.concat(Stream.succeed(quad), cbd(object, seen));
      }
      return Stream.succeed(quad);
    });
  return dedupeQuads(
    Stream.suspend(() => {
      const described = StringMap.emptySet();
      return Stream.flatMap(resources, (r) => {
        if (described.has(r.key)) return Stream.empty;
        described.set(r.key, true);
        return cbd(r, StringMap.setOf([r.key]));
      });
    }),
  );
};

const updateFailed = (message: string) => Effect.fail(new UpdateError({ message }));

const freshBlankNodes = (quads: ReadonlyArray<Term.Quad>): Array<Term.Quad> => {
  const map = StringMap.empty<Term.BlankNode>();
  return quads.map((q) =>
    Term.mapTerms(q, (t) => {
      if (!Term.isBlankNode(t)) return t;
      const existing = map.get(t.value);
      if (existing !== undefined) return existing;
      const n = Term.blankNode();
      map.set(t.value, n);
      return n;
    }),
  );
};

const quadPatternsToAlgebra = (patterns: ReadonlyArray<Ast.QuadPattern>): Algebra.Operation => {
  const byGraph = StringMap.empty<{
    graph: Ast.QuadPattern['graph'];
    triples: Array<Ast.TriplePattern>;
  }>();
  patterns.forEach((p) => {
    const triple: Ast.TriplePattern = {
      _tag: 'TriplePattern',
      subject: p.subject,
      predicate: p.predicate,
      object: p.object,
    };
    const entry = byGraph.get(p.graph.key);
    if (entry === undefined) byGraph.set(p.graph.key, { graph: p.graph, triples: [triple] });
    else entry.triples.push(triple);
  });
  const parts = Array.from(byGraph.values()).map(({ graph, triples }): Algebra.Operation =>
    Term.isDefaultGraph(graph)
      ? Algebra.bgp(triples)
      : { _tag: 'Graph', name: graph, input: Algebra.bgp(triples) },
  );
  return Arr.isReadonlyArrayEmpty(parts)
    ? Algebra.unit
    : parts.reduce((a, b) => Algebra.join(a, b));
};

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
    clause: Option.Option<Ast.DatasetClause>,
    request: RequestOptions,
  ): Store.DatasetSpec =>
    Option.isSome(clause)
      ? { defaultGraph: clause.value.default, namedGraphs: clause.value.named }
      : (request.dataset ?? defaultDataset);

  const service = Option.map(
    Option.fromUndefinedOr(options.service),
    (handler): Evaluator.ServiceHandler =>
      (endpoint, op) =>
        handler(endpoint, op),
  );

  const makeEnv = (dataset: Store.DatasetSpec, baseIri: Option.Option<string>): Evaluator.Env => ({
    store,
    dataset,
    graph: { _tag: 'DefaultGraph' },
    context: B.empty,
    expr: Expression.makeContext({
      baseIri: Option.getOrUndefined(baseIri),
      functions: options.functions,
    }),
    service,
  });

  /** The base IRI of a request: its prologue's, the request's or the engine's. */
  const baseIriFor = (request: RequestOptions, prologue?: Ast.Prologue): Option.Option<string> =>
    Option.fromUndefinedOr(prologue?.base ?? request.baseIri ?? options.baseIri);

  const parseQuery = (query: string | Ast.Query, request: RequestOptions) =>
    Predicate.isString(query)
      ? Parser.parseQuery(query, {
          baseIri: request.baseIri ?? options.baseIri,
          prefixes: request.prefixes,
        })
      : Effect.succeed(query);

  const optimize = (op: Algebra.Operation, env: Evaluator.Env) =>
    options.optimize === false
      ? Effect.succeed(op)
      : Optimizer.optimize(op, { store, dataset: env.dataset, graph: env.graph });

  const run = (query: Ast.Query, request: RequestOptions) =>
    Effect.gen(function* () {
      const algebra = Translate.translateQuery(query);
      const env = makeEnv(
        datasetFor(Option.fromUndefinedOr(algebra.dataset), request),
        baseIriFor(request, query.prologue),
      );
      const input = yield* optimize(prebind(algebra.input, request), env);
      return { algebra, env, input };
    });

  // Span attributes for a request: its text only when `traceQueryText` opts in.
  const textAttributes = (text: string | Ast.Query | Ast.Update): Record<string, string> =>
    options.traceQueryText === true && Predicate.isString(text)
      ? { 'sparql.query.text': text }
      : {};

  const query: SparqlEngineShape['query'] = (q, request = noRequest) =>
    Effect.gen(function* () {
      const ast = yield* parseQuery(q, request);
      const { algebra, env, input } = yield* run(ast, request);
      yield* Effect.annotateCurrentSpan('sparql.query.form', algebra._tag);
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
          Effect.succeed({
            _tag: 'Graph',
            quads: describeResources(d.terms, solutions, env),
          } as const),
        ),
        Match.exhaustive,
      );
    }).pipe(Effect.withSpan('SparqlEngine.query', { attributes: textAttributes(q) }));

  const select: SparqlEngineShape['select'] = (q, request) =>
    Effect.flatMap(query(q, request), (r) =>
      Predicate.isTagged(r, 'Select')
        ? Effect.succeed(r)
        : Effect.fail(new EvaluationError({ message: 'Not a SELECT query' })),
    );

  const ask: SparqlEngineShape['ask'] = (q, request) =>
    Effect.flatMap(query(q, request), (r) =>
      Predicate.isTagged(r, 'Ask')
        ? Effect.succeed(r.value)
        : Effect.fail(new EvaluationError({ message: 'Not an ASK query' })),
    );

  const construct: SparqlEngineShape['construct'] = (q, request) =>
    Effect.flatMap(query(q, request), (r) =>
      Predicate.isTagged(r, 'Graph')
        ? Effect.succeed(r.quads)
        : Effect.fail(new EvaluationError({ message: 'Not a CONSTRUCT or DESCRIBE query' })),
    );

  // --- updates ---------------------------------------------------------------

  const graphExists = (g: Ast.GraphOrDefault) =>
    Term.isDefaultGraph(g) ? Effect.succeed(true) : store.hasGraph(g);

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
              return silent ? Effect.void : updateFailed(`Graph <${graph.value}> does not exist`);
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
            if (Predicate.isTagged(which, 'All')) yield* store.clear(Term.defaultGraph);
          }),
        ),
        Match.exhaustive,
      );
    });

  const transfer = (
    op: Ast.TransferOperation,
  ): Effect.Effect<void, UpdateError | Store.StoreError> =>
    op.source.key === op.destination.key
      ? Effect.void
      : Effect.flatMap(
          graphExists(op.source),
          (exists): Effect.Effect<void, UpdateError | Store.StoreError> =>
            exists
              ? copyGraph(op)
              : op.silent
                ? Effect.void
                : updateFailed(`Graph <${op.source.value}> does not exist`),
        );

  const copyGraph = (op: Ast.TransferOperation) =>
    Effect.gen(function* () {
      const quads = yield* graphQuads(op.source);
      const { source, destination } = op;
      if (!Predicate.isTagged(op, 'Add')) {
        if (Term.isDefaultGraph(destination)) yield* store.clear(Term.defaultGraph);
        else yield* store.dropGraph(destination);
      }
      if (Term.isNamedNode(destination)) yield* store.createGraph(destination);
      yield* store.insert(
        quads.map((q) => new Term.Quad(q.subject, q.predicate, q.object, destination)),
      );
      if (Predicate.isTagged(op, 'Move')) {
        if (Term.isDefaultGraph(source)) yield* store.clear(Term.defaultGraph);
        else yield* store.dropGraph(source);
      }
    });

  const modify = (
    op: Ast.ModifyOperation,
    where: Algebra.Operation,
    baseIri: Option.Option<string>,
    request: RequestOptions,
  ) =>
    Effect.gen(function* () {
      const dataset: Store.DatasetSpec =
        op.using !== undefined
          ? { defaultGraph: op.using.default, namedGraphs: op.using.named }
          : op.with !== undefined
            ? { defaultGraph: [op.with], namedGraphs: 'all' }
            : (request.dataset ?? defaultDataset);
      const env = makeEnv(dataset, baseIri);
      const input = yield* optimize(prebind(where, request), env);
      const solutions = yield* Stream.runCollect(Evaluator.evaluate(input, env));
      const target: Term.Graph = op.with ?? Term.defaultGraph;
      const deletes = solutions.flatMap((b) => instantiate(op.delete, b, target));
      const inserts = solutions.flatMap((b) => instantiate(op.insert, b, target));
      yield* store.delete(deletes);
      yield* store.insert(inserts);
    });

  const executeOperation = (
    op: Ast.UpdateOperation,
    baseIri: Option.Option<string>,
    request: RequestOptions,
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
          return o.silent
            ? Effect.void
            : updateFailed('LOAD is not supported (no loader configured)');
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
              : updateFailed(`Graph <${o.graph.value}> already exists`)
            : store.createGraph(o.graph),
        ),
      ),
      Match.tag('Add', 'Move', 'Copy', (o) => transfer(o)),
      Match.exhaustive,
    );
  };

  const update: SparqlEngineShape['update'] = (u, request = noRequest) =>
    Effect.gen(function* () {
      const ast = Predicate.isString(u)
        ? yield* Parser.parseUpdate(u, {
            baseIri: request.baseIri ?? options.baseIri,
            prefixes: request.prefixes,
          })
        : u;
      const baseIri = baseIriFor(request, ast.prologue);
      yield* Effect.annotateCurrentSpan('sparql.update.operations', ast.operations.length);
      yield* store.transaction(
        Effect.forEach(ast.operations, (op) => executeOperation(op, baseIri, request), {
          concurrency: 1,
          discard: true,
        }),
      );
    }).pipe(Effect.withSpan('SparqlEngine.update', { attributes: textAttributes(u) }));

  const evaluate: SparqlEngineShape['evaluate'] = (op, request = noRequest) =>
    Evaluator.evaluate(
      prebind(op, request),
      makeEnv(request.dataset ?? defaultDataset, baseIriFor(request)),
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
