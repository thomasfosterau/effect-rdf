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
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Schema from 'effect/Schema';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { rdf, xsd } from '@thomasfosterau/effect-rdf/Vocab';
import * as Builtins from './internal/builtins.ts';
import * as Guards from './internal/guards.ts';
import { loop } from './internal/loop.ts';
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

const noGoals: ReadonlyArray<Model.Statement> = [];

const goalsOf = (t: Model.N3Term): Option.Option<ReadonlyArray<Model.Statement>> =>
  Model.isFormula(t)
    ? Option.some(t.statements)
    : t.key === TRUE_KEY
      ? Option.some(noGoals)
      : Option.none();

/** Premise blank nodes become rule-local variables. */
const BLANK_VAR = '\u0000b:';

/** Blank nodes at the top level of statements (not inside nested formulas). */
const topBlanks = (
  statements: ReadonlyArray<Model.Statement>,
): MutableHashSet.MutableHashSet<string> => {
  const out = MutableHashSet.empty<string>();
  const go = (t: Model.N3Term) => {
    if (Guards.isBlankNode(t)) MutableHashSet.add(out, t.value);
    else if (Model.isCollection(t)) t.items.forEach(go);
  };
  statements.forEach((s) => {
    go(s.subject);
    go(s.predicate);
    go(s.object);
  });
  return out;
};

/** Replaces the given blank nodes (outside nested formulas) by variables. */
const blanksToVariables = (
  t: Model.N3Term,
  blanks: MutableHashSet.MutableHashSet<string>,
): Model.N3Term =>
  Guards.isBlankNode(t) && MutableHashSet.has(blanks, t.value)
    ? new Term.Variable(BLANK_VAR + t.value)
    : Model.isCollection(t)
      ? new Model.Collection(t.items.map((x) => blanksToVariables(x, blanks)))
      : t;

const statementBlanksToVariables = (
  s: Model.Statement,
  blanks: MutableHashSet.MutableHashSet<string>,
) =>
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
export const rules = (formula: Model.Formula): ReadonlyArray<Rule> =>
  Arr.getSomes(
    formula.statements.map((s): Option.Option<Rule> => {
      if (!Guards.isNamedNode(s.predicate)) return Option.none();
      const forward = s.predicate.value === log.implies.value;
      const backward = s.predicate.value === log.isImpliedBy.value;
      if (!forward && !backward) return Option.none();
      const premiseTerm = forward ? s.subject : s.object;
      const conclusion = forward ? s.object : s.subject;
      return Option.map(goalsOf(premiseTerm), (premise): Rule => {
        // Blank nodes of the premise are query variables, also in the conclusion.
        const blanks = topBlanks(premise);
        return {
          premise: premise.map((p) => statementBlanksToVariables(p, blanks)),
          conclusion: Model.isFormula(conclusion)
            ? new Model.Formula(
                conclusion.statements.map((c) => statementBlanksToVariables(c, blanks)),
              )
            : conclusion,
          source: s,
        };
      });
    }),
  );

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------

type Bindings = Builtins.Bindings;

/** The bindings that bind nothing. */
const noBindings: Bindings = MutableHashMap.empty<string, Model.N3Term>().backing;

/** `b` with `name` bound to `value` (a copy: bindings are shared between solutions). */
const extend = (b: Bindings, name: string, value: Model.N3Term): Bindings => {
  const next = MutableHashMap.fromIterable(b);
  MutableHashMap.set(next, name, value);
  return next.backing;
};

const noStatements: ReadonlyArray<Model.Statement> = [];

class Store {
  readonly all: Array<Model.Statement> = [];
  readonly keys = MutableHashSet.empty<string>();
  readonly byPredicate = MutableHashMap.empty<string, Array<Model.Statement>>();
  constructor(statements: Iterable<Model.Statement> = []) {
    Arr.fromIterable(statements).forEach((s) => this.add(s));
  }
  has(s: Model.Statement): boolean {
    return MutableHashSet.has(this.keys, s.key);
  }
  add(s: Model.Statement): boolean {
    if (this.has(s)) return false;
    MutableHashSet.add(this.keys, s.key);
    this.all.push(s);
    const k = s.predicate.key;
    const l = this.byPredicate.backing.get(k);
    if (l === undefined) MutableHashMap.set(this.byPredicate, k, [s]);
    else l.push(s);
    return true;
  }
  /** The statements with the predicate `key`. */
  withPredicate(key: string): ReadonlyArray<Model.Statement> {
    return this.byPredicate.backing.get(key) ?? noStatements;
  }
}

