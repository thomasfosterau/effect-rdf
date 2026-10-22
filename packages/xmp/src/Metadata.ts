/**
 * The XMP data model (ISO 16684-1 §6) on top of an RDF `Dataset`: one
 * resource described by properties whose values are simple values,
 * structures or arrays (`rdf:Bag`, `rdf:Seq`, `rdf:Alt`), each of which may
 * carry qualifiers.
 *
 * `fromDataset` reads the RDF an XMP packet parses to into this model and
 * `toDataset` writes it back. Values are immutable; `set` and `remove`
 * return a new `Metadata`. Properties, fields and qualifiers are
 * `[iri, value]` entries. Their order carries no meaning in XMP, so
 * `fromDataset` sorts them by IRI and the serializer writes them in entry
 * order, making output deterministic.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import { dual } from 'effect/Function';
import * as HashSet from 'effect/HashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { RDF } from './Namespaces.ts';

const RDF_VALUE = `${RDF}value`;
const RDF_TYPE = `${RDF}type`;
const MEMBER_RE = /^http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#_([1-9][0-9]*)$/;

/**
 * The `xml:lang` value of the default item of a language alternative.
 *
 * @since 0.1.0
 * @category constants
 */
export const X_DEFAULT = 'x-default';

/**
 * A named value: a property, a structure field or a qualifier, keyed by its
 * full IRI.
 *
 * @since 0.1.0
 * @category models
 */
export type Entry = readonly [iri: string, value: Value];

/**
 * Named values, each IRI at most once.
 *
 * @since 0.1.0
 * @category models
 */
export type Entries = ReadonlyArray<Entry>;

/**
 * A simple value: a text string, or a URI (written with `rdf:resource`).
 *
 * @since 0.1.0
 * @category models
 */
export interface Simple {
  readonly _tag: 'Simple';
  readonly value: string;
  /** Whether the value is a URI rather than text. */
  readonly isUri: boolean;
  /** The `xml:lang` qualifier of a text value. */
  readonly language: Option.Option<string>;
  /** The other qualifiers (`xml:lang` is `language`). */
  readonly qualifiers: Entries;
}

/**
 * A structure: named fields, each keyed by its full IRI.
 *
 * @since 0.1.0
 * @category models
 */
export interface Struct {
  readonly _tag: 'Struct';
  readonly fields: Entries;
  readonly qualifiers: Entries;
}

/**
 * The form of an array: unordered (`Bag`), ordered (`Seq`) or alternatives
 * (`Alt`, of which the first is the default).
 *
 * @since 0.1.0
 * @category models
 */
export type ArrayForm = 'Bag' | 'Seq' | 'Alt';

/**
 * An array value (`rdf:Bag`, `rdf:Seq` or `rdf:Alt`).
 *
 * @since 0.1.0
 * @category models
 */
export interface ArrayValue {
  readonly _tag: 'Array';
  readonly form: ArrayForm;
  readonly items: ReadonlyArray<Value>;
  readonly qualifiers: Entries;
}

/**
 * An XMP property or field value.
 *
 * @since 0.1.0
 * @category models
 */
export type Value = Simple | Struct | ArrayValue;

/**
 * The metadata of one resource: the `rdf:about` value of its descriptions
 * (usually `""`, the containing file) and its top-level properties.
 *
 * @since 0.1.0
 * @category models
 */
export interface Metadata {
  readonly about: string;
  readonly properties: Entries;
}

/**
 * RDF that does not have the shape of the XMP data model: a cycle, a triple
 * term, an array with non-member properties or a property given twice.
 *
 * @since 0.1.0
 * @category errors
 */
export class XmpModelError extends Schema.TaggedError<XmpModelError>()('XmpModelError', {
  message: Schema.String,
}) {}

// -----------------------------------------------------------------------------
// Guards and entries
// -----------------------------------------------------------------------------

/**
 * Whether a value is a simple value.
 *
 * @since 0.1.0
 * @category guards
 */
export const isSimple = (value: Value): value is Simple => Predicate.isTagged(value, 'Simple');

/**
 * Whether a value is a structure.
 *
 * @since 0.1.0
 * @category guards
 */
export const isStruct = (value: Value): value is Struct => Predicate.isTagged(value, 'Struct');

