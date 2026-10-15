/**
 * A simple forward-chaining N3 reasoner.
 *
 * Rules are the top-level statements `{ premise } => { conclusion }` (and
 * `{ conclusion } <= { premise }`). The reasoner repeatedly matches every
 * rule premise against the current statements — joining triple patterns with
 * backtracking and evaluating builtins — and adds the instantiated
 * conclusions, until a fixpoint is reached.
 *
 * - Variables (`?x`) and blank nodes in a premise are matched like query
 *   variables; blank nodes that occur only in a conclusion are instantiated
 *   with fresh blank nodes for each distinct set of bindings (so the closure
 *   is finite whenever the rules do not keep inventing new terms).
 * - Rules inferred by other rules are applied too.
 * - A conclusion `false` signals an inconsistency and fails with
 *   `ReasonerError`.
 * - Builtins: a pragmatic subset of `math:` (arithmetic, comparisons,
 *   trigonometry), `string:` (concatenation, comparisons, regular
 *   expressions), `list:` (`in`, `member`, `length`, `first`, `last`, `rest`,
 *   `append`, `iterate`, `memberAt`, `remove`) and `log:` (`equalTo`,
 *   `notEqualTo`, `includes`, `notIncludes`, `conjunction`, `uri`, `dtlit`,
 *   `langlit`, `rawType`, `collectAllIn`, `forAllIn`). Builtins whose inputs
 *   are not yet bound are deferred until the other premise statements have
 *   been matched.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Builtins from './internal/builtins.ts';
import * as Isomorphism from './Isomorphism.ts';
import * as Model from './Model.ts';
import { log } from './Vocab.ts';

/**
 * Reasoning failed: an inconsistency was derived or a limit was exceeded.
 *
 * @since 0.1.0
 * @category errors
 */
export class ReasonerError extends Schema.TaggedError<ReasonerError>()('N3ReasonerError', {
  message: Schema.String,
}) {}

/**
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /** Maximum number of forward-chaining rounds (default 1000). */
  readonly maxRounds?: number | undefined;
  /** Maximum number of statements in the closure (default 1 000 000). */
  readonly maxStatements?: number | undefined;
  /** Whether to evaluate builtins (default `true`). */
  readonly builtins?: boolean | undefined;
}

/**
 * A rule extracted from a formula.
 *
 * @since 0.1.0
 * @category models
 */
export interface Rule {
  readonly premise: ReadonlyArray<Model.Statement>;
  readonly conclusion: Model.N3Term;
  /** The statement the rule was read from. */
  readonly source: Model.Statement;
}

/**
 * The result of reasoning.
 *
 * @since 0.1.0
 * @category models
 */
export interface Result {
  /** The input statements together with everything inferred. */
  readonly closure: Model.Formula;
  /** Only the newly inferred statements. */
  readonly inferred: Model.Formula;
  /** The number of rounds until the fixpoint was reached. */
  readonly rounds: number;
}

const TRUE_KEY = Term.literal('true', xsd.boolean).key;
const FALSE_KEY = Term.literal('false', xsd.boolean).key;

const goalsOf = (t: Model.N3Term): ReadonlyArray<Model.Statement> | undefined =>
  Model.isFormula(t) ? t.statements : t.key === TRUE_KEY ? [] : undefined;

/** Premise blank nodes become rule-local variables. */
const BLANK_VAR = '\u0000b:';

/** Blank nodes at the top level of statements (not inside nested formulas). */
const topBlanks = (statements: ReadonlyArray<Model.Statement>): Set<string> => {
  const out = new Set<string>();
  const go = (t: Model.N3Term) => {
    if (t._tag === 'BlankNode') out.add(t.value);
    else if (t._tag === 'Collection') t.items.forEach(go);
  };
  for (const s of statements) {
    go(s.subject);
    go(s.predicate);
    go(s.object);
  }
  return out;
};

/** Replaces the given blank nodes (outside nested formulas) by variables. */
const blanksToVariables = <T extends Model.N3Term>(t: T, blanks: ReadonlySet<string>): T => {
  const go = (x: Model.N3Term): Model.N3Term =>
    x._tag === 'BlankNode' && blanks.has(x.value)
      ? new Term.Variable(BLANK_VAR + x.value)
      : x._tag === 'Collection'
        ? new Model.Collection(x.items.map(go))
        : x;
  return go(t) as T;
};

