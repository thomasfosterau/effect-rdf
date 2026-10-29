/**
 * XML Schema datatypes: lexical validation, value mapping, canonical forms
 * and typed literal constructors.
 *
 * @since 0.1.0
 */
import * as BigDecimal from 'effect/BigDecimal';
import * as Option from 'effect/Option';
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
const lexical = new Map<string, RegExp>(
  Object.entries({
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
const integerBounds = new Map<string, readonly [bigint | undefined, bigint | undefined]>(
  Object.entries({
    integer: [undefined, undefined],
    long: [-(2n ** 63n), 2n ** 63n - 1n],
    int: [-(2n ** 31n), 2n ** 31n - 1n],
    short: [-32768n, 32767n],
    byte: [-128n, 127n],
    unsignedLong: [0n, 2n ** 64n - 1n],
    unsignedInt: [0n, 2n ** 32n - 1n],
    unsignedShort: [0n, 65535n],
    unsignedByte: [0n, 255n],
    positiveInteger: [1n, undefined],
    nonNegativeInteger: [0n, undefined],
    negativeInteger: [undefined, -1n],
    nonPositiveInteger: [undefined, 0n],
  }),
);

/**
 * The XSD numeric datatypes recognised by SPARQL, ordered by type promotion.
 *
 * @since 0.1.0
 */
export const numericDatatypes: ReadonlySet<string> = new Set([
  ...Array.from(integerBounds.keys(), (t) => XSD + t),
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
  datatype.startsWith(XSD) && integerBounds.has(datatype.slice(XSD.length));

/**
 * Whether a datatype IRI is numeric.
 *
 * @since 0.1.0
 */
export const isNumericDatatype = (datatype: string): boolean => numericDatatypes.has(datatype);

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
  return lexical.has(local) || integerBounds.has(local) || local === 'anyURI';
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
  const bounds = integerBounds.get(local);
  if (bounds !== undefined) {
    if (!INTEGER.test(value)) return false;
    const n = BigInt(value);
    return (
      (bounds[0] === undefined || n >= bounds[0]) && (bounds[1] === undefined || n <= bounds[1])
    );
  }
  const pattern = lexical.get(local);
  if (pattern === undefined) return true;
  if (!pattern.test(value)) return false;
  if (local === 'date' || local === 'dateTime' || local === 'dateTimeStamp') {
    const m = /^(-?\d+)-(\d\d)-(\d\d)/.exec(value)!;
    return Number(m[3]) <= daysInMonth(Number(m[1]), Number(m[2]));
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

const parseTimezone = (s: string): number | undefined => {
  const m = /(Z|[+-]\d\d:\d\d)$/.exec(s);
  if (m === null) return undefined;
  if (m[1] === 'Z') return 0;
  const sign = m[1]!.startsWith('-') ? -1 : 1;
  return sign * (Number(m[1]!.slice(1, 3)) * 60 + Number(m[1]!.slice(4, 6)));
};

const toEpoch = (
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: number | undefined,
) => {
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, 0, 0);
  return date.getTime() + s * 1000 - (tz ?? 0) * 60_000;
};

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
  if (integerBounds.has(local)) return { _tag: 'Integer', value: BigInt(v) };
  switch (local) {
    case 'boolean':
      return { _tag: 'Boolean', value: v === 'true' || v === '1' };
    case 'decimal': {
      const normalized =
        v.startsWith('.') || v.startsWith('-.') || v.startsWith('+.') ? v.replace('.', '0.') : v;
      return {
        _tag: 'Decimal',
        value: BigDecimal.fromStringUnsafe(
          normalized.endsWith('.') ? `${normalized}0` : normalized,
        ),
      };
    }
    case 'double':
      return { _tag: 'Double', value: parseXsdFloat(v) };
    case 'float':
      return { _tag: 'Float', value: Math.fround(parseXsdFloat(v)) };
    case 'dateTime':
    case 'dateTimeStamp': {
      const m = /^(-?\d+)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(v)!;
      const tz = parseTimezone(v);
      return {
        _tag: 'DateTime',
        kind: 'dateTime',
        epochMillis: toEpoch(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!, tz),
        timezone: tz,
      };
    }
    case 'date': {
      const m = /^(-?\d+)-(\d\d)-(\d\d)/.exec(v)!;
      const tz = parseTimezone(v);
      return {
        _tag: 'DateTime',
        kind: 'date',
        epochMillis: toEpoch(+m[1]!, +m[2]!, +m[3]!, 0, 0, 0, tz),
        timezone: tz,
      };
    }
    case 'time': {
      const m = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(v)!;
      const tz = parseTimezone(v);
      return {
        _tag: 'DateTime',
        kind: 'time',
        epochMillis: toEpoch(1972, 12, 31, +m[1]!, +m[2]!, +m[3]!, tz),
        timezone: tz,
      };
    }
    case 'gYear':
    case 'gYearMonth':
    case 'gMonth':
    case 'gMonthDay':
    case 'gDay': {
      const tz = parseTimezone(v);
      const body = tz === undefined ? v : v.replace(/(Z|[+-]\d\d:\d\d)$/, '');
      let y = 1972;
      let mo = 12;
      let d = 31;
      if (local === 'gYear') y = +body;
      else if (local === 'gYearMonth')
        // SAFETY: `toValue` only gets here for a lexical form `isValidLexical` accepted, so a
        // `gYearMonth` body matches.
        [y, mo] = /^(-?\d+)-(\d\d)$/.exec(body)!.slice(1).map(Number) as [number, number];
      else if (local === 'gMonth') mo = +body.slice(2);
      else if (local === 'gMonthDay') [mo, d] = [+body.slice(2, 4), +body.slice(5, 7)];
      else d = +body.slice(3);
      if (local === 'gYear' || local === 'gYearMonth' || local === 'gMonth') d = 1;
      return {
        _tag: 'DateTime',
        kind: local,
        epochMillis: toEpoch(y, mo, d, 0, 0, 0, tz),
        timezone: tz,
      };
    }
    case 'duration':
    case 'yearMonthDuration':
    case 'dayTimeDuration': {
      const m =
        /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
          v,
        )!;
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
    }
    default:
      return { _tag: 'Other', lexical: v, datatype: dt };
  }
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
  // SAFETY: `toExponential` always produces `<mantissa>e<exponent>`.
  const [mantissa, exponent] = n.toExponential().split('e') as [string, string];
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

/**
 * Returns the canonical form of a literal, or the literal unchanged if its
 * datatype has no known canonical mapping or it is ill-formed.
 *
 * @since 0.1.0
 */
export const canonicalize = (self: Literal): Literal => {
  const value = toValue(self);
  const dt = self.datatype;
  switch (value._tag) {
    case 'Boolean':
      return new Literal(String(value.value), dt);
    case 'Integer':
      return new Literal(value.value.toString(), dt);
    case 'Decimal':
      return new Literal(canonicalDecimal(value.value), dt);
    case 'Double':
    case 'Float':
      return new Literal(canonicalDouble(value.value), dt);
    default:
      return self;
  }
};

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

/**
 * Converts a literal to a natural JavaScript value: strings, booleans,
 * numbers (for integers within the safe range, decimals, floats and doubles),
 * bigints (for large integers) and `Date`s (for `xsd:dateTime` and
 * `xsd:date`). Returns `None` for ill-formed literals and unknown datatypes.
 *
 * @since 0.1.0
 */
export const toJs = (self: Literal): Option.Option<string | number | bigint | boolean | Date> => {
  const v = toValue(self);
  switch (v._tag) {
    case 'String':
      return Option.some(v.value);
    case 'Boolean':
      return Option.some(v.value);
    case 'Integer':
      return Option.some(
        v.value <= BigInt(Number.MAX_SAFE_INTEGER) && v.value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(v.value)
          : v.value,
      );
    case 'Decimal':
      return Option.some(BigDecimal.toNumberUnsafe(v.value));
    case 'Double':
    case 'Float':
      return Option.some(v.value);
    case 'DateTime':
      return v.kind === 'dateTime' || v.kind === 'date'
        ? Option.some(new Date(v.epochMillis))
        : Option.none();
    default:
      return Option.none();
  }
};
