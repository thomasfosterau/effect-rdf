/**
 * A small library of N3 builtins (`math:`, `string:`, `list:`, `log:`).
 *
 * A builtin receives its subject and object with the current bindings
 * applied and returns the extended bindings for each solution, or
 * `undefined` when it cannot be evaluated yet (an input is still unbound).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Term from '../../Term.ts';
import { xsd } from '../../Vocab.ts';
import * as Xsd from '../../Xsd.ts';
import * as Model from '../Model.ts';
import { list, log, math, string } from '../Vocab.ts';
import * as Guards from './guards.ts';

/** @internal */
export type Bindings = ReadonlyMap<string, Model.N3Term>;

/** @internal */
export interface Context {
  readonly unify: (pattern: Model.N3Term, term: Model.N3Term, b: Bindings) => Array<Bindings>;
  /** Solves `goals` against the statements of `scope`. */
  readonly query: (
    scope: Model.Formula,
    goals: ReadonlyArray<Model.Statement>,
    b: Bindings,
    builtins: boolean,
  ) => Array<Bindings>;
  /** The formula of the document being reasoned over (the default scope). */
  readonly document: () => Model.Formula;
  /** The deductive closure of a formula (for `log:conclusion`). */
  readonly conclusion: (formula: Model.Formula) => Model.Formula;
}

/**
 * The solutions of a builtin, or `None` when it cannot be evaluated yet (an
 * input is still unbound).
 *
 * @internal
 */
export type Answer = Option.Option<Array<Bindings>>;

/** @internal */
export type Builtin = (
  subject: Model.N3Term,
  object: Model.N3Term,
  b: Bindings,
  ctx: Context,
) => Answer;

const notReady: Answer = Option.none();

/** The builtin's solutions. */
const solutions = (bs: Array<Bindings>): Answer => Option.some(bs);

/** No solutions once `t` is ground, not ready while it is not. */
const noneOnceReady = (t: Model.N3Term): Answer => (ready(t) ? solutions([]) : notReady);

const TRUE = Term.literal('true', xsd.boolean);

/** Whether a term contains no variables (blank nodes count as ground). */
const ground = (t: Model.N3Term): boolean => Model.isGround(t);

// -----------------------------------------------------------------------------
// Numbers
// -----------------------------------------------------------------------------

type Num =
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'decimal' | 'double'; readonly value: number };

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const toNum = (t: Model.N3Term): Option.Option<Num> => {
  if (!Guards.isLiteral(t)) return Option.none();
  const v = t.value.trim();
  const dt = t.datatype.value;
  if ((dt === xsd.double.value || dt === xsd.float.value) && /^(?:[+-]?INF|NaN)$/.test(v)) {
    return Option.some({
      kind: 'double',
      value: v === 'NaN' ? NaN : v.startsWith('-') ? -Infinity : Infinity,
    });
  }
  if (!NUMERIC.test(v)) return Option.none();
  if (Xsd.isIntegerDatatype(dt) || (dt === Term.XSD_STRING && /^[+-]?\d+$/.test(v))) {
    return Option.some({ kind: 'integer', value: BigInt(v) });
  }
  if (dt === xsd.double.value || dt === xsd.float.value || /[eE]/.test(v)) {
    return Option.some({ kind: 'double', value: Number(v) });
  }
  if (dt === xsd.decimal.value || dt === Term.XSD_STRING) {
    return Option.some({ kind: 'decimal', value: Number(v) });
  }
  return Option.none();
};

const asNumber = (n: Num): number => (n.kind === 'integer' ? Number(n.value) : n.value);

/** The literal of an arithmetic result. */
const fromNum = (n: Num): Term.Literal => {
  if (n.kind === 'integer') return Term.literal(n.value.toString(), xsd.integer);
  if (n.kind === 'double') return Term.literal(Xsd.canonicalDouble(n.value), xsd.double);
  const s = String(Number(n.value.toPrecision(15)));
  return Number.isFinite(n.value) && !/e/i.test(s)
    ? Term.literal(s.includes('.') ? s : `${s}.0`, xsd.decimal)
    : Term.literal(Xsd.canonicalDouble(n.value), xsd.double);
};

