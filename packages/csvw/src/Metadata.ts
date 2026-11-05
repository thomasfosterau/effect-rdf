/**
 * CSVW metadata documents (Metadata Vocabulary for Tabular Data): the
 * normalized description model as Effect `Schema`s (table groups, tables,
 * schemas, columns, dialects, foreign keys, transformations), and decoding a
 * JSON-LD metadata document with its fixed `http://www.w3.org/ns/csvw`
 * context into that model — validating every property, warning about and
 * dropping invalid values, failing on errors, and normalizing per §Normalization
 * (absolute URLs, natural-language and common properties, referenced schemas
 * and dialects fetched and inlined).
 *
 * @since 0.1.0
 */
import { LanguageTag } from '@thomasfosterau/effect-rdf';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Datatype from './Datatype.ts';
import * as Report from './Report.ts';
import * as Json from './internal/json.ts';
import { optional } from './internal/object.ts';
import * as Url from './internal/url.ts';
import * as Vocab from './internal/vocab.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * A metadata document that cannot be used: invalid JSON, an invalid
 * `@context`, a missing required property, or a value the specification
 * says is an error (processing stops).
 *
 * @since 0.1.0
 * @category errors
 */
export class MetadataError extends Schema.TaggedError<MetadataError>()('MetadataError', {
  message: Schema.String,
  url: Schema.optional(Schema.String),
}) {}

// -----------------------------------------------------------------------------
// Model
// -----------------------------------------------------------------------------

/**
 * A natural-language property's value: language tags (`und` when unknown)
 * mapped to strings.
 *
 * @since 0.1.0
 * @category models
 */
export const LanguageMap = Schema.Record(Schema.String, Schema.Array(Schema.String));

/**
 * @since 0.1.0
 * @category models
 */
export type LanguageMap = typeof LanguageMap.Type;

/**
 * Common properties and notes in normalized form: prefixed names or absolute
 * URLs mapped to JSON-LD values.
 *
 * @since 0.1.0
 * @category models
 */
export const CommonProperties = Schema.Record(Schema.String, Schema.Json);

/**
 * @since 0.1.0
 * @category models
 */
export type CommonProperties = typeof CommonProperties.Type;

/**
 * The text direction of cells.
 *
 * @since 0.1.0
 * @category models
 */
export const TextDirection = Schema.Literals(['ltr', 'rtl', 'auto', 'inherit']);

/**
 * @since 0.1.0
 * @category models
 */
export type TextDirection = typeof TextDirection.Type;

/**
 * The direction of a table's columns.
 *
 * @since 0.1.0
 * @category models
 */
export const TableDirection = Schema.Literals(['ltr', 'rtl', 'auto']);

/**
 * @since 0.1.0
 * @category models
 */
export type TableDirection = typeof TableDirection.Type;

/**
 * The inherited properties of a description (§Inherited Properties), set
 * where they were specified; a column inherits each unset one from its
 * schema, table and table group.
 *
 * @since 0.1.0
 * @category models
 */
export const Inherited = Schema.Struct({
  aboutUrl: Schema.optional(Schema.String),
  datatype: Schema.optional(Datatype.Datatype),
  default: Schema.optional(Schema.String),
  lang: Schema.optional(Schema.String),
  null: Schema.optional(Schema.Array(Schema.String)),
  ordered: Schema.optional(Schema.Boolean),
  propertyUrl: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  separator: Schema.optional(Schema.NullOr(Schema.String)),
  textDirection: Schema.optional(TextDirection),
  valueUrl: Schema.optional(Schema.String),
});

/**
 * @since 0.1.0
 * @category models
 */
export type Inherited = typeof Inherited.Type;

/**
 * A column description.
 *
 * @since 0.1.0
 * @category models
 */
export const Column = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  /** The name derived from the first title in the metadata's default language. */
  titleName: Schema.optional(Schema.String),
  titles: LanguageMap,
  isVirtual: Schema.Boolean,
  isSuppressed: Schema.Boolean,
  inherited: Inherited,
  common: CommonProperties,
});

/**
 * @since 0.1.0
 * @category models
 */
export type Column = typeof Column.Type;

/**
 * The referenced side of a foreign key: a table by `resource` URL or by
 * `schemaReference`, and its columns.
 *
 * @since 0.1.0
 * @category models
 */
export const Reference = Schema.Struct({
  resource: Schema.optional(Schema.String),
  schemaReference: Schema.optional(Schema.String),
  columnReference: Schema.Array(Schema.String),
});

/**
 * @since 0.1.0
 * @category models
 */
export type Reference = typeof Reference.Type;

/**
 * A foreign key definition.
 *
 * @since 0.1.0
 * @category models
 */
export const ForeignKey = Schema.Struct({
  columnReference: Schema.Array(Schema.String),
  reference: Reference,
});

/**
 * @since 0.1.0
 * @category models
 */
export type ForeignKey = typeof ForeignKey.Type;

/**
 * A schema description (`tableSchema`).
 *
 * @since 0.1.0
 * @category models
 */
export const TableSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  columns: Schema.Array(Column),
  primaryKey: Schema.optional(Schema.Array(Schema.String)),
  rowTitles: Schema.optional(Schema.Array(Schema.String)),
  foreignKeys: Schema.Array(ForeignKey),
  inherited: Inherited,
  common: CommonProperties,
});

/**
 * @since 0.1.0
 * @category models
 */
export type TableSchema = typeof TableSchema.Type;

/**
 * The trim flag of a dialect.
 *
 * @since 0.1.0
 * @category models
 */
export const Trim = Schema.Literals(['true', 'false', 'start', 'end']);

/**
 * @since 0.1.0
 * @category models
 */
export type Trim = typeof Trim.Type;

/**
 * A dialect description with every flag resolved (`header` folded into
 * `headerRowCount`, `skipInitialSpace` into `trim`).
 *
 * @since 0.1.0
 * @category models
 */
export const Dialect = Schema.Struct({
  id: Schema.optional(Schema.String),
  commentPrefix: Schema.optional(Schema.String),
  delimiter: Schema.String,
  isDoubleQuoted: Schema.Boolean,
  encoding: Schema.String,
  headerRowCount: Schema.Int,
  lineTerminators: Schema.Array(Schema.String),
  quoteChar: Schema.NullOr(Schema.String),
  shouldSkipBlankRows: Schema.Boolean,
  skipColumns: Schema.Int,
  skipRows: Schema.Int,
  trim: Trim,
});

/**
 * @since 0.1.0
 * @category models
 */
export type Dialect = typeof Dialect.Type;

/**
 * The default dialect: UTF-8 CSV with one header row.
 *
 * @since 0.1.0
 * @category constructors
 */
export const defaultDialect: Dialect = {
  delimiter: ',',
  isDoubleQuoted: true,
  encoding: 'utf-8',
  headerRowCount: 1,
  lineTerminators: ['\r\n', '\n'],
  quoteChar: '"',
  shouldSkipBlankRows: false,
  skipColumns: 0,
  skipRows: 0,
  trim: 'true',
};

