/**
 * Typed records over the resources of a `Dataset`: annotate a `Schema.Struct`
 * with the predicate behind each field, then decode a subject's properties
 * into the struct's type and encode a value back to quads.
 *
 * ```ts
 * const Person = Schema.Struct({
 *   name: Resource.property(foaf('name'), TermCodec.string),
 *   nick: Schema.optional(Resource.property(foaf('nick'), TermCodec.string)),
 *   knows: Resource.property(foaf('knows'), Schema.Array(TermCodec.namedNode)),
 * }).pipe(Resource.describe({ type: foaf('Person') }))
 *
 * Resource.decode(Person)(dataset, alice) // Effect<{ name: string; nick?: string; … }, SchemaError>
 * Resource.encode(Person)(alice, value) // Effect<ReadonlyArray<Quad>, SchemaError>
 * ```
 *
 * A field's cardinality comes from its schema: a plain codec reads exactly
 * one object, `Schema.optional` / `Schema.optionalKey` at most one,
 * `Schema.Array` any number (in `Term.Order`) and `list` an RDF collection.
 * A field whose codec is a struct is a nested resource, decoded from the
 * object's own properties. Each value decodes through its field's codec (see
 * `TermCodec`), and failures are ordinary schema issues at the field's path.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Equal from 'effect/Equal';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';
import * as SchemaAST from 'effect/SchemaAST';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaParser from 'effect/SchemaParser';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as Dataset from './Dataset.ts';
import * as LanguageTag from './LanguageTag.ts';
import * as Term from './Term.ts';
import { rdf } from './Vocab.ts';

// -----------------------------------------------------------------------------
// Annotations
// -----------------------------------------------------------------------------

/**
 * The annotation key `property` stores a field's `Property` under.
 *
 * @since 0.1.0
 * @category annotations
 */
export const PropertyKey = '@thomasfosterau/effect-rdf/Resource/property';

/**
 * The annotation key `describe` stores a struct's `Description` under.
 *
 * @since 0.1.0
 * @category annotations
 */
export const DescriptionKey = '@thomasfosterau/effect-rdf/Resource/description';

/**
 * The annotation key `list` marks an array schema as an RDF collection with.
 *
 * @since 0.1.0
 * @category annotations
 */
export const ListKey = '@thomasfosterau/effect-rdf/Resource/list';

/**
 * How a field reads its values: the direction of its predicate and, for
 * literals, the language tags it prefers.
 *
 * @since 0.1.0
 * @category models
 */
export interface PropertyOptions {
  /**
   * Read the subjects of `?x predicate resource` instead of the objects of
   * `resource predicate ?x` (and write such quads).
   */
  readonly inverse?: boolean | undefined;
  /**
   * Language tags in order of preference, `''` for an untagged value. A
   * single-valued field takes the first value whose tag matches, trying the
   * tags in order; a multi-valued field keeps the values whose tag is listed.
   * Tags compare case-insensitively. Overrides `DecodeOptions.languages`.
   */
  readonly languages?: ReadonlyArray<string> | undefined;
}

/**
 * The predicate a field maps to, with its `PropertyOptions`: the value of the
 * `PropertyKey` annotation.
 *
 * @since 0.1.0
 * @category models
 */
export interface Property extends PropertyOptions {
  readonly predicate: Term.NamedNode;
}

/**
 * What `describe` records about a struct: the `rdf:type` its resources carry
 * and the field holding the resource itself.
 *
 * @since 0.1.0
 * @category models
 */
export interface Description {
  /**
   * The class every resource of this shape is an instance of: decoding
   * requires `resource rdf:type type`, encoding writes it, and `decodeAll`
   * finds the resources by it.
   */
  readonly type?: Term.NamedNode | undefined;
  /**
   * The name of a field that holds the resource term itself (decoded through
   * that field's codec, e.g. `TermCodec.namedNode` or `TermCodec.iri`). A
   * nested value with an id encodes under it; one without becomes a fresh
   * blank node.
   */
  readonly id?: string | undefined;
}