/** The term a variable is bound to, through chains of variables (it recurses once per link). */
const walk = (t: Model.N3Term, b: Bindings): Model.N3Term => {
  if (!Guards.isVariable(t)) return t;
  const next = b.get(t.value);
  return next === undefined ? t : walk(next, b);
};

const resolve = (t: Model.N3Term, b: Bindings): Model.N3Term =>
  b.size === 0 ? t : Model.substitute(t, b);

const unify = (pattern: Model.N3Term, term: Model.N3Term, b: Bindings): Array<Bindings> => {
  const p = walk(pattern, b);
  if (Guards.isVariable(p)) {
    if (Guards.isVariable(term) && term.value === p.value) return [b];
    return [extend(b, p.value, term)];
  }
  const t = Guards.isVariable(term) ? walk(term, b) : term;
  if (p instanceof Model.Collection) {
    if (!(t instanceof Model.Collection) || t.items.length !== p.items.length) return [];
    return p.items.reduce<Array<Bindings>>(
      (results, item, i) => {
        const other = t.items[i];
        return other === undefined ? [] : results.flatMap((r) => unify(item, other, r));
      },
      [b],
    );
  }
  if (p instanceof Model.Formula) {
    if (!(t instanceof Model.Formula) || t.statements.length !== p.statements.length) return [];
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
  const used = new Uint8Array(target.length);
  const go = (i: number, cur: Bindings) => {
    const p = patterns[i];
    if (p === undefined) {
      out.push(cur);
      return;
    }
    target.forEach((s, j) => {
      if (used[j] === 1) return;
      used[j] = 1;
      unifyStatement(p, s, cur).forEach((r) => go(i + 1, r));
      used[j] = 0;
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
    if (!Arr.isReadonlyArrayNonEmpty(remaining)) {
      out.push(cur);
      return;
    }
    const [goal, ...rest] = remaining;
    const builtin = engine.builtins
      ? Builtins.builtinFor(walk(goal.predicate, cur))
      : Option.none<Builtins.Builtin>();
    if (Option.isSome(builtin)) {
      const results = builtin.value(
        resolve(goal.subject, cur),
        resolve(goal.object, cur),
        cur,
        ctx,
      );
      if (Option.isNone(results)) {
        // Not ready: try the other goals first (once around the remaining goals).
        if (deferred < remaining.length) go([...rest, goal], cur, deferred + 1);
        return;
      }
      results.value.forEach((r) => go(rest, r, 0));
      return;
    }
    const predicate = walk(goal.predicate, cur);
    const subject = walk(goal.subject, cur);
    const listPredicate = predicate.key === rdf.first.key || predicate.key === rdf.rest.key;
    if (listPredicate && Guards.isVariable(subject) && deferred < remaining.length) {
      // The subject may become bound to a collection by a later goal.
      go([...rest, goal], cur, deferred + 1);
      return;
    }
    if (
      listPredicate &&
      subject instanceof Model.Collection &&
      Arr.isReadonlyArrayNonEmpty(subject.items)
    ) {
      // Collections are lists: answer rdf:first / rdf:rest structurally.
      const value =
        predicate.key === rdf.first.key
          ? subject.items[0]
          : subject.items.length === 1
            ? rdf.nil
            : new Model.Collection(subject.items.slice(1));
      unify(goal.object, value, cur).forEach((r) => go(rest, r, 0));
      return;
    }
    const candidates = Guards.isVariable(predicate)
      ? store.all
      : store.withPredicate(predicate.key);
    candidates.forEach((s) => {
      unifyStatement(goal, s, cur).forEach((r) => go(rest, r, 0));
    });
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
  loop((i) => {
    if (i >= s.length) return false;
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    return true;
  });
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
  if (conclusion !== rule.conclusion) {
    return Option.getOrElse(goalsOf(resolve(conclusion, b)), () => noGoals);
  }
  const goals = goalsOf(conclusion);
  if (Option.isNone(goals)) return noGoals;
  // Fresh blank nodes depend only on the bindings used by the conclusion.
  const used = MutableHashSet.fromIterable(Model.variables(conclusion).map((v) => v.value));
  const entries = Arr.fromIterable(b)
    .filter(([k]) => MutableHashSet.has(used, k))
    .map(([k, v]) => `${k}=${resolve(v, b).key}`);
  const signature = Arr.sort(entries, Order.String).join('|');
  const fresh = MutableHashMap.empty<string, Term.BlankNode>();
  const skolem = (label: string): Term.BlankNode => {
    const known = fresh.backing.get(label);
    if (known !== undefined) return known;
    const node = new Term.BlankNode(`sk${hash(`${rule.source.key}|${signature}|${label}`)}`);
    MutableHashMap.set(fresh, label, node);
    return node;
  };
  // Blank nodes at the top level of the conclusion are instantiated per
  // firing (before the bindings are applied).
  const top = (t: Model.N3Term): Model.N3Term =>
    Guards.isBlankNode(t)
      ? skolem(t.value)
      : Model.isCollection(t)
        ? new Model.Collection(t.items.map(top))
        : t;
  return goals.value.map(
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
  // The formula of the store as it stood at the start of the round, made on first use
  let snapshot = Option.none<Model.Formula>();
  const engine: Engine = {
    builtins: options?.builtins ?? true,
    document: () => {
      if (Option.isSome(snapshot)) return snapshot.value;
      const f = new Model.Formula(store.all);
      snapshot = Option.some(f);
      return f;
    },
    conclusion: (f) => {
      if (depth > 8) throw new LimitExceeded('log:conclusion nested too deeply');
      return closureOf(f, options, depth + 1).closure;
    },
  };
  let result = Option.none<Result>();
  loop((i) => {
    const round = i + 1;
    if (round > maxRounds) return false;
    snapshot = Option.none();
    const fresh: Array<Model.Statement> = [];
    rules(new Model.Formula(store.all)).forEach((rule) => {
      solve(store, rule.premise, noBindings, engine).forEach((b) => {
        instantiate(rule, b).forEach((s) => {
          if (!store.has(s)) fresh.push(s);
        });
      });
    });
    let added = 0;
    fresh.forEach((s) => {
      if (store.add(s)) {
        inferred.push(s);
        added++;
      }
    });
    if (store.all.length > maxStatements) {
      throw new LimitExceeded(`Closure exceeds ${maxStatements} statements`);
    }
    if (added > 0) return true;
    result = Option.some({
      closure: new Model.Formula(store.all),
      inferred: new Model.Formula(inferred),
      rounds: round,
    });
    return false;
  });
  if (Option.isSome(result)) return result.value;
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
  Effect.sync(() => closureOf(Model.isFormula(formula) ? formula : formula.formula, options)).pipe(
    Effect.catchDefect((e) =>
      e instanceof Inconsistency
        ? Effect.fail(new ReasonerError({ message: `Inconsistency derived by rule ${e.rule.key}` }))
        : e instanceof LimitExceeded
          ? Effect.fail(new ReasonerError({ message: e.message }))
          : Effect.die(e),
    ),
    Effect.tap((result) => Effect.annotateCurrentSpan('n3.statements', result.closure.size)),
    Effect.withSpan('Reasoner.reason', {
      attributes: {
        'n3.input.statements': (Model.isFormula(formula) ? formula : formula.formula).size,
      },
    }),
  );

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
  return solve(store, goals, noBindings, {
    builtins: true,
    document: () => formula,
    conclusion: (f) => closureOf(f).closure,
  }).map((b) => {
    const answer = MutableHashMap.empty<string, Model.N3Term>();
    b.forEach((v, k) => {
      if (!k.startsWith(BLANK_VAR)) MutableHashMap.set(answer, k, resolve(v, b));
    });
    return answer.backing;
  });
};
