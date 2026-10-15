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
  const prefix = `e${Math.floor(Math.random() * 0xffffff).toString(36)}_`;
  return {
    now: options?.now ?? new Date(),
    baseIri: options?.baseIri,
    functions: options?.functions ?? new Map(),
    random: options?.random ?? Math.random,
    blankNode: (label, solution) => {
      if (label === undefined) return Term.blankNode(`${prefix}${counter++}`);
      let scope = scopes.get(solution);
      if (scope === undefined) scopes.set(solution, (scope = new Map()));
      let node = scope.get(label);
      if (node === undefined) scope.set(label, (node = Term.blankNode(`${prefix}${counter++}`)));
      return node;
    },
  };
};

const substitute = (t: Term.Term, solution: Bindings): Term.GroundTerm => {
  switch (t._tag) {
    case 'Variable':
      return solution.map.get(t.value) ?? V.fail(`Unbound variable ?${t.value}`);
    case 'Triple':
      return Term.triple(
        substitute(t.subject, solution) as Term.Subject,
        substitute(t.predicate, solution) as Term.Predicate,
        substitute(t.object, solution) as Term.Object,
      );
    case 'DefaultGraph':
      return V.fail('Invalid term');
    default:
      return t;
  }
};

/**
 * Evaluates an expression; throws `EvalFailure` on errors.
 *
 * @internal
 */