/**
 * Whether a value is an array.
 *
 * @since 0.1.0
 * @category guards
 */
export const isArray = (value: Value): value is ArrayValue => Predicate.isTagged(value, 'Array');

/**
 * The value of the entry with the given IRI.
 *
 * @since 0.1.0
 * @category accessors
 */
export const lookup = (entries: Entries, iri: string): Option.Option<Value> =>
  Option.map(
    Arr.findFirst(entries, ([key]) => key === iri),
    ([, value]) => value,
  );

/** Replaces the entry with the same IRI in place, or appends it. */
const upsert = (entries: Entries, entry: Entry): Entries =>
  Arr.some(entries, ([key]) => key === entry[0])
    ? Arr.map(entries, (e) => (e[0] === entry[0] ? entry : e))
    : [...entries, entry];

const entriesOf = (entries: Iterable<Entry>): Entries => Arr.reduce(entries, noEntries, upsert);

const noEntries: Entries = [];

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

/**
 * Metadata with no properties, about the containing file (`rdf:about=""`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const empty: Metadata = { about: '', properties: noEntries };

/**
 * Builds metadata from `[iri, value]` entries (a later entry replaces an
 * earlier one with the same IRI).
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (properties: Iterable<Entry>, about: string = ''): Metadata => ({
  about,
  properties: entriesOf(properties),
});

/**
 * A text value, optionally with an `xml:lang` qualifier.
 *
 * @since 0.1.0
 * @category constructors
 */
export const text = (value: string, language?: string): Simple => ({
  _tag: 'Simple',
  value,
  isUri: false,
  language: Option.fromNullishOr(language),
  qualifiers: noEntries,
});

/**
 * A URI value, written with `rdf:resource`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const uri = (value: string): Simple => ({
  _tag: 'Simple',
  value,
  isUri: true,
  language: Option.none(),
  qualifiers: noEntries,
});

/**
 * A structure from `[iri, value]` field entries.
 *
 * @since 0.1.0
 * @category constructors
 */
export const struct = (fields: Iterable<Entry>): Struct => ({
  _tag: 'Struct',
  fields: entriesOf(fields),
  qualifiers: noEntries,
});

/**
 * An array of the given form.
 *
 * @since 0.1.0
 * @category constructors
 */
export const array = (form: ArrayForm, items: Iterable<Value>): ArrayValue => ({
  _tag: 'Array',
  form,
  items: Arr.fromIterable(items),
  qualifiers: noEntries,
});

/**
 * An unordered array (`rdf:Bag`) of text values.
 *
 * @since 0.1.0
 * @category constructors
 */
export const bag = (items: Iterable<string>): ArrayValue =>
  array(
    'Bag',
    Arr.map(Arr.fromIterable(items), (item) => text(item)),
  );

/**
 * An ordered array (`rdf:Seq`) of text values.
 *
 * @since 0.1.0
 * @category constructors
 */
export const seq = (items: Iterable<string>): ArrayValue =>
  array(
    'Seq',
    Arr.map(Arr.fromIterable(items), (item) => text(item)),
  );

/**
 * A language alternative: an `rdf:Alt` of text values each qualified by
 * `xml:lang`, from `[language, text]` pairs. An `x-default` entry is moved
 * first, as ISO 16684-1 requires.
 *
 * @since 0.1.0
 * @category constructors
 */
export const languageAlternative = (entries: Iterable<readonly [string, string]>): ArrayValue => {
  const all = Arr.fromIterable(entries);
  const isDefault = ([language]: readonly [string, string]) => language === X_DEFAULT;
  return array(
    'Alt',
    Arr.map(
      [...Arr.filter(all, isDefault), ...Arr.filter(all, (entry) => !isDefault(entry))],
      ([language, value]) => text(value, language),
    ),
  );
};

/**
 * Returns the value with the given qualifiers added (replacing qualifiers
 * of the same IRI).
 *
 * @since 0.1.0
 * @category combinators
 */
export const withQualifiers: {
  (qualifiers: Iterable<Entry>): <V extends Value>(self: V) => V;
  <V extends Value>(self: V, qualifiers: Iterable<Entry>): V;
} = dual(2, <V extends Value>(self: V, qualifiers: Iterable<Entry>): V => ({
  ...self,
  qualifiers: Arr.reduce(qualifiers, self.qualifiers, upsert),
}));