/**
 * Maps a struct field to a predicate: annotates `codec` with the predicate
 * (and `options`) without changing its type, so it composes with
 * `Schema.optional`, `Schema.Array` and `list` on either side.
 *
 * @since 0.1.0
 * @category constructors
 */
export const property = <S extends Schema.Top>(
  predicate: Term.NamedNode,
  codec: S,
  options?: PropertyOptions,
): S['Rebuild'] => {
  const value: Property = { ...options, predicate };
  return codec.annotate({ [PropertyKey]: value });
};

/**
 * Describes a struct as an RDF resource: the `rdf:type` it requires and
 * writes, and the field (if any) holding the resource term.
 *
 * @since 0.1.0
 * @category constructors
 */
export const describe =
  (description: Description) =>
  <S extends Schema.Top>(self: S): S['Rebuild'] =>
    self.annotate({ [DescriptionKey]: description });

/**
 * An array read from and written to an RDF collection (an `rdf:first` /
 * `rdf:rest` list ending in `rdf:nil`) instead of repeated objects.
 *
 * @since 0.1.0
 * @category constructors
 */
export const list = <S extends Schema.Top>(item: S): Schema.$Array<S> =>
  Schema.Array(item).annotate({ [ListKey]: true });

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

/**
 * Options for `decode`, `decodeAll` and `schema`.
 *
 * @since 0.1.0
 * @category models
 */
export interface DecodeOptions {
  /** The graph to read (every graph when omitted). */
  readonly graph?: Term.Graph | undefined;
  /** The default `PropertyOptions.languages` of every field. */
  readonly languages?: ReadonlyArray<string> | undefined;
  /** Passed to the struct's decoder (e.g. `{ errors: 'all' }`). */
  readonly parseOptions?: SchemaAST.ParseOptions | undefined;
}

/**
 * Options for `encode` and `schema`.
 *
 * @since 0.1.0
 * @category models
 */
export interface EncodeOptions {
  /** The graph to write the quads into (the default graph when omitted). */
  readonly graph?: Term.Graph | undefined;
  /** Passed to the struct's encoder. */
  readonly parseOptions?: SchemaAST.ParseOptions | undefined;
}

/**
 * One resource `decodeAll` found and decoded.
 *
 * @since 0.1.0
 * @category models
 */
export interface Decoded<A> {
  readonly subject: Term.Subject;
  readonly value: A;
}

// -----------------------------------------------------------------------------
// Field plans
// -----------------------------------------------------------------------------

type Cardinality = 'one' | 'many' | 'list';

// A struct field's name; numeric keys are not fields of a resource.
type Key = string | symbol;

const keyOf = (signature: SchemaAST.PropertySignature): Option.Option<Key> =>
  Predicate.isNumber(signature.name) ? Option.none() : Option.some(signature.name);

interface Field {
  readonly name: Key;
  readonly property: Property;
  readonly cardinality: Cardinality;
  /** The key may be absent: `Schema.optional` / `Schema.optionalKey`. */
  readonly optional: boolean;
  /** The schema of one value. */
  readonly item: SchemaAST.AST;
}

const propertyOf = SchemaAST.resolveAt<Property>(PropertyKey);
const descriptionOf = SchemaAST.resolveAt<Description>(DescriptionKey);
const isList = (ast: SchemaAST.AST): boolean => SchemaAST.resolveAt<boolean>(ListKey)(ast) === true;

const resolveSuspend = (ast: SchemaAST.AST): SchemaAST.AST =>
  SchemaAST.isSuspend(ast) ? resolveSuspend(ast.thunk()) : ast;

