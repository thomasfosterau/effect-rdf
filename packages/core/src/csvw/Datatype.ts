/**
 * CSVW datatypes (Metadata Vocabulary §Datatypes, Tabular Data Model §Parsing
 * Cells): the built-in datatypes, datatype descriptions, and parsing a cell's
 * string value into a typed value with its `format`, length and value
 * constraints.
 *
 * @since 0.1.0
 */
import { Term, Xsd } from '../index.ts';
import * as Arr from 'effect/Array';
import * as BigDecimal from 'effect/BigDecimal';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as DateFormat from './internal/dateFormat.ts';
import * as NumberFormat from './internal/numberFormat.ts';
import { CSVW, RDF, XSD } from './internal/vocab.ts';

/**
 * The names of the built-in datatypes, including the CSVW aliases (`number`,
 * `binary`, `datetime`, `any`, `xml`, `html`, `json`).
 *
 * @since 0.1.0
 * @category datatypes
 */
export const builtIn: ReadonlyArray<string> = [
  'anyAtomicType',
  'anyURI',
  'base64Binary',
  'boolean',
  'date',
  'dateTime',
  'dateTimeStamp',
  'decimal',
  'integer',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'positiveInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
  'nonPositiveInteger',
  'negativeInteger',
  'double',
  'duration',
  'dayTimeDuration',
  'yearMonthDuration',
  'float',
  'gDay',
  'gMonth',
  'gMonthDay',
  'gYear',
  'gYearMonth',
  'hexBinary',
  'QName',
  'string',
  'normalizedString',
  'token',
  'language',
  'Name',
  'NMTOKEN',
  'xml',
  'html',
  'json',
  'time',
  'number',
  'binary',
  'datetime',
  'any',
];

const aliases: Readonly<Record<string, string>> = {
  number: 'double',
  binary: 'base64Binary',
  datetime: 'dateTime',
  any: 'anyAtomicType',
};

/**
 * Whether `name` names a built-in datatype.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const isBuiltIn = (name: string): boolean => Arr.contains(builtIn, name);

/**
 * The XML Schema name of a built-in datatype (`number` is `double`, …).
 *
 * @since 0.1.0
 * @category datatypes
 */
export const canonicalName = (name: string): string =>
  Option.getOrElse(Record.get(aliases, name), () => name);

/**
 * The IRI of a built-in datatype.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const iri = (name: string): string =>
  Match.value(canonicalName(name)).pipe(
    Match.when('xml', () => `${RDF}XMLLiteral`),
    Match.when('html', () => `${RDF}HTML`),
    Match.when('json', () => `${CSVW}JSON`),
    Match.orElse((n) => `${XSD}${n}`),
  );

/**
 * The built-in datatype an IRI identifies, if any.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const fromIri = (url: string): Option.Option<string> =>
  Arr.findFirst(builtIn, (name) => !Record.has(aliases, name) && iri(name) === url);

const integerTypes = [
  'integer',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'positiveInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
  'nonPositiveInteger',
  'negativeInteger',
];
const dateTypes = [
  'date',
  'dateTime',
  'dateTimeStamp',
  'time',
  'gDay',
  'gMonth',
  'gMonthDay',
  'gYear',
  'gYearMonth',
];
const durationTypes = ['duration', 'dayTimeDuration', 'yearMonthDuration'];
const stringTypes = [
  'string',
  'normalizedString',
  'token',
  'language',
  'Name',
  'NMTOKEN',
  'xml',
  'html',
  'json',
];

/**
 * Whether a built-in datatype is an integer type.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const isInteger = (name: string): boolean => Arr.contains(integerTypes, canonicalName(name));

/**
 * Whether a built-in datatype is `decimal` or one of its subtypes.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const isDecimal = (name: string): boolean =>
  canonicalName(name) === 'decimal' || isInteger(name);

/**
 * Whether a built-in datatype is numeric.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const isNumeric = (name: string): boolean =>
  isDecimal(name) || canonicalName(name) === 'double' || canonicalName(name) === 'float';

/**
 * Whether a built-in datatype is a date or time type.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const isDateTime = (name: string): boolean => Arr.contains(dateTypes, canonicalName(name));

/**
 * Whether a built-in datatype is a duration type.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const isDuration = (name: string): boolean =>
  Arr.contains(durationTypes, canonicalName(name));

/**
 * Whether a built-in datatype is `string` or one of its subtypes.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const isString = (name: string): boolean => Arr.contains(stringTypes, canonicalName(name));

/**
 * Whether a built-in datatype is a binary type.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const isBinary = (name: string): boolean =>
  canonicalName(name) === 'base64Binary' || canonicalName(name) === 'hexBinary';

/**
 * A numeric format object (`decimalChar`, `groupChar`, `pattern`).
 *
 * @since 0.1.0
 * @category models
 */
