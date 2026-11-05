/**
 * Evaluation of SPARQL expressions over solution mappings: all operators and
 * functional forms (`&&`, `||`, `!`, `IN`, `IF`, `COALESCE`, `BOUND`,
 * `EXISTS`), the built-in functions of SPARQL 1.1 and 1.2, XSD casts and
 * extension functions, with SPARQL's error semantics.
 *
 * Also exports the effective boolean value, value equality / ordering and
 * the `ORDER BY` term ordering.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as DateTime from 'effect/DateTime';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Random from 'effect/Random';
import * as Result from 'effect/Result';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Algebra from './Algebra.ts';
import type * as Ast from './Ast.ts';
import type { Bindings } from './Bindings.ts';
import * as Functions from './Functions.ts';
import * as V from './internal/values.ts';

/**
 * The context of expression evaluation.
 *
 * @since 0.1.0
 * @category models
 */
export interface Context extends Functions.FunctionContext {
  /** Extension functions by IRI. */
  readonly functions: Functions.Registry;
  /**
   * Evaluates an `EXISTS` pattern for a solution. The engine precomputes
   * these (pattern evaluation is effectful) before evaluating the
   * expression; without it `EXISTS` is an error.
   */
  readonly exists?: ((e: Algebra.ExistsExpression, solution: Bindings) => boolean) | undefined;
}

/**
 * Creates an evaluation context.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeContext = (options?: {
  readonly now?: Date | undefined;
  readonly baseIri?: string | undefined;
  readonly functions?: Functions.Registry | undefined;
  readonly random?: (() => number) | undefined;
}): Context => {
  const scopes = new WeakMap<Bindings, MutableHashMap.MutableHashMap<string, Term.BlankNode>>();
  let counter = 0;
  // A plain constructor, outside any Effect: the defaults are the default
  // `Random` service (`Math.random`) and the current time.
  const defaultRandom = Random.Random.defaultValue();
  const prefix = `e${Math.floor(defaultRandom.nextDoubleUnsafe() * 0xffffff).toString(36)}_`;
  return {
    now: options?.now ?? DateTime.toDateUtc(DateTime.nowUnsafe()),
    baseIri: options?.baseIri,
    functions: options?.functions ?? Functions.registry({}),
    random: options?.random ?? (() => defaultRandom.nextDoubleUnsafe()),
    blankNode: (label, solution) => {
      if (label === undefined) return Term.blankNode(`${prefix}${counter++}`);
      const row = solution.origin ?? solution;
      let scope = scopes.get(row);
      if (scope === undefined) scopes.set(row, (scope = MutableHashMap.empty()));
      const existing = MutableHashMap.get(scope, label);
      if (Option.isSome(existing)) return existing.value;
      const node = Term.blankNode(`${prefix}${counter++}`);
      MutableHashMap.set(scope, label, node);
      return node;
    },
  };
};

/**
 * A term with its variables replaced by their bindings. Plain branches rather
 * than `Match`: it runs for every variable of every evaluated expression.
 */
const substitute = (t: Term.Term, solution: Bindings): Term.GroundTerm => {
  if (Term.isVariable(t))
    return solution.map.get(t.value) ?? V.fail(`Unbound variable ?${t.value}`);
  if (Term.isTriple(t)) {
    // Substitution keeps each position's kind for the ground terms a pattern can be bound to;
    // like the triple patterns it comes from, the result is not checked again.
    return Term.triple<any, any, any>(
      substitute(t.subject, solution),
      substitute(t.predicate, solution),
      substitute(t.object, solution),
    );
  }
  if (Term.isDefaultGraph(t)) return V.fail('Invalid term');
  return t;
};

/**
 * Evaluates an expression; throws `EvalFailure` on errors. Plain branches
 * rather than `Match`: it runs once per expression node per solution.
 *
 * @internal
 */