/**
 * A transformation definition.
 *
 * @since 0.1.0
 * @category models
 */
export const Transformation = Schema.Struct({
  id: Schema.optional(Schema.String),
  url: Schema.String,
  scriptFormat: Schema.String,
  targetFormat: Schema.String,
  source: Schema.optional(Schema.String),
  titles: LanguageMap,
  common: CommonProperties,
});

/**
 * @since 0.1.0
 * @category models
 */
export type Transformation = typeof Transformation.Type;

/**
 * A table description.
 *
 * @since 0.1.0
 * @category models
 */
export const Table = Schema.Struct({
  id: Schema.optional(Schema.String),
  url: Schema.String,
  dialect: Schema.optional(Dialect),
  notes: Schema.Array(Schema.Json),
  isSuppressed: Schema.Boolean,
  tableDirection: Schema.optional(TableDirection),
  tableSchema: Schema.optional(TableSchema),
  transformations: Schema.Array(Transformation),
  inherited: Inherited,
  common: CommonProperties,
});

/**
 * @since 0.1.0
 * @category models
 */
export type Table = typeof Table.Type;

/**
 * A table group description: the normalized form of every metadata document
 * (a table description is wrapped in a group of one).
 *
 * @since 0.1.0
 * @category models
 */
export const TableGroup = Schema.Struct({
  id: Schema.optional(Schema.String),
  tables: Schema.Array(Table),
  dialect: Schema.optional(Dialect),
  notes: Schema.Array(Schema.Json),
  tableDirection: Schema.optional(TableDirection),
  tableSchema: Schema.optional(TableSchema),
  transformations: Schema.Array(Transformation),
  inherited: Inherited,
  common: CommonProperties,
});

/**
 * @since 0.1.0
 * @category models
 */
export type TableGroup = typeof TableGroup.Type;

/**
 * A decoded metadata document and the warnings raised while decoding it.
 *
 * @since 0.1.0
 * @category models
 */
export interface Decoded {
  readonly group: TableGroup;
  readonly warnings: ReadonlyArray<Report.Issue>;
}

/**
 * Fetches the JSON document a `tableSchema` or `dialect` URL references.
 *
 * @since 0.1.0
 * @category models
 */
export type Fetch = (url: string) => Effect.Effect<string, MetadataError>;

// -----------------------------------------------------------------------------
// Decoding context
// -----------------------------------------------------------------------------

type Obj = Schema.JsonObject;

interface Ctx {
  readonly url: string;
  readonly base: string;
  readonly language: Option.Option<string>;
  readonly issues: Array<Report.Issue>;
}

const warn = (ctx: Ctx, message: string): void => {
  ctx.issues.push(Report.warning(message, { table: ctx.url }));
};

const error = (ctx: Ctx, message: string): void => {
  ctx.issues.push(Report.error(message, { table: ctx.url }));
};

const quote = Json.describe;

const CSVW_CONTEXT = 'http://www.w3.org/ns/csvw';

const inheritedKeys = [
  'aboutUrl',
  'datatype',
  'default',
  'lang',
  'null',
  'ordered',
  'propertyUrl',
  'required',
  'separator',
  'textDirection',
  'valueUrl',
] as const;

type Kind =
  | 'TableGroup'
  | 'Table'
  | 'Schema'
  | 'Column'
  | 'Dialect'
  | 'Template'
  | 'Datatype'
  | 'ForeignKey'
  | 'Reference';

const ownKeys: Readonly<Record<Kind, ReadonlyArray<string>>> = {
  TableGroup: [
    'tables',
    'dialect',
    'notes',
    'tableDirection',
    'tableSchema',
    'transformations',
    ...inheritedKeys,
  ],
  Table: [
    'url',
    'dialect',
    'notes',
    'suppressOutput',
    'tableDirection',
    'tableSchema',
    'transformations',
    ...inheritedKeys,
  ],
  Schema: ['columns', 'foreignKeys', 'primaryKey', 'rowTitles', ...inheritedKeys],
  Column: ['name', 'suppressOutput', 'titles', 'virtual', ...inheritedKeys],
  Dialect: [
    'commentPrefix',
    'delimiter',
    'doubleQuote',
    'encoding',
    'header',
    'headerRowCount',
    'lineTerminators',
    'quoteChar',
    'skipBlankRows',
    'skipColumns',
    'skipInitialSpace',
    'skipRows',
    'trim',
  ],
  Template: ['url', 'scriptFormat', 'targetFormat', 'source', 'titles'],
  Datatype: [
    'base',
    'format',
    'length',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'minInclusive',
    'maxInclusive',
    'minExclusive',
    'maxExclusive',
  ],
  ForeignKey: ['columnReference', 'reference'],
  Reference: ['resource', 'schemaReference', 'columnReference'],
};

const isCommonPropertyName = (key: string): boolean => key.includes(':');

const get = (obj: Obj, key: string): Option.Option<Schema.Json> => Json.get(obj, key);

/**
 * Checks the keys of a description object: `@id` (a link that must not be a
 * blank node), `@type` (must name the kind), warnings for properties that are
 * not defined for this kind, and errors for unknown keywords.
 */
const checkKeys = (obj: Obj, kind: Kind, ctx: Ctx): void => {
  const strict = kind === 'ForeignKey' || kind === 'Reference';
  Arr.forEach(Json.keys(obj), (key) => {
    if (key === '@id') {
      const id = obj[key];
      if (Predicate.isString(id) && id.startsWith('_:'))
        error(ctx, `${kind} @id ${quote(id)} must not be a blank node`);
      else if (!Predicate.isString(id)) warn(ctx, `${kind} @id must be a string`);
      return;
    }
    if (key === '@type') {
      if (obj[key] !== kind) error(ctx, `${kind} @type must be "${kind}"`);
      return;
    }
    if (key === '@context') return;
    if (key.startsWith('@')) {
      error(ctx, `${kind} must not use the keyword ${key}`);
      return;
    }
    if (Arr.contains(ownKeys[kind], key)) return;
    if (isCommonPropertyName(key) && !strict) return;
    if (strict) error(ctx, `${kind} must not have the property ${key}`);
    else warn(ctx, `${kind} has an unknown property ${key}`);
  });
};

const idOf = (obj: Obj, ctx: Ctx): Option.Option<string> =>
  Option.flatMap(get(obj, '@id'), (id) =>
    Predicate.isString(id)
      ? id.startsWith('_:')
        ? Option.none()
        : Option.some(Url.resolve(Vocab.expand(id), ctx.base))
      : Option.some(Url.resolve('', ctx.base)),
  );

// -----------------------------------------------------------------------------
// Property value checks
// -----------------------------------------------------------------------------

const booleanProperty = (obj: Obj, key: string, ctx: Ctx): Option.Option<boolean> =>
  Option.flatMap(get(obj, key), (v) => {
    if (Predicate.isBoolean(v)) return Option.some(v);
    warn(ctx, `${key} must be a boolean, not ${quote(v)}`);
    return Option.none();
  });