// `T | undefined` (what `Schema.optional` wraps a field in) without the `undefined`.
const withoutUndefined = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (!SchemaAST.isUnion(ast)) return ast;
  const defined = Arr.filter(ast.types, (t) => !SchemaAST.isUndefined(t));
  return defined.length === 1 && defined.length < ast.types.length
    ? Option.getOrElse(Arr.head(defined), () => ast)
    : ast;
};

// An array of encoded values (`Schema.Array(codec)`), as opposed to a codec whose type is an array.
const arrayItem = (ast: SchemaAST.AST): Option.Option<SchemaAST.AST> =>
  SchemaAST.isArrays(ast) && ast.encoding === undefined && Arr.isReadonlyArrayEmpty(ast.elements)
    ? Arr.head(ast.rest)
    : Option.none();

// A nested resource: a struct whose encoded side is itself a record of terms.
const nestedStruct = (ast: SchemaAST.AST): Option.Option<SchemaAST.Objects> => {
  const resolved = resolveSuspend(ast);
  return SchemaAST.isObjects(resolved) && resolved.encoding === undefined
    ? Option.some(resolved)
    : Option.none();
};

const fieldOf = (signature: SchemaAST.PropertySignature): Option.Option<Field> =>
  Option.flatMap(keyOf(signature), (name) => fieldNamed(name, signature));

const fieldNamed = (name: Key, signature: SchemaAST.PropertySignature): Option.Option<Field> => {
  const declared = signature.type;
  const optional = SchemaAST.isOptional(declared);
  const inner = withoutUndefined(declared);
  const element = arrayItem(inner);
  const annotated = Arr.getSomes([
    Option.fromUndefinedOr(propertyOf(declared)),
    Option.fromUndefinedOr(propertyOf(inner)),
    Option.flatMap(element, (e) => Option.fromUndefinedOr(propertyOf(e))),
  ]);
  return Option.map(Arr.head(annotated), (found) =>
    Option.match(element, {
      onNone: () => ({
        name,
        property: found,
        cardinality: 'one' as const,
        optional,
        item: inner,
      }),
      onSome: (item) => ({
        name,
        property: found,
        cardinality: isList(inner) ? ('list' as const) : ('many' as const),
        optional,
        item,
      }),
    }),
  );
};

const expectStruct = (ast: SchemaAST.AST): Effect.Effect<SchemaAST.Objects, SchemaIssue.Issue> =>
  Effect.mapError(
    Effect.fromOption(nestedStruct(ast)),
    () =>
      new SchemaIssue.InvalidValue({
        message: 'Expected a struct schema (Schema.Struct) to map a resource to',
      }),
  );

const describedType = (ast: SchemaAST.AST): Option.Option<Term.NamedNode> =>
  Option.fromUndefinedOr(descriptionOf(ast)?.type);

const describedId = (ast: SchemaAST.AST): Option.Option<string> =>
  Option.fromUndefinedOr(descriptionOf(ast)?.id);

// -----------------------------------------------------------------------------
// Decoding
// -----------------------------------------------------------------------------

interface DecodeContext {
  readonly dataset: Dataset.Dataset;
  readonly options: DecodeOptions;
}

type Visit = readonly [SchemaAST.AST, Term.Subject];

const languageOf = (term: Term.Term): string =>
  Term.isLiteral(term) ? LanguageTag.normalize(term.language) : '';

const hasLanguage =
  (tag: string) =>
  (term: Term.Term): boolean =>
    languageOf(term) === LanguageTag.normalize(tag);

// The values of a field, before cardinality: sorted for determinism, then narrowed by language.
const valuesOf = (
  context: DecodeContext,
  subject: Term.Subject,
  field: Field,
): ReadonlyArray<Term.Object> => {
  const { predicate, inverse } = field.property;
  const terms: ReadonlyArray<Term.Object> =
    inverse === true
      ? Dataset.subjectsOf(context.dataset, predicate, subject, context.options.graph)
      : Dataset.objectsOf(context.dataset, subject, predicate, context.options.graph);
  const sorted = Arr.sort(terms, Term.Order);
  const languages = field.property.languages ?? context.options.languages;
  if (languages === undefined) return sorted;
  if (field.cardinality === 'one') {
    return Arr.fromOption(
      Arr.findFirst(languages, (tag) => Arr.findFirst(sorted, hasLanguage(tag))),
    );
  }
  return Arr.dedupe(Arr.flatMap(languages, (tag) => Arr.filter(sorted, hasLanguage(tag))));
};