export const evaluateUnsafe = (
  e: Algebra.Expression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => {
  switch (e._tag) {
    case 'Variable':
    case 'Triple':
      return substitute(e, solution);
    case 'NamedNode':
    case 'Literal':
    case 'BlankNode':
      return e;
    case 'Exists': {
      if (ctx.exists === undefined) return V.fail('EXISTS is not supported here');
      const r = ctx.exists(e, solution);
      return V.bool(e.negated ? !r : r);
    }
    case 'FunctionCall': {
      const iri = e.function.value;
      const args = e.args.map((a) => evaluateUnsafe(a, solution, ctx));
      const f = ctx.functions.get(iri);
      if (f !== undefined) return f(args, ctx);
      if (Functions.isCast(iri)) {
        if (args.length !== 1) return V.fail('Casts take one argument');
        return Functions.cast(iri, args[0]!);
      }
      return V.fail(`Unknown function <${iri}>`);
    }
    case 'Operation':
      return operation(e, solution, ctx);
  }
};

const ebvOf = (e: Algebra.Expression, solution: Bindings, ctx: Context): boolean =>
  V.ebv(evaluateUnsafe(e, solution, ctx));

const attempt = <A>(f: () => A): A | V.EvalFailure => {
  try {
    return f();
  } catch (err) {
    if (err instanceof V.EvalFailure) return err;
    throw err;
  }
};

const operation = (
  e: Algebra.OperationExpression,
  solution: Bindings,
  ctx: Context,
): Term.GroundTerm => {
  const args = e.args;
  const arg = (i: number) => evaluateUnsafe(args[i]!, solution, ctx);
  switch (e.operator) {
    case '||': {
      const a = attempt(() => ebvOf(args[0]!, solution, ctx));
      if (a === true) return V.TRUE;
      const b = ebvOf(args[1]!, solution, ctx);
      if (b) return V.TRUE;
      if (a instanceof V.EvalFailure) throw a;
      return V.FALSE;
    }
    case '&&': {
      const a = attempt(() => ebvOf(args[0]!, solution, ctx));
      if (a === false) return V.FALSE;
      const b = ebvOf(args[1]!, solution, ctx);
      if (!b) return V.FALSE;
      if (a instanceof V.EvalFailure) throw a;
      return V.TRUE;
    }
    case '!':
      return V.bool(!ebvOf(args[0]!, solution, ctx));
    case '=':
      return V.bool(V.equals(arg(0), arg(1)));
    case '!=':
      return V.bool(!V.equals(arg(0), arg(1)));
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const a = arg(0);
      const b = arg(1);
      if (a._tag !== 'Literal' || b._tag !== 'Literal') return V.fail('Cannot order non-literals');
      const c = V.compareLiterals(a, b);
      if (Number.isNaN(c)) return V.FALSE;
      switch (e.operator) {
        case '<':
          return V.bool(c < 0);
        case '>':
          return V.bool(c > 0);
        case '<=':
          return V.bool(c <= 0);
        default:
          return V.bool(c >= 0);
      }
    }
    case '+':
    case '-':
    case '*':
    case '/':
      return V.arithmetic(e.operator, arg(0), arg(1));
    case 'UPLUS': {
      const a = arg(0);
      return V.isNumeric(a) ? a : V.fail('Unary plus of a non-numeric');
    }
    case 'UMINUS':
      return V.negate(arg(0));
    case 'IN':
    case 'NOT IN': {
      const value = arg(0);
      let failure: V.EvalFailure | undefined;
      for (let i = 1; i < args.length; i++) {
        const r = attempt(() => V.equals(value, arg(i)));
        if (r === true) return V.bool(e.operator === 'IN');
        if (r instanceof V.EvalFailure) failure = r;
      }
      if (failure !== undefined) throw failure;
      return V.bool(e.operator !== 'IN');
    }
    case 'BOUND': {
      const v = args[0]!;
      return V.bool(v._tag === 'Variable' && solution.map.has(v.value));
    }
    case 'IF':
      return ebvOf(args[0]!, solution, ctx) ? arg(1) : arg(2);
    case 'COALESCE': {
      for (let i = 0; i < args.length; i++) {
        const r = attempt(() => arg(i));
        if (!(r instanceof V.EvalFailure)) return r;
      }
      return V.fail('COALESCE: no argument could be evaluated');
    }
    default: {
      const f = Functions.builtIns[e.operator];
      if (f === undefined) return V.fail(`Unsupported operator ${e.operator}`);
      const values = args.map((a) => evaluateUnsafe(a, solution, ctx));
      return f(values as unknown as Functions.BuiltInArgs, ctx, solution);
    }
  }
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
): Result.Result<Term.GroundTerm, Functions.ExpressionError> => {
  try {
    return Result.succeed(evaluateUnsafe(expression, solution, context));
  } catch (err) {
    if (err instanceof V.EvalFailure) {
      return Result.fail(new Functions.ExpressionError({ message: err.message }));
    }
    throw err;
  }
};

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
): Term.GroundTerm | undefined => {
  try {
    return evaluateUnsafe(expression, solution, context);
  } catch (err) {
    if (err instanceof V.EvalFailure) return undefined;
    throw err;
  }
};

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
): boolean => {
  try {
    return V.ebv(evaluateUnsafe(expression, solution, context));
  } catch (err) {
    if (err instanceof V.EvalFailure) return false;
    throw err;
  }
};

/**
 * The effective boolean value of a term (SPARQL 1.1 §17.2.2).
 *
 * @since 0.1.0
 * @category evaluation
 */
export const effectiveBooleanValue = (
  term: Term.GroundTerm,
): Result.Result<boolean, Functions.ExpressionError> => {
  try {
    return Result.succeed(V.ebv(term));
  } catch (err) {
    if (err instanceof V.EvalFailure) {
      return Result.fail(new Functions.ExpressionError({ message: err.message }));
    }
    throw err;
  }
};

/**
 * Value equality (the `=` operator). Fails for incomparable literals.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const equals = (
  a: Term.GroundTerm,
  b: Term.GroundTerm,
): Result.Result<boolean, Functions.ExpressionError> => {
  try {
    return Result.succeed(V.equals(a, b));
  } catch (err) {
    if (err instanceof V.EvalFailure) {
      return Result.fail(new Functions.ExpressionError({ message: err.message }));
    }
    throw err;
  }
};

/**
 * The total order on (possibly unbound) terms used by `ORDER BY`: unbound <
 * blank nodes < IRIs < literals < triple terms.
 *
 * @since 0.1.0
 * @category ordering
 */
export const compare = (a: Term.GroundTerm | undefined, b: Term.GroundTerm | undefined): number =>
  V.orderCompare(a, b);
