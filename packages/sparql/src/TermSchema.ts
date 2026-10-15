/**
 * Effect `Schema`s that decode RDF terms (as found in SPARQL solutions) to
 * JavaScript values and encode them back, for typed decoding of query
 * results:
 *
 * ```ts
 * const Person = Schema.Struct({
 *   name: TermSchema.string,
 *   age: Schema.optional(TermSchema.integer),
 *   homepage: Schema.optional(TermSchema.iri),
 * })
 * // QueryBuilder.decode(query, Person) : Stream<{ name: string; age?: number; … }>
 * ```
 *
 * Each schema's encoded side is a `Term.GroundTerm`, its decoded side a JS
 * value. Decoding fails (with a schema issue) when the term has the wrong
 * kind or datatype.
 *
 * @since 0.1.0
 */
import * as BigDecimal from 'effect/BigDecimal';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';

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
  ) as any;

const numericValue = (t: Term.GroundTerm): number | undefined => {
  if (t._tag !== 'Literal' || !Xsd.isNumericDatatype(t.datatype.value)) return undefined;
  if (!Xsd.isValidLexical(t.datatype.value, t.value)) return undefined;
  const v = Xsd.toValue(t);
  switch (v._tag) {
    case 'Integer':
      return Number(v.value);
    case 'Decimal':
      return BigDecimal.toNumberUnsafe(v.value);
    case 'Float':
    case 'Double':
      return v.value;
    default:
      return undefined;
  }
};

/**
 * Any RDF term (identity).
 *
 * @since 0.1.0
 * @category schemas
 */
export const term: TermCodec<Term.GroundTerm> = Term.GroundTermSchema as any;

/**
 * An IRI, decoded to a `NamedNode`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const namedNode: TermCodec<Term.NamedNode> = make(Term.NamedNodeSchema, {
  expected: 'an IRI',
  decode: (t) => (t._tag === 'NamedNode' ? t : undefined),
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
  decode: (t) => (t._tag === 'NamedNode' ? t.value : undefined),
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
    decode: (t) => (t._tag === 'NamedNode' || t._tag === 'BlankNode' ? t : undefined),
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
  decode: (t) => (t._tag === 'Literal' ? t : undefined),
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
    t._tag === 'Literal' && (t.language !== '' || t.datatype.value === Term.XSD_STRING)
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
  decode: (t) => (t._tag === 'Literal' || t._tag === 'NamedNode' ? t.value : undefined),
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
      t._tag === 'Literal' && t.language !== ''
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
  decode: numericValue,
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
    t._tag === 'Literal' && Xsd.isIntegerDatatype(t.datatype.value) ? numericValue(t) : undefined,
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
    t._tag === 'Literal' &&
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
      if (t._tag !== 'Literal') return undefined;
      const v = Xsd.toValue(t);
      return v._tag === 'Decimal'
        ? v.value
        : v._tag === 'Integer'
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
    if (t._tag !== 'Literal' || t.datatype.value !== `${XSD}boolean`) return undefined;
    const v = Xsd.toValue(t);
    return v._tag === 'Boolean' ? v.value : undefined;
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
    if (t._tag !== 'Literal') return undefined;
    const v = Xsd.toValue(t);
    return v._tag === 'DateTime' && (v.kind === 'dateTime' || v.kind === 'date')
      ? new Date(v.epochMillis)
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
      if (t._tag !== 'Literal') return undefined;
      const v = Xsd.toJs(t);
      return v._tag === 'Some' ? v.value : undefined;
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
  const iri = typeof datatype === 'string' ? datatype : datatype.value;
  return make(Schema.String, {
    expected: `a literal of type <${iri}>`,
    decode: (t) => (t._tag === 'Literal' && t.datatype.value === iri ? t.value : undefined),
    encode: (s) => Term.literal(s, Term.namedNode(iri)),
  });
};