const describePredicate = (field: Field): string =>
  field.property.inverse === true
    ? `^${field.property.predicate.toString()}`
    : field.property.predicate.toString();

const atField =
  (field: Field, ...path: ReadonlyArray<PropertyKey>) =>
  (issue: SchemaIssue.Issue): SchemaIssue.Issue =>
    new SchemaIssue.Pointer([field.name, ...path], issue);

const missing = (field: Field): SchemaIssue.Issue =>
  atField(field)(
    new SchemaIssue.MissingKey({
      messageMissingKey: `Missing value for ${describePredicate(field)}`,
      predicate: field.property.predicate.value,
    }),
  );

const tooMany = (field: Field, values: ReadonlyArray<Term.Object>): SchemaIssue.Issue =>
  atField(field)(
    new SchemaIssue.InvalidValue(
      {
        message: `Expected ${field.optional ? 'at most' : 'exactly'} one value for ${describePredicate(field)}, got ${values.length}`,
        predicate: field.property.predicate.value,
      },
      values,
    ),
  );

const isSubjectTerm = (term: Term.Term): term is Term.Subject => Term.isSubject(term);

// The encoded value of one field value: the term, or a nested resource's record.
const encodedValue = (
  context: DecodeContext,
  item: SchemaAST.AST,
  term: Term.Object,
  visits: ReadonlyArray<Visit>,
): Effect.Effect<unknown, SchemaIssue.Issue> =>
  Option.match(nestedStruct(item), {
    onNone: () => Effect.succeed(term),
    onSome: () =>
      isSubjectTerm(term)
        ? gather(context, item, term, visits)
        : Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: `Expected an IRI or blank node, got ${term.toString()}` },
              term,
            ),
          ),
  });

const encodedValues = (
  context: DecodeContext,
  field: Field,
  terms: ReadonlyArray<Term.Object>,
  visits: ReadonlyArray<Visit>,
): Effect.Effect<ReadonlyArray<unknown>, SchemaIssue.Issue> =>
  Effect.forEach(
    terms,
    (term, index) =>
      Effect.mapError(encodedValue(context, field.item, term, visits), atField(field, index)),
    { concurrency: 1 },
  );

const listItems = (
  context: DecodeContext,
  field: Field,
  head: Term.Object,
): Effect.Effect<ReadonlyArray<Term.Object>, SchemaIssue.Issue> =>
  Effect.mapError(
    Effect.fromOption(Dataset.list(context.dataset, head, context.options.graph)),
    () =>
      atField(field)(
        new SchemaIssue.InvalidValue(
          {
            message: `Expected an RDF list for ${describePredicate(field)}, got ${head.toString()}`,
            predicate: field.property.predicate.value,
          },
          head,
        ),
      ),
  );

// The encoded value of a field (`None` leaves the key out), checking its cardinality.
const encodedField = (
  context: DecodeContext,
  subject: Term.Subject,
  field: Field,
  visits: ReadonlyArray<Visit>,
): Effect.Effect<Option.Option<unknown>, SchemaIssue.Issue> => {
  const values = valuesOf(context, subject, field);
  if (field.cardinality === 'many') {
    return Arr.isReadonlyArrayEmpty(values) && field.optional
      ? Effect.succeedNone
      : Effect.asSome(encodedValues(context, field, values, visits));
  }
  return Arr.match(values, {
    onEmpty: () => (field.optional ? Effect.succeedNone : Effect.fail(missing(field))),
    onNonEmpty: ([first, ...rest]) => {
      if (Arr.isArrayNonEmpty(rest)) return Effect.fail(tooMany(field, values));
      return field.cardinality === 'list'
        ? Effect.asSome(
            Effect.flatMap(listItems(context, field, first), (items) =>
              encodedValues(context, field, items, visits),
            ),
          )
        : Effect.asSome(
            Effect.mapError(encodedValue(context, field.item, first, visits), atField(field)),
          );
    },
  });
};