const statementBlanksToVariables = (s: Model.Statement, blanks: ReadonlySet<string>) =>
  new Model.Statement(
    blanksToVariables(s.subject, blanks),
    blanksToVariables(s.predicate, blanks),
    blanksToVariables(s.object, blanks),
  );

/**
 * Extracts the rules (`=>` and `<=` statements between formulas) of a
 * formula's top level.
 *
 * @since 0.1.0
 * @category rules
 */
export const rules = (formula: Model.Formula): ReadonlyArray<Rule> => {
  const out: Array<Rule> = [];
  for (const s of formula.statements) {
    if (s.predicate._tag !== 'NamedNode') continue;
    const forward = s.predicate.value === log.implies.value;
    const backward = s.predicate.value === log.isImpliedBy.value;
    if (!forward && !backward) continue;
    const premiseTerm = forward ? s.subject : s.object;
    const conclusion = forward ? s.object : s.subject;
    const premise = goalsOf(premiseTerm);
    if (premise === undefined) continue;
    // Blank nodes of the premise are query variables, also in the conclusion.
    const blanks = topBlanks(premise);
    out.push({
      premise: premise.map((p) => statementBlanksToVariables(p, blanks)),
      conclusion: Model.isFormula(conclusion)
        ? new Model.Formula(conclusion.statements.map((c) => statementBlanksToVariables(c, blanks)))
        : conclusion,
      source: s,
    });
  }
  return out;
};

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------

type Bindings = Builtins.Bindings;

class Store {
  readonly all: Array<Model.Statement> = [];
  readonly keys = new Set<string>();
  readonly byPredicate = new Map<string, Array<Model.Statement>>();
  constructor(statements: Iterable<Model.Statement> = []) {
    for (const s of statements) this.add(s);
  }
  add(s: Model.Statement): boolean {
    if (this.keys.has(s.key)) return false;
    this.keys.add(s.key);
    this.all.push(s);
    const k = s.predicate.key;
    let l = this.byPredicate.get(k);
    if (l === undefined) this.byPredicate.set(k, (l = []));
    l.push(s);
    return true;
  }
}

const walk = (t: Model.N3Term, b: Bindings): Model.N3Term => {
  let cur = t;
  while (cur._tag === 'Variable') {
    const next = b.get(cur.value);
    if (next === undefined) return cur;
    cur = next;
  }
  return cur;
};

const resolve = (t: Model.N3Term, b: Bindings): Model.N3Term =>
  b.size === 0 ? t : (Model.substitute(t, b) as Model.N3Term);

const unify = (pattern: Model.N3Term, term: Model.N3Term, b: Bindings): Array<Bindings> => {
  const p = walk(pattern, b);
  if (p._tag === 'Variable') {
    if (term._tag === 'Variable' && term.value === p.value) return [b];
    return [new Map(b).set(p.value, term)];
  }
  const t = term._tag === 'Variable' ? walk(term, b) : term;
  if (p._tag === 'Collection') {
    if (t._tag !== 'Collection' || t.items.length !== p.items.length) return [];
    let results: Array<Bindings> = [b];
    p.items.forEach((item, i) => {
      results = results.flatMap((r) => unify(item, t.items[i]!, r));
    });
    return results;
  }
  if (p._tag === 'Formula') {
    if (t._tag !== 'Formula' || t.statements.length !== p.statements.length) return [];
    if (Model.isGround(p)) return p.key === t.key || Isomorphism.isomorphic(p, t) ? [b] : [];
    return matchFormula(p.statements, t.statements, b);
  }
  return p.key === t.key ? [b] : [];
};

/** Matches each pattern statement to a distinct statement of `target`. */
const matchFormula = (
  patterns: ReadonlyArray<Model.Statement>,
  target: ReadonlyArray<Model.Statement>,
  b: Bindings,
): Array<Bindings> => {
  const out: Array<Bindings> = [];
  const used = new Set<number>();
  const go = (i: number, cur: Bindings) => {
    if (i === patterns.length) {
      out.push(cur);
      return;
    }
    const p = patterns[i]!;
    target.forEach((s, j) => {
      if (used.has(j)) return;
      used.add(j);
      for (const r of unifyStatement(p, s, cur)) go(i + 1, r);
      used.delete(j);
    });
  };
  go(0, b);
  return out;
};