const stringProperty = (obj: Obj, key: string, ctx: Ctx): Option.Option<string> =>
  Option.flatMap(get(obj, key), (v) => {
    if (Predicate.isString(v)) return Option.some(v);
    warn(ctx, `${key} must be a string, not ${quote(v)}`);
    return Option.none();
  });

const nonNegativeInteger = (obj: Obj, key: string, ctx: Ctx): Option.Option<number> =>
  Option.flatMap(get(obj, key), (v) => {
    if (Predicate.isNumber(v) && Number.isInteger(v) && v >= 0) return Option.some(v);
    warn(ctx, `${key} must be a non-negative integer, not ${quote(v)}`);
    return Option.none();
  });

const linkProperty = (obj: Obj, key: string, ctx: Ctx): Option.Option<string> =>
  Option.map(get(obj, key), (v) => {
    if (Predicate.isString(v)) return Url.resolve(v, ctx.base);
    warn(ctx, `${key} must be a string, not ${quote(v)}`);
    return Url.resolve('', ctx.base);
  });

const templateProperty = (obj: Obj, key: string, ctx: Ctx): Option.Option<string> =>
  Option.map(get(obj, key), (v) => {
    if (Predicate.isString(v)) return v;
    warn(ctx, `${key} must be a URI template string, not ${quote(v)}`);
    return '';
  });

const isLanguageTag = (tag: string): boolean => LanguageTag.isWellFormed(tag);

/** A natural-language property (§Natural Language Properties). */
const naturalLanguage = (value: Schema.Json, key: string, ctx: Ctx): LanguageMap => {
  const lang = Option.getOrElse(ctx.language, () => 'und');
  const strings = (vs: Schema.JsonArray): ReadonlyArray<string> =>
    Arr.filter(vs, (v): v is string => {
      if (Predicate.isString(v)) return true;
      warn(ctx, `${key} values must be strings, not ${quote(v)}`);
      return false;
    });
  if (Predicate.isString(value)) return { [lang]: [value] };
  if (Json.isArray(value))
    return Arr.isReadonlyArrayNonEmpty(value) ? { [lang]: strings(value) } : {};
  if (Json.isObject(value))
    return Record.fromEntries(
      Arr.flatMap(Json.entries(value), ([tag, v]) => {
        if (!isLanguageTag(tag)) {
          warn(ctx, `${key} has an invalid language tag ${quote(tag)}`);
          return [];
        }
        if (Predicate.isString(v)) return [[tag, [v]] as const];
        if (Json.isArray(v)) return [[tag, strings(v)] as const];
        warn(ctx, `${key} values must be strings, not ${quote(v)}`);
        return [];
      }),
    );
  warn(ctx, `${key} must be a string, array or language map, not ${quote(value)}`);
  return {};
};

const columnReference = (
  obj: Obj,
  key: string,
  ctx: Ctx,
  required: boolean,
): Option.Option<ReadonlyArray<string>> =>
  Option.flatMap(get(obj, key), (v) => {
    const refs = Predicate.isString(v)
      ? Option.some([v])
      : Json.isArray(v) && Arr.isReadonlyArrayNonEmpty(v) && Arr.every(v, Predicate.isString)
        ? Option.some(Arr.filter(v, Predicate.isString))
        : Option.none();
    if (Option.isNone(refs)) {
      if (required) error(ctx, `${key} must be a column name or a non-empty array of them`);
      else warn(ctx, `${key} must be a column name or a non-empty array of them`);
    }
    return refs;
  });

// -----------------------------------------------------------------------------
// Common properties (§Values of Common Properties, §Normalization)
// -----------------------------------------------------------------------------

const legitimateTypes = [
  'TableGroup',
  'Table',
  'Schema',
  'Column',
  'Dialect',
  'Template',
  'Datatype',
];

const isValidType = (t: string, valueType: boolean): boolean =>
  !t.startsWith('_:') &&
  ((valueType ? Datatype.isBuiltIn(t) : Arr.contains(legitimateTypes, t)) ||
    Record.has(Vocab.terms, t) ||
    Option.isSome(Vocab.expandPrefixed(t)) ||
    (Vocab.isAbsoluteUrl(t) && !t.includes(' ')));

const normalizeCommon = (value: Schema.Json, ctx: Ctx): Schema.Json => {
  if (Json.isArray(value)) return Arr.map(value, (v) => normalizeCommon(v, ctx));
  if (Predicate.isString(value))
    return Option.match(ctx.language, {
      onNone: () => ({ '@value': value }),
      onSome: (language) => ({ '@value': value, '@language': language }),
    });
  if (!Json.isObject(value)) return value;
  if (Json.has(value, '@value')) {
    const v = value['@value'];
    const extra = Arr.filter(
      Json.keys(value),
      (k) => !Arr.contains(['@value', '@type', '@language'], k),
    );
    if (Arr.isReadonlyArrayNonEmpty(extra))
      error(ctx, `a value object must not have the properties ${Arr.join(extra, ', ')}`);
    if (Json.has(value, '@type') && Json.has(value, '@language'))
      error(ctx, 'a value object must not have both @type and @language');
    if (!(Predicate.isString(v) || Predicate.isNumber(v) || Predicate.isBoolean(v)))
      error(ctx, '@value must be a string, number or boolean');
    Option.map(get(value, '@type'), (t) => {
      if (!Predicate.isString(t) || !isValidType(t, true))
        error(ctx, `invalid value @type ${quote(t)}`);
    });
    Option.map(get(value, '@language'), (l) => {
      if (!(Predicate.isNull(l) || (Predicate.isString(l) && isLanguageTag(l))))
        error(ctx, `invalid @language ${quote(l)}`);
    });
    return value;
  }
  return Record.fromEntries(
    Arr.map(Json.entries(value), ([key, v]): readonly [string, Schema.Json] => {
      if (key === '@id') {
        if (!Predicate.isString(v)) {
          error(ctx, '@id must be a string');
          return [key, v];
        }
        if (v.startsWith('_:')) error(ctx, `@id ${quote(v)} must not be a blank node`);
        return [key, Url.resolve(Vocab.expand(v), ctx.base)];
      }
      if (key === '@type') {
        const types = Json.isArray(v) ? v : [v];
        Arr.forEach(types, (t) => {
          if (!Predicate.isString(t) || !isValidType(t, false))
            error(ctx, `invalid node @type ${quote(t)}`);
        });
        return [key, v];
      }
      if (key === '@language') error(ctx, '@language must only be used with @value');
      else if (key === '@context') error(ctx, 'a metadata document must not add a new @context');
      else if (key === '@list' || key === '@set') error(ctx, `${key} must not be used`);
      else if (key.startsWith('@')) error(ctx, `unknown keyword ${key}`);
      return [key, normalizeCommon(v, ctx)];
    }),
  );
};

