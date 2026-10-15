/**
 * The ShEx validation engine: a synchronous evaluator of `satisfies` with
 * memoisation and coinductive (greatest fixed point) handling of recursive
 * references, partition search for triple expressions over bags of triple
 * constraint assignments, and ShEx 2.2 `EXTENDS` / `ABSTRACT` /
 * `RESTRICTS` semantics.
 *
 * @internal
 */
import * as Option from 'effect/Option';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as SemAct from '../SemAct.ts';
import type * as ShExJ from '../ShExJ.ts';
import { cardinality } from '../ShExJ.ts';
import type { SchemaIndex } from '../Structure.ts';
import { checkNodeConstraint } from './nodeConstraint.ts';

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
  /** The neighbourhood subset being matched (undefined: the full neighbourhood). */
  readonly arcs: ReadonlyArray<Arc> | undefined;
  readonly target: Target | undefined;
  readonly partitionClosed: boolean;
}

const FULL: Ctx = { arcs: undefined, target: undefined, partitionClosed: false };

/** `undefined` means success; a string is a failure reason. */
type Outcome = string | undefined;

const OK = Symbol('ok');

export class Engine {
  private readonly cache = new Map<string, Outcome | typeof OK>();
  private readonly inProgress = new Set<string>();
  private readonly neighbourhoods = new Map<string, ReadonlyArray<Arc>>();
  private readonly shapeTcs = new WeakMap<object, ReadonlyArray<ShExJ.TripleConstraint>>();

  constructor(
    readonly index: SchemaIndex,
    readonly dataset: Dataset.Dataset,
    readonly handler: SemAct.Handler,
    readonly externs: ReadonlyMap<string, ShExJ.ShapeDecl>,
  ) {}

  // ---------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------

  neighbourhood(n: Term.Term): ReadonlyArray<Arc> {
    const cached = this.neighbourhoods.get(n.key);
    if (cached !== undefined) return cached;
    const arcs: Array<Arc> = [];
    const seen = new Set<string>();
    if (n._tag === 'NamedNode' || n._tag === 'BlankNode' || n._tag === 'Triple') {
      for (const q of Dataset.match(this.dataset, { subject: n })) {
        const t = Term.triple(q.subject, q.predicate, q.object);
        if (seen.has(`o${t.key}`)) continue;
        seen.add(`o${t.key}`);
        arcs.push({ triple: t, dir: 'out', predicate: q.predicate.value, value: q.object });
      }
    }
    if (n._tag !== 'Variable' && n._tag !== 'DefaultGraph') {
      for (const q of Dataset.match(this.dataset, { object: n as Term.Object })) {
        const t = Term.triple(q.subject, q.predicate, q.object);
        if (seen.has(`i${t.key}`)) continue;
        seen.add(`i${t.key}`);
        arcs.push({ triple: t, dir: 'in', predicate: q.predicate.value, value: q.subject });
      }
    }
    this.neighbourhoods.set(n.key, arcs);
    return arcs;
  }

  // ---------------------------------------------------------------------------
  // Semantic actions
  // ---------------------------------------------------------------------------

