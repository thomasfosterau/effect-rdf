/**
 * XML Schema datatypes: lexical validation, value mapping, canonical forms
 * and typed literal constructors.
 *
 * @since 0.1.0
 */
import * as BigDecimal from 'effect/BigDecimal';
import * as Arr from 'effect/Array';
import * as HashSet from 'effect/HashSet';
import * as Match from 'effect/Match';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import {
  Literal,
  NamedNode,
  RDF_DIR_LANG_STRING,
  RDF_LANG_STRING,
  XSD_STRING,
  literal,
} from './Term.ts';
import { xsd } from './Vocab.ts';
import * as Predicate from 'effect/Predicate';

const XSD = xsd.base;

// -----------------------------------------------------------------------------
// Lexical spaces
// -----------------------------------------------------------------------------

const TZ = '(?:Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))';
const YEAR = '-?(?:[1-9]\\d{3,}|0\\d{3})';
const MONTH = '(?:0[1-9]|1[0-2])';
const DAY = '(?:0[1-9]|[12]\\d|3[01])';
const TIME = '(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?|24:00:00(?:\\.0+)?)';

const re = (s: string) => new RegExp(`^${s}$`);

const INTEGER = /^[+-]?\d+$/;
const LANGUAGE = /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;

/** Lexical-space patterns by XSD local name. */
const lexical = MutableHashMap.fromIterable<string, RegExp>(
  Record.toEntries({
    boolean: /^(?:true|false|1|0)$/,
    decimal: /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/,
    integer: INTEGER,
    double: /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/,
    float: /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/,
    dateTime: re(`${YEAR}-${MONTH}-${DAY}T${TIME}${TZ}?`),
    dateTimeStamp: re(`${YEAR}-${MONTH}-${DAY}T${TIME}${TZ}`),
    date: re(`${YEAR}-${MONTH}-${DAY}${TZ}?`),
    time: re(`${TIME}${TZ}?`),
    gYear: re(`${YEAR}${TZ}?`),
    gYearMonth: re(`${YEAR}-${MONTH}${TZ}?`),
    gMonth: re(`--${MONTH}${TZ}?`),
    gMonthDay: re(`--${MONTH}-${DAY}${TZ}?`),
    gDay: re(`---${DAY}${TZ}?`),
    duration:
      /^-?P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/,
    yearMonthDuration: /^-?P(?=\d)(?:\d+Y)?(?:\d+M)?$/,
    dayTimeDuration: /^-?P(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/,
    hexBinary: /^(?:[0-9A-Fa-f]{2})*$/,
    base64Binary:
      /^(?:(?:[A-Za-z0-9+/] ?){4})*(?:(?:[A-Za-z0-9+/] ?){2}[AEIMQUYcgkosw048] ?=|[A-Za-z0-9+/] ?[AQgw] ?= ?=)?$/,
    language: LANGUAGE,
    // eslint-disable-next-line no-control-regex
    normalizedString: /^[^\r\n\t]*$/,
    token: /^(?:[^\s](?:[^\s]| (?! ))*[^\s]|[^\s])?$/,
    NMTOKEN: /^[\w.\-:\u00B7\u00C0-\uFFFD]+$/u,
    Name: /^[A-Za-z_:\u00C0-\uFFFD][\w.\-:\u00B7\u00C0-\uFFFD]*$/u,
    NCName: /^[A-Za-z_\u00C0-\uFFFD][\w.\-\u00B7\u00C0-\uFFFD]*$/u,
  }),
);

/** Value-space bounds (inclusive; `undefined` is unbounded) of the XSD integer types. */
/** The inclusive bounds of an integer type; none is unbounded. */
type Bounds = readonly [Option.Option<bigint>, Option.Option<bigint>];

const unbounded: Option.Option<bigint> = Option.none();

const integerBounds = MutableHashMap.fromIterable<string, Bounds>(
  Record.toEntries<string, Bounds>({
    integer: [unbounded, unbounded],
    long: [Option.some(-(2n ** 63n)), Option.some(2n ** 63n - 1n)],
    int: [Option.some(-(2n ** 31n)), Option.some(2n ** 31n - 1n)],
    short: [Option.some(-32768n), Option.some(32767n)],
    byte: [Option.some(-128n), Option.some(127n)],
    unsignedLong: [Option.some(0n), Option.some(2n ** 64n - 1n)],
    unsignedInt: [Option.some(0n), Option.some(2n ** 32n - 1n)],
    unsignedShort: [Option.some(0n), Option.some(65535n)],
    unsignedByte: [Option.some(0n), Option.some(255n)],
    positiveInteger: [Option.some(1n), unbounded],
    nonNegativeInteger: [Option.some(0n), unbounded],
    negativeInteger: [unbounded, Option.some(-1n)],
    nonPositiveInteger: [unbounded, Option.some(0n)],
  }),
);

/**
 * The XSD numeric datatypes recognised by SPARQL.
 *
 * @since 0.1.0
 */
export const numericDatatypes: HashSet.HashSet<string> = HashSet.fromIterable([
  ...Arr.map(Arr.fromIterable(MutableHashMap.keys(integerBounds)), (t) => XSD + t),
  `${XSD}decimal`,
  `${XSD}float`,
  `${XSD}double`,
]);

/**
 * Whether a datatype IRI is one of the XSD integer types (including derived
 * types such as `xsd:int`).
 *
 * @since 0.1.0
 */
export const isIntegerDatatype = (datatype: string): boolean =>
  datatype.startsWith(XSD) && MutableHashMap.has(integerBounds, datatype.slice(XSD.length));

/**
 * Whether a datatype IRI is numeric.
 *
 * @since 0.1.0
 */
export const isNumericDatatype = (datatype: string): boolean =>
  HashSet.has(numericDatatypes, datatype);

/**
 * Whether this implementation knows the lexical space of a datatype.
 *
 * @since 0.1.0
 */
export const isKnownDatatype = (datatype: string): boolean => {
  if (datatype === XSD_STRING || datatype === RDF_LANG_STRING || datatype === RDF_DIR_LANG_STRING)
    return true;
  if (!datatype.startsWith(XSD)) return false;
  const local = datatype.slice(XSD.length);
  return (
    MutableHashMap.has(lexical, local) ||
    MutableHashMap.has(integerBounds, local) ||
    local === 'anyURI'
  );
};

/**
 * Checks whether a lexical form is in the lexical space of a datatype.
 * Unknown datatypes are treated as valid.
 *
 * @since 0.1.0
 */
export const isValidLexical = (datatype: string, value: string): boolean => {
  if (!datatype.startsWith(XSD)) return true;
  const local = datatype.slice(XSD.length);
  const bounds = MutableHashMap.get(integerBounds, local);
  if (Option.isSome(bounds)) {
    if (!INTEGER.test(value)) return false;
    const n = BigInt(value);
    const [min, max] = bounds.value;
    return !Option.exists(min, (m) => n < m) && !Option.exists(max, (m) => n > m);
  }
  const pattern = MutableHashMap.get(lexical, local);
  if (Option.isNone(pattern)) return true;
  if (!pattern.value.test(value)) return false;
  if (local === 'date' || local === 'dateTime' || local === 'dateTimeStamp') {
    const [year = 0, month = 0, day = 0] = numbers(DATE, value);
    return day <= daysInMonth(year, month);
  }
  return true;
};

/**
 * Whether a literal is well-formed: its lexical form is in the lexical space
 * of its (known) datatype. Language-tagged strings must have a well-formed
 * BCP 47 tag.
 *
 * @since 0.1.0
 */
export const isWellFormed = (self: Literal): boolean =>
  self.language !== ''
    ? LANGUAGE.test(self.language)
    : isValidLexical(self.datatype.value, self.value);

const daysInMonth = (year: number, month: number) =>
  month === 2
    ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

// -----------------------------------------------------------------------------
// Value space
// -----------------------------------------------------------------------------

/**
 * A literal's value in the XSD value space.
 *
 * @since 0.1.0
 * @category models
 */
export type Value =
  | {
      readonly _tag: 'String';
      readonly value: string;
      readonly language: string;
      readonly direction: 'ltr' | 'rtl' | undefined;
    }
  | { readonly _tag: 'Boolean'; readonly value: boolean }
  | { readonly _tag: 'Integer'; readonly value: bigint }
  | { readonly _tag: 'Decimal'; readonly value: BigDecimal.BigDecimal }
  | { readonly _tag: 'Float'; readonly value: number }
  | { readonly _tag: 'Double'; readonly value: number }
  | {
      readonly _tag: 'DateTime';
      readonly kind:
        | 'dateTime'
        | 'date'
        | 'time'
        | 'gYear'
        | 'gYearMonth'
        | 'gMonth'
        | 'gMonthDay'
        | 'gDay';
      /** Milliseconds since the epoch, interpreting missing timezones as UTC. */
      readonly epochMillis: number;
      /** Timezone offset in minutes, or `undefined` when absent. */
      readonly timezone: number | undefined;
    }
  | { readonly _tag: 'Duration'; readonly months: number; readonly seconds: number }
  | { readonly _tag: 'Other'; readonly lexical: string; readonly datatype: string };

/** The numbers a pattern's groups match in `v` (the lexical form is valid, so it matches). */
const numbers = (pattern: RegExp, v: string): ReadonlyArray<number> =>
  (pattern.exec(v) ?? []).slice(1).map(Number);

const DATE = /^(-?\d+)-(\d\d)-(\d\d)/;

const parseTimezone = (s: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(/(Z|[+-]\d\d:\d\d)$/.exec(s)?.[1]), (zone) =>
    zone === 'Z'
      ? 0
      : (zone.startsWith('-') ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))),
  );

