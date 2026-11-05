/**
 * Value-level helpers for expression evaluation: numeric type promotion and
 * arithmetic, comparisons, effective boolean value and the ORDER BY term
 * ordering.
 *
 * Errors are signalled by throwing `EvalFailure` (a cheap, stack-less
 * object); the public API converts them to `ExpressionError`s.
 *
 * @internal
 */
import * as BigDecimal from 'effect/BigDecimal';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Str from 'effect/String';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';
import { loop } from './loop.ts';
import * as StringMap from './stringMap.ts';

export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** A thrown expression evaluation error. */
export class EvalFailure {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/**
 * Runs `f`, returning a thrown `EvalFailure` (an expression error) as the
 * failure; any other exception is a defect and propagates.
 */
export const catchEvalFailure = <A>(f: () => A): Result.Result<A, EvalFailure> =>
  Result.try({
    try: f,
    catch: (cause) => {
      if (cause instanceof EvalFailure) return cause;
      throw cause;
    },
  });

export const fail = (message: string): never => {
  throw new EvalFailure(message);
};

export const dt = {
  string: Term.namedNode(`${XSD}string`),
  boolean: Term.namedNode(`${XSD}boolean`),
  integer: Term.namedNode(`${XSD}integer`),
  decimal: Term.namedNode(`${XSD}decimal`),
  float: Term.namedNode(`${XSD}float`),
  double: Term.namedNode(`${XSD}double`),
  dateTime: Term.namedNode(`${XSD}dateTime`),
  dayTimeDuration: Term.namedNode(`${XSD}dayTimeDuration`),
  langString: Term.namedNode(`${RDF}langString`),
  dirLangString: Term.namedNode(`${RDF}dirLangString`),
} as const;

export const TRUE = new Term.Literal('true', dt.boolean);
export const FALSE = new Term.Literal('false', dt.boolean);
export const bool = (b: boolean): Term.Literal => (b ? TRUE : FALSE);

// -----------------------------------------------------------------------------
// Literal kinds
// -----------------------------------------------------------------------------

export const isLiteral = (t: Term.Term): t is Term.Literal => Term.isLiteral(t);

/** A simple literal or `xsd:string` (no language tag). */
export const isSimpleString = (t: Term.Term): t is Term.Literal =>
  Term.isLiteral(t) && t.language === '' && t.datatype.value === Term.XSD_STRING;

/** A string literal: simple, `xsd:string` or language-tagged. */
export const isStringLiteral = (t: Term.Term): t is Term.Literal =>
  Term.isLiteral(t) && (t.language !== '' || t.datatype.value === Term.XSD_STRING);

export const stringLike = (value: string, like: Term.Literal): Term.Literal =>
  like.language === ''
    ? new Term.Literal(value, dt.string)
    : like.direction === undefined
      ? new Term.Literal(value, dt.langString, like.language)
      : new Term.Literal(value, dt.dirLangString, like.language, like.direction);

export const simple = (value: string): Term.Literal => new Term.Literal(value, dt.string);

// -----------------------------------------------------------------------------
// Numerics
// -----------------------------------------------------------------------------

export type Num =
  | { readonly kind: 0; readonly v: bigint }
  | { readonly kind: 1; readonly v: BigDecimal.BigDecimal }
  | { readonly kind: 2; readonly v: number }
  | { readonly kind: 3; readonly v: number };

export const INTEGER = 0;
export const DECIMAL = 1;
export const FLOAT = 2;
export const DOUBLE = 3;

/** The numeric value of each literal met, `None` for a non-numeric one. */
const numCache = new WeakMap<Term.Literal, Option.Option<Num>>();

const numOfValue = (v: Xsd.Value): Option.Option<Num> =>
  Predicate.isTagged(v, 'Integer')
    ? Option.some({ kind: 0, v: v.value })
    : Predicate.isTagged(v, 'Decimal')
      ? Option.some({ kind: 1, v: v.value })
      : Predicate.isTagged(v, 'Float')
        ? Option.some({ kind: 2, v: v.value })
        : Predicate.isTagged(v, 'Double')
          ? Option.some({ kind: 3, v: v.value })
          : Option.none();

/** The numeric value of a literal, `None` if it is not a valid numeric literal. */
export const numeric = (t: Term.Term): Option.Option<Num> => {
  if (!Term.isLiteral(t) || t.language !== '') return Option.none();
  const cached = numCache.get(t);
  if (cached !== undefined) return cached;
  const d = t.datatype.value;
  const result =
    Xsd.isNumericDatatype(d) && Xsd.isValidLexical(d, t.value)
      ? numOfValue(Xsd.toValue(t))
      : Option.none();
  numCache.set(t, result);
  return result;
};

export const isNumeric = (t: Term.Term): boolean => Option.isSome(numeric(t));

export const toNumber = (n: Num): number =>
  n.kind === 0 ? Number(n.v) : n.kind === 1 ? BigDecimal.toNumberUnsafe(n.v) : n.v;

export const toDecimal = (n: Num): BigDecimal.BigDecimal =>
  n.kind === 0 ? BigDecimal.fromBigInt(n.v) : n.kind === 1 ? n.v : fail('Not a decimal');

/** Promotes a numeric value to (at least) the given kind. */
export const promote = (n: Num, kind: number): Num => {
  if (n.kind >= kind) return n;
  return kind === DECIMAL
    ? { kind: 1, v: toDecimal(n) }
    : kind === FLOAT
      ? { kind: 2, v: Math.fround(toNumber(n)) }
      : { kind: 3, v: toNumber(n) };
};

export const numLiteral = (n: Num): Term.Literal =>
  n.kind === 0
    ? new Term.Literal(n.v.toString(), dt.integer)
    : n.kind === 1
      ? new Term.Literal(Xsd.canonicalDecimal(n.v), dt.decimal)
      : n.kind === 2
        ? new Term.Literal(Xsd.canonicalDouble(Math.fround(n.v)), dt.float)
        : new Term.Literal(Xsd.canonicalDouble(n.v), dt.double);

/** The numeric value of a literal; an evaluation error if it has none. */
export const requireNum = (t: Term.Term): Num => {
  const n = numeric(t);
  return Option.isSome(n) ? n.value : fail('Expected a numeric literal');
};

const DIVISION_SCALE = 18;

/** `op` on two values already promoted to the common `kind`. */
const arithmeticAt = (kind: number, op: '+' | '-' | '*' | '/', px: Num, py: Num): Term.Literal => {
  if (px.kind === 0 && py.kind === 0) {
    const u = px.v;
    const v = py.v;
    return numLiteral({ kind: 0, v: op === '+' ? u + v : op === '-' ? u - v : u * v });
  }
  if (px.kind === 1 && py.kind === 1) {
    const u = px.v;
    const v = py.v;
    if (op === '/') {
      if (BigDecimal.isZero(v)) return fail('Division by zero');
      return numLiteral({ kind: 1, v: divideDecimal(u, v) });
    }
    return numLiteral({
      kind: 1,
      v:
        op === '+'
          ? BigDecimal.sum(u, v)
          : op === '-'
            ? BigDecimal.subtract(u, v)
            : BigDecimal.multiply(u, v),
    });
  }
  // The remaining kinds (float, double) carry a JS `number`.
  const u = toNumber(px);
  const v = toNumber(py);
  const r = op === '+' ? u + v : op === '-' ? u - v : op === '*' ? u * v : u / v;
  return numLiteral(kind === FLOAT ? { kind: 2, v: Math.fround(r) } : { kind: 3, v: r });
};

export const arithmetic = (op: '+' | '-' | '*' | '/', a: Term.Term, b: Term.Term): Term.Literal => {
  const x = requireNum(a);
  const y = requireNum(b);
  let kind = Math.max(x.kind, y.kind);
  if (op === '/' && kind === INTEGER) kind = DECIMAL;
  const px = promote(x, kind);
  const py = promote(y, kind);
  return arithmeticAt(kind, op, px, py);
};

/** Decimal division with a fixed number of fractional digits (rounded half-even). */
export const divideDecimal = (
  u: BigDecimal.BigDecimal,
  v: BigDecimal.BigDecimal,
): BigDecimal.BigDecimal => {
  const exact = BigDecimal.divide(u, v);
  const scaled = BigDecimal.round(
    Option.getOrElse(exact, () => BigDecimal.fromBigInt(0n)),
    {
      scale: DIVISION_SCALE,
      mode: 'half-even',
    },
  );
  return BigDecimal.normalize(scaled);
};

export const negate = (a: Term.Term): Term.Literal => {
  return negateNum(requireNum(a));
};

const negateNum = (x: Num): Term.Literal =>
  numLiteral(
    x.kind === 0
      ? { kind: 0, v: -x.v }
      : x.kind === 1
        ? { kind: 1, v: BigDecimal.negate(x.v) }
        : x.kind === 2
          ? { kind: 2, v: -x.v }
          : { kind: 3, v: -x.v },
  );

/** Compares two numerics; returns NaN when unordered (NaN operands). */
export const compareNum = (x: Num, y: Num): number => {
  const kind = Math.max(x.kind, y.kind);
  if (kind <= DECIMAL) {
    if (x.kind === 0 && y.kind === 0) {
      const u = x.v;
      const v = y.v;
      return u < v ? -1 : u > v ? 1 : 0;
    }
    const u = toDecimal(x);
    const v = toDecimal(y);
    return BigDecimal.isLessThan(u, v) ? -1 : BigDecimal.isGreaterThan(u, v) ? 1 : 0;
  }
  const u = toNumber(promote(x, kind));
  const v = toNumber(promote(y, kind));
  if (Number.isNaN(u) || Number.isNaN(v)) return NaN;
  return u < v ? -1 : u > v ? 1 : 0;
};

// -----------------------------------------------------------------------------
// Date/time and durations
// -----------------------------------------------------------------------------

const DATE_KINDS: ReadonlyMap<string, true> = StringMap.setOf([
  'dateTime',
  'dateTimeStamp',
  'date',
  'time',
  'gYear',
  'gYearMonth',
  'gMonth',
  'gMonthDay',
  'gDay',
]);

interface DateValue {
  readonly kind: string;
  readonly millis: number;
  /** Whether the value has a timezone. */
  readonly zoned: boolean;
}

export const dateValue = (t: Term.Term): Option.Option<DateValue> => {
  if (!Term.isLiteral(t) || !t.datatype.value.startsWith(XSD)) return Option.none();
  const local = t.datatype.value.slice(XSD.length);
  if (!DATE_KINDS.has(local) || !Xsd.isValidLexical(t.datatype.value, t.value)) {
    return Option.none();
  }
  const v = Xsd.toValue(t);
  if (!Predicate.isTagged(v, 'DateTime')) return Option.none();
  return Option.some({
    kind: local === 'dateTimeStamp' ? 'dateTime' : local,
    millis: v.epochMillis,
    zoned: v.timezone !== undefined,
  });
};

const FOURTEEN_HOURS = 14 * 3600 * 1000;

const BEFORE = Option.some(-1);
const SAME = Option.some(0);
const AFTER = Option.some(1);

/** Compares two date/time values of the same kind; `None` if indeterminate. */
export const compareDates = (a: DateValue, b: DateValue): Option.Option<number> => {
  if (a.kind !== b.kind) return Option.none();
  if (a.zoned !== b.zoned) {
    const diff = a.millis - b.millis;
    if (Math.abs(diff) <= FOURTEEN_HOURS) return Option.none();
    return diff < 0 ? BEFORE : AFTER;
  }
  return a.millis < b.millis ? BEFORE : a.millis > b.millis ? AFTER : SAME;
};

interface DurationValue {
  readonly kind: string;
  readonly months: number;
  readonly seconds: number;
}

export const durationValue = (t: Term.Term): Option.Option<DurationValue> => {
  if (!Term.isLiteral(t)) return Option.none();
  const d = t.datatype.value;
  if (d !== `${XSD}duration` && d !== `${XSD}dayTimeDuration` && d !== `${XSD}yearMonthDuration`) {
    return Option.none();
  }
  if (!Xsd.isValidLexical(d, t.value)) return Option.none();
  const v = Xsd.toValue(t);
  return Predicate.isTagged(v, 'Duration')
    ? Option.some({ kind: d.slice(XSD.length), months: v.months, seconds: v.seconds })
    : Option.none();
};

// -----------------------------------------------------------------------------
// Strings
// -----------------------------------------------------------------------------

/** Compares strings by Unicode code points. */
export const compareCodepoints = (a: string, b: string): number => {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  // The first offset where the strings differ (`n` if one is a prefix of the other).
  let i = 0;
  loop(() => {
    if (i >= n || a.charCodeAt(i) !== b.charCodeAt(i)) return false;
    i++;
    return true;
  });
  if (i < n) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
};

// -----------------------------------------------------------------------------
// Equality and ordering
// -----------------------------------------------------------------------------

const isBooleanLiteral = (t: Term.Term): t is Term.Literal =>
  Term.isLiteral(t) &&
  t.datatype.value === `${XSD}boolean` &&
  Xsd.isValidLexical(t.datatype.value, t.value);

const booleanValue = (t: Term.Literal): boolean => t.value === 'true' || t.value === '1';

/**
 * Compares two literals by value (for `<`, `>`, …). Returns a number (NaN for
 * unordered) or throws if they are not comparable.
 */
export const compareLiterals = (a: Term.Term, b: Term.Term): number => {
  const x = numeric(a);
  const y = numeric(b);
  if (Option.isSome(x) && Option.isSome(y)) return compareNum(x.value, y.value);
  if (isSimpleString(a) && isSimpleString(b)) return compareCodepoints(a.value, b.value);
  if (
    Term.isLiteral(a) &&
    Term.isLiteral(b) &&
    a.language !== '' &&
    a.language === b.language &&
    a.direction === b.direction
  ) {
    return compareCodepoints(a.value, b.value);
  }
  if (isBooleanLiteral(a) && isBooleanLiteral(b)) {
    return Number(booleanValue(a)) - Number(booleanValue(b));
  }
  const da = dateValue(a);
  const db = dateValue(b);
  if (Option.isSome(da) && Option.isSome(db)) {
    const c = compareDates(da.value, db.value);
    if (Option.isSome(c)) return c.value;
    return fail('Indeterminate date comparison');
  }
  const ua = durationValue(a);
  const ub = durationValue(b);
  if (Option.isSome(ua) && Option.isSome(ub)) {
    const u = ua.value;
    const v = ub.value;
    if (u.months === v.months) return Math.sign(u.seconds - v.seconds);
    if (u.seconds === v.seconds) return Math.sign(u.months - v.months);
    return fail('Indeterminate duration comparison');
  }
  return fail('Incomparable values');
};

const isKnownLiteral = (t: Term.Literal): boolean =>
  t.language !== '' || Xsd.isKnownDatatype(t.datatype.value);

/** RDF term equality with value semantics (`=`). Throws on type errors. */
export const equals = (a: Term.Term, b: Term.Term): boolean => {
  const ta = Term.isTriple(a);
  const tb = Term.isTriple(b);
  if (ta || tb) {
    if (!ta || !tb) return false;
    return (
      equals(a.subject, b.subject) && equals(a.predicate, b.predicate) && equals(a.object, b.object)
    );
  }
  if (!Term.isLiteral(a) || !Term.isLiteral(b)) return a.key === b.key;
  const x = numeric(a);
  const y = numeric(b);
  if (Option.isSome(x) && Option.isSome(y)) return compareNum(x.value, y.value) === 0;
  if (a.key === b.key) return true;
  if (isSimpleString(a) && isSimpleString(b)) return a.value === b.value;
  if (isBooleanLiteral(a) && isBooleanLiteral(b)) return booleanValue(a) === booleanValue(b);
  const da = dateValue(a);
  const db = dateValue(b);
  if (Option.isSome(da) && Option.isSome(db)) {
    if (da.value.kind !== db.value.kind) return false;
    const c = compareDates(da.value, db.value);
    if (Option.isNone(c)) return fail('Indeterminate date comparison');
    return c.value === 0;
  }
  const ua = durationValue(a);
  const ub = durationValue(b);
  if (Option.isSome(ua) && Option.isSome(ub)) {
    return ua.value.months === ub.value.months && ua.value.seconds === ub.value.seconds;
  }
  if (a.language !== '' || b.language !== '') {
    // Language-tagged strings are equal only when they are the same term.
    return false;
  }
  // Both literals with known, value-disjoint datatypes are unequal; anything
  // else (unknown datatypes, ill-formed values) is a type error.
  if (
    isKnownLiteral(a) &&
    isKnownLiteral(b) &&
    Xsd.isWellFormed(a) &&
    Xsd.isWellFormed(b) &&
    a.datatype.value !== b.datatype.value
  ) {
    return false;
  }
  return fail('Cannot compare literals');
};

/** Effective boolean value. */
const numEbv = (n: Num): boolean =>
  n.kind === 0
    ? n.v !== 0n
    : n.kind === 1
      ? !BigDecimal.isZero(n.v)
      : !(n.v === 0 || Number.isNaN(n.v));

export const ebv = (t: Term.Term): boolean => {
  if (!Term.isLiteral(t)) return fail('EBV of a non-literal');
  const d = t.datatype.value;
  if (d === `${XSD}boolean`) {
    if (!Xsd.isValidLexical(d, t.value)) return fail('Invalid boolean');
    return booleanValue(t);
  }
  if (t.language === '' && d === Term.XSD_STRING) return Str.isNonEmpty(t.value);
  if (Xsd.isNumericDatatype(d)) {
    const n = numeric(t);
    return Option.isSome(n) && numEbv(n.value);
  }
  return fail('EBV is not defined for this literal');
};

/** The `ORDER BY` rank of a bound term: blank nodes < IRIs < literals < triple terms. */
const termRank = (t: Term.Term): number =>
  Term.isBlankNode(t)
    ? 1
    : Term.isNamedNode(t)
      ? 2
      : Term.isLiteral(t)
        ? 3
        : Term.isTriple(t)
          ? 4
          : 5;

/** Orders two literals: by value where comparable, else syntactically. */
const compareLiteralOrder = (a: Term.Literal, l: Term.Literal): number => {
  // Where the values cannot be compared, fall through to the syntactic
  // ordering.
  const compared = Result.try(() => compareLiterals(a, l));
  if (Result.isSuccess(compared)) {
    const c = compared.success;
    if (!Number.isNaN(c) && c !== 0) return c;
    if (c === 0 && a.key === l.key) return 0;
  }
  // Simple literals before language-tagged before other typed literals.
  const ka = a.language !== '' ? 1 : a.datatype.value === Term.XSD_STRING ? 0 : 2;
  const kb = l.language !== '' ? 1 : l.datatype.value === Term.XSD_STRING ? 0 : 2;
  if (ka !== kb) return ka - kb;
  return (
    compareCodepoints(a.datatype.value, l.datatype.value) ||
    compareCodepoints(a.language, l.language) ||
    compareCodepoints(a.value, l.value)
  );
};

/**
 * The total ordering used by `ORDER BY` on bound terms: blank nodes < IRIs <
 * literals < triple terms; literals are ordered by value where comparable
 * and otherwise by datatype, language and lexical form.
 */
export const compareTerms = (a: Term.Term, b: Term.Term): number => {
  const ra = termRank(a);
  const rb = termRank(b);
  if (ra !== rb) return ra - rb;
  if (Term.isLiteral(a) && Term.isLiteral(b)) return compareLiteralOrder(a, b);
  if (Term.isTriple(a) && Term.isTriple(b)) {
    return (
      compareTerms(a.subject, b.subject) ||
      compareTerms(a.predicate, b.predicate) ||
      compareTerms(a.object, b.object)
    );
  }
  if (
    (Term.isBlankNode(a) || Term.isNamedNode(a)) &&
    (Term.isBlankNode(b) || Term.isNamedNode(b))
  ) {
    return compareCodepoints(a.value, b.value);
  }
  return 0;
};

/** `compareTerms` on possibly unbound terms (`None`), with unbound first. */
export const orderCompare = (a: Option.Option<Term.Term>, b: Option.Option<Term.Term>): number =>
  Option.isNone(a)
    ? Option.isNone(b)
      ? 0
      : -1
    : Option.isNone(b)
      ? 1
      : compareTerms(a.value, b.value);
