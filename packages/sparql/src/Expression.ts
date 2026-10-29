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
import * as DateTime from 'effect/DateTime';
import * as Match from 'effect/Match';
import * as Random from 'effect/Random';
import * as Result from 'effect/Result';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Algebra from './Algebra.ts';
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
  const scopes = new WeakMap<Bindings, Map<string, Term.BlankNode>>();
  let counter = 0;
  // A plain constructor, outside any Effect: the defaults are the default
  // `Random` service (`Math.random`) and the current time.
  const defaultRandom = Random.Random.defaultValue();
  const prefix = `e${Math.floor(defaultRandom.nextDoubleUnsafe() * 0xffffff).toString(36)}_`;
  return {
    now: options?.now ?? DateTime.toDateUtc(DateTime.nowUnsafe()),
    baseIri: options?.baseIri,
    functions: options?.functions ?? new Map(),
    random: options?.random ?? (() => defaultRandom.nextDoubleUnsafe()),
    blankNode: (label, solution) => {
      if (label === undefined) return Term.blankNode(`${prefix}${counter++}`);
      const row = solution.origin ?? solution;
      let scope = scopes.get(row);
      if (scope === undefined) scopes.set(row, (scope = new Map()));
      let node = scope.get(label);
      if (node === undefined) scope.set(label, (node = Term.blankNode(`${prefix}${counter++}`)));
      return node;
    },
  };
};

const substitute: (t: Term.Term, solution: Bindings) => Term.GroundTerm = Match.fn(
  (t: Term.Term, _solution: Bindings) => t,
).pipe(
  Match.tag(
    'Variable',
    (v, _t, solution): Term.GroundTerm =>
      solution.map.get(v.value) ?? V.fail(`Unbound variable ?${v.value}`),
  ),
  Match.tag('Triple', (x, _t, solution) =>
    // SAFETY: substituting bound ground terms keeps each triple position's kind.
    Term.triple(
      substitute(x.subject, solution) as Term.Subject,
      substitute(x.predicate, solution) as Term.Predicate,
      substitute(x.object, solution) as Term.Object,
    ),
  ),
  Match.tag('DefaultGraph', () => V.fail('Invalid term')),
  Match.orElse((x) => x),
);

/**
 * Evaluates an expression; throws `EvalFailure` on errors.
 *
 * @internal
 */
export const evaluateUnsafe: (
  e: Algebra.Expression,
  solution: Bindings,
  ctx: Context,
) => Term.GroundTerm = Match.fn(
  (e: Algebra.Expression, _solution: Bindings, _ctx: Context) => e,
).pipe(
  Match.tag('Variable', 'Triple', (t, _e, solution): Term.GroundTerm => substitute(t, solution)),
  Match.tag('NamedNode', 'Literal', 'BlankNode', (t) => t),
  Match.tag('Exists', (x, _e, solution, ctx) => {
    if (ctx.exists === undefined) return V.fail('EXISTS is not supported here');
    const r = ctx.exists(x, solution);
    return V.bool(x.negated ? !r : r);
  }),
  Match.tag('FunctionCall', (call, _e, solution, ctx) => {
    const iri = call.function.value;
    const args = call.args.map((a) => evaluateUnsafe(a, solution, ctx));
    const f = ctx.functions.get(iri);
    if (f !== undefined) return f(args, ctx);
    if (Functions.isCast(iri)) {
      if (args.length !== 1) return V.fail('Casts take one argument');
      return Functions.cast(iri, args[0]!);
    }
    return V.fail(`Unknown function <${iri}>`);
  }),
  Match.tag('Operation', (o, _e, solution, ctx) => operation(o, solution, ctx)),
  Match.exhaustive,
);

const ebvOf = (e: Algebra.Expression, solution: Bindings, ctx: Context): boolean =>
  V.ebv(evaluateUnsafe(e, solution, ctx));

const toError = (failure: V.EvalFailure): Functions.ExpressionError =>
  new Functions.ExpressionError({ message: failure.message });

const attempt = <A>(f: () => A): A | V.EvalFailure => Result.merge(V.catchEvalFailure(f));

