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
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Stream from 'effect/Stream';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Algebra from '../Algebra.ts';
import type * as Ast from '../Ast.ts';
import * as B from '../Bindings.ts';
import { EvaluationError } from '../Errors.ts';
import * as Expression from '../Expression.ts';
import type * as Store from '../Store.ts';
import * as StringMap from './stringMap.ts';
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
  /** The handler for `SERVICE` patterns, if federation is configured. */
  readonly service: Option.Option<ServiceHandler>;
}

export type Err = Store.StoreError | EvaluationError;
type S = Stream.Stream<Bindings, Err>;

// -----------------------------------------------------------------------------
// Pattern matching
// -----------------------------------------------------------------------------

type PatternTerm = Ast.TermPattern | Term.Term;

/**
 * Substitutes bound variables: the ground term, or `None` while a variable
 * is unbound. Plain branches rather than `Match`: it runs for every term of
 * every triple pattern per solution.
 */
const ground = (t: PatternTerm, b: Bindings): Option.Option<Term.GroundTerm> => {
  if (Term.isVariable(t)) return Option.fromUndefinedOr(b.map.get(t.value));
  if (Term.isTriple(t)) {
    const s = ground(t.subject, b);
    if (Option.isNone(s)) return s;
    const p = ground(t.predicate, b);
    if (Option.isNone(p)) return p;
    const o = ground(t.object, b);
    if (Option.isNone(o)) return o;
    // Unchanged components keep the triple pattern ground; otherwise substitution keeps each
    // position's kind.
    return t.subject === s.value && t.predicate === p.value && t.object === o.value
      ? Option.some(t)
      : Option.some(Term.triple<any, any, any>(s.value, p.value, o.value));
  }
  return Term.isDefaultGraph(t) ? Option.none() : Option.some(t);
};

/**
 * Unifies a pattern term with a value, extending `map`; false on mismatch.
 * Plain branches rather than `Match`: it runs for every matched quad.
 */
const unify = (
  t: PatternTerm,
  value: Term.GroundTerm,
  map: Map<string, Term.GroundTerm>,
): boolean => {
  if (Term.isVariable(t)) {
    const bound = map.get(t.value);
    if (bound !== undefined) return bound.key === value.key;
    map.set(t.value, value);
    return true;
  }
  if (Term.isTriple(t)) {
    return (
      Term.isTriple(value) &&
      unify(t.subject, value.subject, map) &&
      unify(t.predicate, value.predicate, map) &&
      unify(t.object, value.object, map)
    );
  }
  return t.key === value.key;
};

const dedupeTriples = (quads: Stream.Stream<Term.Quad, Store.StoreError>) =>
  Stream.suspend(() => {
    const seen = StringMap.emptySet();
    return Stream.filter(quads, (q) => {
      const k = `${q.subject.key} ${q.predicate.key} ${q.object.key}`;
      if (seen.has(k)) return false;
      seen.set(k, true);
      return true;
    });
  });

/** Matches a quad pattern (without graph) in the active graph. */
export const matchQuads = (
  env: Env,
  pattern: Omit<Store.QuadPattern, 'graph'>,
): Stream.Stream<Term.Quad, Store.StoreError> => {
  const active = env.graph;
  if (Predicate.isTagged(active, 'NamedGraph')) {
    return env.store.match({ ...pattern, graph: active.graph });
  }
  const def = env.dataset.defaultGraph;
  if (def === 'default') return env.store.match({ ...pattern, graph: Term.defaultGraph });
  if (def === 'union') return dedupeTriples(env.store.match({ ...pattern, graph: undefined }));
  if (!Arr.isReadonlyArrayNonEmpty(def)) return Stream.empty;
  if (def.length === 1) return env.store.match({ ...pattern, graph: Arr.headNonEmpty(def) });
  return dedupeTriples(concatAll(def.map((g) => env.store.match({ ...pattern, graph: g }))));
};

