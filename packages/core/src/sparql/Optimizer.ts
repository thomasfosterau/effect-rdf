/**
 * A simple, semantics-preserving algebra optimizer:
 *
 * - **Filter pushdown**: conjunctive filter conditions are pushed below
 *   `Join` and into the left side of `LeftJoin` / `Minus` when all their
 *   variables are certainly bound there (and they contain no `EXISTS`).
 * - **BGP join ordering**: the triple patterns of each BGP are reordered
 *   greedily by estimated selectivity (using `QuadStore.estimate` when the
 *   store provides it, and a static heuristic otherwise), preferring
 *   patterns connected to already-bound variables.
 *
 * Patterns inside `EXISTS` are left untouched.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as HashSet from 'effect/HashSet';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Term from '../Term.ts';
import * as Algebra from './Algebra.ts';
import type * as Ast from './Ast.ts';
import { loop } from './internal/loop.ts';
import * as StringMap from './internal/stringMap.ts';
import type * as Store from './Store.ts';

/**
 * Inputs of the optimizer.
 *
 * @since 0.1.0
 * @category models
 */
export interface OptimizerContext {
  readonly store: Store.QuadStoreShape;
  readonly dataset: Store.DatasetSpec;
  readonly graph: Store.ActiveGraph;
}

const conjuncts = (e: Algebra.Expression): Array<Algebra.Expression> =>
  Predicate.isTagged(e, 'Operation') && e.operator === '&&' ? e.args.flatMap(conjuncts) : [e];

const conjunction = (es: ReadonlyArray<Algebra.Expression>): Algebra.Expression =>
  es.reduce((a, b) => ({ _tag: 'Operation', operator: '&&', args: [a, b] }));

const subset = (a: HashSet.HashSet<string>, b: HashSet.HashSet<string>): boolean =>
  Array.from(a).every((x) => HashSet.has(b, x));

/** Pushes one filter condition as deep as possible; `None` if it cannot move. */
const push = (e: Algebra.Expression, op: Algebra.Operation): Option.Option<Algebra.Operation> => {
  const vars = Algebra.expressionVariables(e);
  return Match.value(op).pipe(
    Match.tag('Join', (j): Option.Option<Algebra.Operation> => {
      if (subset(vars, Algebra.certainVariables(j.left))) {
        return Option.some({ ...j, left: pushOrWrap(e, j.left) });
      }
      if (subset(vars, Algebra.certainVariables(j.right))) {
        return Option.some({ ...j, right: pushOrWrap(e, j.right) });
      }
      return Option.none();
    }),
    Match.tag('LeftJoin', 'Minus', (o) =>
      subset(vars, Algebra.certainVariables(o.left))
        ? Option.some({ ...o, left: pushOrWrap(e, o.left) })
        : Option.none(),
    ),
    Match.tag('Filter', (f) => Option.some({ ...f, input: pushOrWrap(e, f.input) })),
    Match.orElse(() => Option.none()),
  );
};

const pushOrWrap = (e: Algebra.Expression, op: Algebra.Operation): Algebra.Operation =>
  Option.getOrElse(push(e, op), () => Algebra.filter(e, op));

const pushFilters = (op: Algebra.Operation): Algebra.Operation =>
  Algebra.transform(op, (o) => {
    if (!Predicate.isTagged(o, 'Filter')) return o;
    // The conditions that stay, and the input with the others pushed in.
    const kept: Array<Algebra.Expression> = [];
    const keep = (input: Algebra.Operation, c: Algebra.Expression): Algebra.Operation => {
      kept.push(c);
      return input;
    };
    const input = conjuncts(o.expression).reduce(
      (acc, c) =>
        Algebra.containsExists(c)
          ? keep(acc, c)
          : Option.getOrElse(push(c, acc), () => keep(acc, c)),
      o.input,
    );
    return Arr.isReadonlyArrayEmpty(kept) ? input : Algebra.filter(conjunction(kept), input);
  });

const positions = (p: Ast.TriplePattern): ReadonlyArray<Ast.TermPattern> => [
  p.subject,
  p.predicate,
  p.object,
];

const patternVariables = (p: Ast.TriplePattern): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const go = (t: Ast.TermPattern | Term.Term): void => {
    if (Term.isVariable(t)) out.push(t.value);
    else if (Term.isTriple(t)) {
      go(t.subject);
      go(t.predicate);
      go(t.object);
    }
  };
  positions(p).forEach(go);
  return out;
};