export const NumericFormat = Schema.Struct({
  decimalChar: Schema.optional(Schema.String),
  groupChar: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
});

/**
 * @since 0.1.0
 * @category models
 */
export type NumericFormat = typeof NumericFormat.Type;

/**
 * A bound of a value constraint, as written in the metadata.
 *
 * @since 0.1.0
 * @category models
 */
export const Bound = Schema.Union([Schema.String, Schema.Finite]);

/**
 * @since 0.1.0
 * @category models
 */
export type Bound = typeof Bound.Type;

/**
 * A normalized datatype description: a built-in `base`, an optional `@id`,
 * a `format`, and length and value constraints.
 *
 * @since 0.1.0
 * @category models
 */
export const Datatype = Schema.Struct({
  base: Schema.String,
  id: Schema.optional(Schema.String),
  format: Schema.optional(Schema.Union([Schema.String, NumericFormat])),
  length: Schema.optional(Schema.Int),
  minLength: Schema.optional(Schema.Int),
  maxLength: Schema.optional(Schema.Int),
  minInclusive: Schema.optional(Bound),
  maxInclusive: Schema.optional(Bound),
  minExclusive: Schema.optional(Bound),
  maxExclusive: Schema.optional(Bound),
  common: Schema.Record(Schema.String, Schema.Json),
});

/**
 * @since 0.1.0
 * @category models
 */
export type Datatype = typeof Datatype.Type;

/**
 * The `string` datatype.
 *
 * @since 0.1.0
 * @category constructors
 */
export const string: Datatype = { base: 'string', common: {} };

/**
 * The IRI a value of the datatype has in RDF: its `@id`, or its base's IRI.
 *
 * @since 0.1.0
 * @category datatypes
 */
export const datatypeIri = (datatype: Datatype): string => datatype.id ?? iri(datatype.base);

/**
 * A parsed cell value: its XML Schema lexical form, its datatype and, for
 * strings, its language.
 *
 * @since 0.1.0
 * @category models
 */
export interface Value {
  /** The lexical form (canonical where the format changed the string). */
  readonly lexical: string;
  /** The built-in base datatype. */
  readonly base: string;
  /** The datatype IRI used in RDF (`@id` or the base's IRI). */
  readonly datatype: string;
  /** The language of a string value. */
  readonly language: Option.Option<string>;
}

// -----------------------------------------------------------------------------
// Format validation
// -----------------------------------------------------------------------------

const quote = (s: string): string => `"${s}"`;

const isValidRegex = (source: string): boolean => Result.isSuccess(regexOf(source));

const regexOf = (source: string): Result.Result<RegExp, string> =>
  Result.try({ try: () => new RegExp(`^(?:${source})$`, 'u'), catch: (e) => String(e) });

/**
 * Checks a datatype's `format` against its base, returning a warning when the
 * format is unusable (it is then ignored).
 *
 * @since 0.1.0
 * @category validation
 */
export const checkFormat = (
  base: string,
  format: string | NumericFormat,
): Option.Option<string> => {
  if (isNumeric(base)) return checkNumberFormat(format);
  if (!Predicate.isString(format))
    return Option.some(`format for a ${base} datatype must be a string`);
  return Arr.contains(['date', 'dateTime', 'dateTimeStamp', 'time'], canonicalName(base))
    ? invalidUnless(
        Option.isSome(DateFormat.compile(format)),
        `invalid date/time format ${quote(format)}`,
      )
    : canonicalName(base) === 'boolean'
      ? invalidUnless(/^[^|]+\|[^|]+$/.test(format), `invalid boolean format ${quote(format)}`)
      : invalidUnless(isValidRegex(format), `invalid regular expression format ${quote(format)}`);
};

const invalidUnless = (valid: boolean, message: string): Option.Option<string> =>
  valid ? Option.none() : Option.some(message);

