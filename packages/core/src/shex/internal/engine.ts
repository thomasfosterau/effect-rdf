/**
 * The ShEx validation engine: a synchronous evaluator of `satisfies` with
 * memoisation and coinductive (greatest fixed point) handling of recursive
 * references, partition search for triple expressions over bags of triple
 * constraint assignments, and ShEx 2.2 `EXTENDS` / `ABSTRACT` /
 * `RESTRICTS` semantics.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Iterable from 'effect/Iterable';
import * as Match from 'effect/Match';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Dataset from '../../Dataset.ts';
import * as Term from '../../Term.ts';
import type * as SemAct from '../SemAct.ts';
import type * as ShExJ from '../ShExJ.ts';
import { cardinality } from '../ShExJ.ts';
import type { SchemaIndex } from '../Structure.ts';
import { iterate } from './iterate.ts';
import { checkNodeConstraint } from './nodeConstraint.ts';
import * as Predicate from 'effect/Predicate';

/** An arc of a node's neighbourhood. */
export interface Arc {
  readonly triple: Term.Triple;
  readonly dir: 'out' | 'in';
  readonly predicate: string;
  /** The node at the other end of the arc. */
  readonly value: Term.Term;
}

interface Target {
  readonly label: string;
  count: number;
}

interface Ctx {
  /** The neighbourhood subset being matched (none: the full neighbourhood). */
  readonly arcs: Option.Option<ReadonlyArray<Arc>>;
  readonly target: Option.Option<Target>;
  readonly partitionClosed: boolean;
}

const FULL: Ctx = { arcs: Option.none(), target: Option.none(), partitionClosed: false };

/** None means success; a string is a failure reason. */
type Outcome = Option.Option<string>;

const success: Outcome = Option.none();

/** The labels of the unfinished (recursive) checks an outcome depends on. */
type Deps = MutableHashSet.MutableHashSet<string>;

/** Whether a triple expression was used, and the outcome of its semantic actions. */
interface Visit {
  readonly used: boolean;
  readonly r: Outcome;
}

const unused: Visit = { used: false, r: success };

/** A triple constraint of a shape and the bag position of its arcs. */
type LocalIndex = WeakMap<ShExJ.TripleConstraint, number>;

/** An arc with the triple constraints it can be assigned to. */
interface Choice {
  readonly arc: Arc;
  readonly tcs: ReadonlyArray<ShExJ.TripleConstraint>;
}

/** An arc assigned to one of its triple constraints. */
interface Assigned {
  readonly arc: Arc;
  readonly tc: ShExJ.TripleConstraint;
}

/** A failure reason as the messages print it (`undefined` when there is none). */
const show = (o: Outcome): string => Option.getOrElse(o, () => 'undefined');

const bagKey = (bag: ReadonlyArray<number>): string => bag.join(',');

const dedupe = (bags: ReadonlyArray<ReadonlyArray<number>>): Array<ReadonlyArray<number>> =>
  Arr.fromIterable(
    MutableHashMap.values(MutableHashMap.fromIterable(Arr.map(bags, (b) => [bagKey(b), b]))),
  );

/** The first of the alternatives of a `ShapeOr` that `n` satisfies, preferring the target. */
const satisfiesOr = (
  e: ShExJ.ShapeOr,
  engine: Engine,
  n: Term.Term,
  ctx: Ctx,
  deps: Deps,
): Outcome => {
  // When validating a descendant of a target shape, prefer an
  // alternative that goes through the target.
  let first: Outcome = Option.none();
  let passed = false;
  const throughTarget = Arr.some(e.shapeExprs, (c) => {
    const before = Option.match(ctx.target, { onNone: () => 0, onSome: (t) => t.count });
    const r = engine.satisfies(n, c, ctx, deps, Option.none());
    if (Option.isNone(r)) {
      if (Option.match(ctx.target, { onNone: () => true, onSome: (t) => t.count > before })) {
        return true;
      }
      passed = true;
    } else if (Option.isNone(first)) first = r;
    return false;
  });
  return throughTarget || passed
    ? success
    : Option.some(`${n.key} matches none of the alternatives (${show(first)})`);
};