// -----------------------------------------------------------------------------
// Access
// -----------------------------------------------------------------------------

/**
 * The value of a top-level property.
 *
 * @since 0.1.0
 * @category accessors
 */
export const get: {
  (iri: string): (self: Metadata) => Option.Option<Value>;
  (self: Metadata, iri: string): Option.Option<Value>;
} = dual(2, (self: Metadata, iri: string): Option.Option<Value> => lookup(self.properties, iri));

/**
 * Sets a top-level property, keeping its position if it was already set.
 *
 * @since 0.1.0
 * @category combinators
 */
export const set: {
  (iri: string, value: Value): (self: Metadata) => Metadata;
  (self: Metadata, iri: string, value: Value): Metadata;
} = dual(3, (self: Metadata, iri: string, value: Value): Metadata => ({
  about: self.about,
  properties: upsert(self.properties, [iri, value]),
}));

/**
 * Removes a top-level property.
 *
 * @since 0.1.0
 * @category combinators
 */
export const remove: {
  (iri: string): (self: Metadata) => Metadata;
  (self: Metadata, iri: string): Metadata;
} = dual(2, (self: Metadata, iri: string): Metadata => ({
  about: self.about,
  properties: Arr.filter(self.properties, ([key]) => key !== iri),
}));

const asSimple = Option.liftPredicate(isSimple);

const asArray = Option.liftPredicate(isArray);

/**
 * The string of a simple (text or URI) value.
 *
 * @since 0.1.0
 * @category accessors
 */
export const textOf = (value: Value): Option.Option<string> =>
  Option.map(asSimple(value), (simple) => simple.value);

/**
 * The strings of an array's simple items, in order; items that are not
 * simple values are skipped.
 *
 * @since 0.1.0
 * @category accessors
 */
export const itemsOf = (value: Value): Option.Option<ReadonlyArray<string>> =>
  Option.map(asArray(value), (array) => Arr.getSomes(Arr.map(array.items, textOf)));

const hasLanguage = (language: string) => (item: Simple) =>
  Option.exists(item.language, (l) => l.toLowerCase() === language.toLowerCase());

/**
 * Looks up a language alternative the way ISO 16684-1 §8.2.2.4 describes:
 * the item whose `xml:lang` matches `language` (case-insensitively), else
 * the `x-default` item, else the first item. A simple value is its own
 * only alternative.
 *
 * @since 0.1.0
 * @category accessors
 */
export const localizedOf = (value: Value, language: string = X_DEFAULT): Option.Option<string> => {
  if (isSimple(value)) return Option.some(value.value);
  if (!isArray(value)) return Option.none();
  const items = Arr.getSomes(Arr.map(value.items, asSimple));
  return Option.map(
    Option.firstSomeOf([
      Arr.findFirst(items, hasLanguage(language)),
      Arr.findFirst(items, hasLanguage(X_DEFAULT)),
      Arr.head(items),
    ]),
    (item) => item.value,
  );
};

/**
 * The string of a simple top-level property.
 *
 * @since 0.1.0
 * @category accessors
 */
export const getText: {
  (iri: string): (self: Metadata) => Option.Option<string>;
  (self: Metadata, iri: string): Option.Option<string>;
} = dual(2, (self: Metadata, iri: string): Option.Option<string> =>
  Option.flatMap(get(self, iri), textOf),
);

/**
 * The strings of an array-valued top-level property.
 *
 * @since 0.1.0
 * @category accessors
 */
export const getItems: {
  (iri: string): (self: Metadata) => Option.Option<ReadonlyArray<string>>;
  (self: Metadata, iri: string): Option.Option<ReadonlyArray<string>>;
} = dual(2, (self: Metadata, iri: string): Option.Option<ReadonlyArray<string>> =>
  Option.flatMap(get(self, iri), itemsOf),
);

/**
 * A language-alternative top-level property in the given language (see
 * `localizedOf`).
 *
 * @since 0.1.0
 * @category accessors
 */
export const getLocalized = (
  self: Metadata,
  iri: string,
  language: string = X_DEFAULT,
): Option.Option<string> => Option.flatMap(get(self, iri), (value) => localizedOf(value, language));

/**
 * Sets one language of a language-alternative top-level property, keeping
 * its other languages. Setting `x-default` puts that item first.
 *
 * @since 0.1.0
 * @category combinators
 */
