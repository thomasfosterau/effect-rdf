/**
 * The generic, streaming evaluator of the SPARQL algebra over a `QuadStore`.
 *
 * @internal
 */
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
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
const ground = (t: PatternTerm, b: Bindings): Term.GroundTerm | undefined => {
  switch (t._tag) {
    case 'Variable':
      return b.map.get(t.value);
    case 'Triple': {
      const s = ground(t.subject, b);
      const p = ground(t.predicate, b);
      const o = ground(t.object, b);
      if (s === undefined || p === undefined || o === undefined) return undefined;
      return t.subject === s && t.predicate === p && t.object === o
        ? (t as Term.Triple)
        : Term.triple(s as Term.Subject, p as Term.Predicate, o as Term.Object);
    }
    case 'DefaultGraph':
      return undefined;
    default:
      return t;
  }
};

/** Unifies a pattern term with a value, extending `map`; false on mismatch. */
const unify = (t: PatternTerm, value: Term.Term, map: Map<string, Term.GroundTerm>): boolean => {
  switch (t._tag) {
    case 'Variable': {
      const bound = map.get(t.value);
      if (bound !== undefined) return bound.key === value.key;
      map.set(t.value, value as Term.GroundTerm);
      return true;
    }
    case 'Triple':
      return (
        value._tag === 'Triple' &&
        unify(t.subject, value.subject, map) &&
        unify(t.predicate, value.predicate, map) &&
        unify(t.object, value.object, map)
      );
    default:
      return t.key === value.key;
  }
};

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
  if (def.length === 0) return Stream.empty;
  if (def.length === 1) return env.store.match({ ...pattern, graph: def[0]! });
  return dedupeTriples(concatAll(def.map((g) => env.store.match({ ...pattern, graph: g }))));
};

const concatAll = <A, E>(streams: ReadonlyArray<Stream.Stream<A, E>>): Stream.Stream<A, E> =>
  streams.length === 0 ? Stream.empty : streams.reduce((a, b) => Stream.concat(a, b));

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
  switch (path._tag) {
    case 'PathLink':
      return Effect.map(
        collect(
          env,
          forward
            ? { subject: start, predicate: path.iri }
            : { predicate: path.iri, object: start },
        ),
        (qs) => qs.map((q) => (forward ? q.object : q.subject)),
      );
    case 'PathInverse':
      return pathFrom(env, path.path, start, !forward);
    case 'PathSequence': {
      const steps = forward ? path.paths : [...path.paths].reverse();
      return Effect.reduce(
        steps,
        (): ReadonlyArray<Term.GroundTerm> => [start],
        (frontier, step) =>
          Effect.map(
            Effect.forEach(frontier, (n) => pathFrom(env, step, n, forward)),
            (lists) => lists.flat(),
          ),
      );
    }
    case 'PathAlternative':
      return Effect.map(
        Effect.forEach(path.paths, (p) => pathFrom(env, p, start, forward)),
        (lists) => lists.flat(),
      );
    case 'PathZeroOrOne':
      return Effect.map(pathFrom(env, path.path, start, forward), (ns) =>
        distinctTerms([start, ...ns]),
      );
    case 'PathZeroOrMore':
    case 'PathOneOrMore':
      return closure(env, path.path, start, forward, path._tag === 'PathZeroOrMore');
    case 'PathNegated': {
      const parts: Array<E<ReadonlyArray<Term.GroundTerm>>> = [];
      const excluded = (list: ReadonlyArray<Term.NamedNode>) => new Set(list.map((i) => i.value));
      if (path.iris.length > 0 || path.inverse.length === 0) {
        const ex = excluded(path.iris);
        parts.push(
          Effect.map(collect(env, forward ? { subject: start } : { object: start }), (qs) =>
            qs
              .filter((q) => !ex.has(q.predicate.value))
              .map((q) => (forward ? q.object : q.subject)),
          ),
        );
      }
      if (path.inverse.length > 0) {
        const ex = excluded(path.inverse);
        parts.push(
          Effect.map(collect(env, forward ? { object: start } : { subject: start }), (qs) =>
            qs
              .filter((q) => !ex.has(q.predicate.value))
              .map((q) => (forward ? q.subject : q.object)),
          ),
        );
      }
      return Effect.map(Effect.all(parts), (lists) => lists.flat());
    }
  }
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
    while (frontier.length > 0) {
      const next: Array<Term.GroundTerm> = [];
      for (const n of frontier) {
        if (expanded.has(n.key)) continue;
        expanded.add(n.key);
        for (const m of yield* pathFrom(env, path, n, forward)) {
          if (!visited.has(m.key)) {
            visited.set(m.key, m);
            next.push(m);
          }
        }
      }
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
  switch (path._tag) {
    case 'PathLink':
      return Effect.map(collect(env, { predicate: path.iri }), (qs) =>
        qs.map((q) => [q.subject, q.object] as const),
      );
    case 'PathInverse':
      return Effect.map(pathAll(env, path.path), (ps) => ps.map(([a, b]) => [b, a] as const));
    case 'PathSequence': {
      const [first, ...rest] = path.paths;
      return Effect.flatMap(pathAll(env, first!), (pairs) =>
        Effect.map(
          Effect.forEach(pairs, ([x, m]) =>
            Effect.map(
              rest.length === 0
                ? Effect.succeed([m])
                : pathFrom(env, { _tag: 'PathSequence', paths: rest }, m, true),
              (ys) => ys.map((y) => [x, y] as const),
            ),
          ),
          (lists) => lists.flat(),
        ),
      );
    }
    case 'PathAlternative':
      return Effect.map(
        Effect.forEach(path.paths, (p) => pathAll(env, p)),
        (lists) => lists.flat(),
      );
    case 'PathNegated': {
      const out: Array<E<ReadonlyArray<readonly [Term.GroundTerm, Term.GroundTerm]>>> = [];
      if (path.iris.length > 0 || path.inverse.length === 0) {
        const ex = new Set(path.iris.map((i) => i.value));
        out.push(
          Effect.map(collect(env, {}), (qs) =>
            qs.filter((q) => !ex.has(q.predicate.value)).map((q) => [q.subject, q.object] as const),
          ),
        );
      }
      if (path.inverse.length > 0) {
        const ex = new Set(path.inverse.map((i) => i.value));
        out.push(
          Effect.map(collect(env, {}), (qs) =>
            qs.filter((q) => !ex.has(q.predicate.value)).map((q) => [q.object, q.subject] as const),
          ),
        );
      }
      return Effect.map(Effect.all(out), (lists) => lists.flat());
    }
    default:
      return Effect.flatMap(allNodes(env), (nodes) =>
        Effect.map(
          Effect.forEach(nodes, (n) =>
            Effect.map(pathFrom(env, path, n, true), (ys) => ys.map((y) => [n, y] as const)),
          ),
          (lists) => lists.flat(),
        ),
      );
  }
};