const numEquals = (a: Num, b: Num): boolean => {
  if (a.kind === 'integer' && b.kind === 'integer') return a.value === b.value;
  const x = asNumber(a);
  const y = asNumber(b);
  if (x === y) return true;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y));
};

const resultKind = (ns: ReadonlyArray<Num>): Num['kind'] =>
  ns.some((n) => n.kind === 'double')
    ? 'double'
    : ns.some((n) => n.kind === 'decimal')
      ? 'decimal'
      : 'integer';

const numbersOf = (t: Model.N3Term): Option.Option<Array<Num>> =>
  Model.isCollection(t) ? Option.all(t.items.map(toNum)) : Option.none();

/** Unifies the object with a computed value (or checks it). */
const output = (
  object: Model.N3Term,
  value: Option.Option<Model.N3Term>,
  b: Bindings,
  ctx: Context,
): Answer => {
  if (Option.isNone(value)) return solutions([]);
  if (ground(object)) {
    const on = toNum(object);
    const vn = toNum(value.value);
    if (Option.isSome(on) && Option.isSome(vn)) {
      return solutions(numEquals(on.value, vn.value) ? [b] : []);
    }
  }
  return solutions(ctx.unify(object, value.value, b));
};

const ready = (t: Model.N3Term): boolean => ground(t);

const listFunction =
  (f: (ns: Array<Num>) => Option.Option<Num>, arity = -1): Builtin =>
  (s, o, b, ctx) => {
    if (!ready(s)) return notReady;
    const ns = numbersOf(s);
    if (Option.isNone(ns) || (arity >= 0 && ns.value.length !== arity)) return solutions([]);
    const r = f(ns.value);
    return Option.isNone(r) ? solutions([]) : output(o, Option.some(fromNum(r.value)), b, ctx);
  };

const unaryFunction =
  (f: (n: Num) => Num, inverse?: (n: Num) => Num): Builtin =>
  (s, o, b, ctx) => {
    if (!ready(s)) {
      if (inverse === undefined || !ready(o)) return notReady;
      const n = toNum(o);
      return solutions(Option.isNone(n) ? [] : ctx.unify(s, fromNum(inverse(n.value)), b));
    }
    const n = toNum(s);
    return Option.isNone(n) ? solutions([]) : output(o, Option.some(fromNum(f(n.value))), b, ctx);
  };

const real =
  (f: (x: number) => number) =>
  (n: Num): Num => ({ kind: 'double', value: f(asNumber(n)) });

const comparison =
  (test: (c: number) => boolean): Builtin =>
  (s, o, b) => {
    if (!ready(s) || !ready(o)) return notReady;
    const xs = toNum(s);
    const ys = toNum(o);
    if (Option.isNone(xs) || Option.isNone(ys)) return solutions([]);
    const x = xs.value;
    const y = ys.value;
    // NaN is unordered: only `notEqualTo` holds.
    const c =
      Number.isNaN(asNumber(x)) || Number.isNaN(asNumber(y))
        ? NaN
        : numEquals(x, y)
          ? 0
          : asNumber(x) < asNumber(y)
            ? -1
            : 1;
    return solutions(test(c) ? [b] : []);
  };

/** Folds the numbers as integers when they all are, else as reals. */
const fold =
  (
    int: (a: bigint, n: bigint) => bigint,
    int0: bigint,
    float: (a: number, n: number) => number,
    float0: number,
  ) =>
  (ns: Array<Num>): Option.Option<Num> => {
    const kind = resultKind(ns);
    // `kind === 'integer'` means every value is a `bigint`.
    return Option.some(
      kind === 'integer'
        ? { kind, value: ns.reduce((a, n) => (n.kind === 'integer' ? int(a, n.value) : a), int0) }
        : { kind, value: ns.reduce((a, n) => float(a, asNumber(n)), float0) },
    );
  };