const unifyStatement = (p: Model.Statement, s: Model.Statement, b: Bindings): Array<Bindings> =>
  unify(p.predicate, s.predicate, b)
    .flatMap((r) => unify(p.subject, s.subject, r))
    .flatMap((r) => unify(p.object, s.object, r));

interface Engine {
  readonly builtins: boolean;
  readonly document: () => Model.Formula;
  readonly conclusion: (formula: Model.Formula) => Model.Formula;
}

const solve = (
  store: Store,
  goals: ReadonlyArray<Model.Statement>,
  b: Bindings,
  engine: Engine,
): Array<Bindings> => {
  const out: Array<Bindings> = [];
  const ctx: Builtins.Context = {
    unify,
    query: (scope, scopeGoals, bindings, builtins) => {
      const blanks = topBlanks(scopeGoals);
      return solve(
        new Store(scope.statements),
        scopeGoals.map((g) => statementBlanksToVariables(g, blanks)),
        bindings,
        { ...engine, builtins: engine.builtins && builtins },
      );
    },
    document: engine.document,
    conclusion: engine.conclusion,
  };
  const go = (remaining: ReadonlyArray<Model.Statement>, cur: Bindings, deferred: number) => {
    if (remaining.length === 0) {
      out.push(cur);
      return;
    }
    const [goal, ...rest] = remaining as [Model.Statement, ...Array<Model.Statement>];
    const builtin = engine.builtins ? Builtins.builtinFor(walk(goal.predicate, cur)) : undefined;
    if (builtin !== undefined) {
      const results = builtin(resolve(goal.subject, cur), resolve(goal.object, cur), cur, ctx);
      if (results === undefined) {
        // Not ready: try the other goals first (once around the remaining goals).
        if (deferred < remaining.length) go([...rest, goal], cur, deferred + 1);
        return;
      }
      for (const r of results) go(rest, r, 0);
      return;
    }
    const predicate = walk(goal.predicate, cur);
    const subject = walk(goal.subject, cur);
    const listPredicate = predicate.key === rdf.first.key || predicate.key === rdf.rest.key;
    if (listPredicate && subject._tag === 'Variable' && deferred < remaining.length) {
      // The subject may become bound to a collection by a later goal.
      go([...rest, goal], cur, deferred + 1);
      return;
    }
    if (listPredicate && subject._tag === 'Collection' && subject.items.length > 0) {
      // Collections are lists: answer rdf:first / rdf:rest structurally.
      const value =
        predicate.key === rdf.first.key
          ? subject.items[0]!
          : subject.items.length === 1
            ? rdf.nil
            : new Model.Collection(subject.items.slice(1));
      for (const r of unify(goal.object, value, cur)) go(rest, r, 0);
      return;
    }
    const candidates =
      predicate._tag === 'Variable' ? store.all : (store.byPredicate.get(predicate.key) ?? []);
    for (const s of candidates) {
      for (const r of unifyStatement(goal, s, cur)) go(rest, r, 0);
    }
  };
  go(goals, b, 0);
  return out;
};

// -----------------------------------------------------------------------------
// Forward chaining
// -----------------------------------------------------------------------------

const hash = (s: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
};

class Inconsistency {
  readonly rule: Model.Statement;
  constructor(rule: Model.Statement) {
    this.rule = rule;
  }
}

const instantiate = (rule: Rule, b: Bindings): ReadonlyArray<Model.Statement> => {
  const conclusion = walk(rule.conclusion, b);
  if (conclusion.key === FALSE_KEY) throw new Inconsistency(rule.source);
  // A conclusion bound through a variable is asserted as it is.
  if (conclusion !== rule.conclusion) return goalsOf(resolve(conclusion, b)) ?? [];
  const goals = goalsOf(conclusion);
  if (goals === undefined) return [];
  // Fresh blank nodes depend only on the bindings used by the conclusion.
  const used = new Set(Model.variables(conclusion).map((v) => v.value));
  const signature = Array.from(b)
    .filter(([k]) => used.has(k))
    .map(([k, v]) => `${k}=${resolve(v, b).key}`)
    .sort()
    .join('|');
  const fresh = new Map<string, Term.BlankNode>();
  const skolem = (label: string): Term.BlankNode => {
    let node = fresh.get(label);
    if (node === undefined) {
      node = new Term.BlankNode(`sk${hash(`${rule.source.key}|${signature}|${label}`)}`);
      fresh.set(label, node);
    }
    return node;
  };
  // Blank nodes at the top level of the conclusion are instantiated per
  // firing (before the bindings are applied).
  const top = (t: Model.N3Term): Model.N3Term =>
    t._tag === 'BlankNode'
      ? skolem(t.value)
      : t._tag === 'Collection'
        ? new Model.Collection(t.items.map(top))
        : t;
  return goals.map(
    (s) =>
      new Model.Statement(
        resolve(top(s.subject), b),
        resolve(top(s.predicate), b),
        resolve(top(s.object), b),
      ),
  );
};