/** The common properties of a description object. */
const commonProperties = (obj: Obj, ctx: Ctx): CommonProperties =>
  Record.fromEntries(
    Arr.map(
      Arr.filter(Json.entries(obj), ([key]) => isCommonPropertyName(key) && !key.startsWith('@')),
      ([key, value]) => [key, normalizeCommon(value, ctx)] as const,
    ),
  );

const notesOf = (obj: Obj, ctx: Ctx): ReadonlyArray<Schema.Json> =>
  Option.match(get(obj, 'notes'), {
    onNone: () => [],
    onSome: (v) => {
      if (Json.isArray(v)) return Arr.map(v, (n) => normalizeCommon(n, ctx));
      warn(ctx, 'notes must be an array');
      return [];
    },
  });

// -----------------------------------------------------------------------------
// Datatypes
// -----------------------------------------------------------------------------

const bound = (obj: Obj, key: string, base: string, ctx: Ctx): Option.Option<Datatype.Bound> =>
  Option.flatMap(get(obj, key), (v) => {
    if (Predicate.isNumber(v) || Predicate.isString(v)) {
      if (Option.isNone(Datatype.boundKey(v, base)))
        error(ctx, `${key} ${quote(v)} is not a valid ${base}`);
      return Option.some(v);
    }
    warn(ctx, `${key} must be a number or string`);
    return Option.none();
  });

const sameBound = (a: Datatype.Bound, b: Datatype.Bound, base: string): boolean =>
  Option.makeEquivalence((x: number, y: number) => x === y)(
    Datatype.boundKey(a, base),
    Datatype.boundKey(b, base),
  );

/** Whether both values are present and satisfy `f`. */
const both = <A>(a: Option.Option<A>, b: Option.Option<A>, f: (x: A, y: A) => boolean): boolean =>
  Option.exists(Option.all([a, b]), ([x, y]) => f(x, y));

const of = Option.fromNullishOr;

/** Whether bound `a` is below bound `b` (`strict`) or at most `b`, in `base`'s value space. */
const below =
  (base: string, strict: boolean) =>
  (a: Datatype.Bound, b: Datatype.Bound): boolean =>
    Option.exists(Option.all([Datatype.boundKey(a, base), Datatype.boundKey(b, base)]), ([x, y]) =>
      strict ? x < y : x <= y,
    );

const hasLength = (d: Datatype.Datatype): boolean =>
  d.length !== undefined || d.minLength !== undefined || d.maxLength !== undefined;

const hasBounds = (d: Datatype.Datatype): boolean =>
  d.minInclusive !== undefined ||
  d.maxInclusive !== undefined ||
  d.minExclusive !== undefined ||
  d.maxExclusive !== undefined;

const lengthApplies = (base: string): boolean =>
  Datatype.isString(base) || Datatype.isBinary(base) || base === 'anyAtomicType';

const boundsApply = (base: string): boolean =>
  Datatype.isNumeric(base) || Datatype.isDateTime(base) || Datatype.isDuration(base);

/** The datatype constraint combinations that are errors (§Derived Datatypes). */
const datatypeRules: ReadonlyArray<
  readonly [(d: Datatype.Datatype) => boolean, (d: Datatype.Datatype) => string]
> = [
  [
    (d) => both(of(d.length), of(d.minLength), (l, m) => l < m),
    () => 'length is less than minLength',
  ],
  [
    (d) => both(of(d.length), of(d.maxLength), (l, m) => l > m),
    () => 'length is greater than maxLength',
  ],
  [
    (d) => both(of(d.minLength), of(d.maxLength), (l, m) => l > m),
    () => 'minLength is greater than maxLength',
  ],
  [
    (d) => hasLength(d) && !lengthApplies(d.base),
    (d) => `length constraints do not apply to ${d.base}`,
  ],
  [
    (d) => hasBounds(d) && !boundsApply(d.base),
    (d) => `value constraints do not apply to ${d.base}`,
  ],
  [
    (d) => both(of(d.minInclusive), of(d.minExclusive), () => true),
    () => 'minInclusive and minExclusive must not both be specified',
  ],
  [
    (d) => both(of(d.maxInclusive), of(d.maxExclusive), () => true),
    () => 'maxInclusive and maxExclusive must not both be specified',
  ],
  [
    (d) => both(of(d.maxInclusive), of(d.minInclusive), below(d.base, true)),
    () => 'maxInclusive is less than minInclusive',
  ],
  [
    (d) => both(of(d.maxExclusive), of(d.minInclusive), below(d.base, false)),
    () => 'maxExclusive is not greater than minInclusive',
  ],
  [
    (d) => both(of(d.maxExclusive), of(d.minExclusive), below(d.base, true)),
    () => 'maxExclusive is less than minExclusive',
  ],
  [
    (d) => both(of(d.maxInclusive), of(d.minExclusive), below(d.base, false)),
    () => 'maxInclusive is not greater than minExclusive',
  ],
];

const checkDatatype = (d: Datatype.Datatype, ctx: Ctx): void =>
  Arr.forEach(datatypeRules, ([violated, message]) => {
    if (violated(d)) error(ctx, message(d));
  });

const datatypeObject = (obj: Obj, ctx: Ctx): Datatype.Datatype => {
  checkKeys(obj, 'Datatype', ctx);
  const id = idOf(obj, ctx);
  if (Option.isSome(id) && Option.isSome(Datatype.fromIri(id.value))) {
    if (Arr.some(Json.keys(obj), (k) => k !== '@id' && k !== '@type'))
      error(ctx, `a datatype with the built-in @id ${id.value} must not have other properties`);
  }
  const base = Option.getOrElse(
    Option.flatMap(stringProperty(obj, 'base', ctx), (b) => {
      if (Datatype.isBuiltIn(b)) return Option.some(b);
      warn(ctx, `base ${quote(b)} is not a built-in datatype`);
      return Option.some('string');
    }),
    () => 'string',
  );
  const format = Option.flatMap(
    get(obj, 'format'),
    (f): Option.Option<string | Datatype.NumericFormat> => {
      const candidate = Predicate.isString(f)
        ? Option.some<string | Datatype.NumericFormat>(f)
        : Json.isObject(f) && Datatype.isNumeric(base)
          ? Option.some<string | Datatype.NumericFormat>({
              ...optional('decimalChar', stringProperty(f, 'decimalChar', ctx)),
              ...optional('groupChar', stringProperty(f, 'groupChar', ctx)),
              ...optional('pattern', stringProperty(f, 'pattern', ctx)),
            })
          : Option.none();
      if (Option.isNone(candidate)) {
        warn(ctx, `invalid format for a ${base} datatype`);
        return Option.none();
      }
      return Option.match(Datatype.checkFormat(base, candidate.value), {
        onNone: () => candidate,
        onSome: (message) => {
          warn(ctx, message);
          return Option.none();
        },
      });
    },
  );
  const minimum = bound(obj, 'minimum', base, ctx);
  const maximum = bound(obj, 'maximum', base, ctx);
  const minInclusive = bound(obj, 'minInclusive', base, ctx);
  const maxInclusive = bound(obj, 'maxInclusive', base, ctx);
  if (
    Option.isSome(minimum) &&
    Option.isSome(minInclusive) &&
    !sameBound(minimum.value, minInclusive.value, base)
  )
    error(ctx, 'minimum and minInclusive differ');
  if (
    Option.isSome(maximum) &&
    Option.isSome(maxInclusive) &&
    !sameBound(maximum.value, maxInclusive.value, base)
  )
    error(ctx, 'maximum and maxInclusive differ');
  const datatype: Datatype.Datatype = {
    base,
    ...optional('id', id),
    ...optional('format', format),
    ...optional('length', nonNegativeInteger(obj, 'length', ctx)),
    ...optional('minLength', nonNegativeInteger(obj, 'minLength', ctx)),
    ...optional('maxLength', nonNegativeInteger(obj, 'maxLength', ctx)),
    ...optional(
      'minInclusive',
      Option.orElse(minInclusive, () => minimum),
    ),
    ...optional(
      'maxInclusive',
      Option.orElse(maxInclusive, () => maximum),
    ),
    ...optional('minExclusive', bound(obj, 'minExclusive', base, ctx)),
    ...optional('maxExclusive', bound(obj, 'maxExclusive', base, ctx)),
    common: commonProperties(obj, ctx),
  };
  checkDatatype(datatype, ctx);
  return datatype;
};