const sum = fold(
  (a, n) => a + n,
  0n,
  (a, n) => a + n,
  0,
);

const product = fold(
  (a, n) => a * n,
  1n,
  (a, n) => a * n,
  1,
);

const noInteger = (): Option.Option<bigint> => Option.none();

const binary =
  (
    int: (a: bigint, b: bigint) => Option.Option<bigint>,
    float: (a: number, b: number) => number,
    forceReal = false,
  ) =>
  (ns: Array<Num>): Option.Option<Num> => {
    // `binary` is only used as `listFunction(binary(…), 2)`, which passes exactly two numbers.
    const [a, c] = ns;
    if (a === undefined || c === undefined) return Option.none();
    const kind = resultKind(ns);
    let outKind: Num['kind'] = kind === 'integer' ? 'decimal' : kind;
    if (a.kind === 'integer' && c.kind === 'integer' && !forceReal) {
      const r = int(a.value, c.value);
      if (Option.isSome(r)) return Option.some({ kind: 'integer', value: r.value });
      outKind = 'double';
    }
    const r = float(asNumber(a), asNumber(c));
    if (outKind !== 'double' && !Number.isFinite(r)) return Option.none();
    return Option.some({ kind: outKind, value: r });
  };

const mathBuiltins = {
  sum: listFunction(sum),
  product: listFunction(product),
  difference: listFunction(
    binary(
      (a, b) => Option.some(a - b),
      (a, b) => a - b,
    ),
    2,
  ),
  quotient: listFunction(
    binary(noInteger, (a, b) => a / b, true),
    2,
  ),
  integerQuotient: listFunction((ns) => {
    // `listFunction(f, 2)` only calls `f` with two numbers.
    const [a, b] = ns.map(asNumber);
    return a === undefined || b === undefined || b === 0
      ? Option.none()
      : Option.some({ kind: 'integer', value: BigInt(Math.trunc(a / b)) });
  }, 2),
  remainder: listFunction((ns) => {
    // `listFunction(f, 2)` only calls `f` with two numbers.
    const [a, b] = ns;
    if (a?.kind !== 'integer' || b?.kind !== 'integer' || b.value === 0n) return Option.none();
    // The result has the sign of the divisor (floored division).
    return Option.some({ kind: 'integer', value: ((a.value % b.value) + b.value) % b.value });
  }, 2),
  exponentiation: listFunction(
    binary(
      (a, b) => (b >= 0n ? Option.some(a ** b) : Option.none()),
      (a, b) => a ** b,
    ),
    2,
  ),
  negation: unaryFunction(
    (n) =>
      n.kind === 'integer' ? { kind: n.kind, value: -n.value } : { kind: n.kind, value: -n.value },
    (n) =>
      n.kind === 'integer' ? { kind: n.kind, value: -n.value } : { kind: n.kind, value: -n.value },
  ),
  absoluteValue: unaryFunction((n) =>
    n.kind === 'integer'
      ? { kind: n.kind, value: n.value < 0n ? -n.value : n.value }
      : { kind: n.kind, value: Math.abs(n.value) },
  ),
  rounded: unaryFunction((n) =>
    n.kind === 'integer' ? n : { kind: n.kind, value: Math.round(n.value) },
  ),
  floor: unaryFunction((n) => ({ kind: 'integer', value: BigInt(Math.floor(asNumber(n))) })),
  ceiling: unaryFunction((n) => ({ kind: 'integer', value: BigInt(Math.ceil(asNumber(n))) })),
  sin: unaryFunction(real(Math.sin), real(Math.asin)),
  cos: unaryFunction(real(Math.cos), real(Math.acos)),
  tan: unaryFunction(real(Math.tan), real(Math.atan)),
  asin: unaryFunction(real(Math.asin), real(Math.sin)),
  acos: unaryFunction(real(Math.acos), real(Math.cos)),
  atan: unaryFunction(real(Math.atan), real(Math.tan)),
  sinh: unaryFunction(real(Math.sinh), real(Math.asinh)),
  cosh: unaryFunction(real(Math.cosh)),
  tanh: unaryFunction(real(Math.tanh), real(Math.atanh)),
  degrees: unaryFunction(
    real((x) => (x * 180) / Math.PI),
    real((x) => (x * Math.PI) / 180),
  ),
  greaterThan: comparison((c) => c > 0),
  lessThan: comparison((c) => c < 0),
  notGreaterThan: comparison((c) => c <= 0),
  notLessThan: comparison((c) => c >= 0),
  equalTo: comparison((c) => c === 0),
  notEqualTo: comparison((c) => !(c === 0)),
} satisfies Record.ReadonlyRecord<string, Builtin>;

