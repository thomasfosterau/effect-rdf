/**
 * Effect `Schema`s that decode RDF terms to JavaScript values and encode them
 * back: typed access to the objects of a `Dataset`, SPARQL solutions, SHACL
 * or ShEx results and XMP properties.
 *
 * ```ts
 * const Person = Schema.Struct({
 *   name: TermCodec.string,
 *   age: Schema.optional(TermCodec.integer),
 *   homepage: Schema.optional(TermCodec.iri),
 * })
 * // QueryBuilder.decode(query, Person) : Stream<{ name: string; age?: number; … }>
 * ```
 *
 * Each schema's encoded side is a `Term.GroundTerm`, its decoded side a JS
 * value. Decoding fails (with a schema issue) when the term has the wrong
 * kind or datatype. Because `Term.GroundTermSchema` has a JSON codec,
 * `Schema.toCodecJson` of a struct of these codecs encodes to JSON terms.
 *
 * This module moved here from `@thomasfosterau/effect-sparql/TermSchema`,
 * which re-exports it.
 *
 * @since 0.1.0
 */
import * as BigDecimal from 'effect/BigDecimal';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as Term from './Term.ts';
import * as Xsd from './Xsd.ts';
import * as Predicate from 'effect/Predicate';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * A schema decoding a term to a JS value of type `A`.
 *
 * @since 0.1.0
 * @category models
 */
export type TermCodec<A> = Schema.Codec<A, Term.GroundTerm>;

/**
 * Builds a term codec from a (fallible) decoder and an encoder.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = <A>(
  target: Schema.Codec<A>,
  options: {
    readonly expected: string;
    readonly decode: (term: Term.GroundTerm) => A | undefined;
    readonly encode: (value: A) => Term.GroundTerm;
  },
): TermCodec<A> =>
  Term.GroundTermSchema.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformEffect({
        decode: (term: Term.GroundTerm) => {
          const value = options.decode(term);
          return value === undefined
            ? Effect.fail(
                new SchemaIssue.InvalidValue(
                  { message: `Expected ${options.expected}, got ${term.toString()}` },
                  term,
                ),
              )
            : Effect.succeed(value);
        },
        encode: (value: A) => Effect.succeed(options.encode(value)),
      }),
    ),
  );

const numericValue = (t: Term.GroundTerm): Option.Option<number> => {
  if (!Term.isLiteral(t) || !Xsd.isNumericDatatype(t.datatype.value)) return Option.none();
  if (!Xsd.isValidLexical(t.datatype.value, t.value)) return Option.none();
  const v = Xsd.toValue(t);
  return Match.value(v).pipe(
    Match.tag('Integer', (i) => Option.some(Number(i.value))),
    Match.tag('Decimal', (d) => Option.some(BigDecimal.toNumberUnsafe(d.value))),
    Match.tag('Float', 'Double', (f) => Option.some(f.value)),
    Match.orElse(() => Option.none()),
  );
};

/**
 * Any RDF term (identity).
 *
 * @since 0.1.0
 * @category schemas
 */
export const term: TermCodec<Term.GroundTerm> = Term.GroundTermSchema;

/**
 * An IRI, decoded to a `NamedNode`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const namedNode: TermCodec<Term.NamedNode> = make(Term.NamedNodeSchema, {
  expected: 'an IRI',
  decode: (t) => (Term.isNamedNode(t) ? t : undefined),
  encode: (n) => n,
});

/**
 * An IRI, decoded to its string.
 *
 * @since 0.1.0
 * @category schemas
 */
export const iri: TermCodec<string> = make(Schema.String, {
  expected: 'an IRI',
  decode: (t) => (Term.isNamedNode(t) ? t.value : undefined),
  encode: (s) => Term.namedNode(s),
});

/**
 * A blank node or IRI (a resource), decoded to the term.
 *
 * @since 0.1.0
 * @category schemas
 */
export const resource: TermCodec<Term.Resource> = make(
  Schema.declare((u): u is Term.Resource => Term.isResource(u)),
  {
    expected: 'an IRI or blank node',
    decode: (t) => (Term.isResource(t) ? t : undefined),
    encode: (r) => r,
  },
);

