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
import * as Str from 'effect/String';
import * as BigDecimal from 'effect/BigDecimal';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';

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

export const isLiteral = (t: Term.Term): t is Term.Literal => t._tag === 'Literal';

/** A simple literal or `xsd:string` (no language tag). */
export const isSimpleString = (t: Term.Term): t is Term.Literal =>
  t._tag === 'Literal' && t.language === '' && t.datatype.value === Term.XSD_STRING;

/** A string literal: simple, `xsd:string` or language-tagged. */
export const isStringLiteral = (t: Term.Term): t is Term.Literal =>
  t._tag === 'Literal' && (t.language !== '' || t.datatype.value === Term.XSD_STRING);

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

const numCache = new WeakMap<Term.Literal, Num | null>();

/** The numeric value of a literal, or `undefined` if it is not a valid numeric literal. */
export const numeric = (t: Term.Term): Num | undefined => {
  if (t._tag !== 'Literal' || t.language !== '') return undefined;
  const cached = numCache.get(t);
  if (cached !== undefined) return cached ?? undefined;
  let result: Num | undefined;
  const d = t.datatype.value;
  if (Xsd.isNumericDatatype(d) && Xsd.isValidLexical(d, t.value)) {
    const v = Xsd.toValue(t);
    switch (v._tag) {
      case 'Integer':
        result = { kind: 0, v: v.value };
        break;
      case 'Decimal':
        result = { kind: 1, v: v.value };
        break;
      case 'Float':
        result = { kind: 2, v: v.value };
        break;
      case 'Double':
        result = { kind: 3, v: v.value };
        break;
      default:
        result = undefined;
    }
  }
  numCache.set(t, result ?? null);
  return result;
};

export const isNumeric = (t: Term.Term): boolean => numeric(t) !== undefined;

export const toNumber = (n: Num): number =>
  n.kind === 0 ? Number(n.v) : n.kind === 1 ? BigDecimal.toNumberUnsafe(n.v) : n.v;

export const toDecimal = (n: Num): BigDecimal.BigDecimal =>
  n.kind === 0 ? BigDecimal.fromBigInt(n.v) : n.kind === 1 ? n.v : fail('Not a decimal');

/** Promotes a numeric value to (at least) the given kind. */
export const promote = (n: Num, kind: number): Num => {
  if (n.kind >= kind) return n;
  switch (kind) {
    case DECIMAL:
      return { kind: 1, v: toDecimal(n) };
    case FLOAT:
      return { kind: 2, v: Math.fround(toNumber(n)) };
    default:
      return { kind: 3, v: toNumber(n) };
  }
};

export const numLiteral = (n: Num): Term.Literal => {
  switch (n.kind) {
    case 0:
      return new Term.Literal(n.v.toString(), dt.integer);
    case 1:
      return new Term.Literal(Xsd.canonicalDecimal(n.v), dt.decimal);
    case 2:
      return new Term.Literal(Xsd.canonicalDouble(Math.fround(n.v)), dt.float);
    case 3:
      return new Term.Literal(Xsd.canonicalDouble(n.v), dt.double);
  }
};

const requireNum = (t: Term.Term): Num => numeric(t) ?? fail('Expected a numeric literal');

const DIVISION_SCALE = 18;