// -----------------------------------------------------------------------------
// Strings
// -----------------------------------------------------------------------------

/** The XPath string value of a literal (numbers and booleans in canonical form). */
const literalString = (t: Term.Literal): string => {
  const dt = t.datatype.value;
  if (dt === xsd.boolean.value) return t.value === '1' || t.value === 'true' ? 'true' : 'false';
  if (dt !== Term.XSD_STRING && Xsd.isNumericDatatype(dt)) {
    const num = toNum(t);
    if (Option.isSome(num)) {
      const n = num.value;
      if (n.kind === 'integer') return n.value.toString();
      if (Number.isNaN(n.value)) return 'NaN';
      if (!Number.isFinite(n.value)) return n.value > 0 ? 'INF' : '-INF';
      return String(n.value);
    }
  }
  return t.value;
};

/** The XPath string value of a term: of a literal or an IRI. */
const str = (t: Model.N3Term): Option.Option<string> =>
  Guards.isLiteral(t)
    ? Option.some(literalString(t))
    : Guards.isNamedNode(t)
      ? Option.some(t.value)
      : Option.none();

const stringTest =
  (test: (a: string, b: string) => boolean): Builtin =>
  (s, o, b) => {
    if (!ready(s) || !ready(o)) return notReady;
    const x = str(s);
    const y = str(o);
    return solutions(Option.isSome(x) && Option.isSome(y) && test(x.value, y.value) ? [b] : []);
  };

const stringsOf = (t: Model.N3Term): Option.Option<Array<string>> =>
  Model.isCollection(t) ? Option.all(t.items.map(str)) : Option.none();

const stringFunction =
  (f: (args: Array<string>) => Option.Option<string>): Builtin =>
  (s, o, b, ctx) => {
    if (!ready(s)) return notReady;
    const r = Option.flatMap(stringsOf(s), f);
    return solutions(Option.isNone(r) ? [] : ctx.unify(o, Term.literal(r.value), b));
  };

const regex = (pattern: string, flags = ''): Option.Option<RegExp> =>
  Result.getSuccess(Result.try(() => new RegExp(pattern, flags)));