const datatypeProperty = (value: Schema.Json, ctx: Ctx): Option.Option<Datatype.Datatype> => {
  if (Predicate.isString(value)) {
    if (Datatype.isBuiltIn(value)) return Option.some({ base: value, common: {} });
    warn(ctx, `datatype ${quote(value)} is not a built-in datatype`);
    return Option.some(Datatype.string);
  }
  if (Json.isObject(value)) return Option.some(datatypeObject(value, ctx));
  warn(ctx, `datatype must be a string or object, not ${quote(value)}`);
  return Option.some(Datatype.string);
};

// -----------------------------------------------------------------------------
// Inherited properties
// -----------------------------------------------------------------------------

/** A `separator`: a string, or `null` for none (overriding an inherited one). */
type Separator = Exclude<Inherited['separator'], undefined>;

const inheritedOf = (obj: Obj, ctx: Ctx): Inherited => {
  const nulls = Option.flatMap(get(obj, 'null'), (v): Option.Option<ReadonlyArray<string>> => {
    if (Predicate.isString(v)) return Option.some([v]);
    if (Json.isArray(v)) {
      const strings = Arr.filter(v, Predicate.isString);
      if (Arr.length(strings) !== Arr.length(v)) warn(ctx, 'null values must be strings');
      return Option.some(strings);
    }
    warn(ctx, `null must be a string or array of strings, not ${quote(v)}`);
    return Option.some(['']);
  });
  const lang = Option.flatMap(stringProperty(obj, 'lang', ctx), (l) => {
    if (isLanguageTag(l)) return Option.some(l);
    warn(ctx, `lang ${quote(l)} is not a valid language tag`);
    return Option.some('und');
  });
  const separator = Option.flatMap(get(obj, 'separator'), (v): Option.Option<Separator> => {
    if (Predicate.isString(v) || Predicate.isNull(v)) return Option.some(v);
    warn(ctx, `separator must be a string or null, not ${quote(v)}`);
    return Option.some(null);
  });
  const textDirection = Option.flatMap(
    get(obj, 'textDirection'),
    (v): Option.Option<TextDirection> => {
      if (v === 'ltr' || v === 'rtl' || v === 'auto' || v === 'inherit') return Option.some(v);
      warn(ctx, `textDirection must be "ltr", "rtl", "auto" or "inherit", not ${quote(v)}`);
      return Option.some('inherit');
    },
  );
  const defaultValue = Option.flatMap(get(obj, 'default'), (v) => {
    if (Predicate.isString(v)) return Option.some(v);
    warn(ctx, `default must be a string, not ${quote(v)}`);
    return Option.some('');
  });
  const flag = (key: string) =>
    Option.flatMap(get(obj, key), (v) => {
      if (Predicate.isBoolean(v)) return Option.some(v);
      warn(ctx, `${key} must be a boolean, not ${quote(v)}`);
      return Option.some(false);
    });
  return {
    ...optional('aboutUrl', templateProperty(obj, 'aboutUrl', ctx)),
    ...optional(
      'datatype',
      Option.flatMap(get(obj, 'datatype'), (v) => datatypeProperty(v, ctx)),
    ),
    ...optional('default', defaultValue),
    ...optional('lang', lang),
    ...optional('null', nulls),
    ...optional('ordered', flag('ordered')),
    ...optional('propertyUrl', templateProperty(obj, 'propertyUrl', ctx)),
    ...optional('required', flag('required')),
    ...optional('separator', separator),
    ...optional('textDirection', textDirection),
    ...optional('valueUrl', templateProperty(obj, 'valueUrl', ctx)),
  };
};

// -----------------------------------------------------------------------------
// Columns and schemas
// -----------------------------------------------------------------------------

const COLUMN_NAME = /^(?:[A-Za-z0-9]|%[0-9A-Fa-f]{2})(?:[A-Za-z0-9_.]|%[0-9A-Fa-f]{2})*$/;

const columnOf = (obj: Obj, ctx: Ctx): Column => {
  checkKeys(obj, 'Column', ctx);
  const titles = Option.match(get(obj, 'titles'), {
    onNone: () => ({}),
    onSome: (v) => naturalLanguage(v, 'titles', ctx),
  });
  const name = Option.flatMap(get(obj, 'name'), (v) => {
    if (!Predicate.isString(v)) {
      warn(ctx, `column name must be a string, not ${quote(v)}`);
      return Option.none();
    }
    if (!COLUMN_NAME.test(v) || v.startsWith('_')) {
      warn(ctx, `invalid column name ${quote(v)}`);
      return Option.none();
    }
    return Option.some(v);
  });
  return {
    ...optional('id', idOf(obj, ctx)),
    ...optional('name', name),
    ...optional(
      'titleName',
      Option.flatMap(
        Record.get(
          titles,
          Option.getOrElse(ctx.language, () => 'und'),
        ),
        Arr.head,
      ),
    ),
    titles,
    isVirtual: Option.getOrElse(booleanProperty(obj, 'virtual', ctx), () => false),
    isSuppressed: Option.getOrElse(booleanProperty(obj, 'suppressOutput', ctx), () => false),
    inherited: inheritedOf(obj, ctx),
    common: commonProperties(obj, ctx),
  };
};

const arrayProperty = (obj: Obj, key: string, ctx: Ctx): ReadonlyArray<Obj> =>
  Option.match(get(obj, key), {
    onNone: () => [],
    onSome: (v) => {
      if (!Json.isArray(v)) {
        warn(ctx, `${key} must be an array`);
        return [];
      }
      return Arr.filter(v, (item): item is Obj => {
        if (Json.isObject(item)) return true;
        warn(ctx, `${key} items must be objects, not ${quote(item)}`);
        return false;
      });
    },
  });

