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
import * as Effect from 'effect/Effect';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Algebra from './Algebra.ts';
import type * as Ast from './Ast.ts';
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
  e._tag === 'Operation' && e.operator === '&&' ? e.args.flatMap(conjuncts) : [e];

const conjunction = (es: ReadonlyArray<Algebra.Expression>): Algebra.Expression =>
  es.reduce((a, b) => ({ _tag: 'Operation', operator: '&&', args: [a, b] }));

const subset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

/** Pushes one filter condition as deep as possible; returns undefined if it cannot move. */
const push = (e: Algebra.Expression, op: Algebra.Operation): Algebra.Operation | undefined => {
  const vars = Algebra.expressionVariables(e);
  switch (op._tag) {
    case 'Join': {
      if (subset(vars, Algebra.certainVariables(op.left))) {
        return { ...op, left: pushOrWrap(e, op.left) };
      }
      if (subset(vars, Algebra.certainVariables(op.right))) {
        return { ...op, right: pushOrWrap(e, op.right) };
      }
      return undefined;
    }
    case 'LeftJoin':
    case 'Minus':
      if (subset(vars, Algebra.certainVariables(op.left))) {
        return { ...op, left: pushOrWrap(e, op.left) };
      }
      return undefined;
    case 'Filter':
      return { ...op, input: pushOrWrap(e, op.input) };
    default:
      return undefined;
  }
};

const pushOrWrap = (e: Algebra.Expression, op: Algebra.Operation): Algebra.Operation =>
  push(e, op) ?? Algebra.filter(e, op);

const pushFilters = (op: Algebra.Operation): Algebra.Operation =>
  Algebra.transform(op, (o) => {
    if (o._tag !== 'Filter') return o;
    const kept: Array<Algebra.Expression> = [];
    let input = o.input;
    for (const c of conjuncts(o.expression)) {
      if (Algebra.containsExists(c)) {
        kept.push(c);
        continue;
      }
      const pushed = push(c, input);
      if (pushed === undefined) kept.push(c);
      else input = pushed;
    }
    return kept.length === 0 ? input : Algebra.filter(conjunction(kept), input);
  });

const positions = (p: Ast.TriplePattern): ReadonlyArray<Ast.TermPattern> => [
  p.subject,
  p.predicate,
  p.object,
];

const patternVariables = (p: Ast.TriplePattern): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const go = (t: Ast.TermPattern | Term.Term): void => {
    if (t._tag === 'Variable') out.push(t.value);
    else if (t._tag === 'Triple') {
      go(t.subject);
      go(t.predicate);
      go(t.object);
    }
  };
  positions(p).forEach(go);
  return out;
};

const constant = (t: Ast.TermPattern): Term.GroundTerm | undefined =>
  t._tag === 'Variable' ||
  (t._tag === 'Triple' &&
    patternVariables({
      _tag: 'TriplePattern',
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
    }).length > 0)
    ? undefined
    : (t as Term.GroundTerm);

/** Static selectivity heuristic when the store gives no estimates. */
const staticCost = (p: Ast.TriplePattern): number => {
  let cost = 1;
  if (constant(p.subject) === undefined) cost *= 100;
  if (constant(p.object) === undefined) cost *= 10;
  if (constant(p.predicate) === undefined) cost *= 5;
  return cost;
};

const orderBgp = (
  patterns: ReadonlyArray<Ast.TriplePattern>,
  ctx: OptimizerContext,
): Effect.Effect<ReadonlyArray<Ast.TriplePattern>, Store.StoreError> =>
  Effect.gen(function* () {
    if (patterns.length < 2) return patterns;
    const estimate = ctx.store.estimate;
    const costs = yield* Effect.forEach(patterns, (p) =>
      estimate === undefined
        ? Effect.succeed(staticCost(p))
        : estimate({
            subject: constant(p.subject),
            predicate: constant(p.predicate),
            object: constant(p.object),
            graph:
              ctx.graph._tag === 'NamedGraph'
                ? ctx.graph.graph
                : ctx.dataset.defaultGraph === 'default'
                  ? Term.defaultGraph
                  : undefined,
          }),
    );
    const remaining = patterns.map((p, i) => ({ p, cost: costs[i]!, vars: patternVariables(p) }));
    const bound = new Set<string>();
    const out: Array<Ast.TriplePattern> = [];
    while (remaining.length > 0) {
      let best = -1;
      let bestScore = Infinity;
      const connected = remaining.some((r) => r.vars.some((v) => bound.has(v)));
      remaining.forEach((r, i) => {
        const isConnected = r.vars.some((v) => bound.has(v));
        if (connected && !isConnected && bound.size > 0) return;
        const boundCount = r.vars.filter((v) => bound.has(v)).length;
        const score = r.cost / 10 ** boundCount;
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      });
      if (best === -1) best = 0;
      const [chosen] = remaining.splice(best, 1);
      out.push(chosen!.p);
      for (const v of chosen!.vars) bound.add(v);
    }
    return out;
  });

const orderBgps = (
  op: Algebra.Operation,
  ctx: OptimizerContext,
): Effect.Effect<Algebra.Operation, Store.StoreError> => {
  switch (op._tag) {
    case 'Bgp':
      return Effect.map(orderBgp(op.patterns, ctx), (patterns) => Algebra.bgp(patterns));
    case 'Path':
    case 'Values':
      return Effect.succeed(op);
    case 'Graph':
      return Effect.map(
        orderBgps(op.input, {
          ...ctx,
          graph: op.name._tag === 'NamedNode' ? { _tag: 'NamedGraph', graph: op.name } : ctx.graph,
        }),
        (input) => ({ ...op, input }),
      );
    default: {
      const children: Array<Algebra.Operation> = [];
      Algebra.mapChildren(op, (c) => {
        children.push(c);
        return c;
      });
      return Effect.map(
        Effect.forEach(children, (c) => orderBgps(c, ctx)),
        (optimized) => {
          let i = 0;
          return Algebra.mapChildren(op, () => optimized[i++]!);
        },
      );
    }
  }
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