const toEpoch = (
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: Option.Option<number>,
) => {
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, 0, 0);
  return date.getTime() + s * 1000 - Option.getOrElse(tz, () => 0) * 60_000;
};

// Built once: `toValue` runs for every literal a comparison, filter or index touches.
const valueOf = Match.fn((local: string, _v: string, _dt: string) => local).pipe(
  Match.withReturnType<Value>(),
  Match.when('boolean', (_local, _l, v) => ({ _tag: 'Boolean', value: v === 'true' || v === '1' })),
  Match.when('decimal', (_local, _l, v) => {
    const normalized =
      v.startsWith('.') || v.startsWith('-.') || v.startsWith('+.') ? v.replace('.', '0.') : v;
    return {
      _tag: 'Decimal',
      value: BigDecimal.fromStringUnsafe(normalized.endsWith('.') ? `${normalized}0` : normalized),
    };
  }),
  Match.when('double', (_local, _l, v) => ({ _tag: 'Double', value: parseXsdFloat(v) })),
  Match.when('float', (_local, _l, v) => ({
    _tag: 'Float',
    value: Math.fround(parseXsdFloat(v)),
  })),
  Match.when(Match.is('dateTime', 'dateTimeStamp'), (_local, _l, v) => {
    const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = numbers(
      /^(-?\d+)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d(?:\.\d+)?)/,
      v,
    );
    const tz = parseTimezone(v);
    return {
      _tag: 'DateTime',
      kind: 'dateTime',
      epochMillis: toEpoch(y, mo, d, h, mi, s, tz),
      timezone: Option.getOrUndefined(tz),
    };
  }),
  Match.when('date', (_local, _l, v) => {
    const [y = 0, mo = 0, d = 0] = numbers(DATE, v);
    const tz = parseTimezone(v);
    return {
      _tag: 'DateTime',
      kind: 'date',
      epochMillis: toEpoch(y, mo, d, 0, 0, 0, tz),
      timezone: Option.getOrUndefined(tz),
    };
  }),
  Match.when('time', (_local, _l, v) => {
    const [h = 0, mi = 0, s = 0] = numbers(/^(\d\d):(\d\d):(\d\d(?:\.\d+)?)/, v);
    const tz = parseTimezone(v);
    return {
      _tag: 'DateTime',
      kind: 'time',
      epochMillis: toEpoch(1972, 12, 31, h, mi, s, tz),
      timezone: Option.getOrUndefined(tz),
    };
  }),
  Match.when(Match.is('gYear', 'gYearMonth', 'gMonth', 'gMonthDay', 'gDay'), (local, _l, v) => {
    const tz = parseTimezone(v);
    const body = Option.isNone(tz) ? v : v.replace(/(Z|[+-]\d\d:\d\d)$/, '');
    let y = 1972;
    let mo = 12;
    let d = 31;
    if (local === 'gYear') y = +body;
    else if (local === 'gYearMonth') {
      const [year = y, month = mo] = numbers(/^(-?\d+)-(\d\d)$/, body);
      y = year;
      mo = month;
    } else if (local === 'gMonth') mo = +body.slice(2);
    else if (local === 'gMonthDay') [mo, d] = [+body.slice(2, 4), +body.slice(5, 7)];
    else d = +body.slice(3);
    if (local === 'gYear' || local === 'gYearMonth' || local === 'gMonth') d = 1;
    return {
      _tag: 'DateTime',
      kind: local,
      epochMillis: toEpoch(y, mo, d, 0, 0, 0, tz),
      timezone: Option.getOrUndefined(tz),
    };
  }),
  Match.when(Match.is('duration', 'yearMonthDuration', 'dayTimeDuration'), (_local, _l, v) => {
    const m =
      /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
        v,
      ) ?? [];
    const sign = m[1] === '-' ? -1 : 1;
    const months = sign * (Number(m[2] ?? 0) * 12 + Number(m[3] ?? 0));
    const seconds =
      sign *
      (Number(m[4] ?? 0) * 86400 +
        Number(m[5] ?? 0) * 3600 +
        Number(m[6] ?? 0) * 60 +
        Number(m[7] ?? 0));
    return {
      _tag: 'Duration',
      months: months === 0 ? 0 : months,
      seconds: seconds === 0 ? 0 : seconds,
    };
  }),
  Match.orElse((_local, _l, v, dt) => ({ _tag: 'Other', lexical: v, datatype: dt })),
);