// Built once: `satisfies` runs it for every shape expression of every node it checks.
const satisfiesExpr: (
  e: ShExJ.ShapeExpr,
  engine: Engine,
  n: Term.Term,
  ctx: Ctx,
  deps: Deps,
  declLabel: Option.Option<string>,
) => Outcome = Match.fn(
  (
    e: ShExJ.ShapeExpr,
    _engine: Engine,
    _n: Term.Term,
    _ctx: Ctx,
    _deps: Deps,
    _declLabel: Option.Option<string>,
  ) => e,
).pipe(
  Match.withReturnType<Outcome>(),
  Match.when({ type: 'ShapeAnd' }, (e, _e, engine, n, ctx, deps) =>
    Arr.findFirst(e.shapeExprs, (c) => engine.satisfies(n, c, ctx, deps, Option.none())),
  ),
  Match.when({ type: 'ShapeOr' }, (e, _e, engine, n, ctx, deps) =>
    satisfiesOr(e, engine, n, ctx, deps),
  ),
  Match.when({ type: 'ShapeNot' }, (e, _e, engine, n, ctx, deps) =>
    Option.isNone(engine.satisfies(n, e.shapeExpr, ctx, deps, Option.none()))
      ? Option.some(`${n.key} matches a negated shape expression`)
      : success,
  ),
  Match.when({ type: 'NodeConstraint' }, (e, _e, engine, n) => {
    const r = checkNodeConstraint(n, e);
    if (Option.isSome(r)) return r;
    return engine.runSemActs(e.semActs, { site: 'nodeConstraint', node: n });
  }),
  Match.when({ type: 'ShapeExternal' }, (_e, _input, engine, n, ctx, deps, declLabel) =>
    Option.match(
      Option.flatMap(declLabel, (l) => MutableHashMap.get(engine.externs, l)),
      {
        onNone: () =>
          Option.some(
            `no definition available for external shape ${Option.getOrElse(declLabel, () => 'undefined')}`,
          ),
        onSome: (ext) => engine.satisfies(n, ext.shapeExpr, ctx, deps, Option.none()),
      },
    ),
  ),
  Match.when({ type: 'Shape' }, (e, _e, engine, n, ctx, deps) =>
    engine.matchesShape(n, e, ctx, deps),
  ),
  Match.exhaustive,
);

/** Appends to `out` the triple constraints of `tcs` it does not have yet. */
const addAll = (
  out: Array<ShExJ.TripleConstraint>,
  tcs: ReadonlyArray<ShExJ.TripleConstraint>,
): void =>
  tcs.forEach((tc) => {
    if (!out.includes(tc)) out.push(tc);
  });

// Built once: `extensionTcs` runs it for every shape expression an extension refers to.
const extensionTcsOf: (
  e: ShExJ.ShapeExpr,
  engine: Engine,
  out: Array<ShExJ.TripleConstraint>,
  seen: MutableHashSet.MutableHashSet<string>,
) => void = Match.fn(
  (
    e: ShExJ.ShapeExpr,
    _engine: Engine,
    _out: Array<ShExJ.TripleConstraint>,
    _seen: MutableHashSet.MutableHashSet<string>,
  ) => e,
).pipe(
  Match.when({ type: 'Shape' }, (e, _e, engine, out, seen) => {
    addAll(out, engine.localTcs(e));
    e.extends?.forEach((x) => engine.extensionTcs(x, out, seen));
  }),
  Match.when({ type: Match.is('ShapeAnd', 'ShapeOr') }, (e, _e, engine, out, seen) => {
    e.shapeExprs.forEach((c) => engine.extensionTcs(c, out, seen));
  }),
  Match.when({ type: 'ShapeNot' }, (e, _e, engine, out, seen) => {
    engine.extensionTcs(e.shapeExpr, out, seen);
  }),
  Match.orElse(() => undefined),
);

