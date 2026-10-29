/**
 * The generic, streaming evaluator of the SPARQL algebra over a `QuadStore`.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Result from 'effect/Result';
import * as Stream from 'effect/Stream';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Algebra from '../Algebra.ts';
import type * as Ast from '../Ast.ts';
import * as B from '../Bindings.ts';
import { EvaluationError } from '../Errors.ts';
import * as Expression from '../Expression.ts';
import type * as Store from '../Store.ts';
import * as V from './values.ts';

type Bindings = B.Bindings;

/**
 * A handler for `SERVICE` patterns (federated queries).
 */
export type ServiceHandler = (
  endpoint: Term.NamedNode,
  service: Algebra.Service,
  env: Env,
) => Stream.Stream<Bindings, EvaluationError | Store.StoreError>;

export interface Env {
  readonly store: Store.QuadStoreShape;
  readonly dataset: Store.DatasetSpec;
  readonly graph: Store.ActiveGraph;
  /** The context solution (μctx) flowing into EXISTS patterns. */
  readonly context: Bindings;
  readonly expr: Expression.Context;
  readonly service?: ServiceHandler | undefined;
}

export type Err = Store.StoreError | EvaluationError;
type S = Stream.Stream<Bindings, Err>;

// -----------------------------------------------------------------------------
// Pattern matching
// -----------------------------------------------------------------------------

type PatternTerm = Ast.TermPattern | Term.Term;

/** Substitutes bound variables; returns a ground term or undefined (still variable). */
const ground: (t: PatternTerm, b: Bindings) => Term.GroundTerm | undefined = Match.fn(
  (t: PatternTerm, _b: Bindings) => t,
).pipe(
  Match.tag('Variable', (v, _t, b) => b.map.get(v.value)),
  Match.tag('Triple', (t, _t, b): Term.GroundTerm | undefined => {
    const s = ground(t.subject, b);
    const p = ground(t.predicate, b);
    const o = ground(t.object, b);
    if (s === undefined || p === undefined || o === undefined) return undefined;
    // SAFETY: unchanged components keep the triple pattern ground; otherwise substitution keeps
    // each position's kind.
    return t.subject === s && t.predicate === p && t.object === o
      ? (t as Term.Triple)
      : Term.triple(s as Term.Subject, p as Term.Predicate, o as Term.Object);
  }),
  Match.tag('DefaultGraph', () => undefined),
  Match.orElse((t) => t),
);

/** Unifies a pattern term with a value, extending `map`; false on mismatch. */
const unify: (t: PatternTerm, value: Term.Term, map: Map<string, Term.GroundTerm>) => boolean =
  Match.fn((t: PatternTerm, _value: Term.Term, _map: Map<string, Term.GroundTerm>) => t).pipe(
    Match.tag('Variable', (v, _t, value, map) => {
      const bound = map.get(v.value);
      if (bound !== undefined) return bound.key === value.key;
      // SAFETY: only ground terms are bound in solutions.
      map.set(v.value, value as Term.GroundTerm);
      return true;
    }),
    Match.tag(
      'Triple',
      (t, _t, value, map) =>
        value._tag === 'Triple' &&
        unify(t.subject, value.subject, map) &&
        unify(t.predicate, value.predicate, map) &&
        unify(t.object, value.object, map),
    ),
    Match.orElse((t, _t, value) => t.key === value.key),
  );