const foreignKeyOf = (obj: Obj, ctx: Ctx): Option.Option<ForeignKey> => {
  checkKeys(obj, 'ForeignKey', ctx);
  const columns = columnReference(obj, 'columnReference', ctx, true);
  const reference = Option.flatMap(get(obj, 'reference'), (r): Option.Option<Reference> => {
    if (!Json.isObject(r)) {
      error(ctx, 'foreign key reference must be an object');
      return Option.none();
    }
    checkKeys(r, 'Reference', ctx);
    const resource = linkProperty(r, 'resource', ctx);
    const schemaReference = linkProperty(r, 'schemaReference', ctx);
    if (Option.isSome(resource) === Option.isSome(schemaReference))
      error(ctx, 'foreign key reference needs exactly one of resource and schemaReference');
    return Option.map(columnReference(r, 'columnReference', ctx, true), (cols) => ({
      ...optional('resource', resource),
      ...optional('schemaReference', schemaReference),
      columnReference: cols,
    }));
  });
  if (Option.isNone(reference) && !Json.has(obj, 'reference'))
    error(ctx, 'foreign key needs a reference');
  return Option.map(Option.all([columns, reference]), ([from, to]) => ({
    columnReference: from,
    reference: to,
  }));
};

const schemaOf = (obj: Obj, ctx: Ctx): TableSchema => {
  checkKeys(obj, 'Schema', ctx);
  const columns = Arr.map(arrayProperty(obj, 'columns', ctx), (c) => columnOf(c, ctx));
  const names = Arr.getSomes(Arr.map(columns, (c) => Option.fromNullishOr(c.name)));
  if (Arr.length(Arr.dedupe(names)) !== Arr.length(names))
    error(ctx, 'column names must be unique');
  const firstVirtual = Arr.findFirstIndex(columns, (c) => c.isVirtual);
  if (Option.exists(firstVirtual, (i) => Arr.some(Arr.drop(columns, i), (c) => !c.isVirtual)))
    error(ctx, 'virtual columns must follow every non-virtual column');
  const references = (key: string) =>
    Option.flatMap(columnReference(obj, key, ctx, false), (refs) => {
      if (Arr.every(refs, (r) => Arr.contains(names, r))) return Option.some(refs);
      warn(ctx, `${key} references a column that does not exist`);
      return Option.none();
    });
  const foreignKeys = Arr.getSomes(
    Arr.map(arrayProperty(obj, 'foreignKeys', ctx), (fk) => foreignKeyOf(fk, ctx)),
  );
  Arr.forEach(foreignKeys, (fk) => {
    if (!Arr.every(fk.columnReference, (r) => Arr.contains(names, r)))
      error(ctx, 'foreign key columnReference references a column that does not exist');
  });
  return {
    ...optional('id', idOf(obj, ctx)),
    columns,
    ...optional('primaryKey', references('primaryKey')),
    ...optional('rowTitles', references('rowTitles')),
    foreignKeys,
    inherited: inheritedOf(obj, ctx),
    common: commonProperties(obj, ctx),
  };
};

// -----------------------------------------------------------------------------
// Dialects and transformations
// -----------------------------------------------------------------------------

const isEncoding = (encoding: string): boolean =>
  Result.isSuccess(Result.try(() => new TextDecoder(encoding)));

const dialectOf = (obj: Obj, ctx: Ctx): Dialect => {
  checkKeys(obj, 'Dialect', ctx);
  const d = defaultDialect;
  const header = booleanProperty(obj, 'header', ctx);
  const headerRowCount = nonNegativeInteger(obj, 'headerRowCount', ctx);
  const skipInitialSpace = booleanProperty(obj, 'skipInitialSpace', ctx);
  const trim = Option.flatMap(get(obj, 'trim'), (v): Option.Option<Trim> => {
    if (Predicate.isBoolean(v)) return Option.some(v ? 'true' : 'false');
    if (v === 'true' || v === 'false' || v === 'start' || v === 'end') return Option.some(v);
    warn(ctx, `trim must be a boolean or "true", "false", "start" or "end", not ${quote(v)}`);
    return Option.none();
  });
  const quoteChar = Option.flatMap(
    get(obj, 'quoteChar'),
    (v): Option.Option<Dialect['quoteChar']> => {
      if (Predicate.isString(v) || Predicate.isNull(v)) return Option.some(v);
      warn(ctx, `quoteChar must be a string or null, not ${quote(v)}`);
      return Option.none();
    },
  );
  const lineTerminators = Option.flatMap(
    get(obj, 'lineTerminators'),
    (v): Option.Option<ReadonlyArray<string>> => {
      if (Predicate.isString(v)) return Option.some([v]);
      if (Json.isArray(v) && Arr.every(v, Predicate.isString))
        return Option.some(Arr.filter(v, Predicate.isString));
      warn(ctx, 'lineTerminators must be a string or an array of strings');
      return Option.none();
    },
  );
  const encoding = Option.flatMap(stringProperty(obj, 'encoding', ctx), (e) => {
    if (isEncoding(e)) return Option.some(e);
    warn(ctx, `unknown encoding ${quote(e)}`);
    return Option.none();
  });
  return {
    ...optional('id', idOf(obj, ctx)),
    ...optional('commentPrefix', stringProperty(obj, 'commentPrefix', ctx)),
    delimiter: Option.getOrElse(stringProperty(obj, 'delimiter', ctx), () => d.delimiter),
    isDoubleQuoted: Option.getOrElse(
      booleanProperty(obj, 'doubleQuote', ctx),
      () => d.isDoubleQuoted,
    ),
    encoding: Option.getOrElse(encoding, () => d.encoding),
    headerRowCount: Option.getOrElse(headerRowCount, () =>
      Option.getOrElse(
        Option.map(header, (h) => (h ? 1 : 0)),
        () => d.headerRowCount,
      ),
    ),
    lineTerminators: Option.getOrElse(lineTerminators, () => d.lineTerminators),
    quoteChar: Option.getOrElse(quoteChar, () => d.quoteChar),
    shouldSkipBlankRows: Option.getOrElse(
      booleanProperty(obj, 'skipBlankRows', ctx),
      () => d.shouldSkipBlankRows,
    ),
    skipColumns: Option.getOrElse(nonNegativeInteger(obj, 'skipColumns', ctx), () => d.skipColumns),
    skipRows: Option.getOrElse(nonNegativeInteger(obj, 'skipRows', ctx), () => d.skipRows),
    trim: Option.getOrElse(trim, () =>
      Option.getOrElse(
        Option.map(skipInitialSpace, (s): Trim => (s ? 'start' : 'false')),
        () => d.trim,
      ),
    ),
  };
};