export const setLocalized = (
  self: Metadata,
  iri: string,
  value: string,
  language: string = X_DEFAULT,
): Metadata => {
  const existing = Option.match(Option.flatMap(get(self, iri), asArray), {
    onNone: () => [],
    onSome: (alt) => Arr.getSomes(Arr.map(alt.items, asSimple)),
  });
  const kept = Arr.map(
    Arr.filter(existing, (item) => !hasLanguage(language)(item)),
    (item) => [Option.getOrElse(item.language, () => X_DEFAULT), item.value] as const,
  );
  return set(self, iri, languageAlternative([...kept, [language, value]]));
};

// -----------------------------------------------------------------------------
// RDF ⇄ model
// -----------------------------------------------------------------------------

const memberIndex = (iri: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(MEMBER_RE.exec(iri)), (m) => Number(m[1]));

const ARRAY_FORMS: ReadonlyArray<ArrayForm> = ['Bag', 'Seq', 'Alt'];

const arrayForm = (type: Term.Object): Option.Option<ArrayForm> =>
  Term.isNamedNode(type)
    ? Arr.findFirst(ARRAY_FORMS, (form) => type.value === `${RDF}${form}`)
    : Option.none();

const byMember = Order.mapInput(Order.Number, (entry: readonly [number, Term.Quad]) => entry[0]);

const byPredicate = Order.mapInput(Order.String, (q: Term.Quad) => q.predicate.value);

type Visiting = HashSet.HashSet<string>;

class ModelReader {
  readonly dataset: Dataset.Dataset;
  constructor(dataset: Dataset.Dataset) {
    this.dataset = dataset;
  }

  fail(message: string): never {
    throw new XmpModelError({ message });
  }

  properties(subject: Term.Subject): ReadonlyArray<Term.Quad> {
    return Dataset.match(this.dataset, { subject });
  }

  /** Reads entries from quads, rejecting a property given twice. */
  entries(quads: ReadonlyArray<Term.Quad>, visiting: Visiting): Entries {
    const keys = Arr.map(quads, (q) => q.predicate.value);
    Option.map(
      Arr.findFirst(keys, (key, i) => keys.indexOf(key) !== i),
      (key) => this.fail(`Property <${key}> is given more than once`),
    );
    return Arr.map(
      Arr.sort(quads, byPredicate),
      (q) => [q.predicate.value, this.value(q.object, visiting)] as const,
    );
  }

  value(object: Term.Object, visiting: Visiting): Value {
    if (Term.isLiteral(object)) {
      return text(object.value, object.language === '' ? undefined : object.language);
    }
    if (Term.isNamedNode(object)) return uri(object.value);
    if (Term.isTriple(object)) return this.fail('XMP values cannot be triple terms');
    if (HashSet.has(visiting, object.key)) {
      return this.fail(`Blank node ${object.key} contains itself`);
    }
    return this.node(object, HashSet.add(visiting, object.key));
  }

  node(node: Term.BlankNode, visiting: Visiting): Value {
    const quads = this.properties(node);
    const isValue = (q: Term.Quad) => q.predicate.value === RDF_VALUE;
    const value = Arr.findFirst(quads, isValue);
    if (Option.isSome(value)) {
      const others = Arr.filter(quads, (q) => !isValue(q));
      return withQualifiers(
        this.value(value.value.object, visiting),
        this.entries(others, visiting),
      );
    }
    const form = Option.flatMap(
      Arr.findFirst(quads, (q) => q.predicate.value === RDF_TYPE),
      (q) => arrayForm(q.object),
    );
    if (Option.isNone(form)) return struct(this.entries(quads, visiting));
    const members = Arr.filterMap(quads, (q) =>
      Option.match(memberIndex(q.predicate.value), {
        onNone: () =>
          q.predicate.value === RDF_TYPE
            ? Result.failVoid
            : this.fail(`Array ${node.key} has the non-member property <${q.predicate.value}>`),
        onSome: (i) => Result.succeed([i, q] as const),
      }),
    );
    return array(
      form.value,
      Arr.map(Arr.sort(members, byMember), ([, q]) => this.value(q.object, visiting)),
    );
  }