/** Whether a path can match with zero length. */
const nullable = (path: Ast.Path): boolean => {
  switch (path._tag) {
    case 'PathZeroOrMore':
    case 'PathZeroOrOne':
      return true;
    case 'PathInverse':
      return nullable(path.path);
    case 'PathSequence':
      return path.paths.every(nullable);
    case 'PathAlternative':
      return path.paths.some(nullable);
    default:
      return false;
  }
};

const isGraphNode = (env: Env, term: Term.GroundTerm): E<boolean> =>
  Effect.map(
    Effect.all([
      Stream.runHead(matchQuads(env, { subject: term })),
      Stream.runHead(matchQuads(env, { object: term })),
    ]),
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
        for (const [term, value] of [
          [op.subject, s],
          [op.object, o],
        ] as const) {
          if (value !== undefined && term._tag !== 'NamedNode' && term._tag !== 'Literal') {
            if (!(yield* isGraphNode(env, value))) return out;
          }
        }
      }
      const emit = (x: Term.GroundTerm, y: Term.GroundTerm) => {
        const map = new Map(initial.map);
        if (unify(op.subject, x, map) && unify(op.object, y, map)) out.push(new B.Bindings(map));
      };
      if (s !== undefined) {
        for (const y of yield* pathFrom(env, op.path, s, true)) emit(s, y);
      } else if (o !== undefined) {
        for (const x of yield* pathFrom(env, op.path, o, false)) emit(x, o);
      } else {
        for (const [x, y] of yield* pathAll(env, op.path)) emit(x, y);
      }
      return out;
    }),
  );

// -----------------------------------------------------------------------------
// Expressions with EXISTS
// -----------------------------------------------------------------------------