const checkNumberFormat = (format: string | NumericFormat): Option.Option<string> => {
  const { pattern, decimalChar, groupChar } = Predicate.isString(format)
    ? { pattern: format, decimalChar: '.', groupChar: ',' }
    : {
        pattern: format.pattern,
        decimalChar: format.decimalChar ?? '.',
        groupChar: format.groupChar ?? ',',
      };
  return Option.flatMap(Option.fromNullishOr(pattern), (p) =>
    invalidUnless(
      Option.isSome(NumberFormat.parsePattern(p, decimalChar, groupChar)),
      `invalid number format pattern ${quote(p)}`,
    ),
  );
};

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

const numberFormatOf = (format: Datatype['format']): NumberFormat.NumberFormat => {
  if (format === undefined)
    return { pattern: Option.none(), decimalChar: '.', groupChar: Option.none() };
  const decimalChar = Predicate.isString(format) ? '.' : (format.decimalChar ?? '.');
  const groupChar = Predicate.isString(format) ? undefined : format.groupChar;
  const pattern = Predicate.isString(format) ? format : format.pattern;
  return {
    decimalChar,
    groupChar: Option.fromNullishOr(groupChar),
    pattern: Option.flatMap(Option.fromNullishOr(pattern), (p) =>
      NumberFormat.parsePattern(p, decimalChar, groupChar ?? ','),
    ),
  };
};

const xsdValid = (base: string, lexical: string): boolean =>
  Xsd.isValidLexical(`${XSD}${canonicalName(base)}`, lexical);

const parseNumber = (text: string, datatype: Datatype): Result.Result<string, string> => {
  const base = datatype.base;
  if (datatype.format === undefined) {
    return xsdValid(base, text)
      ? Result.succeed(text)
      : Result.fail(`${quote(text)} is not a valid ${base}`);
  }
  return Result.flatMap(
    Result.mapError(
      NumberFormat.parse(text, numberFormatOf(datatype.format)),
      (reason) => `${quote(text)} ${reason}`,
    ),
    (parsed) => {
      if (isInteger(base) && parsed.hasDecimal)
        return Result.fail(`${quote(text)} has a decimal part but ${base} is an integer`);
      if (isDecimal(base) && (parsed.hasExponent || parsed.special))
        return Result.fail(`${quote(text)} is not a valid ${base}`);
      return xsdValid(base, parsed.lexical)
        ? Result.succeed(parsed.lexical)
        : Result.fail(`${quote(text)} is not a valid ${base}`);
    },
  );
};

const parseBoolean = (text: string, datatype: Datatype): Result.Result<string, string> => {
  const format = datatype.format;
  if (Predicate.isString(format)) {
    const [yes, no] = format.split('|');
    if (text === yes) return Result.succeed('true');
    if (text === no) return Result.succeed('false');
    return Result.fail(`${quote(text)} does not match the format ${format}`);
  }
  if (text === 'true' || text === '1') return Result.succeed('true');
  if (text === 'false' || text === '0') return Result.succeed('false');
  return Result.fail(`${quote(text)} is not a valid boolean`);
};

const parseDateTime = (text: string, datatype: Datatype): Result.Result<string, string> => {
  const base = canonicalName(datatype.base);
  const pattern = Predicate.isString(datatype.format)
    ? DateFormat.compile(datatype.format)
    : Option.none();
  return Option.match(pattern, {
    onNone: () =>
      xsdValid(base, text)
        ? Result.succeed(text)
        : Result.fail(`${quote(text)} is not a valid ${base}`),
    onSome: (p) =>
      Result.flatMap(
        Result.mapError(DateFormat.parse(text, p, base), (r) => `${quote(text)} ${r}`),
        (lexical) =>
          xsdValid(base, lexical)
            ? Result.succeed(lexical)
            : Result.fail(`${quote(text)} is not a valid ${base}`),
      ),
  });
};

const parseOther = (text: string, datatype: Datatype): Result.Result<string, string> => {
  const base = canonicalName(datatype.base);
  const format = datatype.format;
  const matches = Predicate.isString(format)
    ? Result.match(regexOf(format), { onFailure: () => true, onSuccess: (re) => re.test(text) })
    : true;
  if (!matches) return Result.fail(`${quote(text)} does not match its format`);
  if (base === 'json' || base === 'xml' || base === 'html' || base === 'anyAtomicType')
    return Result.succeed(text);
  return base === 'string' || xsdValid(base, text)
    ? Result.succeed(text)
    : Result.fail(`${quote(text)} is not a valid ${base}`);
};

const lengthOf = (lexical: string, base: string): number => {
  if (canonicalName(base) === 'hexBinary') return lexical.length / 2;
  if (canonicalName(base) === 'base64Binary') {
    const clean = lexical.replace(/\s/g, '');
    return (clean.length * 3) / 4 - (clean.match(/=+$/)?.[0].length ?? 0);
  }
  return Array.from(lexical).length;
};