/**
 * Maps a literal to its value. Ill-formed literals and unknown datatypes map
 * to `Other`.
 *
 * @since 0.1.0
 */
export const toValue = (self: Literal): Value => {
  const dt = self.datatype.value;
  const v = self.value;
  if (dt === XSD_STRING || dt === RDF_LANG_STRING || dt === RDF_DIR_LANG_STRING) {
    return { _tag: 'String', value: v, language: self.language, direction: self.direction };
  }
  if (!dt.startsWith(XSD) || !isValidLexical(dt, v))
    return { _tag: 'Other', lexical: v, datatype: dt };
  const local = dt.slice(XSD.length);
  if (MutableHashMap.has(integerBounds, local)) return { _tag: 'Integer', value: BigInt(v) };
  return valueOf(local, v, dt);
};

const parseXsdFloat = (v: string): number =>
  v === 'INF' || v === '+INF' ? Infinity : v === '-INF' ? -Infinity : v === 'NaN' ? NaN : Number(v);

// -----------------------------------------------------------------------------
// Canonical forms
// -----------------------------------------------------------------------------

/**
 * Formats a number in the canonical `xsd:double` form (e.g. `1.0E0`).
 *
 * @since 0.1.0
 */
export const canonicalDouble = (n: number): string => {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'INF';
  if (n === -Infinity) return '-INF';
  if (n === 0) return Object.is(n, -0) ? '-0.0E0' : '0.0E0';
  // `toExponential` always produces `<mantissa>e<exponent>`
  const [mantissa = '', exponent = ''] = n.toExponential().split('e');
  const m = mantissa.includes('.') ? mantissa : `${mantissa}.0`;
  return `${m}E${exponent.replace('+', '')}`;
};