const hasType = (
  context: DecodeContext,
  subject: Term.Subject,
  type: Term.NamedNode,
): Effect.Effect<void, SchemaIssue.Issue> =>
  Arr.isReadonlyArrayNonEmpty(
    Dataset.match(context.dataset, {
      subject,
      predicate: rdf.type,
      object: type,
      graph: context.options.graph,
    }),
  )
    ? Effect.void
    : Effect.fail(
        new SchemaIssue.InvalidValue(
          {
            message: `Expected ${subject.toString()} to have rdf:type ${type.toString()}`,
            predicate: rdf.type.value,
          },
          subject,
        ),
      );

// The encoded record of a resource: every mapped field's terms (or nested records), so the
// struct's own decoder turns it into the struct's type.
const gather = (
  context: DecodeContext,
  ast: SchemaAST.AST,
  subject: Term.Subject,
  visits: ReadonlyArray<Visit>,
): Effect.Effect<Record.ReadonlyRecord<Key, unknown>, SchemaIssue.Issue> =>
  Effect.gen(function* () {
    const struct = yield* expectStruct(ast);
    if (Arr.some(visits, ([seen, at]) => seen === struct && Equal.equals(at, subject))) {
      return yield* Effect.fail(
        new SchemaIssue.InvalidValue(
          { message: `Cycle: ${subject.toString()} is already being decoded as this resource` },
          subject,
        ),
      );
    }
    yield* Option.match(describedType(struct), {
      onNone: () => Effect.void,
      onSome: (type) => hasType(context, subject, type),
    });
    const id = describedId(struct);
    const inner: ReadonlyArray<Visit> = [...visits, [struct, subject]];
    const entries = yield* Effect.forEach(
      struct.propertySignatures,
      (signature): Effect.Effect<Option.Option<readonly [Key, unknown]>, SchemaIssue.Issue> =>
        Option.match(keyOf(signature), {
          onNone: () => Effect.succeedNone,
          onSome: (name) =>
            Option.contains(id, name)
              ? Effect.succeedSome([name, subject])
              : Option.match(fieldNamed(name, signature), {
                  onNone: () => Effect.succeedNone,
                  onSome: (field) =>
                    Effect.map(
                      encodedField(context, subject, field, inner),
                      Option.map((value) => [name, value]),
                    ),
                }),
        }),
      { concurrency: 1 },
    );
    return Record.fromEntries(Arr.getSomes(entries));
  });

const contextOf = (dataset: Dataset.Dataset, options: DecodeOptions): DecodeContext => ({
  dataset,
  options,
});

const decodeIssue = <S extends Schema.Constraint>(
  schema: S,
  dataset: Dataset.Dataset,
  subject: Term.Subject,
  options: DecodeOptions,
  parseOptions?: SchemaAST.ParseOptions,
): Effect.Effect<S['Type'], SchemaIssue.Issue, S['DecodingServices']> =>
  Effect.flatMap(gather(contextOf(dataset, options), schema.ast, subject, []), (record) =>
    SchemaParser.decodeEffect(schema)(record, parseOptions ?? options.parseOptions),
  );

const toSchemaError = (issue: SchemaIssue.Issue): Schema.SchemaError =>
  new Schema.SchemaError(issue);

/**
 * Decodes the resource `subject` of `dataset` with a struct of `property`
 * fields: reads each field's values, checks their number against the field's
 * cardinality, decodes nested resources recursively and runs the struct's
 * decoder over the result.
 *
 * @since 0.1.0
 * @category decoding
 */