export const arithmetic = (op: '+' | '-' | '*' | '/', a: Term.Term, b: Term.Term): Term.Literal => {
  const x = requireNum(a);
  const y = requireNum(b);
  let kind = Math.max(x.kind, y.kind);
  if (op === '/' && kind === INTEGER) kind = DECIMAL;
  const px = promote(x, kind);
  const py = promote(y, kind);
  switch (kind) {
    case INTEGER: {
      const u = px.v as bigint;
      const v = py.v as bigint;
      return numLiteral({ kind: 0, v: op === '+' ? u + v : op === '-' ? u - v : u * v });
    }
    case DECIMAL: {
      const u = px.v as BigDecimal.BigDecimal;
      const v = py.v as BigDecimal.BigDecimal;
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
    default: {
      const u = px.v as number;
      const v = py.v as number;
      const r = op === '+' ? u + v : op === '-' ? u - v : op === '*' ? u * v : u / v;
      return numLiteral({ kind: kind as 2 | 3, v: kind === FLOAT ? Math.fround(r) : r });
    }
  }
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
  const x = requireNum(a);
  switch (x.kind) {
    case 0:
      return numLiteral({ kind: 0, v: -x.v });
    case 1:
      return numLiteral({ kind: 1, v: BigDecimal.negate(x.v) });
    default:
      return numLiteral({ kind: x.kind, v: -x.v });
  }
};

/** Compares two numerics; returns NaN when unordered (NaN operands). */
export const compareNum = (x: Num, y: Num): number => {
  const kind = Math.max(x.kind, y.kind);
  if (kind <= DECIMAL) {
    if (kind === INTEGER) {
      const u = x.v as bigint;
      const v = y.v as bigint;
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

const DATE_KINDS = new Set([
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
  readonly timezone: number | undefined;
}

export const dateValue = (t: Term.Term): DateValue | undefined => {
  if (t._tag !== 'Literal' || !t.datatype.value.startsWith(XSD)) return undefined;
  const local = t.datatype.value.slice(XSD.length);
  if (!DATE_KINDS.has(local) || !Xsd.isValidLexical(t.datatype.value, t.value)) return undefined;
  const v = Xsd.toValue(t);
  if (v._tag !== 'DateTime') return undefined;
  return {
    kind: local === 'dateTimeStamp' ? 'dateTime' : local,
    millis: v.epochMillis,
    timezone: v.timezone,
  };
};

const FOURTEEN_HOURS = 14 * 3600 * 1000;

/** Compares two date/time values of the same kind; undefined if indeterminate. */
export const compareDates = (a: DateValue, b: DateValue): number | undefined => {
  if (a.kind !== b.kind) return undefined;
  if ((a.timezone === undefined) !== (b.timezone === undefined)) {
    const diff = a.millis - b.millis;
    if (Math.abs(diff) <= FOURTEEN_HOURS) return undefined;
    return diff < 0 ? -1 : 1;
  }
  return a.millis < b.millis ? -1 : a.millis > b.millis ? 1 : 0;
};

interface DurationValue {
  readonly kind: string;
  readonly months: number;
  readonly seconds: number;
}

export const durationValue = (t: Term.Term): DurationValue | undefined => {
  if (t._tag !== 'Literal') return undefined;
  const d = t.datatype.value;
  if (d !== `${XSD}duration` && d !== `${XSD}dayTimeDuration` && d !== `${XSD}yearMonthDuration`) {
    return undefined;
  }
  if (!Xsd.isValidLexical(d, t.value)) return undefined;
  const v = Xsd.toValue(t);
  return v._tag === 'Duration'
    ? { kind: d.slice(XSD.length), months: v.months, seconds: v.seconds }
    : undefined;
};

// -----------------------------------------------------------------------------
// Strings
// -----------------------------------------------------------------------------

/** Compares strings by Unicode code points. */
export const compareCodepoints = (a: string, b: string): number => {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const xs = x >= 0xd800 && x <= 0xdfff;
      const ys = y >= 0xd800 && y <= 0xdfff;
      if (xs !== ys) return xs ? 1 : -1;
      return x < y ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
};

// -----------------------------------------------------------------------------
// Equality and ordering
// -----------------------------------------------------------------------------

const isBooleanLiteral = (t: Term.Term): t is Term.Literal =>
  t._tag === 'Literal' &&
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
  if (x !== undefined && y !== undefined) return compareNum(x, y);
  if (isSimpleString(a) && isSimpleString(b)) return compareCodepoints(a.value, b.value);
  if (
    a._tag === 'Literal' &&
    b._tag === 'Literal' &&
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
  if (da !== undefined && db !== undefined) {
    const c = compareDates(da, db);
    if (c !== undefined) return c;
    return fail('Indeterminate date comparison');
  }
  const ua = durationValue(a);
  const ub = durationValue(b);
  if (ua !== undefined && ub !== undefined) {
    if (ua.months === ub.months) return Math.sign(ua.seconds - ub.seconds);
    if (ua.seconds === ub.seconds) return Math.sign(ua.months - ub.months);
    return fail('Indeterminate duration comparison');
  }
  return fail('Incomparable values');
};

const isKnownLiteral = (t: Term.Literal): boolean =>
  t.language !== '' || Xsd.isKnownDatatype(t.datatype.value);

/** RDF term equality with value semantics (`=`). Throws on type errors. */
export const equals = (a: Term.Term, b: Term.Term): boolean => {
  if (a._tag === 'Triple' || b._tag === 'Triple') {
    if (a._tag !== 'Triple' || b._tag !== 'Triple') return false;
    return (
      equals(a.subject, b.subject) && equals(a.predicate, b.predicate) && equals(a.object, b.object)
    );
  }
  if (a._tag !== 'Literal' || b._tag !== 'Literal') return a.key === b.key;
  const x = numeric(a);
  const y = numeric(b);
  if (x !== undefined && y !== undefined) return compareNum(x, y) === 0;
  if (a.key === b.key) return true;
  if (isSimpleString(a) && isSimpleString(b)) return a.value === b.value;
  if (isBooleanLiteral(a) && isBooleanLiteral(b)) return booleanValue(a) === booleanValue(b);
  const da = dateValue(a);
  const db = dateValue(b);
  if (da !== undefined && db !== undefined) {
    if (da.kind !== db.kind) return false;
    const c = compareDates(da, db);
    if (c === undefined) return fail('Indeterminate date comparison');
    return c === 0;
  }
  const ua = durationValue(a);
  const ub = durationValue(b);
  if (ua !== undefined && ub !== undefined) {
    return ua.months === ub.months && ua.seconds === ub.seconds;
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
export const ebv = (t: Term.Term): boolean => {
  if (t._tag !== 'Literal') return fail('EBV of a non-literal');
  const d = t.datatype.value;
  if (d === `${XSD}boolean`) {
    if (!Xsd.isValidLexical(d, t.value)) return fail('Invalid boolean');
    return booleanValue(t);
  }
  if (t.language === '' && d === Term.XSD_STRING) return Str.isNonEmpty(t.value);
  if (Xsd.isNumericDatatype(d)) {
    const n = numeric(t);
    if (n === undefined) return false;
    switch (n.kind) {
      case 0:
        return n.v !== 0n;
      case 1:
        return !BigDecimal.isZero(n.v);
      default:
        return !(n.v === 0 || Number.isNaN(n.v));
    }
  }
  return fail('EBV is not defined for this literal');
};

const rank = (t: Term.Term | undefined): number => {
  if (t === undefined) return 0;
  switch (t._tag) {
    case 'BlankNode':
      return 1;
    case 'NamedNode':
      return 2;
    case 'Literal':
      return 3;
    case 'Triple':
      return 4;
    default:
      return 5;
  }
};

/**
 * The total ordering used by `ORDER BY`: unbound < blank nodes < IRIs <
 * literals < triple terms; literals are ordered by value where comparable
 * and otherwise by datatype, language and lexical form.
 */
export const orderCompare = (a: Term.Term | undefined, b: Term.Term | undefined): number => {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a === undefined || b === undefined) return 0;
  switch (a._tag) {
    case 'BlankNode':
    case 'NamedNode':
      return compareCodepoints(a.value, (b as Term.NamedNode).value);
    case 'Triple': {
      const t = b as Term.Triple;
      return (
        orderCompare(a.subject, t.subject) ||
        orderCompare(a.predicate, t.predicate) ||
        orderCompare(a.object, t.object)
      );
    }
    case 'Literal': {
      const l = b as Term.Literal;
      // Where the values cannot be compared, fall through to the syntactic
      // ordering.
      const c = Result.getOrUndefined(Result.try(() => compareLiterals(a, l)));
      if (c !== undefined) {
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
    }
    default:
      return 0;
  }
};