/**
 * Formats a `BigDecimal` in the canonical `xsd:decimal` form (always
 * containing a decimal point).
 *
 * @since 0.1.0
 */
export const canonicalDecimal = (d: BigDecimal.BigDecimal): string => {
  const s = BigDecimal.format(BigDecimal.normalize(d));
  return s.includes('.') ? s : `${s}.0`;
};

// Built once: `canonicalize` runs for every literal a serializer or the dataset canonicalises.
const canonicalOf = Match.fn((value: Value, _self: Literal) => value).pipe(
  Match.withReturnType<Literal>(),
  Match.tag('Boolean', (value, _v, self) => new Literal(String(value.value), self.datatype)),
  Match.tag('Integer', (value, _v, self) => new Literal(value.value.toString(), self.datatype)),
  Match.tag(
    'Decimal',
    (value, _v, self) => new Literal(canonicalDecimal(value.value), self.datatype),
  ),
  Match.tag(
    'Double',
    'Float',
    (value, _v, self) => new Literal(canonicalDouble(value.value), self.datatype),
  ),
  Match.orElse((_value, _v, self) => self),
);

/**
 * Returns the canonical form of a literal, or the literal unchanged if its
 * datatype has no known canonical mapping or it is ill-formed.
 *
 * @since 0.1.0
 */
export const canonicalize = (self: Literal): Literal => canonicalOf(toValue(self), self);

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