/** The arcs of `quads` in one direction, each triple once. */
const arcsOf = (
  quads: Iterable<Term.Quad>,
  dir: Arc['dir'],
  valueOf: (q: Term.Quad) => Term.Term,
): Array<Arc> => {
  const seen = MutableHashSet.empty<string>();
  return Arr.filterMap(Arr.fromIterable(quads), (q) => {
    const t = Term.triple(q.subject, q.predicate, q.object);
    if (MutableHashSet.has(seen, t.key)) return Result.failVoid;
    MutableHashSet.add(seen, t.key);
    return Result.succeed({ triple: t, dir, predicate: q.predicate.value, value: valueOf(q) });
  });
};

export class Engine {
  private readonly cache = MutableHashMap.empty<string, Outcome>();
  private readonly inProgress = MutableHashSet.empty<string>();
  private readonly neighbourhoods = MutableHashMap.empty<string, ReadonlyArray<Arc>>();
  private readonly shapeTcs = new WeakMap<object, ReadonlyArray<ShExJ.TripleConstraint>>();

  readonly index: SchemaIndex;
  readonly dataset: Dataset.Dataset;
  readonly handler: SemAct.Handler;
  readonly externs: MutableHashMap.MutableHashMap<string, ShExJ.ShapeDecl>;
  constructor(
    index: SchemaIndex,
    dataset: Dataset.Dataset,
    handler: SemAct.Handler,
    externs: MutableHashMap.MutableHashMap<string, ShExJ.ShapeDecl>,
  ) {
    this.index = index;
    this.dataset = dataset;
    this.handler = handler;
    this.externs = externs;
  }

  // ---------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------

  neighbourhood(n: Term.Term): ReadonlyArray<Arc> {
    return Option.getOrElse(MutableHashMap.get(this.neighbourhoods, n.key), () => {
      const arcs = [
        ...(Term.isResource(n) || Term.isTriple(n)
          ? arcsOf(Dataset.match(this.dataset, { subject: n }), 'out', (q) => q.object)
          : []),
        ...(!Term.isVariable(n) && !Term.isDefaultGraph(n)
          ? arcsOf(Dataset.match(this.dataset, { object: n }), 'in', (q) => q.subject)
          : []),
      ];
      MutableHashMap.set(this.neighbourhoods, n.key, arcs);
      return arcs;
    });
  }

  // ---------------------------------------------------------------------------
  // Semantic actions
  // ---------------------------------------------------------------------------

  runSemActs(acts: ReadonlyArray<ShExJ.SemAct> = [], context: SemAct.SemActContext): Outcome {
    return Arr.findFirst(acts, (act) => {
      const r = this.handler(act, context);
      return Option.isSome(r) && !r.value
        ? Option.some(`semantic action <${act.name}> failed`)
        : Option.none();
    });
  }

  // ---------------------------------------------------------------------------
  // Shape labels
  // ---------------------------------------------------------------------------

  /** Validates `n` against a shape label (or a descendant) on its full neighbourhood. */
  validateLabel(n: Term.Term, label: string, deps: Deps): Outcome {
    return this.memoized(`${n.key}\u0000${label}`, deps, (local) =>
      this.satisfiesDescendant(n, label, local),
    );
  }

  /** Validates `n` against the start shape expression. */
  validateStart(n: Term.Term, deps: Deps): Outcome {
    const start = this.index.schema.start;
    if (start === undefined) return Option.some('the schema has no start shape');
    return this.memoized(`${n.key}\u0000\u0000START`, deps, (local) =>
      this.satisfies(n, start, FULL, local, Option.none()),
    );
  }