const operation = (
  e: Algebra.OperationExpression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => operatorOf(e.operator, e, solution, ctx);

/** Evaluates argument `i` of an operation. */
const argOf = (e: Algebra.OperationExpression, i: number, solution: Bindings, ctx: Context) =>
  evaluateUnsafe(e.args[i]!, solution, ctx);

const operatorOf: (
  operator: Algebra.OperationExpression['operator'],
  e: Algebra.OperationExpression,
  solution: Bindings,
  ctx: Context,
) => Term.GroundTerm = Match.fn(
  (
    operator: Algebra.OperationExpression['operator'],
    _e: Algebra.OperationExpression,
    _solution: Bindings,
    _ctx: Context,
  ) => operator,
).pipe(
  Match.when('||', (_op, _o, e, solution, ctx): Term.GroundTerm => {
    const a = attempt(() => ebvOf(e.args[0]!, solution, ctx));
    if (a === true) return V.TRUE;
    const b = ebvOf(e.args[1]!, solution, ctx);
    if (b) return V.TRUE;
    if (a instanceof V.EvalFailure) throw a;
    return V.FALSE;
  }),
  Match.when('&&', (_op, _o, e, solution, ctx) => {
    const a = attempt(() => ebvOf(e.args[0]!, solution, ctx));
    if (a === false) return V.FALSE;
    const b = ebvOf(e.args[1]!, solution, ctx);
    if (!b) return V.FALSE;
    if (a instanceof V.EvalFailure) throw a;
    return V.TRUE;
  }),
  Match.when('!', (_op, _o, e, solution, ctx) => V.bool(!ebvOf(e.args[0]!, solution, ctx))),
  Match.when('=', (_op, _o, e, solution, ctx) =>
    V.bool(V.equals(argOf(e, 0, solution, ctx), argOf(e, 1, solution, ctx))),
  ),
  Match.when('!=', (_op, _o, e, solution, ctx) =>
    V.bool(!V.equals(argOf(e, 0, solution, ctx), argOf(e, 1, solution, ctx))),
  ),
  Match.when(Match.is('<', '>', '<=', '>='), (op, _o, e, solution, ctx) => {
    const a = argOf(e, 0, solution, ctx);
    const b = argOf(e, 1, solution, ctx);
    if (a._tag !== 'Literal' || b._tag !== 'Literal') return V.fail('Cannot order non-literals');
    const c = V.compareLiterals(a, b);
    if (Number.isNaN(c)) return V.FALSE;
    return V.bool(op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0);
  }),
  Match.when(Match.is('+', '-', '*', '/'), (op, _o, e, solution, ctx) =>
    V.arithmetic(op, argOf(e, 0, solution, ctx), argOf(e, 1, solution, ctx)),
  ),
  Match.when('UPLUS', (_op, _o, e, solution, ctx) => {
    const a = argOf(e, 0, solution, ctx);
    return V.isNumeric(a) ? a : V.fail('Unary plus of a non-numeric');
  }),
  Match.when('UMINUS', (_op, _o, e, solution, ctx) => V.negate(argOf(e, 0, solution, ctx))),
  Match.when(Match.is('IN', 'NOT IN'), (op, _o, e, solution, ctx) => {
    const value = argOf(e, 0, solution, ctx);
    let failure: V.EvalFailure | undefined;
    for (let i = 1; i < e.args.length; i++) {
      const r = attempt(() => V.equals(value, argOf(e, i, solution, ctx)));
      if (r === true) return V.bool(op === 'IN');
      if (r instanceof V.EvalFailure) failure = r;
    }
    if (failure !== undefined) throw failure;
    return V.bool(op !== 'IN');
  }),
  Match.when('BOUND', (_op, _o, e, solution) => {
    const v = e.args[0]!;
    return V.bool(v._tag === 'Variable' && solution.map.has(v.value));
  }),
  Match.when('IF', (_op, _o, e, solution, ctx) =>
    ebvOf(e.args[0]!, solution, ctx) ? argOf(e, 1, solution, ctx) : argOf(e, 2, solution, ctx),
  ),
  Match.when('COALESCE', (_op, _o, e, solution, ctx) => {
    for (let i = 0; i < e.args.length; i++) {
      const r = attempt(() => argOf(e, i, solution, ctx));
      if (!(r instanceof V.EvalFailure)) return r;
    }
    return V.fail('COALESCE: no argument could be evaluated');
  }),
  Match.orElse((op, _o, e, solution, ctx) => {
    const f = Functions.builtIns[op];
    if (f === undefined) return V.fail(`Unsupported operator ${op}`);
    const values = e.args.map((a) => evaluateUnsafe(a, solution, ctx));
    // SAFETY: `BuiltInArgs` types the first three slots as present; each built-in checks its own
    // arity before reading them.
    return f(values as unknown as Functions.BuiltInArgs, ctx, solution);
  }),
);

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
  V.orderCompare(a, b);