const stringBuiltins = {
  concatenation: stringFunction((args) => Option.some(args.join(''))),
  contains: stringTest((a, b) => a.includes(b)),
  containsIgnoringCase: stringTest((a, b) => a.toLowerCase().includes(b.toLowerCase())),
  startsWith: stringTest((a, b) => a.startsWith(b)),
  endsWith: stringTest((a, b) => a.endsWith(b)),
  equalIgnoringCase: stringTest((a, b) => a.toLowerCase() === b.toLowerCase()),
  notEqualIgnoringCase: stringTest((a, b) => a.toLowerCase() !== b.toLowerCase()),
  greaterThan: stringTest((a, b) => a > b),
  lessThan: stringTest((a, b) => a < b),
  notGreaterThan: stringTest((a, b) => a <= b),
  notLessThan: stringTest((a, b) => a >= b),
  matches: stringTest((a, b) => Option.exists(regex(b), (re) => re.test(a))),
  notMatches: stringTest(
    (a, b) => !Option.match(regex(b), { onNone: () => true, onSome: (re) => re.test(a) }),
  ),
  replace: stringFunction(([s, p, r]) => {
    if (s === undefined || p === undefined || r === undefined) return Option.none();
    return Option.map(regex(p, 'g'), (re) => s.replace(re, r.replace(/\\(\d)/g, '$$$1')));
  }),
  scrape: stringFunction(([s, p]) => {
    if (s === undefined || p === undefined) return Option.none();
    return Option.flatMap(regex(p), (re) => Option.fromUndefinedOr(re.exec(s)?.[1]));
  }),
  format: stringFunction(([fmt, ...args]) => {
    if (fmt === undefined) return Option.none();
    let i = 0;
    return Option.some(fmt.replace(/%s/g, () => args[i++] ?? ''));
  }),
} satisfies Record.ReadonlyRecord<string, Builtin>;

// -----------------------------------------------------------------------------
// Lists
// -----------------------------------------------------------------------------

/** The two items of a two-item collection. */
const pairOf = (t: Model.N3Term): Option.Option<readonly [Model.N3Term, Model.N3Term]> => {
  if (!Model.isCollection(t)) return Option.none();
  const [x, y] = t.items;
  return t.items.length === 2 && x !== undefined && y !== undefined
    ? Option.some([x, y])
    : Option.none();
};

/** The three items of a three-item collection. */
const tripleOf = (
  t: Model.N3Term,
): Option.Option<readonly [Model.N3Term, Model.N3Term, Model.N3Term]> => {
  if (!Model.isCollection(t)) return Option.none();
  const [x, y, z] = t.items;
  return t.items.length === 3 && x !== undefined && y !== undefined && z !== undefined
    ? Option.some([x, y, z])
    : Option.none();
};

const noSolutions = (): Array<Bindings> => [];

const integerLiteral = (n: number): Term.Literal => Term.literal(String(n), xsd.integer);

const listBuiltins = {
  in: (s, o, b, ctx) => {
    if (!Model.isCollection(o)) return noneOnceReady(o);
    return solutions(o.items.flatMap((item) => ctx.unify(s, item, b)));
  },
  member: (s, o, b, ctx) => {
    if (!Model.isCollection(s)) return noneOnceReady(s);
    return solutions(s.items.flatMap((item) => ctx.unify(o, item, b)));
  },
  length: (s, o, b, ctx) =>
    !Model.isCollection(s)
      ? noneOnceReady(s)
      : output(o, Option.some(integerLiteral(s.items.length)), b, ctx),
  first: (s, o, b, ctx) =>
    !Model.isCollection(s)
      ? noneOnceReady(s)
      : output(o, Option.fromUndefinedOr(s.items[0]), b, ctx),
  last: (s, o, b, ctx) =>
    !Model.isCollection(s)
      ? noneOnceReady(s)
      : output(o, Option.fromUndefinedOr(s.items.at(-1)), b, ctx),
  rest: (s, o, b, ctx) =>
    !Model.isCollection(s) || Arr.isReadonlyArrayEmpty(s.items)
      ? noneOnceReady(s)
      : solutions(ctx.unify(o, new Model.Collection(s.items.slice(1)), b)),
  append: (s, o, b, ctx) => {
    if (!ready(s)) return notReady;
    if (!Model.isCollection(s) || !s.items.every(Model.isCollection)) return solutions([]);
    return solutions(
      ctx.unify(
        o,
        new Model.Collection(s.items.flatMap((l) => (Model.isCollection(l) ? l.items : []))),
        b,
      ),
    );
  },
  iterate: (s, o, b, ctx) => {
    if (!Model.isCollection(s)) return noneOnceReady(s);
    return solutions(
      s.items.flatMap((item, i) =>
        ctx.unify(o, new Model.Collection([integerLiteral(i), item]), b),
      ),
    );
  },
  memberAt: (s, o, b, ctx) => {
    if (!ready(s)) return notReady;
    const found = Option.flatMap(pairOf(s), ([l, idx]) =>
      Model.isCollection(l)
        ? Option.map(toNum(idx), (n) => Option.fromUndefinedOr(l.items[asNumber(n)]))
        : Option.none(),
    );
    return Option.isNone(found) ? solutions([]) : output(o, found.value, b, ctx);
  },
  remove: (s, o, b, ctx) => {
    if (!ready(s)) return notReady;
    return solutions(
      Option.match(pairOf(s), {
        onNone: noSolutions,
        onSome: ([l, x]) =>
          Model.isCollection(l)
            ? ctx.unify(o, new Model.Collection(l.items.filter((i) => i.key !== x.key)), b)
            : [],
      }),
    );
  },
} satisfies Record.ReadonlyRecord<string, Builtin>;