  /**
   * Runs `check` once per `key` (a node and shape pair), caching its outcome.
   * A key already in progress is a recursive reference: it succeeds for now
   * and is reported to the caller in `deps`, and an outcome is cached only
   * once it no longer depends on an unfinished key.
   */
  private memoized(key: string, deps: Deps, check: (local: Deps) => Outcome): Outcome {
    const cached = MutableHashMap.get(this.cache, key);
    if (Option.isSome(cached)) return cached.value;
    if (MutableHashSet.has(this.inProgress, key)) {
      MutableHashSet.add(deps, key);
      return success;
    }
    MutableHashSet.add(this.inProgress, key);
    const local = MutableHashSet.empty<string>();
    const result = Result.try(() => check(local));
    MutableHashSet.remove(this.inProgress, key);
    if (Result.isFailure(result)) throw result.failure;
    const r = result.success;
    MutableHashSet.remove(local, key);
    if (Option.isSome(r) || MutableHashSet.size(local) === 0)
      MutableHashMap.set(this.cache, key, r);
    Iterable.forEach(local, (d) => MutableHashSet.add(deps, d));
    return r;
  }

  private satisfiesDescendant(n: Term.Term, label: string, deps: Deps): Outcome {
    const decl = this.index.shapes.get(label);
    if (decl === undefined) return Option.some(`unknown shape ${label}`);
    const candidates = [label, ...(this.index.descendants.get(label) ?? [])].filter(
      (l) => this.index.shapes.get(l)?.abstract !== true,
    );
    if (Arr.isReadonlyArrayEmpty(candidates))
      return Option.some(`${label} is abstract and has no concrete extension`);
    let first: Outcome = Option.none();
    const found = Arr.some(candidates, (c) => {
      const target: Option.Option<Target> =
        c === label ? Option.none() : Option.some({ label, count: 0 });
      const r = this.satisfiesDecl(
        n,
        c,
        { arcs: Option.none(), target, partitionClosed: false },
        deps,
      );
      if (
        Option.isNone(r) &&
        Option.match(target, { onNone: () => true, onSome: (t) => t.count > 0 })
      )
        return true;
      if (Option.isNone(first))
        first = Option.orElse(r, () =>
          Option.some(`${n.key} matches ${c} but not through ${label}`),
        );
      return false;
    });
    return found ? success : first;
  }

  private satisfiesDecl(n: Term.Term, label: string, ctx: Ctx, deps: Deps): Outcome {
    const decl = this.index.shapes.get(label);
    if (decl === undefined) return Option.some(`unknown shape ${label}`);
    return Arr.findFirst([...(decl.restricts ?? []), decl.shapeExpr], (e) =>
      this.satisfies(n, e, ctx, deps, Option.some(label)),
    );
  }

  // ---------------------------------------------------------------------------
  // Shape expressions
  // ---------------------------------------------------------------------------

  satisfies(
    n: Term.Term,
    e: ShExJ.ShapeExprOrRef,
    ctx: Ctx,
    deps: Deps,
    declLabel: Option.Option<string>,
  ): Outcome {
    if (Predicate.isString(e)) {
      if (Option.isNone(ctx.arcs)) return this.validateLabel(n, e, deps);
      const r = this.satisfiesDecl(n, e, ctx, deps);
      if (Option.isNone(r) && Option.isSome(ctx.target) && ctx.target.value.label === e)
        ctx.target.value.count++;
      return r;
    }
    return satisfiesExpr(e, this, n, ctx, deps, declLabel);
  }

  // ---------------------------------------------------------------------------
  // Triple constraints
  // ---------------------------------------------------------------------------

  /** The triple constraints of a triple expression (through inclusions). */
  private tcsOf(
    te: ShExJ.TripleExprOrRef,
    out: Array<ShExJ.TripleConstraint>,
    seen: MutableHashSet.MutableHashSet<string>,
  ): void {
    if (Predicate.isString(te)) {
      if (MutableHashSet.has(seen, te)) return;
      MutableHashSet.add(seen, te);
      const included = this.index.tripleExprs.get(te);
      if (included !== undefined) this.tcsOf(included, out, seen);
      return;
    }
    if (te.type === 'TripleConstraint') {
      if (!out.includes(te)) out.push(te);
    } else te.expressions.forEach((c) => this.tcsOf(c, out, seen));
  }