  runSemActs(
    acts: ReadonlyArray<ShExJ.SemAct> | undefined,
    context: SemAct.SemActContext,
  ): Outcome {
    if (acts === undefined) return undefined;
    for (const act of acts) {
      const r = this.handler(act, context);
      if (Option.isSome(r) && !r.value) return `semantic action <${act.name}> failed`;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Shape labels
  // ---------------------------------------------------------------------------

  /** Validates `n` against a shape label (or a descendant) on its full neighbourhood. */
  validateLabel(n: Term.Term, label: string, deps: Set<string>): Outcome {
    const key = `${n.key}\u0000${label}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached === OK ? undefined : cached;
    if (this.inProgress.has(key)) {
      deps.add(key);
      return undefined;
    }
    this.inProgress.add(key);
    const local = new Set<string>();
    let r: Outcome;
    try {
      r = this.satisfiesDescendant(n, label, local);
    } finally {
      this.inProgress.delete(key);
    }
    local.delete(key);
    if (r !== undefined || local.size === 0) this.cache.set(key, r ?? OK);
    for (const d of local) deps.add(d);
    return r;
  }

  /** Validates `n` against the start shape expression. */
  validateStart(n: Term.Term, deps: Set<string>): Outcome {
    const start = this.index.schema.start;
    if (start === undefined) return 'the schema has no start shape';
    const key = `${n.key}\u0000\u0000START`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached === OK ? undefined : cached;
    if (this.inProgress.has(key)) {
      deps.add(key);
      return undefined;
    }
    this.inProgress.add(key);
    const local = new Set<string>();
    let r: Outcome;
    try {
      r = this.satisfies(n, start, FULL, local, undefined);
    } finally {
      this.inProgress.delete(key);
    }
    local.delete(key);
    if (r !== undefined || local.size === 0) this.cache.set(key, r ?? OK);
    for (const d of local) deps.add(d);
    return r;
  }

  private satisfiesDescendant(n: Term.Term, label: string, deps: Set<string>): Outcome {
    const decl = this.index.shapes.get(label);
    if (decl === undefined) return `unknown shape ${label}`;
    const candidates = [label, ...(this.index.descendants.get(label) ?? [])].filter(
      (l) => this.index.shapes.get(l)?.abstract !== true,
    );
    if (candidates.length === 0) return `${label} is abstract and has no concrete extension`;
    let first: Outcome;
    for (const c of candidates) {
      const target: Target | undefined = c === label ? undefined : { label, count: 0 };
      const r = this.satisfiesDecl(n, c, { arcs: undefined, target, partitionClosed: false }, deps);
      if (r === undefined && (target === undefined || target.count > 0)) return undefined;
      first ??= r ?? `${n.key} matches ${c} but not through ${label}`;
    }
    return first;
  }

  private satisfiesDecl(n: Term.Term, label: string, ctx: Ctx, deps: Set<string>): Outcome {
    const decl = this.index.shapes.get(label);
    if (decl === undefined) return `unknown shape ${label}`;
    for (const e of [...(decl.restricts ?? []), decl.shapeExpr]) {
      const r = this.satisfies(n, e, ctx, deps, label);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Shape expressions
  // ---------------------------------------------------------------------------

  satisfies(
    n: Term.Term,
    e: ShExJ.ShapeExprOrRef,
    ctx: Ctx,
    deps: Set<string>,
    declLabel: string | undefined,
  ): Outcome {
    if (typeof e === 'string') {
      if (ctx.arcs === undefined) return this.validateLabel(n, e, deps);
      const r = this.satisfiesDecl(n, e, ctx, deps);
      if (r === undefined && ctx.target !== undefined && ctx.target.label === e) ctx.target.count++;
      return r;
    }
    switch (e.type) {
      case 'ShapeAnd':
        for (const c of e.shapeExprs) {
          const r = this.satisfies(n, c, ctx, deps, undefined);
          if (r !== undefined) return r;
        }
        return undefined;
      case 'ShapeOr': {
        // When validating a descendant of a target shape, prefer an
        // alternative that goes through the target.
        let first: Outcome;
        let passed = false;
        for (const c of e.shapeExprs) {
          const before = ctx.target?.count ?? 0;
          const r = this.satisfies(n, c, ctx, deps, undefined);
          if (r === undefined) {
            if (ctx.target === undefined || ctx.target.count > before) return undefined;
            passed = true;
          } else first ??= r;
        }
        return passed ? undefined : `${n.key} matches none of the alternatives (${first})`;
      }
      case 'ShapeNot': {
        const r = this.satisfies(n, e.shapeExpr, ctx, deps, undefined);
        return r === undefined ? `${n.key} matches a negated shape expression` : undefined;
      }
      case 'NodeConstraint': {
        const r = checkNodeConstraint(n, e);
        if (r !== undefined) return r;
        return this.runSemActs(e.semActs, { site: 'nodeConstraint', node: n });
      }
      case 'ShapeExternal': {
        const ext = declLabel === undefined ? undefined : this.externs.get(declLabel);
        if (ext === undefined) return `no definition available for external shape ${declLabel}`;
        return this.satisfies(n, ext.shapeExpr, ctx, deps, undefined);
      }
      case 'Shape':
        return this.matchesShape(n, e, ctx, deps);
    }
  }

  // ---------------------------------------------------------------------------
  // Triple constraints
  // ---------------------------------------------------------------------------

  /** The triple constraints of a triple expression (through inclusions). */
  private tcsOf(te: ShExJ.TripleExprOrRef | undefined, out: Array<ShExJ.TripleConstraint>, seen: Set<string>): void {
    if (te === undefined) return;
    if (typeof te === 'string') {
      if (seen.has(te)) return;
      seen.add(te);
      this.tcsOf(this.index.tripleExprs.get(te), out, seen);
      return;
    }
    if (te.type === 'TripleConstraint') {
      if (!out.includes(te)) out.push(te);
    } else for (const c of te.expressions) this.tcsOf(c, out, seen);
  }

  private localTcs(shape: ShExJ.Shape): ReadonlyArray<ShExJ.TripleConstraint> {
    let tcs = this.shapeTcs.get(shape);
    if (tcs === undefined) {
      const out: Array<ShExJ.TripleConstraint> = [];
      this.tcsOf(shape.expression, out, new Set());
      this.shapeTcs.set(shape, (tcs = out));
    }
    return tcs;
  }

  /** All triple constraints of the shapes an extension refers to (recursively). */
  private extensionTcs(e: ShExJ.ShapeExprOrRef, out: Array<ShExJ.TripleConstraint>, seen: Set<string>): void {
    if (typeof e === 'string') {
      if (seen.has(e)) return;
      seen.add(e);
      const decl = this.index.shapes.get(e);
      if (decl !== undefined) {
        for (const r of decl.restricts ?? []) this.extensionTcs(r, out, seen);
        this.extensionTcs(decl.shapeExpr, out, seen);
      }
      return;
    }
    switch (e.type) {
      case 'Shape':
        for (const tc of this.localTcs(e)) if (!out.includes(tc)) out.push(tc);
        for (const x of e.extends ?? []) this.extensionTcs(x, out, seen);
        return;
      case 'ShapeAnd':
      case 'ShapeOr':
        for (const c of e.shapeExprs) this.extensionTcs(c, out, seen);
        return;
      case 'ShapeNot':
        this.extensionTcs(e.shapeExpr, out, seen);
        return;
      default:
        return;
    }
  }

  private matchesShape(n: Term.Term, shape: ShExJ.Shape, ctx: Ctx, deps: Set<string>): Outcome {
    const arcs = ctx.arcs ?? this.neighbourhood(n);
    const closed = shape.closed === true || ctx.partitionClosed;
    const local = this.localTcs(shape);
    const extensions = shape.extends ?? [];
    const extTcs = extensions.map((x) => {
      const out: Array<ShExJ.TripleConstraint> = [];
      this.extensionTcs(x, out, new Set());
      return out;
    });
    const all: Array<ShExJ.TripleConstraint> = [...local];
    for (const group of extTcs) for (const tc of group) if (!all.includes(tc)) all.push(tc);
    const localIndex = new Map<ShExJ.TripleConstraint, number>();
    local.forEach((tc, i) => localIndex.set(tc, i));
    const extGroupsOf = new Map<ShExJ.TripleConstraint, Array<number>>();
    extTcs.forEach((group, i) => {
      for (const tc of group) {
        if (localIndex.has(tc)) continue;
        let g = extGroupsOf.get(tc);
        if (g === undefined) extGroupsOf.set(tc, (g = []));
        g.push(i);
      }
    });
    const byPredicate = new Map<string, Array<ShExJ.TripleConstraint>>();
    for (const tc of all) {
      const k = `${tc.inverse === true ? 'in' : 'out'} ${tc.predicate}`;
      let l = byPredicate.get(k);
      if (l === undefined) byPredicate.set(k, (l = []));
      l.push(tc);
    }
    const extra = new Set(shape.extra ?? []);

    // Candidate triple constraints of every arc.
    const choices: Array<{ arc: Arc; tcs: ReadonlyArray<ShExJ.TripleConstraint> }> = [];
    const valueCache = new Map<string, Outcome>();
    for (const arc of arcs) {
      const tcs = byPredicate.get(`${arc.dir} ${arc.predicate}`);
      if (tcs === undefined) {
        if (arc.dir === 'out' && closed)
          return `closed shape does not allow ${arc.triple.key}`;
        continue;
      }
      const ok: Array<ShExJ.TripleConstraint> = [];
      let firstReason: Outcome;
      for (const tc of tcs) {
        if (tc.valueExpr === undefined) {
          ok.push(tc);
          continue;
        }
        const ck = `${all.indexOf(tc)} ${arc.value.key}`;
        let r: Outcome;
        if (valueCache.has(ck)) r = valueCache.get(ck);
        else {
          r = this.satisfies(arc.value, tc.valueExpr, FULL, deps, undefined);
          valueCache.set(ck, r);
        }
        if (r === undefined) ok.push(tc);
        else firstReason ??= r;
      }
      if (ok.length === 0) {
        if (!extra.has(arc.predicate))
          return `${arc.triple.key} does not match its triple constraint: ${firstReason}`;
        continue;
      }
      choices.push({ arc, tcs: ok });
    }

    const hasTcSemActs = local.some((tc) => tc.semActs !== undefined);
    const tried = new Set<string>();
    const assignment: Array<ShExJ.TripleConstraint> = new Array(choices.length);
    let firstFailure: Outcome;
    const extDeps = deps;

    const tryAssignment = (): Outcome => {
      const counts = new Array<number>(local.length).fill(0);
      const partitions: Array<Array<Arc>> = extensions.map(() => []);
      const keyParts: Array<string> = [];
      for (let i = 0; i < choices.length; i++) {
        const tc = assignment[i]!;
        const li = localIndex.get(tc);
        if (li !== undefined) {
          counts[li]!++;
          if (hasTcSemActs) keyParts.push(`L${li}`);
        } else {
          const groups = extGroupsOf.get(tc) ?? [];
          for (const g of groups) partitions[g]!.push(choices[i]!.arc);
          keyParts.push(`E${groups.join('.')}`);
        }
      }
      const key = `${counts.join(',')}|${keyParts.join('-')}`;
      if (tried.has(key)) return 'duplicate partition';
      tried.add(key);
      // Local triple expression.
      if (shape.expression !== undefined) {
        if (!this.matchBag(shape.expression, counts, localIndex)) {
          return `the triples of ${n.key} do not match the triple expression`;
        }
      } else if (counts.some((c) => c > 0)) return 'unexpected triples';
      // Extensions.
      for (let i = 0; i < extensions.length; i++) {
        const r = this.satisfies(
          n,
          extensions[i]!,
          { arcs: partitions[i]!, target: ctx.target, partitionClosed: closed },
          extDeps,
          undefined,
        );
        if (r !== undefined) return r;
      }
      // Semantic actions.
      const matched: Array<Term.Triple> = [];
      for (let i = 0; i < choices.length; i++) {
        const tc = assignment[i]!;
        const arc = choices[i]!.arc;
        matched.push(arc.triple);
        if (localIndex.has(tc)) {
          const r = this.runSemActs(tc.semActs, {
            site: 'tripleConstraint',
            node: n,
            triple: arc.triple,
          });
          if (r !== undefined) return r;
        }
      }
      if (shape.expression !== undefined) {
        const r = this.groupSemActs(shape.expression, counts, localIndex, n, matched);
        if (r !== undefined) return r;
      }
      return this.runSemActs(shape.semActs, { site: 'shape', node: n, triples: matched });
    };

    const search = (i: number): boolean => {
      if (i === choices.length) {
        const r = tryAssignment();
        if (r === undefined) return true;
        if (r !== 'duplicate partition') firstFailure ??= r;
        return false;
      }
      for (const tc of choices[i]!.tcs) {
        assignment[i] = tc;
        if (search(i + 1)) return true;
      }
      return false;
    };
    if (search(0)) return undefined;
    return firstFailure ?? `${n.key} does not match the shape`;
  }

  // ---------------------------------------------------------------------------
  // Triple expression matching on bags
  // ---------------------------------------------------------------------------

  /** Whether the bag of triple constraint counts matches the triple expression. */
  private matchBag(
    te: ShExJ.TripleExprOrRef,
    counts: ReadonlyArray<number>,
    localIndex: ReadonlyMap<ShExJ.TripleConstraint, number>,
  ): boolean {
    const zero = counts.map(() => 0).join(',');
    return this.step(te, counts, localIndex, 0).some((b) => b.join(',') === zero);
  }

  private resolveTe(te: ShExJ.TripleExprOrRef): ShExJ.TripleExpr | undefined {
    return typeof te === 'string' ? this.index.tripleExprs.get(te) : te;
  }

  /** All bags remaining after `te` (with its cardinality) consumes part of `bag`. */
  private step(
    te0: ShExJ.TripleExprOrRef,
    bag: ReadonlyArray<number>,
    localIndex: ReadonlyMap<ShExJ.TripleConstraint, number>,
    depth: number,
  ): Array<ReadonlyArray<number>> {
    const te = this.resolveTe(te0);
    if (te === undefined || depth > 64) return [];
    const { min, max } = cardinality(te);
    if (te.type === 'TripleConstraint') {
      const k = localIndex.get(te);
      if (k === undefined) return min === 0 ? [bag] : [];
      const out: Array<ReadonlyArray<number>> = [];
      const avail = bag[k]!;
      for (let c = min; c <= Math.min(max, avail); c++) {
        const nb = bag.slice();
        nb[k] = avail - c;
        out.push(nb);
      }
      return out;
    }
    const once = (b: ReadonlyArray<number>): Array<ReadonlyArray<number>> => {
      if (te.type === 'OneOf') {
        return dedupe(te.expressions.flatMap((x) => this.step(x, b, localIndex, depth + 1)));
      }
      let sets: Array<ReadonlyArray<number>> = [b];
      for (const x of te.expressions) {
        sets = dedupe(sets.flatMap((s) => this.step(x, s, localIndex, depth + 1)));
        if (sets.length === 0) break;
      }
      return sets;
    };
    const result = new Map<string, ReadonlyArray<number>>();
    if (min === 0) result.set(bag.join(','), bag);
    let frontier: Array<ReadonlyArray<number>> = [bag];
    for (let i = 1; i <= max && frontier.length > 0; i++) {
      const next = dedupe(frontier.flatMap(once));
      if (i >= min) {
        frontier = [];
        for (const b of next) {
          const k = b.join(',');
          if (!result.has(k)) {
            result.set(k, b);
            frontier.push(b);
          }
        }
      } else frontier = next;
    }
    return Array.from(result.values());
  }

  /** Runs the semantic actions of the groups (EachOf/OneOf) that took part in a match. */
  private groupSemActs(
    te0: ShExJ.TripleExprOrRef,
    counts: ReadonlyArray<number>,
    localIndex: ReadonlyMap<ShExJ.TripleConstraint, number>,
    n: Term.Term,
    triples: ReadonlyArray<Term.Triple>,
  ): Outcome {
    const visit = (te0: ShExJ.TripleExprOrRef, seen: Set<string>): { used: boolean; r: Outcome } => {
      if (typeof te0 === 'string') {
        if (seen.has(te0)) return { used: false, r: undefined };
        seen.add(te0);
      }
      const te = this.resolveTe(te0);
      if (te === undefined) return { used: false, r: undefined };
      if (te.type === 'TripleConstraint') {
        const k = localIndex.get(te);
        return { used: k !== undefined && counts[k]! > 0, r: undefined };
      }
      let used = false;
      for (const x of te.expressions) {
        const v = visit(x, seen);
        if (v.r !== undefined) return v;
        used ||= v.used;
      }
      if (used || cardinality(te).min > 0) {
        const r = this.runSemActs(te.semActs, { site: 'tripleExpression', node: n, triples });
        if (r !== undefined) return { used, r };
      }
      return { used, r: undefined };
    };
    return visit(te0, new Set()).r;
  }
}

const dedupe = (bags: ReadonlyArray<ReadonlyArray<number>>): Array<ReadonlyArray<number>> => {
  const m = new Map<string, ReadonlyArray<number>>();
  for (const b of bags) m.set(b.join(','), b);
  return Array.from(m.values());
};