/**
 * Any literal, decoded to the `Literal` term.
 *
 * @since 0.1.0
 * @category schemas
 */
export const literal: TermCodec<Term.Literal> = make(Term.LiteralSchema, {
  expected: 'a literal',
  decode: (t) => (Term.isLiteral(t) ? t : undefined),
  encode: (l) => l,
});

/**
 * A string literal (simple, `xsd:string` or language-tagged), decoded to its
 * lexical form. Encodes to `xsd:string`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const string: TermCodec<string> = make(Schema.String, {
  expected: 'a string literal',
  decode: (t) =>
    Term.isLiteral(t) && (t.language !== '' || t.datatype.value === Term.XSD_STRING)
      ? t.value
      : undefined,
  encode: (s) => Term.literal(s),
});

/**
 * The lexical form of any literal, or the string of an IRI.
 *
 * @since 0.1.0
 * @category schemas
 */
export const lexical: TermCodec<string> = make(Schema.String, {
  expected: 'a literal or IRI',
  decode: (t) => (Term.isLiteral(t) || Term.isNamedNode(t) ? t.value : undefined),
  encode: (s) => Term.literal(s),
});

/**
 * A language-tagged string, decoded to `{ value, language, direction? }`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const langString: TermCodec<{
  readonly value: string;
  readonly language: string;
  readonly direction?: Term.Direction | undefined;
}> = make(
  Schema.Struct({
    value: Schema.String,
    language: Schema.String,
    direction: Schema.optional(Schema.Literals(['ltr', 'rtl'])),
  }),
  {
    expected: 'a language-tagged string',
    decode: (t) =>
      Term.isLiteral(t) && t.language !== ''
        ? t.direction !== undefined
          ? { value: t.value, language: t.language, direction: t.direction }
          : { value: t.value, language: t.language }
        : undefined,
    encode: (v) => Term.literal(v.value, { language: v.language, direction: v.direction }),
  },
);

/**
 * Any numeric literal, decoded to a JS number. Encodes to `xsd:double`
 * (or `xsd:integer` for integral values).
 *
 * @since 0.1.0
 * @category schemas
 */
export const number: TermCodec<number> = make(Schema.Number, {
  expected: 'a numeric literal',
  decode: (t) => Option.getOrUndefined(numericValue(t)),
  encode: (n) => (Number.isInteger(n) ? Xsd.integer(n) : Xsd.double(n)),
});

/**
 * An integer literal (`xsd:integer` and derived types), decoded to a JS
 * number.
 *
 * @since 0.1.0
 * @category schemas
 */
export const integer: TermCodec<number> = make(Schema.Number, {
  expected: 'an integer literal',
  decode: (t) =>
    Term.isLiteral(t) && Xsd.isIntegerDatatype(t.datatype.value)
      ? Option.getOrUndefined(numericValue(t))
      : undefined,
  encode: (n) => Xsd.integer(n),
});

/**
 * An integer literal decoded to a `bigint` (no precision loss).
 *
 * @since 0.1.0
 * @category schemas
 */
export const bigint: TermCodec<bigint> = make(Schema.BigInt, {
  expected: 'an integer literal',
  decode: (t) =>
    Term.isLiteral(t) &&
    Xsd.isIntegerDatatype(t.datatype.value) &&
    Xsd.isValidLexical(t.datatype.value, t.value)
      ? BigInt(t.value)
      : undefined,
  encode: (n) => Xsd.integer(n),
});

/**
 * A decimal (or integer) literal decoded to a `BigDecimal`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const decimal: TermCodec<BigDecimal.BigDecimal> = make(
  Schema.declare((u): u is BigDecimal.BigDecimal => BigDecimal.isBigDecimal(u)),
  {
    expected: 'a decimal literal',
    decode: (t) => {
      if (!Term.isLiteral(t)) return undefined;
      const v = Xsd.toValue(t);
      return Predicate.isTagged(v, 'Decimal')
        ? v.value
        : Predicate.isTagged(v, 'Integer')
          ? BigDecimal.fromBigInt(v.value)
          : undefined;
    },
    encode: (d) => Xsd.decimal(d),
  },
);

/**
 * An `xsd:boolean` literal.
 *
 * @since 0.1.0
 * @category schemas
 */