  localTcs(shape: ShExJ.Shape): ReadonlyArray<ShExJ.TripleConstraint> {
    const cached = this.shapeTcs.get(shape);
    if (cached !== undefined) return cached;
    const out: Array<ShExJ.TripleConstraint> = [];
    if (shape.expression !== undefined) this.tcsOf(shape.expression, out, MutableHashSet.empty());
    this.shapeTcs.set(shape, out);
    return out;
  }

  /** All triple constraints of the shapes an extension refers to (recursively). */
  extensionTcs(
    e: ShExJ.ShapeExprOrRef,
    out: Array<ShExJ.TripleConstraint>,
    seen: MutableHashSet.MutableHashSet<string>,
  ): void {
    if (Predicate.isString(e)) {
      if (MutableHashSet.has(seen, e)) return;
      MutableHashSet.add(seen, e);
      const decl = this.index.shapes.get(e);
      if (decl !== undefined) {
        decl.restricts?.forEach((r) => this.extensionTcs(r, out, seen));
        this.extensionTcs(decl.shapeExpr, out, seen);
      }
      return;
    }
    extensionTcsOf(e, this, out, seen);
  }

  matchesShape(n: Term.Term, shape: ShExJ.Shape, ctx: Ctx, deps: Deps): Outcome {
    const arcs = Option.getOrElse(ctx.arcs, () => this.neighbourhood(n));
    const closed = shape.closed === true || ctx.partitionClosed;
    const local = this.localTcs(shape);
    const extensions = shape.extends ?? [];
    const extTcs = Arr.map(extensions, (x) => {
      const out: Array<ShExJ.TripleConstraint> = [];
      this.extensionTcs(x, out, MutableHashSet.empty());
      return out;
    });
    const all = Arr.dedupeWith([...local, ...Arr.flatten(extTcs)], (a, b) => a === b);
    const localIndex: LocalIndex = new WeakMap(Arr.map(local, (tc, i) => [tc, i] as const));
    const extGroupsOf = new WeakMap<ShExJ.TripleConstraint, Array<number>>();
    extTcs.forEach((group, i) =>
      group.forEach((tc) => {
        if (localIndex.has(tc)) return;
        const g = extGroupsOf.get(tc);
        if (g === undefined) extGroupsOf.set(tc, [i]);
        else g.push(i);
      }),
    );
    const byPredicate = Arr.groupBy(
      all,
      (tc) => `${tc.inverse === true ? 'in' : 'out'} ${tc.predicate}`,
    );
    const extra = MutableHashSet.fromIterable(shape.extra ?? []);

    // Candidate triple constraints of every arc.
    const choices: Array<Choice> = [];
    const valueCache = MutableHashMap.empty<string, Outcome>();
    const valueOutcome = (
      tc: ShExJ.TripleConstraint,
      valueExpr: ShExJ.ShapeExprOrRef,
      arc: Arc,
    ) => {
      const ck = `${all.indexOf(tc)} ${arc.value.key}`;
      return Option.getOrElse(MutableHashMap.get(valueCache, ck), () => {
        const r = this.satisfies(arc.value, valueExpr, FULL, deps, Option.none());
        MutableHashMap.set(valueCache, ck, r);
        return r;
      });
    };
    const arcFailure = Arr.findFirst(arcs, (arc): Outcome => {
      const tcs = byPredicate[`${arc.dir} ${arc.predicate}`];
      if (tcs === undefined) {
        return arc.dir === 'out' && closed
          ? Option.some(`closed shape does not allow ${arc.triple.key}`)
          : success;
      }
      let firstReason: Outcome = Option.none();
      const ok = Arr.filter(tcs, (tc) => {
        if (tc.valueExpr === undefined) return true;
        const r = valueOutcome(tc, tc.valueExpr, arc);
        if (Option.isNone(r)) return true;
        if (Option.isNone(firstReason)) firstReason = r;
        return false;
      });
      if (Arr.isReadonlyArrayEmpty(ok)) {
        return MutableHashSet.has(extra, arc.predicate)
          ? success
          : Option.some(
              `${arc.triple.key} does not match its triple constraint: ${show(firstReason)}`,
            );
      }
      choices.push({ arc, tcs: ok });
      return success;
    });
    if (Option.isSome(arcFailure)) return arcFailure;

    const hasTcSemActs = local.some((tc) => tc.semActs !== undefined);
    const tried = MutableHashSet.empty<string>();
    // Filled in order by `search`, so it is dense once every arc is assigned.
    const assignment: Array<Assigned> = [];
    let firstFailure: Outcome = Option.none();

    const tryAssignment = (): Outcome => {
      const counts = Array.from({ length: local.length }, () => 0);
      const partitions: Array<Array<Arc>> = extensions.map(() => []);
      const keyParts = Arr.filterMap(assignment, ({ arc, tc }) => {
        const li = localIndex.get(tc);
        if (li !== undefined) {
          counts[li] = (counts[li] ?? 0) + 1;
          return hasTcSemActs ? Result.succeed(`L${li}`) : Result.failVoid;
        }
        const groups = extGroupsOf.get(tc) ?? [];
        groups.forEach((g) => partitions[g]?.push(arc));
        return Result.succeed(`E${groups.join('.')}`);
      });
      const key = `${counts.join(',')}|${keyParts.join('-')}`;
      if (MutableHashSet.has(tried, key)) return Option.some('duplicate partition');
      MutableHashSet.add(tried, key);
      // Local triple expression.
      if (shape.expression !== undefined) {
        if (!this.matchBag(shape.expression, counts, localIndex)) {
          return Option.some(`the triples of ${n.key} do not match the triple expression`);
        }
      } else if (counts.some((c) => c > 0)) return Option.some('unexpected triples');
      // Extensions.
      const extFailure = Arr.findFirst(extensions, (x, i) =>
        this.satisfies(
          n,
          x,
          { arcs: Option.some(partitions[i] ?? []), target: ctx.target, partitionClosed: closed },
          deps,
          Option.none(),
        ),
      );
      if (Option.isSome(extFailure)) return extFailure;
      // Semantic actions.
      const matched = Arr.map(assignment, ({ arc }) => arc.triple);
      const tcFailure = Arr.findFirst(assignment, ({ arc, tc }) =>
        localIndex.has(tc)
          ? this.runSemActs(tc.semActs, { site: 'tripleConstraint', node: n, triple: arc.triple })
          : success,
      );
      if (Option.isSome(tcFailure)) return tcFailure;
      if (shape.expression !== undefined) {
        const r = this.groupSemActs(shape.expression, counts, localIndex, n, matched);
        if (Option.isSome(r)) return r;
      }
      return this.runSemActs(shape.semActs, { site: 'shape', node: n, triples: matched });
    };

    const search = (i: number): boolean => {
      const choice = choices[i];
      if (choice === undefined) {
        const r = tryAssignment();
        if (Option.isNone(r)) return true;
        if (r.value !== 'duplicate partition' && Option.isNone(firstFailure)) firstFailure = r;
        return false;
      }
      return Arr.some(choice.tcs, (tc) => {
        assignment[i] = { arc: choice.arc, tc };
        return search(i + 1);
      });
    };
    if (search(0)) return success;
    return Option.orElse(firstFailure, () => Option.some(`${n.key} does not match the shape`));
  }