const dedupeTriples = (quads: Stream.Stream<Term.Quad, Store.StoreError>) =>
  Stream.suspend(() => {
    const seen = new Set<string>();
    return Stream.filter(quads, (q) => {
      const k = `${q.subject.key} ${q.predicate.key} ${q.object.key}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

/** Matches a quad pattern (without graph) in the active graph. */
export const matchQuads = (
  env: Env,
  pattern: Omit<Store.QuadPattern, 'graph'>,
): Stream.Stream<Term.Quad, Store.StoreError> => {
  if (env.graph._tag === 'NamedGraph')
    return env.store.match({ ...pattern, graph: env.graph.graph });
  const def = env.dataset.defaultGraph;
  if (def === 'default') return env.store.match({ ...pattern, graph: Term.defaultGraph });
  if (def === 'union') return dedupeTriples(env.store.match({ ...pattern, graph: undefined }));
  if (Arr.isReadonlyArrayEmpty(def)) return Stream.empty;
  if (def.length === 1) return env.store.match({ ...pattern, graph: def[0]! });
  return dedupeTriples(concatAll(def.map((g) => env.store.match({ ...pattern, graph: g }))));
};

const concatAll = <A, E>(streams: ReadonlyArray<Stream.Stream<A, E>>): Stream.Stream<A, E> =>
  Arr.isReadonlyArrayEmpty(streams) ? Stream.empty : streams.reduce((a, b) => Stream.concat(a, b));

const matchTriple = (pattern: Ast.TriplePattern, env: Env, b: Bindings): S => {
  const s = ground(pattern.subject, b);
  const p = ground(pattern.predicate, b);
  const o = ground(pattern.object, b);
  return matchQuads(env, { subject: s, predicate: p, object: o }).pipe(
    Stream.filterMap((q) => {
      const map = new Map(b.map);
      if (
        (s !== undefined || unify(pattern.subject, q.subject, map)) &&
        (p !== undefined || unify(pattern.predicate, q.predicate, map)) &&
        (o !== undefined || unify(pattern.object, q.object, map))
      ) {
        return Result.succeed(new B.Bindings(map));
      }
      return Result.fail(undefined);
    }),
  );
};

const evalBgp = (patterns: ReadonlyArray<Ast.TriplePattern>, env: Env, initial: Bindings): S => {
  let stream: S = Stream.succeed(initial);
  for (const p of patterns) stream = Stream.flatMap(stream, (b) => matchTriple(p, env, b));
  return stream;
};

// -----------------------------------------------------------------------------
// Property paths
// -----------------------------------------------------------------------------

type E<A> = Effect.Effect<A, Store.StoreError>;

/** `Effect.forEach` in order, concatenating each element's results. */
const forEachFlat = <A, B>(
  items: Iterable<A>,
  f: (a: A) => E<ReadonlyArray<B>>,
): E<ReadonlyArray<B>> =>
  Effect.map(Effect.forEach(items, f, { concurrency: 1 }), (lists) => lists.flat());

const collect = (
  env: Env,
  pattern: Omit<Store.QuadPattern, 'graph'>,
): E<ReadonlyArray<Term.Quad>> => Stream.runCollect(matchQuads(env, pattern));

const distinctTerms = (terms: ReadonlyArray<Term.GroundTerm>): Array<Term.GroundTerm> => {
  const seen = new Map<string, Term.GroundTerm>();
  for (const t of terms) if (!seen.has(t.key)) seen.set(t.key, t);
  return Array.from(seen.values());
};

/** Nodes reachable from `start` by `path` (forward) or reaching `start` (backward); a bag. */
const pathFrom = (
  env: Env,
  path: Ast.Path,
  start: Term.GroundTerm,
  forward: boolean,
): E<ReadonlyArray<Term.GroundTerm>> => {
  return Match.value(path).pipe(
    Match.tag('PathLink', (link) =>
      Effect.map(
        collect(
          env,
          forward
            ? { subject: start, predicate: link.iri }
            : { predicate: link.iri, object: start },
        ),
        (qs) => qs.map((q) => (forward ? q.object : q.subject)),
      ),
    ),
    Match.tag('PathInverse', (inv) => pathFrom(env, inv.path, start, !forward)),
    Match.tag('PathSequence', (seq) => {
      const steps = forward ? seq.paths : [...seq.paths].reverse();
      return Effect.reduce(
        steps,
        (): ReadonlyArray<Term.GroundTerm> => [start],
        (frontier, step) => forEachFlat(frontier, (n) => pathFrom(env, step, n, forward)),
      );
    }),
    Match.tag('PathAlternative', (alt) =>
      forEachFlat(alt.paths, (p) => pathFrom(env, p, start, forward)),
    ),
    Match.tag('PathZeroOrOne', (opt) =>
      Effect.map(pathFrom(env, opt.path, start, forward), (ns) => distinctTerms([start, ...ns])),
    ),
    Match.tag('PathZeroOrMore', 'PathOneOrMore', (rep) =>
      closure(env, rep.path, start, forward, rep._tag === 'PathZeroOrMore'),
    ),
    Match.tag('PathNegated', (neg) => {
      const parts: Array<E<ReadonlyArray<Term.GroundTerm>>> = [];
      const excluded = (list: ReadonlyArray<Term.NamedNode>) => new Set(list.map((i) => i.value));
      if (Arr.isReadonlyArrayNonEmpty(neg.iris) || Arr.isReadonlyArrayEmpty(neg.inverse)) {
        const ex = excluded(neg.iris);
        parts.push(
          Effect.map(collect(env, forward ? { subject: start } : { object: start }), (qs) =>
            qs
              .filter((q) => !ex.has(q.predicate.value))
              .map((q) => (forward ? q.object : q.subject)),
          ),
        );
      }
      if (Arr.isReadonlyArrayNonEmpty(neg.inverse)) {
        const ex = excluded(neg.inverse);
        parts.push(
          Effect.map(collect(env, forward ? { object: start } : { subject: start }), (qs) =>
            qs
              .filter((q) => !ex.has(q.predicate.value))
              .map((q) => (forward ? q.subject : q.object)),
          ),
        );
      }
      return Effect.map(Effect.all(parts, { concurrency: 1 }), (lists) => lists.flat());
    }),
    Match.exhaustive,
  );
};

const closure = (
  env: Env,
  path: Ast.Path,
  start: Term.GroundTerm,
  forward: boolean,
  includeStart: boolean,
): E<ReadonlyArray<Term.GroundTerm>> =>
  Effect.gen(function* () {
    const visited = new Map<string, Term.GroundTerm>();
    if (includeStart) visited.set(start.key, start);
    let frontier: Array<Term.GroundTerm> = [start];
    const expanded = new Set<string>();
    while (Arr.isReadonlyArrayNonEmpty(frontier)) {
      const next: Array<Term.GroundTerm> = [];
      const unexpanded = frontier.filter((n) => {
        if (expanded.has(n.key)) return false;
        expanded.add(n.key);
        return true;
      });
      yield* Effect.forEach(
        unexpanded,
        (n) =>
          Effect.map(pathFrom(env, path, n, forward), (reached) => {
            for (const m of reached) {
              if (!visited.has(m.key)) {
                visited.set(m.key, m);
                next.push(m);
              }
            }
          }),
        { concurrency: 1, discard: true },
      );
      frontier = next;
    }
    return Array.from(visited.values());
  });

/** All nodes (subjects and objects) of the active graph. */
const allNodes = (env: Env): E<ReadonlyArray<Term.GroundTerm>> =>
  Effect.map(collect(env, {}), (qs) => distinctTerms(qs.flatMap((q) => [q.subject, q.object])));

const pathAll = (
  env: Env,
  path: Ast.Path,
): E<ReadonlyArray<readonly [Term.GroundTerm, Term.GroundTerm]>> => {
  return Match.value(path).pipe(
    Match.tag('PathLink', (link): E<ReadonlyArray<readonly [Term.GroundTerm, Term.GroundTerm]>> =>
      Effect.map(collect(env, { predicate: link.iri }), (qs) =>
        qs.map((q) => [q.subject, q.object] as const),
      ),
    ),
    Match.tag('PathInverse', (inv) =>
      Effect.map(pathAll(env, inv.path), (ps) => ps.map(([a, b]) => [b, a] as const)),
    ),
    Match.tag('PathSequence', (seq) => {
      const [first, ...rest] = seq.paths;
      return Effect.flatMap(pathAll(env, first!), (pairs) =>
        forEachFlat(pairs, ([x, m]) =>
          Effect.map(
            Arr.isReadonlyArrayEmpty(rest)
              ? Effect.succeed([m])
              : pathFrom(env, { _tag: 'PathSequence', paths: rest }, m, true),
            (ys) => ys.map((y) => [x, y] as const),
          ),
        ),
      );
    }),
    Match.tag('PathAlternative', (alt) => forEachFlat(alt.paths, (p) => pathAll(env, p))),
    Match.tag('PathNegated', (neg) => {
      const out: Array<E<ReadonlyArray<readonly [Term.GroundTerm, Term.GroundTerm]>>> = [];
      if (Arr.isReadonlyArrayNonEmpty(neg.iris) || Arr.isReadonlyArrayEmpty(neg.inverse)) {
        const ex = new Set(neg.iris.map((i) => i.value));
        out.push(
          Effect.map(collect(env, {}), (qs) =>
            qs.filter((q) => !ex.has(q.predicate.value)).map((q) => [q.subject, q.object] as const),
          ),
        );
      }
      if (Arr.isReadonlyArrayNonEmpty(neg.inverse)) {
        const ex = new Set(neg.inverse.map((i) => i.value));
        out.push(
          Effect.map(collect(env, {}), (qs) =>
            qs.filter((q) => !ex.has(q.predicate.value)).map((q) => [q.object, q.subject] as const),
          ),
        );
      }
      return Effect.map(Effect.all(out, { concurrency: 1 }), (lists) => lists.flat());
    }),
    Match.orElse((p) =>
      Effect.flatMap(allNodes(env), (nodes) =>
        forEachFlat(nodes, (n) =>
          Effect.map(pathFrom(env, p, n, true), (ys) => ys.map((y) => [n, y] as const)),
        ),
      ),
    ),
  );
};

/** Whether a path can match with zero length. */
const nullable: (path: Ast.Path) => boolean = Match.type<Ast.Path>().pipe(
  Match.tag('PathZeroOrMore', 'PathZeroOrOne', () => true),
  Match.tag('PathInverse', (p) => nullable(p.path)),
  Match.tag('PathSequence', (p) => p.paths.every(nullable)),
  Match.tag('PathAlternative', (p) => p.paths.some(nullable)),
  Match.orElse(() => false),
);

const isGraphNode = (env: Env, term: Term.GroundTerm): E<boolean> =>
  Effect.map(
    Effect.all(
      [
        Stream.runHead(matchQuads(env, { subject: term })),
        Stream.runHead(matchQuads(env, { object: term })),
      ],
      { concurrency: 1 },
    ),
    ([a, b]) => Option.isSome(a) || Option.isSome(b),
  );

const evalPath = (op: Algebra.Path, env: Env, initial: Bindings): S =>
  Stream.fromIterableEffect(
    Effect.gen(function* () {
      const s = ground(op.subject, initial);
      const o = ground(op.object, initial);
      const out: Array<Bindings> = [];
      // A variable endpoint ranges over the nodes of the graph only (the
      // zero-length case must not produce terms that are not in the graph),
      // so an endpoint bound by an outer solution must be a graph node.
      if (nullable(op.path)) {
        const endpoints = [
          [op.subject, s],
          [op.object, o],
        ] as const;
        const outsideGraph = yield* Effect.findFirst(endpoints, ([term, value]) =>
          value !== undefined && term._tag !== 'NamedNode' && term._tag !== 'Literal'
            ? Effect.map(isGraphNode(env, value), (isNode) => !isNode)
            : Effect.succeed(false),
        );
        if (Option.isSome(outsideGraph)) return out;
      }
      const emit = (x: Term.GroundTerm, y: Term.GroundTerm) => {
        const map = new Map(initial.map);
        if (unify(op.subject, x, map) && unify(op.object, y, map)) out.push(new B.Bindings(map));
      };
      if (s !== undefined) {
        const ys = yield* pathFrom(env, op.path, s, true);
        for (const y of ys) emit(s, y);
      } else if (o !== undefined) {
        const xs = yield* pathFrom(env, op.path, o, false);
        for (const x of xs) emit(x, o);
      } else {
        const pairs = yield* pathAll(env, op.path);
        for (const [x, y] of pairs) emit(x, y);
      }
      return out;
    }),
  );

// -----------------------------------------------------------------------------
// Expressions with EXISTS
// -----------------------------------------------------------------------------

const collectExists: (e: Algebra.Expression, out: Array<Algebra.ExistsExpression>) => void =
  Match.fn((e: Algebra.Expression, _out: Array<Algebra.ExistsExpression>) => e).pipe(
    Match.tag('Exists', (x, _e, out) => {
      out.push(x);
    }),
    Match.tag('Operation', 'FunctionCall', (call, _e, out) => {
      for (const a of call.args) collectExists(a, out);
    }),
    Match.orElse(() => undefined),
  );

/**
 * Prepares an expression for evaluation: returns a function producing the
 * expression context for a solution (precomputing EXISTS patterns).
 */
const prepare = (
  expression: Algebra.Expression,
  env: Env,
): ((b: Bindings) => Effect.Effect<Expression.Context, Err>) => {
  const nodes: Array<Algebra.ExistsExpression> = [];
  collectExists(expression, nodes);
  if (Arr.isReadonlyArrayEmpty(nodes)) return () => Effect.succeed(env.expr);
  return (b) =>
    Effect.map(
      Effect.forEach(
        nodes,
        (n) => Effect.map(Stream.runHead(evaluate(n.input, { ...env, context: b })), Option.isSome),
        { concurrency: 1 },
      ),
      (results) => {
        const table = new Map(nodes.map((n, i) => [n, results[i]!] as const));
        return { ...env.expr, exists: (e: Algebra.ExistsExpression) => table.get(e) ?? false };
      },
    );
};

const filterStream = (stream: S, expression: Algebra.Expression, env: Env): S => {
  const ctxFor = prepare(expression, env);
  if (!Algebra_containsExists(expression)) {
    return Stream.filter(stream, (b) => Expression.test(expression, b, env.expr));
  }
  return Stream.filterEffect(stream, (b) =>
    Effect.map(ctxFor(b), (ctx) => Expression.test(expression, b, ctx)),
  );
};

const Algebra_containsExists = (e: Algebra.Expression): boolean => {
  const out: Array<Algebra.ExistsExpression> = [];
  collectExists(e, out);
  return Arr.isReadonlyArrayNonEmpty(out);
};

// -----------------------------------------------------------------------------
// Joins
// -----------------------------------------------------------------------------

/** Operators that can be evaluated with an initial solution (bind join). */
const bindable = (op: Algebra.Operation): boolean =>
  op._tag === 'Bgp' ||
  op._tag === 'Path' ||
  // `SERVICE ?endpoint` is evaluated per solution once `?endpoint` is bound.
  (op._tag === 'Service' && op.name._tag === 'Variable') ||
  (op._tag === 'Join' && bindable(op.left) && bindable(op.right));

const evalWith = (op: Algebra.Operation, env: Env, initial: Bindings): S => {
  return Match.value(op).pipe(
    Match.tag('Bgp', (o): S => evalBgp(o.patterns, env, initial)),
    Match.tag('Path', (o) => evalPath(o, env, initial)),
    Match.tag('Join', (o) =>
      Stream.flatMap(evalWith(o.left, env, initial), (b) => evalWith(o.right, env, b)),
    ),
    Match.tag('Service', (o) => evalBoundService(o, env, initial)),
    Match.orElse(() => Stream.die(new Cause.IllegalArgumentError('not bindable'))),
  );
};

const isUnit = (op: Algebra.Operation): boolean =>
  op._tag === 'Bgp' && Arr.isReadonlyArrayEmpty(op.patterns);

/** An index of solutions by the values of the variables bound in all of them. */
class SolutionIndex {
  readonly keyVars: ReadonlyArray<string>;
  readonly buckets = new Map<string, Array<Bindings>>();
  readonly all: ReadonlyArray<Bindings>;
  constructor(solutions: ReadonlyArray<Bindings>) {
    this.all = solutions;
    const first = solutions[0];
    this.keyVars =
      first === undefined
        ? []
        : Array.from(first.map.keys()).filter((v) => solutions.every((s) => s.map.has(v)));
  }
  candidates(b: Bindings): ReadonlyArray<Bindings> {
    const vars = this.keyVars.filter((v) => b.map.has(v));
    if (Arr.isReadonlyArrayEmpty(vars)) return this.all;
    const sig = vars.join('|');
    const key = `${sig}#${vars.map((v) => b.map.get(v)!.key).join('\u0001')}`;
    if (!this.buckets.has(`${sig}#__built`)) {
      this.buckets.set(`${sig}#__built`, []);
      for (const s of this.all) {
        const k = `${sig}#${vars.map((v) => s.map.get(v)!.key).join('\u0001')}`;
        let list = this.buckets.get(k);
        if (list === undefined) this.buckets.set(k, (list = []));
        list.push(s);
      }
    }
    return this.buckets.get(key) ?? [];
  }
}

const materialize = (op: Algebra.Operation, env: Env) => Stream.runCollect(evaluate(op, env));

const evalJoin = (op: Algebra.Join, env: Env): S => {
  if (isUnit(op.left)) {
    return bindable(op.right)
      ? evalWith(op.right, env, env.context)
      : joinWith(Stream.succeed(env.context), op.right, env);
  }
  if (bindable(op.right)) {
    return Stream.flatMap(evaluate(op.left, env), (b) => evalWith(op.right, env, b));
  }
  return joinWith(evaluate(op.left, env), op.right, env);
};

const joinWith = (left: S, right: Algebra.Operation, env: Env): S =>
  Stream.unwrap(
    Effect.map(materialize(right, env), (rs) => {
      const index = new SolutionIndex(rs);
      return Stream.flatMap(left, (a) =>
        Stream.fromIterable(
          index.candidates(a).flatMap((r) => {
            const m = B.merge(a, r);
            return m === undefined ? [] : [m];
          }),
        ),
      );
    }),
  );

const evalLeftJoin = (op: Algebra.LeftJoin, env: Env): S => {
  const left = isUnit(op.left) ? Stream.succeed(env.context) : evaluate(op.left, env);
  const expression = op.expression;
  const ctxFor = expression !== undefined ? prepare(expression, env) : undefined;
  const keep = (b: Bindings): Effect.Effect<boolean, Err> =>
    expression === undefined
      ? Effect.succeed(true)
      : Effect.map(ctxFor!(b), (ctx) => Expression.test(expression, b, ctx));
  const extend = (a: Bindings, matches: ReadonlyArray<Bindings>) =>
    Effect.map(Effect.filter(matches, keep), (kept) =>
      Arr.isReadonlyArrayNonEmpty(kept) ? kept : [a],
    );
  if (bindable(op.right)) {
    return Stream.flatMap(left, (a) =>
      Stream.fromIterableEffect(
        Effect.flatMap(Stream.runCollect(evalWith(op.right, env, a)), (ms) => extend(a, ms)),
      ),
    );
  }
  return Stream.unwrap(
    Effect.map(materialize(op.right, env), (rs) => {
      const index = new SolutionIndex(rs);
      return Stream.flatMap(left, (a) => {
        const merged = index.candidates(a).flatMap((r) => {
          const m = B.merge(a, r);
          return m === undefined ? [] : [m];
        });
        return Stream.fromIterableEffect(extend(a, merged));
      });
    }),
  );
};

const evalMinus = (op: Algebra.Minus, env: Env): S =>
  Stream.unwrap(
    Effect.map(materialize(op.right, env), (rs) =>
      Stream.filter(
        isUnit(op.left) ? Stream.succeed(env.context) : evaluate(op.left, env),
        (a) => !rs.some((r) => B.sharesVariable(a, r) && B.compatible(a, r)),
      ),
    ),
  );

// -----------------------------------------------------------------------------
// Graphs
// -----------------------------------------------------------------------------

const namedGraphs = (env: Env): E<ReadonlyArray<Term.NamedNode | Term.BlankNode>> =>
  env.dataset.namedGraphs === 'all'
    ? Stream.runCollect(env.store.graphs)
    : Effect.succeed(env.dataset.namedGraphs);

const evalGraph = (op: Algebra.Graph, env: Env): S => {
  if (op.name._tag === 'NamedNode') {
    const name = op.name;
    return Stream.unwrap(
      Effect.map(namedGraphs(env), (graphs) =>
        graphs.some((g) => g.key === name.key)
          ? evaluate(op.input, { ...env, graph: { _tag: 'NamedGraph', graph: name } })
          : Stream.empty,
      ),
    );
  }
  const variable = op.name.value;
  return Stream.unwrap(
    Effect.map(namedGraphs(env), (graphs) =>
      concatAll(
        graphs.map((g) =>
          evaluate(op.input, { ...env, graph: { _tag: 'NamedGraph', graph: g } }).pipe(
            Stream.filterMap((b) => {
              const m = B.merge(b, new B.Bindings(new Map([[variable, g]])));
              return m === undefined ? Result.fail(undefined) : Result.succeed(m);
            }),
          ),
        ),
      ),
    ),
  );
};

// -----------------------------------------------------------------------------
// Grouping and aggregation
// -----------------------------------------------------------------------------

const aggregateValue = (
  agg: Algebra.Aggregate,
  members: ReadonlyArray<Bindings>,
  env: Env,
): Term.GroundTerm | undefined => {
  if (agg.expression === '*') {
    if (agg.name !== 'COUNT') return undefined;
    const n = agg.distinct ? new Set(members.map((m) => m.key)).size : members.length;
    return new Term.Literal(String(n), V.dt.integer);
  }
  const expr = agg.expression;
  let values: Array<Term.GroundTerm | undefined> = members.map((m) =>
    Expression.evaluateOrUndefined(expr, m, env.expr),
  );
  if (agg.distinct) {
    const seen = new Set<string>();
    values = values.filter((v) => {
      const k = v === undefined ? '' : v.key;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  const defined = values.filter((v): v is Term.GroundTerm => v !== undefined);
  // An expression error in the aggregate leaves it unbound.
  return Result.getOrUndefined(V.catchEvalFailure(() => aggregateOf(agg, values, defined)));
};

const aggregateOf = (
  agg: Algebra.Aggregate,
  values: ReadonlyArray<Term.GroundTerm | undefined>,
  defined: ReadonlyArray<Term.GroundTerm>,
): Term.GroundTerm | undefined => {
  return Match.value(agg.name).pipe(
    Match.when(
      'COUNT',
      (): Term.GroundTerm | undefined => new Term.Literal(String(defined.length), V.dt.integer),
    ),
    Match.when('SUM', () => {
      if (defined.length !== values.length) return undefined;
      let acc: Term.GroundTerm = new Term.Literal('0', V.dt.integer);
      for (const v of defined) acc = V.arithmetic('+', acc, v);
      return acc;
    }),
    Match.when('AVG', () => {
      if (defined.length !== values.length) return undefined;
      if (Arr.isReadonlyArrayEmpty(defined)) return new Term.Literal('0', V.dt.integer);
      let acc: Term.GroundTerm = new Term.Literal('0', V.dt.integer);
      for (const v of defined) acc = V.arithmetic('+', acc, v);
      return V.arithmetic('/', acc, new Term.Literal(String(defined.length), V.dt.integer));
    }),
    Match.when(Match.is('MIN', 'MAX'), (name) => {
      if (Arr.isReadonlyArrayEmpty(defined)) return undefined;
      let best = defined[0]!;
      for (const v of defined.slice(1)) {
        const c = V.orderCompare(v, best);
        if (name === 'MIN' ? c < 0 : c > 0) best = v;
      }
      return best;
    }),
    Match.when('SAMPLE', () => defined[0]),
    Match.when('GROUP_CONCAT', () => {
      if (defined.length !== values.length) return undefined;
      const lits = defined.map((v) => (v._tag === 'Literal' ? v : V.fail('Not a literal')));
      const sep = agg.separator ?? ' ';
      // GROUP_CONCAT always produces an xsd:string.
      return V.simple(lits.map((l) => l.value).join(sep));
    }),
    Match.exhaustive,
  );
};

const evalGroup = (op: Algebra.Group, env: Env): S =>
  Stream.fromIterableEffect(
    Effect.map(materialize(op.input, env), (solutions) => {
      const groups = new Map<
        string,
        { keys: Array<Term.GroundTerm | undefined>; members: Array<Bindings> }
      >();
      for (const s of solutions) {
        const keys = op.keys.map((k) => Expression.evaluateOrUndefined(k.expression, s, env.expr));
        const id = keys.map((k) => (k === undefined ? '' : k.key)).join('\u0001');
        let g = groups.get(id);
        if (g === undefined) groups.set(id, (g = { keys, members: [] }));
        g.members.push(s);
      }
      if (groups.size === 0 && Arr.isReadonlyArrayEmpty(op.keys))
        groups.set('', { keys: [], members: [] });
      const out: Array<Bindings> = [];
      for (const g of groups.values()) {
        const map = new Map<string, Term.GroundTerm>();
        op.keys.forEach((k, i) => {
          const v = g.keys[i];
          if (v !== undefined) map.set(k.variable.value, v);
        });
        for (const a of op.aggregates) {
          const v = aggregateValue(a.aggregate, g.members, env);
          if (v !== undefined) map.set(a.variable.value, v);
        }
        out.push(new B.Bindings(map));
      }
      return out;
    }),
  );

const evalOrderBy = (op: Algebra.OrderBy, env: Env): S =>
  Stream.fromIterableEffect(
    Effect.map(materialize(op.input, env), (solutions) => {
      const keyed = solutions.map((s) => ({
        s,
        keys: op.conditions.map((c) => Expression.evaluateOrUndefined(c.expression, s, env.expr)),
      }));
      const byConditions = Order.make<(typeof keyed)[number]>((a, b) => {
        for (let i = 0; i < op.conditions.length; i++) {
          const c = V.orderCompare(a.keys[i], b.keys[i]);
          if (c !== 0) return c < 0 === op.conditions[i]!.descending ? 1 : -1;
        }
        return 0;
      });
      return Arr.sort(keyed, byConditions).map((k) => k.s);
    }),
  );

const evalExtend = (op: Algebra.Extend, env: Env): S => {
  const name = op.variable.value;
  const ctxFor = prepare(op.expression, env);
  const input = isUnit(op.input) ? Stream.succeed(env.context) : evaluate(op.input, env);
  return Stream.mapEffect(input, (b) =>
    Effect.map(ctxFor(b), (ctx) => {
      if (b.map.has(name)) return b;
      const v = Expression.evaluateOrUndefined(op.expression, b, ctx);
      return v === undefined ? b : B.set(b, name, v);
    }),
  );
};

const runService = (op: Algebra.Service, env: Env, endpoint: Term.NamedNode): S => {
  const handler = env.service;
  const stream: S =
    handler === undefined
      ? Stream.fail(
          new EvaluationError({ message: `SERVICE <${endpoint.value}> is not supported` }),
        )
      : handler(endpoint, op, env);
  return op.silent ? Stream.catchCause(stream, () => Stream.succeed(B.empty)) : stream;
};

const evalService = (op: Algebra.Service, env: Env): S => {
  if (op.name._tag === 'Variable') {
    return Stream.fail(
      new EvaluationError({
        message: `SERVICE ?${op.name.value} needs the endpoint variable to be bound first`,
      }),
    );
  }
  return runService(op, env, op.name);
};

/**
 * `SERVICE ?endpoint { … }` with `?endpoint` bound by an earlier pattern:
 * the remote pattern is evaluated at the bound endpoint and joined with the
 * solution.
 */
const mergeWith = (initial: Bindings, solutions: S): S =>
  Stream.flatMap(solutions, (b) => {
    const m = B.merge(initial, b);
    return m === undefined ? Stream.empty : Stream.succeed(m);
  });

const evalBoundService = (op: Algebra.Service, env: Env, initial: Bindings): S => {
  if (op.name._tag === 'NamedNode') {
    return mergeWith(initial, runService(op, env, op.name));
  }
  const endpoint = initial.map.get(op.name.value);
  if (endpoint === undefined || endpoint._tag !== 'NamedNode') {
    return op.silent
      ? Stream.succeed(initial)
      : Stream.fail(
          new EvaluationError({
            message: `SERVICE ?${op.name.value} is not bound to an IRI`,
          }),
        );
  }
  return mergeWith(initial, runService(op, env, endpoint));
};

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------

/** Evaluates an algebra operator, offering it to the store's query capability first. */
export const evaluate = (op: Algebra.Operation, env: Env): S => {
  const capability = env.store.query;
  if (capability !== undefined && env.context.size === 0) {
    const native = capability.evaluate(op, {
      dataset: env.dataset,
      activeGraph: env.graph,
      evaluate: (o, g) => evaluate(o, g === undefined ? env : { ...env, graph: g }),
    });
    if (Option.isSome(native)) return native.value;
  }
  return evaluateGeneric(op, env);
};

const evaluateGeneric = (op: Algebra.Operation, env: Env): S => {
  return Match.value(op).pipe(
    Match.tag('Bgp', (o): S =>
      evalBgp(o.patterns, env, Arr.isReadonlyArrayEmpty(o.patterns) ? env.context : B.empty),
    ),
    Match.tag('Path', (o) => evalPath(o, env, B.empty)),
    Match.tag('Join', (o) => evalJoin(o, env)),
    Match.tag('LeftJoin', (o) => evalLeftJoin(o, env)),
    Match.tag('Filter', (o) => filterStream(evaluate(o.input, env), o.expression, env)),
    Match.tag('Union', (o) => Stream.concat(evaluate(o.left, env), evaluate(o.right, env))),
    Match.tag('Graph', (o) => evalGraph(o, env)),
    Match.tag('Extend', (o) => evalExtend(o, env)),
    Match.tag('Minus', (o) => evalMinus(o, env)),
    Match.tag('Group', (o) => evalGroup(o, env)),
    Match.tag('OrderBy', (o) => evalOrderBy(o, env)),
    Match.tag('Project', (o) => {
      const names = o.variables.map((v) => v.value);
      return Stream.map(evaluate(o.input, env), (b) => B.project(b, names));
    }),
    Match.tag('Distinct', 'Reduced', (o) =>
      Stream.suspend(() => {
        const seen = new Set<string>();
        return Stream.filter(evaluate(o.input, env), (b) => {
          if (seen.has(b.key)) return false;
          seen.add(b.key);
          return true;
        });
      }),
    ),
    Match.tag('Slice', (o) => {
      let s = evaluate(o.input, env);
      if (o.offset > 0) s = Stream.drop(s, o.offset);
      if (o.limit !== undefined) s = Stream.take(s, o.limit);
      return s;
    }),
    Match.tag('Values', (o) => Stream.fromIterable(o.bindings)),
    Match.tag('Service', (o) => evalService(o, env)),
    Match.exhaustive,
  );
};