class LimitExceeded {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/** Forward chaining to a fixpoint; throws `Inconsistency` / `LimitExceeded`. */
const closureOf = (input: Model.Formula, options?: Options, depth = 0): Result => {
  const maxRounds = options?.maxRounds ?? 1000;
  const maxStatements = options?.maxStatements ?? 1_000_000;
  const store = new Store(input.statements);
  const inferred: Array<Model.Statement> = [];
  let snapshot: Model.Formula | undefined;
  const engine: Engine = {
    builtins: options?.builtins ?? true,
    document: () => (snapshot ??= new Model.Formula(store.all)),
    conclusion: (f) => {
      if (depth > 8) throw new LimitExceeded('log:conclusion nested too deeply');
      return closureOf(f, options, depth + 1).closure;
    },
  };
  for (let round = 1; round <= maxRounds; round++) {
    snapshot = undefined;
    const fresh: Array<Model.Statement> = [];
    for (const rule of rules(new Model.Formula(store.all))) {
      for (const b of solve(store, rule.premise, new Map(), engine)) {
        for (const s of instantiate(rule, b)) {
          if (!store.keys.has(s.key)) fresh.push(s);
        }
      }
    }
    let added = 0;
    for (const s of fresh) {
      if (store.add(s)) {
        inferred.push(s);
        added++;
      }
    }
    if (store.all.length > maxStatements) {
      throw new LimitExceeded(`Closure exceeds ${maxStatements} statements`);
    }
    if (added === 0) {
      return {
        closure: new Model.Formula(store.all),
        inferred: new Model.Formula(inferred),
        rounds: round,
      };
    }
  }
  throw new LimitExceeded(`No fixpoint after ${maxRounds} rounds`);
};

/**
 * Computes the deductive closure of a formula under its rules.
 *
 * @example
 * ```ts
 * import { Effect } from 'effect'
 * import { N3, Reasoner } from '@thomasfosterau/effect-n3'
 *
 * const program = Effect.gen(function* () {
 *   const doc = yield* N3.parse(`@prefix : <http://example.org/> .
 *     :socrates a :Man .
 *     { ?x a :Man } => { ?x a :Mortal } .`)
 *   const { inferred } = yield* Reasoner.reason(doc.formula)
 *   return N3.serializeDocument(inferred) // :socrates a :Mortal .
 * })
 * ```
 *
 * @since 0.1.0
 * @category reasoning
 */
export const reason = (
  formula: Model.Formula | Model.Document,
  options?: Options,
): Effect.Effect<Result, ReasonerError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(
        closureOf(Model.isFormula(formula) ? formula : formula.formula, options),
      );
    } catch (e) {
      if (e instanceof Inconsistency) {
        return Effect.fail(
          new ReasonerError({ message: `Inconsistency derived by rule ${e.rule.key}` }),
        );
      }
      if (e instanceof LimitExceeded) return Effect.fail(new ReasonerError({ message: e.message }));
      throw e;
    }
  });

/**
 * Answers a query: all bindings of the variables (and blank nodes) of
 * `pattern` under which every statement of `pattern` holds in `formula`
 * (builtins are evaluated).
 *
 * @since 0.1.0
 * @category reasoning
 */
export const query = (
  formula: Model.Formula,
  pattern: Model.Formula,
): ReadonlyArray<ReadonlyMap<string, Model.N3Term>> => {
  const store = new Store(formula.statements);
  const blanks = topBlanks(pattern.statements);
  const goals = pattern.statements.map((s) => statementBlanksToVariables(s, blanks));
  return solve(store, goals, new Map(), {
    builtins: true,
    document: () => formula,
    conclusion: (f) => closureOf(f).closure,
  }).map(
    (b) =>
      new Map(
        Array.from(b)
          .filter(([k]) => !k.startsWith(BLANK_VAR))
          .map(([k, v]) => [k, resolve(v, b)] as const),
      ),
  );
};