export const boolean: TermCodec<boolean> = make(Schema.Boolean, {
  expected: 'a boolean literal',
  decode: (t) => {
    if (!Term.isLiteral(t) || t.datatype.value !== `${XSD}boolean`) return undefined;
    const v = Xsd.toValue(t);
    return Predicate.isTagged(v, 'Boolean') ? v.value : undefined;
  },
  encode: (b) => Xsd.boolean(b),
});

/**
 * An `xsd:dateTime` or `xsd:date` literal decoded to a `Date`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const date: TermCodec<Date> = make(Schema.Date, {
  expected: 'an xsd:dateTime or xsd:date literal',
  decode: (t) => {
    if (!Term.isLiteral(t)) return undefined;
    const v = Xsd.toValue(t);
    // An instant outside the range of `Date` does not decode.
    return Predicate.isTagged(v, 'DateTime') && (v.kind === 'dateTime' || v.kind === 'date')
      ? Option.getOrUndefined(Option.map(DateTime.make(v.epochMillis), DateTime.toDateUtc))
      : undefined;
  },
  encode: (d) => Xsd.dateTime(d),
});

/**
 * A literal decoded to its natural JS value (see `Xsd.toJs`): strings,
 * numbers, bigints, booleans and dates.
 *
 * @since 0.1.0
 * @category schemas
 */
export const value: TermCodec<string | number | bigint | boolean | Date> = make(
  Schema.Union([Schema.String, Schema.Number, Schema.BigInt, Schema.Boolean, Schema.Date]),
  {
    expected: 'a literal with a known datatype',
    decode: (t) => {
      if (!Term.isLiteral(t)) return undefined;
      return Option.getOrUndefined(Xsd.toJs(t));
    },
    encode: (v) => Xsd.fromJs(v),
  },
);

/**
 * A literal with a specific datatype, decoded to its lexical form.
 *
 * @since 0.1.0
 * @category schemas
 */
export const typed = (datatype: string | Term.NamedNode): TermCodec<string> => {
  const datatypeIri = Predicate.isString(datatype) ? datatype : datatype.value;
  return make(Schema.String, {
    expected: `a literal of type <${datatypeIri}>`,
    decode: (t) => (Term.isLiteral(t) && t.datatype.value === datatypeIri ? t.value : undefined),
    encode: (s) => Term.literal(s, Term.namedNode(datatypeIri)),
  });
};

// The literal a ground term is, if it is one. Built once: every new codec's decoder calls it.
const literalOf: (t: Term.GroundTerm) => Option.Option<Term.Literal> =
  Match.type<Term.GroundTerm>().pipe(
    Match.tag('Literal', (l) => Option.some(l)),
    Match.orElse(() => Option.none()),
  );

const withDatatype = (
  t: Term.GroundTerm,
  datatypes: ReadonlyArray<string>,
): Option.Option<Term.Literal> =>
  Option.filter(literalOf(t), (l) => datatypes.includes(l.datatype.value));

/**
 * An `xsd:dateTime` or `xsd:dateTimeStamp` literal decoded to an Effect
 * `DateTime`: a `DateTime.Zoned` with a fixed offset when the lexical form
 * has a `±hh:mm` offset, otherwise (`Z`, or no timezone, read as UTC) a
 * `DateTime.Utc`. Encodes to `xsd:dateTime`, keeping a zoned value's offset.
 *
 * @since 0.1.0
 * @category schemas
 */
export const dateTime: TermCodec<DateTime.DateTime> = make(
  Schema.Union([Schema.DateTimeUtc, Schema.DateTimeZoned]),
  {
    expected: 'an xsd:dateTime literal',
    decode: (t) =>
      Option.getOrUndefined(
        Option.flatMap(withDatatype(t, [`${XSD}dateTime`, `${XSD}dateTimeStamp`]), (l) => {
          if (!Xsd.isValidLexical(l.datatype.value, l.value)) return Option.none();
          return Match.value(Xsd.toValue(l)).pipe(
            Match.tag('DateTime', (v) => {
              // An instant outside the range of `DateTime` does not decode.
              const utc = DateTime.make(v.epochMillis);
              const offset = v.timezone;
              return offset !== undefined && /[+-]\d\d:\d\d$/.test(l.value)
                ? Option.flatMap(utc, (instant) =>
                    DateTime.makeZoned(instant, {
                      timeZone: DateTime.zoneMakeOffset(offset * 60_000),
                    }),
                  )
                : utc;
            }),
            Match.orElse(() => Option.none()),
          );
        }),
      ),
    encode: (d) =>
      Term.literal(
        DateTime.isZoned(d) ? DateTime.formatIsoOffset(d) : DateTime.formatIso(d),
        Term.namedNode(`${XSD}dateTime`),
      ),
  },
);