export const decode =
  <S extends Schema.Constraint>(schema: S) =>
  (
    dataset: Dataset.Dataset,
    subject: Term.Subject,
    options?: DecodeOptions,
  ): Effect.Effect<S['Type'], Schema.SchemaError, S['DecodingServices']> =>
    Effect.mapError(decodeIssue(schema, dataset, subject, options ?? {}), toSchemaError);

/**
 * Decodes every resource whose `rdf:type` is the struct's described `type`
 * (in `Term.Order` of the subjects). Fails on the first resource that does
 * not decode, with the subject at the head of the issue's path; fails when
 * the struct has no described `type`.
 *
 * @since 0.1.0
 * @category decoding
 */
export const decodeAll =
  <S extends Schema.Constraint>(schema: S) =>
  (
    dataset: Dataset.Dataset,
    options?: DecodeOptions,
  ): Effect.Effect<ReadonlyArray<Decoded<S['Type']>>, Schema.SchemaError, S['DecodingServices']> =>
    Option.match(describedType(schema.ast), {
      onNone: () =>
        Effect.fail(
          toSchemaError(
            new SchemaIssue.InvalidValue({
              message: 'Resource.decodeAll needs a struct described with a type',
            }),
          ),
        ),
      onSome: (type) =>
        Effect.forEach(
          Arr.sort(Dataset.subjectsOf(dataset, rdf.type, type, options?.graph), Term.Order),
          (subject) =>
            Effect.mapBoth(decodeIssue(schema, dataset, subject, options ?? {}), {
              onFailure: (issue) => toSchemaError(new SchemaIssue.Pointer([subject.key], issue)),
              onSuccess: (value): Decoded<S['Type']> => ({ subject, value }),
            }),
          { concurrency: 1 },
        ),
    });

// -----------------------------------------------------------------------------
// Encoding
// -----------------------------------------------------------------------------

interface Emitted {
  readonly subject: Term.Subject;
  readonly quads: ReadonlyArray<Term.Quad>;
}

// What a struct encodes to: one entry per field.
type EncodedRecord = Record.ReadonlyRecord<Key, unknown>;

const isEncodedRecord = (u: unknown): u is EncodedRecord =>
  Predicate.isObject(u) && !Term.isTerm(u);

const read = (record: EncodedRecord, key: Key): Option.Option<unknown> =>
  Option.filter(Record.get(record, key), Predicate.isNotUndefined);

const unexpected = (expected: string): SchemaIssue.Issue =>
  new SchemaIssue.InvalidValue({ message: `Expected the codec to encode to ${expected}` });

const statement = (
  field: Field,
  subject: Term.Subject,
  value: Term.Object,
  graph: Term.Graph,
): Effect.Effect<Term.Quad, SchemaIssue.Issue> => {
  const predicate = field.property.predicate;
  if (field.property.inverse !== true) {
    return Effect.succeed(new Term.Quad(subject, predicate, value, graph));
  }
  return isSubjectTerm(value)
    ? Effect.succeed(new Term.Quad(value, predicate, subject, graph))
    : Effect.fail(
        atField(field)(
          new SchemaIssue.InvalidValue(
            {
              message: `Expected an IRI or blank node for ${describePredicate(field)}, got ${value.toString()}`,
              predicate: predicate.value,
            },
            value,
          ),
        ),
      );
};

// An RDF collection of `items`: its head and the `rdf:first` / `rdf:rest` quads.
const collection = (
  items: ReadonlyArray<Term.Object>,
  graph: Term.Graph,
): readonly [Term.Object, ReadonlyArray<Term.Quad>] => {
  const nodes = Arr.map(items, () => Term.blankNode());
  const rests: ReadonlyArray<Term.Object> = [...Arr.drop(nodes, 1), rdf.nil];
  const quads = Arr.flatMap(Arr.zip(nodes, Arr.zip(items, rests)), ([node, [item, rest]]) => [
    new Term.Quad(node, rdf.first, item, graph),
    new Term.Quad(node, rdf.rest, rest, graph),
  ]);
  return [Option.getOrElse(Arr.head(nodes), (): Term.Object => rdf.nil), quads];
};