const orderKey = (lexical: string, datatype: string): Option.Option<number> => {
  const value = Xsd.toValue(Term.literal(lexical, Term.namedNode(datatype)));
  return Match.valueTags(value, {
    Integer: ({ value: n }) => Option.some(Number(n)),
    Decimal: ({ value: d }) => Option.some(BigDecimal.toNumberUnsafe(d)),
    Float: ({ value: f }) => Option.some(f),
    Double: ({ value: f }) => Option.some(f),
    DateTime: ({ epochMillis }) => Option.some(epochMillis),
    // An average month, so durations of months and of seconds compare.
    Duration: ({ months, seconds }) => Option.some(months * 2_629_746 + seconds),
    String: () => Option.none(),
    Boolean: () => Option.none(),
    Other: () => Option.none(),
  });
};

/**
 * The order key of a constraint bound for a base datatype, if it is a valid
 * value of that datatype.
 *
 * @since 0.1.0
 * @category validation
 */
export const boundKey = (bound: Bound, base: string): Option.Option<number> =>
  Predicate.isNumber(bound)
    ? Option.some(bound)
    : xsdValid(base, bound)
      ? orderKey(bound, iri(base))
      : Option.none();

const checkConstraints = (value: Value, datatype: Datatype): ReadonlyArray<string> => {
  const length = lengthOf(value.lexical, datatype.base);
  const lengthErrors = Arr.getSomes([
    datatype.length !== undefined && length !== datatype.length
      ? Option.some(`length ${length} is not ${datatype.length}`)
      : Option.none(),
    datatype.minLength !== undefined && length < datatype.minLength
      ? Option.some(`length ${length} is less than minLength ${datatype.minLength}`)
      : Option.none(),
    datatype.maxLength !== undefined && length > datatype.maxLength
      ? Option.some(`length ${length} is greater than maxLength ${datatype.maxLength}`)
      : Option.none(),
  ]);
  const key = orderKey(value.lexical, iri(datatype.base));
  const bound = (
    b: Option.Option<Bound>,
    ok: (v: number, limit: number) => boolean,
    name: string,
  ): Option.Option<string> =>
    Option.flatMap(b, (limit) =>
      Option.flatMap(Option.all([key, boundKey(limit, datatype.base)]), ([v, l]) =>
        ok(v, l) ? Option.none() : Option.some(`value violates ${name} ${limit}`),
      ),
    );
  const of = Option.fromNullishOr;
  return [
    ...lengthErrors,
    ...Arr.getSomes([
      bound(of(datatype.minInclusive), (v, l) => v >= l, 'minimum'),
      bound(of(datatype.maxInclusive), (v, l) => v <= l, 'maximum'),
      bound(of(datatype.minExclusive), (v, l) => v > l, 'minExclusive'),
      bound(of(datatype.maxExclusive), (v, l) => v < l, 'maxExclusive'),
    ]),
  ];
};

/**
 * Parses a (non-empty, non-null) cell string with a datatype: the value, or
 * the errors that make the cell invalid.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  text: string,
  datatype: Datatype,
  language: Option.Option<string>,
): Result.Result<Value, ReadonlyArray<string>> => {
  const base = canonicalName(datatype.base);
  const lexical = isNumeric(base)
    ? parseNumber(text, datatype)
    : base === 'boolean'
      ? parseBoolean(text, datatype)
      : isDateTime(base) || isDuration(base)
        ? isDuration(base)
          ? parseOther(text, datatype)
          : parseDateTime(text, datatype)
        : parseOther(text, datatype);
  return Result.match(lexical, {
    onFailure: (e) => Result.fail([e]),
    onSuccess: (l) => {
      const value: Value = {
        lexical: l,
        base: datatype.base,
        datatype: datatypeIri(datatype),
        language: base === 'string' && datatype.id === undefined ? language : Option.none(),
      };
      const errors = checkConstraints(value, datatype);
      return Arr.isReadonlyArrayNonEmpty(errors) ? Result.fail(errors) : Result.succeed(value);
    },
  });
};

/**
 * A plain string value, as an invalid cell's value.
 *
 * @since 0.1.0
 * @category constructors
 */
export const stringValue = (text: string, language: Option.Option<string>): Value => ({
  lexical: text,
  base: 'string',
  datatype: `${XSD}string`,
  language,
});