const collectExists = (e: Algebra.Expression, out: Array<Algebra.ExistsExpression>): void => {
  switch (e._tag) {
    case 'Exists':
      out.push(e);
      return;
    case 'Operation':
    case 'FunctionCall':
      for (const a of e.args) collectExists(a, out);
      return;
    default:
      return;
  }
};

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
  if (nodes.length === 0) return () => Effect.succeed(env.expr);
  return (b) =>
    Effect.map(
      Effect.forEach(nodes, (n) =>
        Effect.map(Stream.runHead(evaluate(n.input, { ...env, context: b })), Option.isSome),
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
  return out.length > 0;
};

// -----------------------------------------------------------------------------
// Joins
// -----------------------------------------------------------------------------

/** Operators that can be evaluated with an initial solution (bind join). */
const bindable = (op: Algebra.Operation): boolean =>
  op._tag === 'Bgp' ||
  op._tag === 'Path' ||
  (op._tag === 'Join' && bindable(op.left) && bindable(op.right));

const evalWith = (op: Algebra.Operation, env: Env, initial: Bindings): S => {
  switch (op._tag) {
    case 'Bgp':
      return evalBgp(op.patterns, env, initial);
    case 'Path':
      return evalPath(op, env, initial);
    case 'Join':
      return Stream.flatMap(evalWith(op.left, env, initial), (b) => evalWith(op.right, env, b));
    default:
      return Stream.die(new Error('not bindable'));
  }
};

const isUnit = (op: Algebra.Operation): boolean => op._tag === 'Bgp' && op.patterns.length === 0;

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
    if (vars.length === 0) return this.all;
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
    Effect.map(Effect.filter(matches, keep), (kept) => (kept.length > 0 ? kept : [a]));
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
  try {
    switch (agg.name) {
      case 'COUNT':
        return new Term.Literal(String(defined.length), V.dt.integer);
      case 'SUM': {
        if (defined.length !== values.length) return undefined;
        let acc: Term.GroundTerm = new Term.Literal('0', V.dt.integer);
        for (const v of defined) acc = V.arithmetic('+', acc, v);
        return acc;
      }
      case 'AVG': {
        if (defined.length !== values.length) return undefined;
        if (defined.length === 0) return new Term.Literal('0', V.dt.integer);
        let acc: Term.GroundTerm = new Term.Literal('0', V.dt.integer);
        for (const v of defined) acc = V.arithmetic('+', acc, v);
        return V.arithmetic('/', acc, new Term.Literal(String(defined.length), V.dt.integer));
      }
      case 'MIN':
      case 'MAX': {
        if (defined.length === 0) return undefined;
        let best = defined[0]!;
        for (const v of defined.slice(1)) {
          const c = V.orderCompare(v, best);
          if (agg.name === 'MIN' ? c < 0 : c > 0) best = v;
        }
        return best;
      }
      case 'SAMPLE':
        return defined[0];
      case 'GROUP_CONCAT': {
        if (defined.length !== values.length) return undefined;
        const lits = defined.map((v) => (v._tag === 'Literal' ? v : V.fail('Not a literal')));
        const sep = agg.separator ?? ' ';
        // GROUP_CONCAT always produces an xsd:string.
        return V.simple(lits.map((l) => l.value).join(sep));
      }
    }
  } catch (err) {
    if (err instanceof V.EvalFailure) return undefined;
    throw err;
  }
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
      if (groups.size === 0 && op.keys.length === 0) groups.set('', { keys: [], members: [] });
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
      keyed.sort((a, b) => {
        for (let i = 0; i < op.conditions.length; i++) {
          const c = V.orderCompare(a.keys[i], b.keys[i]);
          if (c !== 0) return op.conditions[i]!.descending ? -c : c;
        }
        return 0;
      });
      return keyed.map((k) => k.s);
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

const evalService = (op: Algebra.Service, env: Env): S => {
  const handler = env.service;
  const run = (endpoint: Term.NamedNode): S =>
    handler === undefined
      ? Stream.fail(
          new EvaluationError({ message: `SERVICE <${endpoint.value}> is not supported` }),
        )
      : handler(endpoint, op, env);
  if (op.name._tag === 'Variable') {
    return Stream.fail(
      new EvaluationError({ message: 'SERVICE with a variable endpoint is not supported' }),
    );
  }
  const stream = run(op.name);
  return op.silent ? Stream.catchCause(stream, () => Stream.succeed(B.empty)) : stream;
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
  switch (op._tag) {
    case 'Bgp':
      return evalBgp(op.patterns, env, op.patterns.length === 0 ? env.context : B.empty);
    case 'Path':
      return evalPath(op, env, B.empty);
    case 'Join':
      return evalJoin(op, env);
    case 'LeftJoin':
      return evalLeftJoin(op, env);
    case 'Filter':
      return filterStream(evaluate(op.input, env), op.expression, env);
    case 'Union':
      return Stream.concat(evaluate(op.left, env), evaluate(op.right, env));
    case 'Graph':
      return evalGraph(op, env);
    case 'Extend':
      return evalExtend(op, env);
    case 'Minus':
      return evalMinus(op, env);
    case 'Group':
      return evalGroup(op, env);
    case 'OrderBy':
      return evalOrderBy(op, env);
    case 'Project': {
      const names = op.variables.map((v) => v.value);
      return Stream.map(evaluate(op.input, env), (b) => B.project(b, names));
    }
    case 'Distinct':
    case 'Reduced':
      return Stream.suspend(() => {
        const seen = new Set<string>();
        return Stream.filter(evaluate(op.input, env), (b) => {
          if (seen.has(b.key)) return false;
          seen.add(b.key);
          return true;
        });
      });
    case 'Slice': {
      let s = evaluate(op.input, env);
      if (op.offset > 0) s = Stream.drop(s, op.offset);
      if (op.limit !== undefined) s = Stream.take(s, op.limit);
      return s;
    }
    case 'Values':
      return Stream.fromIterable(op.bindings);
    case 'Service':
      return evalService(op, env);
  }
};