// The term for one encoded value of a field, with the quads of a nested resource.
type Emittable = readonly [Term.Object, ReadonlyArray<Term.Quad>];

// The statements of one field of `record`, with the quads of its nested resources.
const emitField = (
  field: Field,
  subject: Term.Subject,
  record: EncodedRecord,
  graph: Term.Graph,
): Effect.Effect<ReadonlyArray<Term.Quad>, SchemaIssue.Issue> =>
  Effect.gen(function* () {
    const items: ReadonlyArray<unknown> = Option.match(read(record, field.name), {
      onNone: () => [],
      onSome: (v) => (field.cardinality !== 'one' && Arr.isArray(v) ? v : [v]),
    });
    const nested = nestedStruct(field.item);
    const emitted = yield* Effect.forEach(
      items,
      (item, index): Effect.Effect<Emittable, SchemaIssue.Issue> => {
        const at = field.cardinality === 'one' ? atField(field) : atField(field, index);
        return Option.match(nested, {
          onNone: () =>
            Term.isObject(item)
              ? Effect.succeed([item, []])
              : Effect.fail(at(unexpected('an RDF term'))),
          onSome: (struct) =>
            isEncodedRecord(item)
              ? Effect.mapBoth(emit(struct, Option.none(), item, graph), {
                  onFailure: at,
                  onSuccess: (out): Emittable => [out.subject, out.quads],
                })
              : Effect.fail(at(unexpected('a record'))),
        });
      },
      { concurrency: 1 },
    );
    const inner = Arr.flatMap(emitted, ([, quads]) => quads);
    const terms = Arr.map(emitted, ([term]) => term);
    if (field.cardinality === 'list' && Option.isSome(read(record, field.name))) {
      const [head, links] = collection(terms, graph);
      const link = yield* statement(field, subject, head, graph);
      return [link, ...links, ...inner];
    }
    const links = yield* Effect.forEach(terms, (term) => statement(field, subject, term, graph), {
      concurrency: 1,
    });
    return [...links, ...inner];
  });

// The quads of an encoded record: its type, each mapped field's statements and nested resources.
const emit = (
  struct: SchemaAST.Objects,
  given: Option.Option<Term.Subject>,
  record: EncodedRecord,
  graph: Term.Graph,
): Effect.Effect<Emitted, SchemaIssue.Issue> =>
  Effect.gen(function* () {
    const id = describedId(struct);
    const subject = Option.getOrElse(
      Option.orElse(given, () =>
        Option.filter(
          Option.flatMap(id, (key) => read(record, key)),
          (term): term is Term.Subject => Term.isSubject(term),
        ),
      ),
      (): Term.Subject => Term.blankNode(),
    );
    const typed = Arr.map(
      Arr.fromOption(describedType(struct)),
      (type) => new Term.Quad(subject, rdf.type, type, graph),
    );
    const fields = Arr.filter(
      Arr.getSomes(Arr.map(struct.propertySignatures, fieldOf)),
      (field) => !Option.contains(id, field.name),
    );
    const quads = yield* Effect.forEach(
      fields,
      (field) => emitField(field, subject, record, graph),
      { concurrency: 1 },
    );
    return { subject, quads: [...typed, ...Arr.flatten(quads)] };
  });