  /**
   * Every top-level description: a subject that is an IRI or a blank node no
   * other triple refers to. ISO 16684-1 §7.4 requires all of them to describe
   * the same resource; readers accept differing or absent `rdf:about` values
   * and merge them.
   */
  metadata(): Metadata {
    const referenced = HashSet.fromIterable(
      Arr.map(Arr.filter(Dataset.objects(this.dataset), Term.isBlankNode), (o) => o.key),
    );
    const roots = Arr.filter(Dataset.subjects(this.dataset), (s) => {
      if (Term.isTriple(s)) return this.fail('XMP descriptions cannot be about triple terms');
      return Term.isNamedNode(s) || !HashSet.has(referenced, s.key);
    });
    const about = Option.getOrElse(
      Arr.findFirst(roots, (s) =>
        Term.isNamedNode(s) && s.value !== '' ? Option.some(s.value) : Option.none(),
      ),
      () => '',
    );
    return make(
      this.entries(
        Arr.flatMap(roots, (s) => this.properties(s)),
        HashSet.empty(),
      ),
      about,
    );
  }
}

/**
 * Reads the XMP data model from the RDF of an XMP packet, returning a
 * `Result`. Typed literals keep only their lexical form (XMP has no
 * datatypes); named graphs are ignored.
 *
 * @since 0.1.0
 * @category conversions
 */
export const fromDatasetResult = (
  dataset: Dataset.Dataset,
): Result.Result<Metadata, XmpModelError> =>
  Result.try({
    try: () => new ModelReader(dataset).metadata(),
    catch: (e) => {
      if (e instanceof XmpModelError) return e;
      throw e;
    },
  });

/**
 * Reads the XMP data model from the RDF of an XMP packet.
 *
 * @since 0.1.0
 * @category conversions
 */
export const fromDataset = (dataset: Dataset.Dataset): Effect.Effect<Metadata, XmpModelError> =>
  Effect.suspend(() => Effect.fromResult(fromDatasetResult(dataset)));

const rdf = (local: string) => new Term.NamedNode(`${RDF}${local}`);

const simpleTerm = (value: Simple): Term.Object =>
  value.isUri
    ? new Term.NamedNode(value.value)
    : Term.literal(value.value, Option.getOrUndefined(value.language));

/**
 * The RDF of the XMP data model: the properties of one `rdf:about` subject,
 * structures and arrays as blank nodes, and qualified values in the
 * `rdf:value` form.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toDataset = (self: Metadata): Dataset.Dataset =>
  Dataset.mutate(Dataset.empty, (builder) => {
    const emit = (s: Term.Subject, p: string, o: Term.Object) => {
      builder.add(new Term.Quad(s, new Term.NamedNode(p), o, Term.defaultGraph));
    };
    const emitAll = (s: Term.Subject, entries: Entries) => {
      entries.forEach(([p, v]) => emit(s, p, term(v)));
    };
    const bare = (value: Value): Term.Object => {
      if (isSimple(value)) return simpleTerm(value);
      const node = Term.blankNode();
      if (isStruct(value)) {
        emitAll(node, value.fields);
      } else {
        emit(node, RDF_TYPE, rdf(value.form));
        value.items.forEach((item, i) => emit(node, `${RDF}_${i + 1}`, term(item)));
      }
      return node;
    };
    const term = (value: Value): Term.Object => {
      if (!Arr.isReadonlyArrayNonEmpty(value.qualifiers)) return bare(value);
      const node = Term.blankNode();
      emit(node, RDF_VALUE, bare(value));
      emitAll(node, value.qualifiers);
      return node;
    };
    emitAll(new Term.NamedNode(self.about), self.properties);
  });

// -----------------------------------------------------------------------------
// Typed accessors
// -----------------------------------------------------------------------------

/**
 * A typed setter of one property, data-first or data-last.
 *
 * @since 0.1.0
 * @category models
 */
export interface Setter<A> {
  (value: A): (self: Metadata) => Metadata;
  (self: Metadata, value: A): Metadata;
}

/**
 * A typed setter of one language of a language-alternative property
 * (`x-default` unless a language is given), data-first or data-last.
 *
 * @since 0.1.0
 * @category models
 */
export interface LocalizedSetter {
  (value: string, language?: string): (self: Metadata) => Metadata;
  (self: Metadata, value: string, language?: string): Metadata;
}