const dts = {
  boolean: xsd.boolean,
  integer: xsd.integer,
  decimal: xsd.decimal,
  double: xsd.double,
  float: xsd.float,
  dateTime: xsd.dateTime,
  date: xsd.date,
  anyURI: xsd.anyURI,
} as const;

/**
 * @since 0.1.0
 * @category constructors
 */
export const string = (value: string): Literal => literal(value);

/**
 * @since 0.1.0
 * @category constructors
 */
export const boolean = (value: boolean): Literal => new Literal(String(value), dts.boolean);

/**
 * @since 0.1.0
 * @category constructors
 */
export const integer = (value: number | bigint): Literal =>
  new Literal(
    Predicate.isBigInt(value) ? value.toString() : Math.trunc(value).toString(),
    dts.integer,
  );

/**
 * @since 0.1.0
 * @category constructors
 */
export const decimal = (value: BigDecimal.BigDecimal | number | string): Literal =>
  new Literal(
    canonicalDecimal(
      BigDecimal.isBigDecimal(value)
        ? value
        : Predicate.isNumber(value)
          ? BigDecimal.fromNumberUnsafe(value)
          : BigDecimal.fromStringUnsafe(value),
    ),
    dts.decimal,
  );

/**
 * @since 0.1.0
 * @category constructors
 */
export const double = (value: number): Literal => new Literal(canonicalDouble(value), dts.double);

/**
 * @since 0.1.0
 * @category constructors
 */
export const float = (value: number): Literal =>
  new Literal(canonicalDouble(Math.fround(value)), dts.float);

/**
 * @since 0.1.0
 * @category constructors
 */
export const dateTime = (value: Date): Literal => new Literal(value.toISOString(), dts.dateTime);

/**
 * @since 0.1.0
 * @category constructors
 */
export const date = (value: Date): Literal =>
  new Literal(value.toISOString().slice(0, 10), dts.date);

/**
 * @since 0.1.0
 * @category constructors
 */
export const anyURI = (value: string): Literal => new Literal(value, dts.anyURI);

/**
 * Creates a typed literal from a datatype and lexical form.
 *
 * @since 0.1.0
 * @category constructors
 */
export const typed = (value: string, datatype: NamedNode): Literal => new Literal(value, datatype);

/**
 * Converts a JavaScript value to the most natural literal: strings become
 * `xsd:string`, booleans `xsd:boolean`, integers `xsd:integer`, other numbers
 * `xsd:double`, bigints `xsd:integer` and dates `xsd:dateTime`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromJs = (value: string | number | bigint | boolean | Date): Literal => {
  if (Predicate.isString(value)) return string(value);
  if (Predicate.isBoolean(value)) return boolean(value);
  if (Predicate.isBigInt(value)) return integer(value);
  if (Predicate.isNumber(value)) return Number.isInteger(value) ? integer(value) : double(value);
  return dateTime(value);
};

// Built once: `toJs` runs for every literal a result row or JSON conversion reads.
const jsOf = Match.type<Value>().pipe(
  Match.withReturnType<Option.Option<string | number | bigint | boolean | Date>>(),
  Match.tag('String', (v) => Option.some(v.value)),
  Match.tag('Boolean', (v) => Option.some(v.value)),
  Match.tag('Integer', (v) =>
    Option.some(
      v.value <= BigInt(Number.MAX_SAFE_INTEGER) && v.value >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(v.value)
        : v.value,
    ),
  ),
  Match.tag('Decimal', (v) => Option.some(BigDecimal.toNumberUnsafe(v.value))),
  Match.tag('Double', 'Float', (v) => Option.some(v.value)),
  Match.tag('DateTime', (v) =>
    v.kind === 'dateTime' || v.kind === 'date'
      ? Option.some(new Date(v.epochMillis))
      : Option.none(),
  ),
  Match.orElse(() => Option.none()),
);

/**
 * Converts a literal to a natural JavaScript value: strings, booleans,
 * numbers (for integers within the safe range, decimals, floats and doubles),
 * bigints (for large integers) and `Date`s (for `xsd:dateTime` and
 * `xsd:date`). Returns `None` for ill-formed literals and unknown datatypes.
 *
 * @since 0.1.0
 */
export const toJs = (self: Literal): Option.Option<string | number | bigint | boolean | Date> =>
  jsOf(toValue(self));