const encodeIssue = <S extends Schema.Constraint>(
  schema: S,
  subject: Option.Option<Term.Subject>,
  value: S['Type'],
  options: EncodeOptions,
  parseOptions?: SchemaAST.ParseOptions,
): Effect.Effect<Emitted, SchemaIssue.Issue, S['EncodingServices']> =>
  Effect.gen(function* () {
    const struct = yield* expectStruct(schema.ast);
    const record = yield* SchemaParser.encodeEffect(schema)(
      value,
      parseOptions ?? options.parseOptions,
    );
    return isEncodedRecord(record)
      ? yield* emit(struct, subject, record, options.graph ?? Term.defaultGraph)
      : yield* Effect.fail(unexpected('a record'));
  });

/**
 * Encodes `value` as the resource `subject`: the struct's encoder turns each
 * field into terms, written as `subject predicate term` quads (or
 * `term predicate subject` for an `inverse` field), with an `rdf:type` quad
 * for a described type, RDF collections for `list` fields and the quads of
 * nested resources.
 *
 * @since 0.1.0
 * @category encoding
 */
export const encode =
  <S extends Schema.Constraint>(schema: S) =>
  (
    subject: Term.Subject,
    value: S['Type'],
    options?: EncodeOptions,
  ): Effect.Effect<ReadonlyArray<Term.Quad>, Schema.SchemaError, S['EncodingServices']> =>
    Effect.mapBoth(encodeIssue(schema, Option.some(subject), value, options ?? {}), {
      onFailure: toSchemaError,
      onSuccess: (out) => out.quads,
    });

// -----------------------------------------------------------------------------
// Schema form
// -----------------------------------------------------------------------------

/**
 * A subject term: an IRI, blank node or triple term.
 *
 * @since 0.1.0
 * @category schemas
 */
export const SubjectSchema: Schema.Union<
  readonly [
    Schema.declare<Term.NamedNode>,
    Schema.declare<Term.BlankNode>,
    Schema.declare<Term.Triple>,
  ]
> = Schema.Union([Term.NamedNodeSchema, Term.BlankNodeSchema, Term.TripleSchema]);

/**
 * The type `SubjectSchema` decodes to: `Term.Subject`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type SubjectSchema = typeof SubjectSchema.Type;

/**
 * The encoded side of `schema`: a dataset and the resource in it.
 *
 * @since 0.1.0
 * @category schemas
 */
export const InputSchema: Schema.Struct<{
  readonly dataset: Schema.declare<Dataset.Dataset>;
  readonly subject: typeof SubjectSchema;
}> = Schema.Struct({ dataset: Dataset.DatasetSchema, subject: SubjectSchema });

/**
 * The type `InputSchema` decodes to: `{ dataset, subject }`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type InputSchema = typeof InputSchema.Type;

/**
 * The `Schema` form of `decode` / `encode`: decodes `{ dataset, subject }`
 * to the struct's type, and encodes a value to the dataset of its quads with
 * the resource as `subject` (its `describe`d id, or a fresh blank node). It
 * composes with `Schema.decodeTo`, `Schema.decodeUnknownEffect` and the rest
 * of the `Schema` API.
 *
 * @since 0.1.0
 * @category schemas
 */
export const schema = <S extends Schema.Top>(
  self: S,
  options?: DecodeOptions & EncodeOptions,
): Schema.decodeTo<
  Schema.toType<S>,
  typeof InputSchema,
  S['DecodingServices'],
  S['EncodingServices']
> =>
  InputSchema.pipe(
    Schema.decodeTo(
      Schema.toType(self),
      SchemaTransformation.transformEffect<
        S['Type'],
        InputSchema,
        S['DecodingServices'],
        S['EncodingServices']
      >({
        decode: (input, parseOptions) =>
          decodeIssue(self, input.dataset, input.subject, options ?? {}, parseOptions),
        encode: (value, parseOptions) =>
          Effect.map(
            encodeIssue(self, Option.none(), value, options ?? {}, parseOptions),
            (out): InputSchema => ({
              dataset: Dataset.fromIterable(out.quads),
              subject: out.subject,
            }),
          ),
      }),
    ),
  );