const transformationOf = (obj: Obj, ctx: Ctx): Option.Option<Transformation> => {
  checkKeys(obj, 'Template', ctx);
  const required = (key: string) => {
    const v = linkProperty(obj, key, ctx);
    if (Option.isNone(v)) error(ctx, `transformation needs ${key}`);
    return v;
  };
  const url = required('url');
  const scriptFormat = required('scriptFormat');
  const targetFormat = required('targetFormat');
  const source = Option.flatMap(stringProperty(obj, 'source', ctx), (s) => {
    if (s === 'json' || s === 'rdf') return Option.some(s);
    warn(ctx, `transformation source must be "json" or "rdf", not ${quote(s)}`);
    return Option.none();
  });
  return Option.map(Option.all([url, scriptFormat, targetFormat]), ([u, sf, tf]) => ({
    ...optional('id', idOf(obj, ctx)),
    url: u,
    scriptFormat: sf,
    targetFormat: tf,
    ...optional('source', source),
    titles: Option.match(get(obj, 'titles'), {
      onNone: () => ({}),
      onSome: (v) => naturalLanguage(v, 'titles', ctx),
    }),
    common: commonProperties(obj, ctx),
  }));
};

const tableDirectionOf = (obj: Obj, ctx: Ctx): Option.Option<TableDirection> =>
  Option.flatMap(get(obj, 'tableDirection'), (v): Option.Option<TableDirection> => {
    if (v === 'ltr' || v === 'rtl' || v === 'auto') return Option.some(v);
    warn(ctx, `tableDirection must be "ltr", "rtl" or "auto", not ${quote(v)}`);
    return Option.some('auto');
  });

// -----------------------------------------------------------------------------
// Object properties referencing other documents
// -----------------------------------------------------------------------------

interface Located {
  readonly obj: Obj;
  readonly ctx: Ctx;
}

const contextOf = (
  doc: Obj,
  url: string,
  issues: Array<Report.Issue>,
  required: boolean,
): Result.Result<Ctx, MetadataError> => {
  const fail = (message: string) => Result.fail(new MetadataError({ message, url }));
  const ctx: Ctx = { url, base: url, language: Option.none(), issues };
  return Option.match(get(doc, '@context'), {
    onNone: () =>
      required ? fail('a metadata document must have a @context') : Result.succeed(ctx),
    onSome: (c) => {
      if (c === CSVW_CONTEXT) return Result.succeed(ctx);
      if (!Json.isArray(c) || Arr.length(c) !== 2 || c[0] !== CSVW_CONTEXT)
        return fail(`@context must be "${CSVW_CONTEXT}" or ["${CSVW_CONTEXT}", {…}]`);
      const local = c[1];
      if (local === undefined || !Json.isObject(local))
        return fail('the local @context must be an object');
      const others = Arr.filter(Json.keys(local), (k) => k !== '@base' && k !== '@language');
      if (Arr.isReadonlyArrayNonEmpty(others))
        return fail(
          `the local @context must only define @base and @language, not ${Arr.join(others, ', ')}`,
        );
      const base = Option.match(get(local, '@base'), {
        onNone: () => url,
        onSome: (b) => {
          if (Predicate.isString(b)) return Url.resolve(b, url);
          issues.push(Report.warning('@base must be a string', { table: url }));
          return url;
        },
      });
      const language = Option.flatMap(get(local, '@language'), (l) => {
        if (Predicate.isString(l) && isLanguageTag(l)) return Option.some(l);
        issues.push(
          Report.warning(`@language ${quote(l)} is not a valid language tag`, { table: url }),
        );
        return Option.none();
      });
      return Result.succeed({ url, base, language, issues });
    },
  });
};

const parseDocument = (text: string, url: string): Result.Result<Schema.Json, MetadataError> =>
  Result.mapError(
    Json.parseJson(text),
    (message) => new MetadataError({ message: `invalid JSON: ${message}`, url }),
  );

const objectProperty = (
  obj: Obj,
  key: string,
  ctx: Ctx,
  load: Fetch,
): Effect.Effect<Option.Option<Located>, MetadataError> =>
  Option.match(get(obj, key), {
    onNone: () => Effect.succeedNone,
    onSome: (v) => {
      if (Json.isObject(v)) {
        if (Json.has(v, '@context')) error(ctx, `${key} must not have a @context`);
        return Effect.succeedSome({ obj: v, ctx });
      }
      if (Predicate.isString(v)) {
        const url = Url.resolve(v, ctx.base);
        return Effect.flatMap(load(url), (text) =>
          Effect.fromResult(
            Result.flatMap(parseDocument(text, url), (doc) => {
              if (!Json.isObject(doc))
                return Result.fail(new MetadataError({ message: `${key} must be an object`, url }));
              return Result.map(contextOf(doc, url, ctx.issues, false), (sub) =>
                Option.some({
                  obj: Json.has(doc, '@id') ? doc : Json.set(doc, '@id', url),
                  ctx: sub,
                }),
              );
            }),
          ),
        );
      }
      warn(ctx, `${key} must be an object or a URL, not ${quote(v)}`);
      return Effect.succeedSome({ obj: {}, ctx });
    },
  });

// -----------------------------------------------------------------------------
// Tables and table groups
// -----------------------------------------------------------------------------

/** The properties table and table group descriptions share. */
const sharedProperties = Effect.fnUntraced(function* (obj: Obj, ctx: Ctx, load: Fetch) {
  const schema = yield* objectProperty(obj, 'tableSchema', ctx, load);
  const dialect = yield* objectProperty(obj, 'dialect', ctx, load);
  return {
    ...optional('id', idOf(obj, ctx)),
    ...optional(
      'dialect',
      Option.map(dialect, (d) => dialectOf(d.obj, d.ctx)),
    ),
    notes: notesOf(obj, ctx),
    ...optional('tableDirection', tableDirectionOf(obj, ctx)),
    ...optional(
      'tableSchema',
      Option.map(schema, (s) => schemaOf(s.obj, s.ctx)),
    ),
    transformations: Arr.getSomes(
      Arr.map(arrayProperty(obj, 'transformations', ctx), (t) => transformationOf(t, ctx)),
    ),
    inherited: inheritedOf(obj, ctx),
    common: commonProperties(obj, ctx),
  };
});

const describedTable = Effect.fnUntraced(function* (obj: Obj, ctx: Ctx, load: Fetch) {
  checkKeys(obj, 'Table', ctx);
  const url = linkProperty(obj, 'url', ctx);
  if (Option.isNone(url) || !Predicate.isString(obj['url'])) error(ctx, 'a table must have a url');
  const shared = yield* sharedProperties(obj, ctx, load);
  const table: Table = {
    ...shared,
    url: Option.getOrElse(url, () => ctx.base),
    isSuppressed: Option.getOrElse(booleanProperty(obj, 'suppressOutput', ctx), () => false),
  };
  return table;
});