// -----------------------------------------------------------------------------
// Log
// -----------------------------------------------------------------------------

const scopeOf = (t: Model.N3Term, ctx: Context): Option.Option<Model.Formula> =>
  Model.isFormula(t)
    ? Option.some(t)
    : Guards.isLiteral(t) && t.key === TRUE.key
      ? Option.some(Model.emptyFormula)
      : Guards.isBlankNode(t)
        ? Option.some(ctx.document())
        : Option.none();

const noGoals: ReadonlyArray<Model.Statement> = [];

const goalsOf = (t: Model.N3Term): Option.Option<ReadonlyArray<Model.Statement>> =>
  Model.isFormula(t)
    ? Option.some(t.statements)
    : t.key === TRUE.key
      ? Option.some(noGoals)
      : Option.none();

/**
 * `log:includes` / `log:notIncludes`: queries the subject formula for the
 * object's statements and maps the solutions with `answer`. An unbound or
 * non-formula operand gives no solutions once the subject is ground, and is
 * not ready otherwise.
 */
const included = (
  s: Model.N3Term,
  o: Model.N3Term,
  b: Bindings,
  ctx: Context,
  answer: (found: Array<Bindings>) => Array<Bindings>,
): Answer => {
  const scope = scopeOf(s, ctx);
  const goals = goalsOf(o);
  if (Option.isNone(scope) || Option.isNone(goals)) return noneOnceReady(s);
  return solutions(answer(ctx.query(scope.value, goals.value, b, false)));
};