const floatingCodec = (local: 'double' | 'float') =>
  make(Schema.Number, {
    expected: `an xsd:${local} literal`,
    decode: (t) =>
      Option.getOrUndefined(
        Option.flatMap(withDatatype(t, [`${XSD}${local}`]), (l) =>
          Xsd.isValidLexical(l.datatype.value, l.value) ? numericValue(l) : Option.none(),
        ),
      ),
    encode: (n) => (local === 'double' ? Xsd.double(n) : Xsd.float(n)),
  });

/**
 * An `xsd:double` literal, decoded to a JS number and encoded back to
 * `xsd:double` (unlike `number`, which accepts any numeric datatype and
 * encodes integral values as `xsd:integer`).
 *
 * @since 0.1.0
 * @category schemas
 */
export const double: TermCodec<number> = floatingCodec('double');

/**
 * An `xsd:float` literal, decoded to a JS number and encoded back to
 * `xsd:float`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const float: TermCodec<number> = floatingCodec('float');

/**
 * The value `localized` decodes to: a string with an optional language tag
 * and base direction.
 *
 * @since 0.1.0
 * @category models
 */
export interface LocalizedString {
  readonly value: string;
  readonly language?: string | undefined;
  readonly direction?: Term.Direction | undefined;
}

/**
 * A string literal with an optional language tag and base direction: a
 * simple or `xsd:string` literal decodes to `{ value }`, a (directional)
 * language-tagged string to `{ value, language, direction? }`. Encodes back
 * to the same kind of literal.
 *
 * @since 0.1.0
 * @category schemas
 */
export const localized: TermCodec<LocalizedString> = make<LocalizedString>(
  Schema.Struct({
    value: Schema.String,
    language: Schema.optional(Schema.String),
    direction: Schema.optional(Schema.Literals(['ltr', 'rtl'])),
  }),
  {
    expected: 'a string or language-tagged string literal',
    decode: (t) =>
      Option.getOrUndefined(
        Option.flatMap(literalOf(t), (l) => {
          if (l.language === '') {
            return l.datatype.value === Term.XSD_STRING
              ? Option.some({ value: l.value })
              : Option.none();
          }
          return Option.some(
            l.direction === undefined
              ? { value: l.value, language: l.language }
              : { value: l.value, language: l.language, direction: l.direction },
          );
        }),
      ),
    encode: (v) =>
      v.language === undefined || v.language === ''
        ? Term.literal(v.value)
        : Term.literal(v.value, { language: v.language, direction: v.direction }),
  },
);

/**
 * A literal whose datatype is any of `datatypes`, decoded to its lexical
 * form and datatype IRI (so encoding restores the same literal). Use it
 * where a property's range admits several datatypes, e.g. `xsd:date` or
 * `xsd:gYear`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const typedOneOf = (
  datatypes: ReadonlyArray<string | Term.NamedNode>,
): TermCodec<{ readonly value: string; readonly datatype: string }> => {
  const iris = datatypes.map((d) => (Predicate.isString(d) ? d : d.value));
  return make(Schema.Struct({ value: Schema.String, datatype: Schema.Literals(iris) }), {
    expected: `a literal of type ${iris.map((dt) => `<${dt}>`).join(' or ')}`,
    decode: (t) =>
      Option.getOrUndefined(
        Option.map(withDatatype(t, iris), (l) => ({ value: l.value, datatype: l.datatype.value })),
      ),
    encode: (v) => Term.literal(v.value, Term.namedNode(v.datatype)),
  });
};