const concatAll = <A, X>(streams: ReadonlyArray<Stream.Stream<A, X>>): Stream.Stream<A, X> =>
  Arr.isReadonlyArrayEmpty(streams) ? Stream.empty : streams.reduce((a, b) => Stream.concat(a, b));

const matchTriple = (pattern: Ast.TriplePattern, env: Env, b: Bindings): S => {
  const s = ground(pattern.subject, b);
  const p = ground(pattern.predicate, b);
  const o = ground(pattern.object, b);
  const unifyS = Option.isNone(s);
  const unifyP = Option.isNone(p);
  const unifyO = Option.isNone(o);
  return matchQuads(env, {
    subject: Option.getOrUndefined(s),
    predicate: Option.getOrUndefined(p),
    object: Option.getOrUndefined(o),
  }).pipe(
    Stream.filterMap((q) => {
      const map = StringMap.copy(b.map);
      if (
        (!unifyS || unify(pattern.subject, q.subject, map)) &&
        (!unifyP || unify(pattern.predicate, q.predicate, map)) &&
        (!unifyO || unify(pattern.object, q.object, map))
      ) {
        return Result.succeed(new B.Bindings(map));
      }
      return Result.fail(undefined);
    }),
  );
};

const evalBgp = (patterns: ReadonlyArray<Ast.TriplePattern>, env: Env, initial: Bindings): S => {
  const start: S = Stream.succeed(initial);
  return patterns.reduce(
    (stream, p) => Stream.flatMap(stream, (b) => matchTriple(p, env, b)),
    start,
  );
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

const iriValueSet = (list: ReadonlyArray<Term.NamedNode>) =>
  StringMap.setOf(list.map((i) => i.value));

const distinctTerms = (terms: ReadonlyArray<Term.GroundTerm>): Array<Term.GroundTerm> => {
  const seen = StringMap.empty<Term.GroundTerm>();
  terms.forEach((t) => {
    if (!seen.has(t.key)) seen.set(t.key, t);
  });
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
      const steps = forward ? seq.paths : seq.paths.toReversed();
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
      closure(env, rep.path, start, forward, Predicate.isTagged(rep, 'PathZeroOrMore')),
    ),
    Match.tag('PathNegated', (neg) => {
      const parts: Array<E<ReadonlyArray<Term.GroundTerm>>> = [];
      if (Arr.isReadonlyArrayNonEmpty(neg.iris) || Arr.isReadonlyArrayEmpty(neg.inverse)) {
        const ex = iriValueSet(neg.iris);
        parts.push(
          Effect.map(collect(env, forward ? { subject: start } : { object: start }), (qs) =>
            qs
              .filter((q) => !ex.has(q.predicate.value))
              .map((q) => (forward ? q.object : q.subject)),
          ),
        );
      }
      if (Arr.isReadonlyArrayNonEmpty(neg.inverse)) {
        const ex = iriValueSet(neg.inverse);
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
  Effect.suspend(() => {
    const visited = StringMap.empty<Term.GroundTerm>();
    if (includeStart) visited.set(start.key, start);
    const expanded = StringMap.emptySet();
    /** Expands the frontier's unexpanded nodes, then the nodes they newly reach. */
    const expand = (frontier: ReadonlyArray<Term.GroundTerm>): E<void> => {
      if (Arr.isReadonlyArrayEmpty(frontier)) return Effect.void;
      const next: Array<Term.GroundTerm> = [];
      const unexpanded = frontier.filter((n) => {
        if (expanded.has(n.key)) return false;
        expanded.set(n.key, true);
        return true;
      });
      return Effect.forEach(
        unexpanded,
        (n) =>
          Effect.map(pathFrom(env, path, n, forward), (reached) =>
            reached.forEach((m) => {
              if (!visited.has(m.key)) {
                visited.set(m.key, m);
                next.push(m);
              }
            }),
          ),
        { concurrency: 1, discard: true },
      ).pipe(Effect.flatMap(() => expand(next)));
    };
    return Effect.map(expand([start]), () => Array.from(visited.values()));
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
      // A parsed sequence has at least two steps.
      if (first === undefined) return Effect.succeed([]);
      return Effect.flatMap(pathAll(env, first), (pairs) =>
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
        const ex = iriValueSet(neg.iris);
        out.push(
          Effect.map(collect(env, {}), (qs) =>
            qs.filter((q) => !ex.has(q.predicate.value)).map((q) => [q.subject, q.object] as const),
          ),
        );
      }
      if (Arr.isReadonlyArrayNonEmpty(neg.inverse)) {
        const ex = iriValueSet(neg.inverse);
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
          Option.isSome(value) && !Term.isNamedNode(term) && !Term.isLiteral(term)
            ? Effect.map(isGraphNode(env, value.value), (isNode) => !isNode)
            : Effect.succeed(false),
        );
        if (Option.isSome(outsideGraph)) return out;
      }
      const emit = (x: Term.GroundTerm, y: Term.GroundTerm) => {
        const map = StringMap.copy(initial.map);
        if (unify(op.subject, x, map) && unify(op.object, y, map)) out.push(new B.Bindings(map));
      };
      if (Option.isSome(s)) {
        const from = s.value;
        const ys = yield* pathFrom(env, op.path, from, true);
        ys.forEach((y) => emit(from, y));
      } else if (Option.isSome(o)) {
        const to = o.value;
        const xs = yield* pathFrom(env, op.path, to, false);
        xs.forEach((x) => emit(x, to));
      } else {
        const pairs = yield* pathAll(env, op.path);
        pairs.forEach(([x, y]) => emit(x, y));
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
    Match.tag('Operation', 'FunctionCall', (call, _e, out) =>
      call.args.forEach((a) => collectExists(a, out)),
    ),
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
        // By identity: each `EXISTS` node of the expression and its result.
        const table = new WeakMap<Algebra.ExistsExpression, boolean>();
        Arr.zip(nodes, results).forEach(([n, r]) => table.set(n, r));
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
  Predicate.isTagged(op, 'Bgp') ||
  Predicate.isTagged(op, 'Path') ||
  // `SERVICE ?endpoint` is evaluated per solution once `?endpoint` is bound.
  (Predicate.isTagged(op, 'Service') && Term.isVariable(op.name)) ||
  (Predicate.isTagged(op, 'Join') && bindable(op.left) && bindable(op.right));

/**
 * Evaluates a bindable operator with an initial solution. Plain branches
 * rather than `Match`: a bind join runs it once per solution of its left
 * side.
 */
const evalWith = (op: Algebra.Operation, env: Env, initial: Bindings): S => {
  if (Predicate.isTagged(op, 'Bgp')) return evalBgp(op.patterns, env, initial);
  if (Predicate.isTagged(op, 'Path')) return evalPath(op, env, initial);
  if (Predicate.isTagged(op, 'Join')) {
    return Stream.flatMap(evalWith(op.left, env, initial), (b) => evalWith(op.right, env, b));
  }
  if (Predicate.isTagged(op, 'Service')) return evalBoundService(op, env, initial);
  return Stream.die(new Cause.IllegalArgumentError('not bindable'));
};

const isUnit = (op: Algebra.Operation): boolean =>
  Predicate.isTagged(op, 'Bgp') && Arr.isReadonlyArrayEmpty(op.patterns);

/** An index of solutions by the values of the variables bound in all of them. */
/** The index key of a solution: its terms for `vars`, all of which it binds. */
const indexKey = (sig: string, vars: ReadonlyArray<string>, b: Bindings): string =>
  `${sig}#${vars.map((v) => b.map.get(v)?.key ?? '').join('\u0001')}`;

class SolutionIndex {
  readonly keyVars: ReadonlyArray<string>;
  readonly buckets = StringMap.empty<Array<Bindings>>();
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
    const built = `${sig}#__built`;
    if (!this.buckets.has(built)) {
      this.buckets.set(built, []);
      this.all.forEach((s) => {
        const k = indexKey(sig, vars, s);
        const list = this.buckets.get(k);
        if (list === undefined) this.buckets.set(k, [s]);
        else list.push(s);
      });
    }
    return this.buckets.get(indexKey(sig, vars, b)) ?? [];
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

const keepAll: Effect.Effect<boolean, Err> = Effect.succeed(true);

/** Whether a solution passes an `OPTIONAL`'s filter. */
const keepWhere = (
  expression: Algebra.Expression,
  env: Env,
): ((b: Bindings) => Effect.Effect<boolean, Err>) => {
  const ctxFor = prepare(expression, env);
  return (b) => Effect.map(ctxFor(b), (ctx) => Expression.test(expression, b, ctx));
};

const evalLeftJoin = (op: Algebra.LeftJoin, env: Env): S => {
  const left = isUnit(op.left) ? Stream.succeed(env.context) : evaluate(op.left, env);
  const expression = op.expression;
  const keep =
    expression === undefined
      ? (): Effect.Effect<boolean, Err> => keepAll
      : keepWhere(expression, env);
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
  const name = op.name;
  if (Term.isNamedNode(name)) {
    return Stream.unwrap(
      Effect.map(namedGraphs(env), (graphs) =>
        graphs.some((g) => g.key === name.key)
          ? evaluate(op.input, { ...env, graph: { _tag: 'NamedGraph', graph: name } })
          : Stream.empty,
      ),
    );
  }
  const variable = name.value;
  return Stream.unwrap(
    Effect.map(namedGraphs(env), (graphs) =>
      concatAll(
        graphs.map((g) =>
          evaluate(op.input, { ...env, graph: { _tag: 'NamedGraph', graph: g } }).pipe(
            Stream.filterMap((b) => {
              const m = B.merge(b, new B.Bindings(StringMap.fromEntries([[variable, g]])));
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

const integerLiteral = (n: number): Term.Literal => new Term.Literal(String(n), V.dt.integer);

/** An aggregate over a group's members; `None` leaves it unbound. */
const aggregateValue = (
  agg: Algebra.Aggregate,
  members: ReadonlyArray<Bindings>,
  env: Env,
): Option.Option<Term.GroundTerm> => {
  if (agg.expression === '*') {
    if (agg.name !== 'COUNT') return Option.none();
    const n = agg.distinct ? StringMap.setOf(members.map((m) => m.key)).size : members.length;
    return Option.some(integerLiteral(n));
  }
  const expr = agg.expression;
  const evaluated = members.map((m) =>
    Option.fromUndefinedOr(Expression.evaluateOrUndefined(expr, m, env.expr)),
  );
  // With DISTINCT, the first of each value (an error, `None`, counting as one value).
  const seen = StringMap.emptySet();
  const values = agg.distinct
    ? evaluated.filter((v) => {
        const k = Option.isNone(v) ? '' : v.value.key;
        if (seen.has(k)) return false;
        seen.set(k, true);
        return true;
      })
    : evaluated;
  const defined = Arr.getSomes(values);
  // An expression error in the aggregate leaves it unbound.
  return Option.flatten(
    Result.getSuccess(V.catchEvalFailure(() => aggregateOf(agg, values.length, defined))),
  );
};

const sum = (values: ReadonlyArray<Term.GroundTerm>): Term.GroundTerm =>
  values.reduce<Term.GroundTerm>((acc, v) => V.arithmetic('+', acc, v), integerLiteral(0));

/**
 * An aggregate of the values that evaluated (`defined`, of `count`
 * members); `None` leaves it unbound.
 */
const aggregateOf = (
  agg: Algebra.Aggregate,
  count: number,
  defined: ReadonlyArray<Term.GroundTerm>,
): Option.Option<Term.GroundTerm> => {
  const complete = defined.length === count;
  return Match.value(agg.name).pipe(
    Match.when('COUNT', () => Option.some(integerLiteral(defined.length))),
    Match.when('SUM', () => (complete ? Option.some(sum(defined)) : Option.none())),
    Match.when('AVG', (): Option.Option<Term.GroundTerm> => {
      if (!complete) return Option.none();
      if (Arr.isReadonlyArrayEmpty(defined)) return Option.some(integerLiteral(0));
      return Option.some(V.arithmetic('/', sum(defined), integerLiteral(defined.length)));
    }),
    Match.when(Match.is('MIN', 'MAX'), (name) =>
      Option.map(Arr.head(defined), (first) =>
        defined.slice(1).reduce((best, v) => {
          const c = V.compareTerms(v, best);
          return (name === 'MIN' ? c < 0 : c > 0) ? v : best;
        }, first),
      ),
    ),
    Match.when('SAMPLE', () => Arr.head(defined)),
    Match.when('GROUP_CONCAT', (): Option.Option<Term.GroundTerm> => {
      if (!complete) return Option.none();
      const lits = defined.map((v) => (Term.isLiteral(v) ? v : V.fail('Not a literal')));
      const sep = agg.separator ?? ' ';
      // GROUP_CONCAT always produces an xsd:string.
      return Option.some(V.simple(lits.map((l) => l.value).join(sep)));
    }),
    Match.exhaustive,
  );
};

/** A group of solutions: its key values (`None` where a key is unbound) and members. */
interface Group {
  readonly keys: ReadonlyArray<Option.Option<Term.GroundTerm>>;
  readonly members: Array<Bindings>;
}

/** Evaluates an expression per solution; `None` on errors. */
const evaluateOption = (
  expression: Algebra.Expression,
  b: Bindings,
  ctx: Expression.Context,
): Option.Option<Term.GroundTerm> =>
  Option.fromUndefinedOr(Expression.evaluateOrUndefined(expression, b, ctx));

const evalGroup = (op: Algebra.Group, env: Env): S =>
  Stream.fromIterableEffect(
    Effect.map(materialize(op.input, env), (solutions) => {
      const groups = StringMap.empty<Group>();
      solutions.forEach((s) => {
        const keys = op.keys.map((k) => evaluateOption(k.expression, s, env.expr));
        const id = keys.map((k) => (Option.isNone(k) ? '' : k.value.key)).join('\u0001');
        const g = groups.get(id);
        if (g === undefined) groups.set(id, { keys, members: [s] });
        else g.members.push(s);
      });
      if (groups.size === 0 && Arr.isReadonlyArrayEmpty(op.keys))
        groups.set('', { keys: [], members: [] });
      return Array.from(groups.values(), (g) => {
        const map = StringMap.empty<Term.GroundTerm>();
        Arr.zip(op.keys, g.keys).forEach(([k, v]) => {
          if (Option.isSome(v)) map.set(k.variable.value, v.value);
        });
        op.aggregates.forEach((a) => {
          const v = aggregateValue(a.aggregate, g.members, env);
          if (Option.isSome(v)) map.set(a.variable.value, v.value);
        });
        return new B.Bindings(map);
      });
    }),
  );

/** A solution with its `ORDER BY` keys (`None` where a key is unbound or an error). */
interface Keyed {
  readonly s: Bindings;
  readonly keys: ReadonlyArray<Option.Option<Term.GroundTerm>>;
}

const unbound = Option.none<Term.GroundTerm>();

const evalOrderBy = (op: Algebra.OrderBy, env: Env): S =>
  Stream.fromIterableEffect(
    Effect.map(materialize(op.input, env), (solutions) => {
      const keyed = solutions.map((s): Keyed => ({
        s,
        keys: op.conditions.map((c) => evaluateOption(c.expression, s, env.expr)),
      }));
      const byConditions = Order.make<Keyed>((a, b) => {
        // The first condition the solutions differ on decides.
        let order: -1 | 0 | 1 = 0;
        op.conditions.some((condition, i) => {
          const c = V.orderCompare(a.keys[i] ?? unbound, b.keys[i] ?? unbound);
          if (c === 0) return false;
          order = c < 0 === condition.descending ? 1 : -1;
          return true;
        });
        return order;
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
  const stream: S = Option.isNone(handler)
    ? Stream.fail(new EvaluationError({ message: `SERVICE <${endpoint.value}> is not supported` }))
    : handler.value(endpoint, op, env);
  return op.silent ? Stream.catchCause(stream, () => Stream.succeed(B.empty)) : stream;
};

const evalService = (op: Algebra.Service, env: Env): S => {
  const name = op.name;
  if (Term.isVariable(name)) {
    return Stream.fail(
      new EvaluationError({
        message: `SERVICE ?${name.value} needs the endpoint variable to be bound first`,
      }),
    );
  }
  return runService(op, env, name);
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
  const name = op.name;
  if (Term.isNamedNode(name)) {
    return mergeWith(initial, runService(op, env, name));
  }
  const endpoint = initial.map.get(name.value);
  if (!Term.isNamedNode(endpoint)) {
    return op.silent
      ? Stream.succeed(initial)
      : Stream.fail(
          new EvaluationError({
            message: `SERVICE ?${name.value} is not bound to an IRI`,
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

const evalDistinct = (op: Algebra.Distinct | Algebra.Reduced, env: Env): S =>
  Stream.suspend(() => {
    const seen = StringMap.emptySet();
    return Stream.filter(evaluate(op.input, env), (b) => {
      const k = b.key;
      if (seen.has(k)) return false;
      seen.set(k, true);
      return true;
    });
  });

const evalSlice = (op: Algebra.Slice, env: Env): S => {
  const input = evaluate(op.input, env);
  const dropped = op.offset > 0 ? Stream.drop(input, op.offset) : input;
  return op.limit !== undefined ? Stream.take(dropped, op.limit) : dropped;
};

/**
 * Evaluates an operator by its kind. Plain branches rather than `Match`:
 * `EXISTS` patterns and bind joins run it once per solution.
 */
const evaluateGeneric = (op: Algebra.Operation, env: Env): S => {
  if (Predicate.isTagged(op, 'Bgp')) {
    return evalBgp(op.patterns, env, Arr.isReadonlyArrayEmpty(op.patterns) ? env.context : B.empty);
  }
  if (Predicate.isTagged(op, 'Join')) return evalJoin(op, env);
  if (Predicate.isTagged(op, 'Filter')) {
    return filterStream(evaluate(op.input, env), op.expression, env);
  }
  if (Predicate.isTagged(op, 'Project')) {
    const names = op.variables.map((v) => v.value);
    return Stream.map(evaluate(op.input, env), (b) => B.project(b, names));
  }
  if (Predicate.isTagged(op, 'LeftJoin')) return evalLeftJoin(op, env);
  if (Predicate.isTagged(op, 'Union')) {
    return Stream.concat(evaluate(op.left, env), evaluate(op.right, env));
  }
  if (Predicate.isTagged(op, 'Extend')) return evalExtend(op, env);
  if (Predicate.isTagged(op, 'Path')) return evalPath(op, env, B.empty);
  if (Predicate.isTagged(op, 'Graph')) return evalGraph(op, env);
  if (Predicate.isTagged(op, 'Minus')) return evalMinus(op, env);
  if (Predicate.isTagged(op, 'Group')) return evalGroup(op, env);
  if (Predicate.isTagged(op, 'OrderBy')) return evalOrderBy(op, env);
  if (Predicate.isTagged(op, 'Distinct') || Predicate.isTagged(op, 'Reduced')) {
    return evalDistinct(op, env);
  }
  if (Predicate.isTagged(op, 'Slice')) return evalSlice(op, env);
  if (Predicate.isTagged(op, 'Values')) return Stream.fromIterable(op.bindings);
  return evalService(op, env);
};