  // ---------------------------------------------------------------------------
  // Triple expression matching on bags
  // ---------------------------------------------------------------------------

  /** Whether the bag of triple constraint counts matches the triple expression. */
  private matchBag(
    te: ShExJ.TripleExprOrRef,
    counts: ReadonlyArray<number>,
    localIndex: LocalIndex,
  ): boolean {
    const zero = bagKey(counts.map(() => 0));
    return this.step(te, counts, localIndex, 0).some((b) => bagKey(b) === zero);
  }

  private resolveTe(te: ShExJ.TripleExprOrRef): Option.Option<ShExJ.TripleExpr> {
    return Predicate.isString(te)
      ? Option.fromUndefinedOr(this.index.tripleExprs.get(te))
      : Option.some(te);
  }

  /** All bags remaining after `te` (with its cardinality) consumes part of `bag`. */
  private step(
    te0: ShExJ.TripleExprOrRef,
    bag: ReadonlyArray<number>,
    localIndex: LocalIndex,
    depth: number,
  ): Array<ReadonlyArray<number>> {
    const resolved = this.resolveTe(te0);
    if (Option.isNone(resolved) || depth > 64) return [];
    const te = resolved.value;
    const { min, max } = cardinality(te);
    if (te.type === 'TripleConstraint') {
      const k = localIndex.get(te);
      if (k === undefined) return min === 0 ? [bag] : [];
      const avail = bag[k] ?? 0;
      const hi = Math.min(max, avail);
      return hi < min
        ? []
        : Arr.map(Arr.range(min, hi), (c) => {
            const nb = bag.slice();
            nb[k] = avail - c;
            return nb;
          });
    }
    const once = (b: ReadonlyArray<number>): Array<ReadonlyArray<number>> =>
      te.type === 'OneOf'
        ? dedupe(te.expressions.flatMap((x) => this.step(x, b, localIndex, depth + 1)))
        : Arr.reduce(te.expressions, [b], (sets: Array<ReadonlyArray<number>>, x) =>
            Arr.isReadonlyArrayEmpty(sets)
              ? sets
              : dedupe(sets.flatMap((s) => this.step(x, s, localIndex, depth + 1))),
          );
    const result = MutableHashMap.empty<string, ReadonlyArray<number>>();
    if (min === 0) MutableHashMap.set(result, bagKey(bag), bag);
    iterate({ i: 1, frontier: [bag] }, ({ i, frontier }) => {
      if (i > max || Arr.isReadonlyArrayEmpty(frontier)) return Option.none();
      const next = dedupe(frontier.flatMap(once));
      if (i < min) return Option.some({ i: i + 1, frontier: next });
      const fresh = Arr.filter(next, (b) => {
        const k = bagKey(b);
        if (MutableHashMap.has(result, k)) return false;
        MutableHashMap.set(result, k, b);
        return true;
      });
      return Option.some({ i: i + 1, frontier: fresh });
    });
    return Arr.fromIterable(MutableHashMap.values(result));
  }