const logBuiltins = {
  equalTo: (s, o, b, ctx) => solutions(ctx.unify(s, o, b)),
  notEqualTo: (s, o, b) =>
    !ready(s) || !ready(o) ? notReady : solutions(s.key !== o.key ? [b] : []),
  includes: (s, o, b, ctx) => included(s, o, b, ctx, (found) => found),
  notIncludes: (s, o, b, ctx) =>
    included(s, o, b, ctx, (found) => (Arr.isReadonlyArrayEmpty(found) ? [b] : [])),
  conjunction: (s, o, b, ctx) => {
    if (!ready(s)) return notReady;
    if (!Model.isCollection(s)) return solutions([]);
    const parts = Option.all(s.items.map(goalsOf));
    if (Option.isNone(parts)) return solutions([]);
    return solutions(ctx.unify(o, new Model.Formula(parts.value.flat()), b));
  },
  conclusion: (s, o, b, ctx) => {
    const f = s.key === TRUE.key ? Model.emptyFormula : s;
    if (!Model.isFormula(f)) return noneOnceReady(s);
    return solutions(ctx.unify(o, ctx.conclusion(f), b));
  },
  uri: (s, o, b, ctx) => {
    if (Guards.isNamedNode(s)) return solutions(ctx.unify(o, Term.literal(s.value), b));
    if (Guards.isLiteral(o)) return solutions(ctx.unify(s, Term.namedNode(o.value), b));
    return noneOnceReady(s);
  },
  dtlit: (s, o, b, ctx) => {
    const pair = pairOf(s);
    if (Option.isSome(pair) && ready(s)) {
      const [lex, dt] = pair.value;
      if (!Guards.isLiteral(lex) || !Guards.isNamedNode(dt)) return solutions([]);
      return solutions(ctx.unify(o, Term.literal(lex.value, dt), b));
    }
    if (Guards.isLiteral(o)) {
      return solutions(ctx.unify(s, new Model.Collection([Term.literal(o.value), o.datatype]), b));
    }
    return notReady;
  },
  langlit: (s, o, b, ctx) => {
    const pair = pairOf(s);
    if (Option.isSome(pair) && ready(s)) {
      const [lex, lang] = pair.value;
      if (!Guards.isLiteral(lex) || !Guards.isLiteral(lang)) return solutions([]);
      return solutions(ctx.unify(o, Term.literal(lex.value, lang.value), b));
    }
    if (Guards.isLiteral(o) && o.language !== '') {
      return solutions(
        ctx.unify(s, new Model.Collection([Term.literal(o.value), Term.literal(o.language)]), b),
      );
    }
    return notReady;
  },
  rawType: (s, o, b, ctx) => {
    if (!ready(s)) return notReady;
    const type = Model.isFormula(s)
      ? log.Formula
      : Guards.isLiteral(s)
        ? log.Literal
        : Model.isCollection(s)
          ? log.List
          : log.Other;
    return solutions(ctx.unify(o, type, b));
  },
  collectAllIn: (s, o, b, ctx) =>
    solutions(
      Option.match(
        Option.flatMap(tripleOf(s), ([template, where, result]) =>
          Option.map(Option.all([scopeOf(o, ctx), goalsOf(where)]), ([scope, goals]) => ({
            template,
            result,
            scope,
            goals,
          })),
        ),
        {
          onNone: noSolutions,
          onSome: ({ template, result, scope, goals }) => {
            const values = ctx
              .query(scope, goals, b, true)
              .map((sol) => Model.substitute(template, sol));
            return ctx.unify(result, new Model.Collection(values), b);
          },
        },
      ),
    ),
  forAllIn: (s, o, b, ctx) =>
    solutions(
      Option.match(
        Option.flatMap(pairOf(s), ([w, t]) => {
          const where = goalsOf(w);
          const then = goalsOf(t);
          return Option.all([scopeOf(o, ctx), where, then]);
        }),
        {
          onNone: noSolutions,
          onSome: ([scope, where, then]) =>
            ctx
              .query(scope, where, b, true)
              .every((sol) => Arr.isReadonlyArrayNonEmpty(ctx.query(scope, then, sol, true)))
              ? [b]
              : [],
        },
      ),
    ),
} satisfies Record.ReadonlyRecord<string, Builtin>;

const table = MutableHashMap.empty<string, Builtin>();
const namespaces: ReadonlyArray<readonly [string, Record.ReadonlyRecord<string, Builtin>]> = [
  [math.base, mathBuiltins],
  [string.base, stringBuiltins],
  [list.base, listBuiltins],
  [log.base, logBuiltins],
];
namespaces.forEach(([ns, builtins]) => {
  Record.toEntries(builtins).forEach(([name, f]) => MutableHashMap.set(table, ns + name, f));
});

/** @internal */
export const builtinFor = (predicate: Model.N3Term): Option.Option<Builtin> =>
  Guards.isNamedNode(predicate) ? MutableHashMap.get(table, predicate.value) : Option.none();

/** The IRIs of all supported builtins. @internal */
export const builtinIris: ReadonlyArray<string> = Arr.fromIterable(MutableHashMap.keys(table));