const describedGroup = Effect.fnUntraced(function* (obj: Obj, ctx: Ctx, load: Fetch) {
  checkKeys(obj, 'TableGroup', ctx);
  const tables = yield* Effect.forEach(
    arrayProperty(obj, 'tables', ctx),
    (t) => describedTable(t, ctx, load),
    { concurrency: 1 },
  );
  if (!Arr.isReadonlyArrayNonEmpty(tables))
    error(ctx, 'a table group must have at least one table');
  const shared = yield* sharedProperties(obj, ctx, load);
  const group: TableGroup = { ...shared, tables };
  return group;
});

/**
 * Decodes a parsed metadata document found at `url` into a normalized table
 * group (a table description becomes a group of one), fetching the schemas
 * and dialects it references by URL with `load`. Warnings are returned with
 * the group; errors fail with `MetadataError`.
 *
 * @since 0.1.0
 * @category decoding
 */
export const decodeJson = Effect.fnUntraced(function* (
  document: Schema.Json,
  url: string,
  load: Fetch,
): Effect.fn.Return<Decoded, MetadataError> {
  if (!Json.isObject(document))
    return yield* new MetadataError({ message: 'a metadata document must be an object', url });
  const issues: Array<Report.Issue> = [];
  const ctx = yield* Effect.fromResult(contextOf(document, url, issues, true));
  const isGroup = Json.has(document, 'tables');
  if (!isGroup && !Json.has(document, 'url')) {
    return yield* new MetadataError({
      message: 'a metadata document must describe a table group (tables) or a table (url)',
      url,
    });
  }
  const group: TableGroup = isGroup
    ? yield* describedGroup(document, ctx, load)
    : {
        tables: [yield* describedTable(document, ctx, load)],
        notes: [],
        transformations: [],
        inherited: {},
        common: {},
      };
  const first = Arr.findFirst(issues, (i) => i.level === 'error');
  if (Option.isSome(first)) return yield* new MetadataError({ message: first.value.message, url });
  return { group, warnings: issues };
});

/**
 * Decodes metadata text found at `url` (see `decodeJson`); invalid JSON fails
 * with `MetadataError`.
 *
 * @since 0.1.0
 * @category decoding
 */
export const decode = (
  text: string,
  url: string,
  load: Fetch,
): Effect.Effect<Decoded, MetadataError> =>
  Effect.flatMap(Effect.fromResult(parseDocument(text, url)), (doc) => decodeJson(doc, url, load));

/**
 * A `Fetch` that fails for every URL: for metadata that references no other
 * document.
 *
 * @since 0.1.0
 * @category decoding
 */
export const noFetch: Fetch = (url) =>
  Effect.fail(new MetadataError({ message: `cannot fetch ${url}`, url }));

// -----------------------------------------------------------------------------
// Inheritance, names and compatibility
// -----------------------------------------------------------------------------

/**
 * The effective inherited properties of a column: its own, then its schema's,
 * its table's and its group's.
 *
 * @since 0.1.0
 * @category inheritance
 */
export const inherit = (...levels: ReadonlyArray<Inherited>): Inherited =>
  Arr.reduceRight(levels, noInherited, (acc, level) => ({ ...acc, ...level }));

const noInherited: Inherited = {};

/**
 * The table's effective schema: its own, or its group's.
 *
 * @since 0.1.0
 * @category inheritance
 */
export const schemaOfTable = (group: TableGroup, table: Table): Option.Option<TableSchema> =>
  Option.orElse(Option.fromNullishOr(table.tableSchema), () =>
    Option.fromNullishOr(group.tableSchema),
  );

/**
 * The table's effective dialect: its own, its group's, or the default.
 *
 * @since 0.1.0
 * @category inheritance
 */
export const dialectOfTable = (group: TableGroup, table: Table): Dialect =>
  table.dialect ?? group.dialect ?? defaultDialect;

/**
 * Whether two language tags match for title comparison: `und` matches any
 * language, and tags match when equal after truncation to the shorter one.
 *
 * @since 0.1.0
 * @category compatibility
 */
export const languagesMatch = (a: string, b: string): boolean => {
  if (a === 'und' || b === 'und') return true;
  const x = a.toLowerCase().split('-');
  const y = b.toLowerCase().split('-');
  const n = Math.min(Arr.length(x), Arr.length(y));
  return Arr.join(Arr.take(x, n), '-') === Arr.join(Arr.take(y, n), '-');
};

const titleEntries = (titles: LanguageMap): ReadonlyArray<readonly [string, string]> =>
  Arr.flatMap(Record.toEntries(titles), ([lang, ts]) => Arr.map(ts, (t) => [lang, t] as const));

/**
 * Whether two column descriptions are compatible (§Schema Compatibility).
 *
 * @since 0.1.0
 * @category compatibility
 */
export const columnsCompatible = (a: Column, b: Column, validating: boolean): boolean => {
  const aTitles = titleEntries(a.titles);
  const bTitles = titleEntries(b.titles);
  const aEmpty = a.name === undefined && !Arr.isReadonlyArrayNonEmpty(aTitles);
  const bEmpty = b.name === undefined && !Arr.isReadonlyArrayNonEmpty(bTitles);
  if (aEmpty || bEmpty) return true;
  if (a.name !== undefined && a.name === b.name) return true;
  if (
    Arr.some(aTitles, ([la, ta]) =>
      Arr.some(bTitles, ([lb, tb]) => ta === tb && languagesMatch(la, lb)),
    )
  )
    return true;
  if (!validating) {
    const nameOnly = (c: Column, ts: ReadonlyArray<unknown>) =>
      c.name !== undefined && !Arr.isReadonlyArrayNonEmpty(ts);
    const titlesOnly = (c: Column, ts: ReadonlyArray<unknown>) =>
      c.name === undefined && Arr.isReadonlyArrayNonEmpty(ts);
    if (
      (nameOnly(a, aTitles) && titlesOnly(b, bTitles)) ||
      (titlesOnly(a, aTitles) && nameOnly(b, bTitles))
    )
      return true;
  }
  return false;
};

/**
 * Checks a table's schema against the columns embedded in its data
 * (§Schema Compatibility), returning the reason they are incompatible.
 *
 * @since 0.1.0
 * @category compatibility
 */
export const checkCompatible = (
  schema: ReadonlyArray<Column>,
  embedded: ReadonlyArray<Column>,
  validating: boolean,
): Option.Option<string> => {
  const real = Arr.filter(schema, (c) => !c.isVirtual);
  if (Arr.length(real) !== Arr.length(embedded))
    return Option.some(
      `the metadata describes ${Arr.length(real)} columns but the data has ${Arr.length(embedded)}`,
    );
  return Option.map(
    Arr.findFirstIndex(Arr.zip(real, embedded), ([a, b]) => !columnsCompatible(a, b, validating)),
    (i) => `column ${i + 1} of the metadata is not compatible with the data's header`,
  );
};

/**
 * Whether a table group describes the table at `url` (URLs compared after
 * normalization).
 *
 * @since 0.1.0
 * @category compatibility
 */
export const describes = (group: TableGroup, url: string): boolean =>
  Arr.some(group.tables, (t) => Url.normalize(t.url) === Url.normalize(url));