export const evaluateUnsafe = (
  e: Algebra.Expression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => {
  if (Predicate.isTagged(e, 'Operation')) return operation(e, solution, ctx);
  if (Term.isVariable(e) || Term.isTriple(e)) return substitute(e, solution);
  if (Predicate.isTagged(e, 'FunctionCall')) return functionCall(e, solution, ctx);
  if (Predicate.isTagged(e, 'Exists')) {
    if (ctx.exists === undefined) return V.fail('EXISTS is not supported here');
    const r = ctx.exists(e, solution);
    return V.bool(e.negated ? !r : r);
  }
  return e;
};

const functionCall = (
  call: Algebra.FunctionCallExpression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => {
  const iri = call.function.value;
  const args = call.args.map((a) => evaluateUnsafe(a, solution, ctx));
  const f = ctx.functions.get(iri);
  if (f !== undefined) return f(args, ctx);
  if (Functions.isCast(iri)) {
    const [arg, ...rest] = args;
    if (arg === undefined || Arr.isReadonlyArrayNonEmpty(rest)) {
      return V.fail('Casts take one argument');
    }
    return Functions.cast(iri, arg);
  }
  return V.fail(`Unknown function <${iri}>`);
};

const ebvOf = (e: Algebra.Expression, solution: Bindings, ctx: Context): boolean =>
  V.ebv(evaluateUnsafe(e, solution, ctx));

const toError = (failure: V.EvalFailure): Functions.ExpressionError =>
  new Functions.ExpressionError({ message: failure.message });

const attempt = <A>(f: () => A): A | V.EvalFailure => Result.merge(V.catchEvalFailure(f));

/** Argument `i` of an operation (the parser checked each operator's arity). */
const argAt = (e: Algebra.OperationExpression, i: number): Algebra.Expression =>
  e.args[i] ?? V.fail(`${e.operator} is missing argument ${i + 1}`);

/** Evaluates argument `i` of an operation. */
const argOf = (e: Algebra.OperationExpression, i: number, solution: Bindings, ctx: Context) =>
  evaluateUnsafe(argAt(e, i), solution, ctx);

const or = (e: Algebra.OperationExpression, solution: Bindings, ctx: Context): Term.GroundTerm => {
  const a = attempt(() => ebvOf(argAt(e, 0), solution, ctx));
  if (a === true) return V.TRUE;
  const b = ebvOf(argAt(e, 1), solution, ctx);
  if (b) return V.TRUE;
  if (a instanceof V.EvalFailure) throw a;
  return V.FALSE;
};

const and = (e: Algebra.OperationExpression, solution: Bindings, ctx: Context): Term.GroundTerm => {
  const a = attempt(() => ebvOf(argAt(e, 0), solution, ctx));
  if (a === false) return V.FALSE;
  const b = ebvOf(argAt(e, 1), solution, ctx);
  if (!b) return V.FALSE;
  if (a instanceof V.EvalFailure) throw a;
  return V.TRUE;
};

const order = (
  op: '<' | '>' | '<=' | '>=',
  e: Algebra.OperationExpression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => {
  const a = argOf(e, 0, solution, ctx);
  const b = argOf(e, 1, solution, ctx);
  if (!Term.isLiteral(a) || !Term.isLiteral(b)) return V.fail('Cannot order non-literals');
  const c = V.compareLiterals(a, b);
  if (Number.isNaN(c)) return V.FALSE;
  return V.bool(op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0);
};

const isIn = (
  e: Algebra.OperationExpression,
  solution: Bindings,
  ctx: Context,
  negated: boolean,
): Term.GroundTerm => {
  const value = argOf(e, 0, solution, ctx);
  let failure = Option.none<V.EvalFailure>();
  const found = e.args.some((x, i) => {
    if (i === 0) return false;
    const r = attempt(() => V.equals(value, evaluateUnsafe(x, solution, ctx)));
    if (r instanceof V.EvalFailure) failure = Option.some(r);
    return r === true;
  });
  if (found) return V.bool(!negated);
  if (Option.isSome(failure)) throw failure.value;
  return V.bool(negated);
};

const coalesce = (
  e: Algebra.OperationExpression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => {
  let value = Option.none<Term.GroundTerm>();
  e.args.some((x) => {
    const r = attempt(() => evaluateUnsafe(x, solution, ctx));
    if (r instanceof V.EvalFailure) return false;
    value = Option.some(r);
    return true;
  });
  return Option.isSome(value) ? value.value : V.fail('COALESCE: no argument could be evaluated');
};

const builtIn = (
  op: Ast.BuiltInName,
  e: Algebra.OperationExpression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => {
  const f = Functions.builtIns[op];
  if (f === undefined) return V.fail(`Unsupported operator ${op}`);
  const values = e.args.map((a) => evaluateUnsafe(a, solution, ctx));
  // SAFETY: `BuiltInArgs` types the first three slots as present; each built-in checks its own
  // arity before reading them.
  return f(values as unknown as Functions.BuiltInArgs, ctx, solution);
};

/**
 * Evaluates an operation, by operator. Plain branches rather than `Match`:
 * it runs once per operation per solution.
 */
const operation = (
  e: Algebra.OperationExpression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => {
  const op = e.operator;
  if (op === '||') return or(e, solution, ctx);
  if (op === '&&') return and(e, solution, ctx);
  if (op === '=') return V.bool(V.equals(argOf(e, 0, solution, ctx), argOf(e, 1, solution, ctx)));
  if (op === '!=') {
    return V.bool(!V.equals(argOf(e, 0, solution, ctx), argOf(e, 1, solution, ctx)));
  }
  if (op === '<' || op === '>' || op === '<=' || op === '>=') return order(op, e, solution, ctx);
  if (op === '!') return V.bool(!ebvOf(argAt(e, 0), solution, ctx));
  if (op === '+' || op === '-' || op === '*' || op === '/') {
    return V.arithmetic(op, argOf(e, 0, solution, ctx), argOf(e, 1, solution, ctx));
  }
  if (op === 'UPLUS') {
    const a = argOf(e, 0, solution, ctx);
    return V.isNumeric(a) ? a : V.fail('Unary plus of a non-numeric');
  }
  if (op === 'UMINUS') return V.negate(argOf(e, 0, solution, ctx));
  if (op === 'IN' || op === 'NOT IN') return isIn(e, solution, ctx, op === 'NOT IN');
  if (op === 'BOUND') {
    const v = e.args[0];
    return V.bool(Term.isVariable(v) && solution.map.has(v.value));
  }
  if (op === 'IF') {
    return ebvOf(argAt(e, 0), solution, ctx)
      ? argOf(e, 1, solution, ctx)
      : argOf(e, 2, solution, ctx);
  }
  if (op === 'COALESCE') return coalesce(e, solution, ctx);
  return builtIn(op, e, solution, ctx);
};

/**
 * Evaluates an expression against a solution.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const evaluate = (
  expression: Algebra.Expression,
  solution: Bindings,
  context: Context,
): Result.Result<Term.GroundTerm, Functions.ExpressionError> =>
  Result.mapError(
    V.catchEvalFailure(() => evaluateUnsafe(expression, solution, context)),
    toError,
  );

/**
 * Evaluates an expression, returning `undefined` on errors.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const evaluateOrUndefined = (
  expression: Algebra.Expression,
  solution: Bindings,
  context: Context,
): Term.GroundTerm | undefined =>
  Result.getOrUndefined(V.catchEvalFailure(() => evaluateUnsafe(expression, solution, context)));

/**
 * Evaluates a filter condition: the effective boolean value of the
 * expression, with errors counting as `false`.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const test = (
  expression: Algebra.Expression,
  solution: Bindings,
  context: Context,
): boolean =>
  Result.getOrElse(
    V.catchEvalFailure(() => V.ebv(evaluateUnsafe(expression, solution, context))),
    () => false,
  );

/**
 * The effective boolean value of a term (SPARQL 1.1 §17.2.2).
 *
 * @since 0.1.0
 * @category evaluation
 */
export const effectiveBooleanValue = (
  term: Term.GroundTerm,
): Result.Result<boolean, Functions.ExpressionError> =>
  Result.mapError(
    V.catchEvalFailure(() => V.ebv(term)),
    toError,
  );

/**
 * Value equality (the `=` operator). Fails for incomparable literals.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const equals = (
  a: Term.GroundTerm,
  b: Term.GroundTerm,
): Result.Result<boolean, Functions.ExpressionError> =>
  Result.mapError(
    V.catchEvalFailure(() => V.equals(a, b)),
    toError,
  );

/**
 * The total order on (possibly unbound) terms used by `ORDER BY`: unbound <
 * blank nodes < IRIs < literals < triple terms.
 *
 * @since 0.1.0
 * @category ordering
 */
export const compare = (a: Term.GroundTerm | undefined, b: Term.GroundTerm | undefined): number =>
  V.orderCompare(Option.fromUndefinedOr(a), Option.fromUndefinedOr(b));