  /** Runs the semantic actions of the groups (EachOf/OneOf) that took part in a match. */
  private groupSemActs(
    te0: ShExJ.TripleExprOrRef,
    counts: ReadonlyArray<number>,
    localIndex: LocalIndex,
    n: Term.Term,
    triples: ReadonlyArray<Term.Triple>,
  ): Outcome {
    const visit = (
      node: ShExJ.TripleExprOrRef,
      seen: MutableHashSet.MutableHashSet<string>,
    ): Visit => {
      if (Predicate.isString(node)) {
        if (MutableHashSet.has(seen, node)) return unused;
        MutableHashSet.add(seen, node);
      }
      const resolved = this.resolveTe(node);
      if (Option.isNone(resolved)) return unused;
      const te = resolved.value;
      if (te.type === 'TripleConstraint') {
        const k = localIndex.get(te);
        return { used: k !== undefined && (counts[k] ?? 0) > 0, r: success };
      }
      let used = false;
      const failed = Arr.findFirst(te.expressions, (x) => {
        const v = visit(x, seen);
        if (Option.isSome(v.r)) return Option.some(v);
        used ||= v.used;
        return Option.none();
      });
      if (Option.isSome(failed)) return failed.value;
      if (used || cardinality(te).min > 0) {
        const r = this.runSemActs(te.semActs, { site: 'tripleExpression', node: n, triples });
        if (Option.isSome(r)) return { used, r };
      }
      return { used, r: success };
    };
    return visit(te0, MutableHashSet.empty()).r;
  }
}