/** A pattern term as a constant: `None` for a variable or a triple pattern with variables. */
const constant = (t: Ast.TermPattern): Option.Option<Term.GroundTerm> => {
  if (Term.isVariable(t)) return Option.none();
  if (Term.isTriple(t)) {
    const vars = patternVariables({
      _tag: 'TriplePattern',
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
    });
    return Arr.isReadonlyArrayNonEmpty(vars) ? Option.none() : Option.some(t);
  }
  return Option.some(t);
};

/** Static selectivity heuristic when the store gives no estimates. */
const staticCost = (p: Ast.TriplePattern): number =>
  (Option.isNone(constant(p.subject)) ? 100 : 1) *
  (Option.isNone(constant(p.object)) ? 10 : 1) *
  (Option.isNone(constant(p.predicate)) ? 5 : 1);

const orderBgp = (
  patterns: ReadonlyArray<Ast.TriplePattern>,
  ctx: OptimizerContext,
): Effect.Effect<ReadonlyArray<Ast.TriplePattern>, Store.StoreError> =>
  Effect.gen(function* () {
    if (patterns.length < 2) return patterns;
    const estimate = ctx.store.estimate;
    const costs = yield* Effect.forEach(
      patterns,
      (p) =>
        estimate === undefined
          ? Effect.succeed(staticCost(p))
          : estimate({
              subject: Option.getOrUndefined(constant(p.subject)),
              predicate: Option.getOrUndefined(constant(p.predicate)),
              object: Option.getOrUndefined(constant(p.object)),
              graph: Predicate.isTagged(ctx.graph, 'NamedGraph')
                ? ctx.graph.graph
                : ctx.dataset.defaultGraph === 'default'
                  ? Term.defaultGraph
                  : undefined,
            }),
      { concurrency: 1 },
    );
    const remaining = Arr.zip(patterns, costs).map(([p, cost]) => ({
      p,
      cost,
      vars: patternVariables(p),
    }));
    const bound = StringMap.emptySet();
    const out: Array<Ast.TriplePattern> = [];
    // Greedily picks the cheapest pattern, preferring those connected to the bound variables.
    loop(() => {
      if (!Arr.isArrayNonEmpty(remaining)) return false;
      const connected = remaining.some((r) => r.vars.some((v) => bound.has(v)));
      const scored = Arr.map(remaining, (r, i) => {
        const isConnected = r.vars.some((v) => bound.has(v));
        const eligible = !(connected && !isConnected && bound.size > 0);
        const boundCount = r.vars.filter((v) => bound.has(v)).length;
        return { r, i, score: eligible ? r.cost / 10 ** boundCount : Infinity };
      });
      // The first with the lowest score (the first pattern if none is eligible).
      const best = scored.reduce((a, b) => (b.score < a.score ? b : a));
      remaining.splice(best.i, 1);
      out.push(best.r.p);
      best.r.vars.forEach((v) => bound.set(v, true));
      return true;
    });
    return out;
  });

const orderBgps = (
  op: Algebra.Operation,
  ctx: OptimizerContext,
): Effect.Effect<Algebra.Operation, Store.StoreError> => {
  return Match.value(op).pipe(
    Match.tag('Bgp', (b): Effect.Effect<Algebra.Operation, Store.StoreError> =>
      Effect.map(orderBgp(b.patterns, ctx), (patterns) => Algebra.bgp(patterns)),
    ),
    Match.tag('Path', 'Values', (o) => Effect.succeed(o)),
    Match.tag('Graph', (g) =>
      Effect.map(
        orderBgps(g.input, {
          ...ctx,
          graph: Term.isNamedNode(g.name) ? { _tag: 'NamedGraph', graph: g.name } : ctx.graph,
        }),
        (input) => ({ ...g, input }),
      ),
    ),
    Match.orElse((o) => {
      const children: Array<Algebra.Operation> = [];
      Algebra.mapChildren(o, (c) => {
        children.push(c);
        return c;
      });
      return Effect.map(
        Effect.forEach(children, (c) => orderBgps(c, ctx), { concurrency: 1 }),
        (optimized) => {
          let i = 0;
          return Algebra.mapChildren(o, (c) => optimized[i++] ?? c);
        },
      );
    }),
  );
};

/**
 * Optimizes an algebra expression.
 *
 * @since 0.1.0
 * @category optimization
 */
export const optimize = (
  op: Algebra.Operation,
  ctx: OptimizerContext,
): Effect.Effect<Algebra.Operation, Store.StoreError> => orderBgps(pushFilters(op), ctx);
