/**
 * RDF/JSON (https://www.w3.org/TR/rdf-json/), media type
 * `application/rdf+json`.
 *
 * The document structure is described with Effect `Schema`s, so decoding
 * validates the JSON shape and reports precise errors. `RdfJsonFromString`
 * decodes JSON text into a typed `Document`, and `DatasetFromRdfJson` /
 * `DatasetFromString` transform documents into core `Dataset`s and back.
 *
 * ## RDF 1.2 extensions
 *
 * RDF/JSON predates RDF 1.2. This module defines two backwards-compatible
 * extensions, accepted when parsing by default and written only when
 * `extensions: true` is passed to the serializer:
 *
 * - **Base direction**: a literal object with a `"lang"` may carry
 *   `"direction": "ltr" | "rtl"`, denoting a directional language-tagged
 *   string (`rdf:dirLangString`).
 * - **Triple terms**: an object value `{ "type": "triple", "value": { … } }`
 *   whose `value` has `"subject"` (a `uri` or `bnode` value), `"predicate"`
 *   (a `uri` value) and `"object"` (any object value, including another
 *   triple term) members.
 *
 * ```json
 * {
 *   "http://example.org/s": {
 *     "http://example.org/says": [
 *       { "type": "literal", "value": "שלום", "lang": "he", "direction": "rtl" },
 *       { "type": "triple", "value": {
 *           "subject": { "type": "uri", "value": "http://example.org/a" },
 *           "predicate": { "type": "uri", "value": "http://example.org/b" },
 *           "object": { "type": "literal", "value": "c" } } }
 *     ]
 *   }
 * }
 * ```
 *
 * RDF/JSON describes a single graph: serialising quads in named graphs fails
 * unless `mergeGraphs: true` is given.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Order from 'effect/Order';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { parseJson } from './internal/json.ts';

const FORMAT_NAME = 'RDF/JSON';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const RDF_DIR_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#dirLangString';

/**
 * The RDF/JSON format description.
 *
 * @since 0.1.0
 * @category formats
 */
export const format: Serialization.Format = Serialization.makeFormat({
  name: FORMAT_NAME,
  mediaType: 'application/rdf+json',
  extensions: ['rj'],
  datasets: false,
});

// -----------------------------------------------------------------------------
// Document model
// -----------------------------------------------------------------------------

/**
 * An IRI value: `{ "type": "uri", "value": "http://…" }`.
 *
 * @since 0.1.0
 * @category models
 */
export type UriValue = {
  readonly type: 'uri';
  readonly value: string;
};

/**
 * A blank node value: `{ "type": "bnode", "value": "_:label" }`.
 *
 * @since 0.1.0
 * @category models
 */
export type BlankNodeValue = {
  readonly type: 'bnode';
  readonly value: string;
};

/**
 * A literal value. `lang` and `datatype` are mutually exclusive;
 * `direction` is an RDF 1.2 extension that requires `lang`.
 *
 * @since 0.1.0
 * @category models
 */
export type LiteralValue = {
  readonly type: 'literal';
  readonly value: string;
  readonly lang?: string;
  readonly datatype?: string;
  readonly direction?: Term.Direction;
};

/**
 * An RDF 1.2 triple term value (extension).
 *
 * @since 0.1.0
 * @category models
 */
export type TripleTermValue = {
  readonly type: 'triple';
  readonly value: {
    readonly subject: UriValue | BlankNodeValue;
    readonly predicate: UriValue;
    readonly object: ObjectValue;
  };
};

/**
 * Any value in the object position.
 *
 * @since 0.1.0
 * @category models
 */
export type ObjectValue = UriValue | BlankNodeValue | LiteralValue | TripleTermValue;

/**
 * An RDF/JSON document: subject → predicate → array of object values.
 * Subjects are IRIs or blank node labels (`"_:label"`).
 *
 * @since 0.1.0
 * @category models
 */
export interface Document {
  readonly [subject: string]: { readonly [predicate: string]: ReadonlyArray<ObjectValue> };
}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category schemas
 */
export const UriValue: Schema.Codec<UriValue> = Schema.Struct({
  type: Schema.Literal('uri'),
  value: Schema.String,
}).annotate({ identifier: 'UriValue', description: 'An RDF/JSON IRI value' });

/**
 * @since 0.1.0
 * @category schemas
 */
export const BlankNodeValue: Schema.Codec<BlankNodeValue> = Schema.Struct({
  type: Schema.Literal('bnode'),
  value: Schema.String.check(
    Schema.isPattern(/^_:.+$/s, { message: 'Blank node values must have the form "_:label"' }),
  ),
}).annotate({ identifier: 'BlankNodeValue', description: 'An RDF/JSON blank node value' });

const Direction = Schema.Literals(['ltr', 'rtl']);

/**
 * @since 0.1.0
 * @category schemas
 */
export const LiteralValue: Schema.Codec<LiteralValue> = Schema.Struct({
  type: Schema.Literal('literal'),
  value: Schema.String,
  lang: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^[a-zA-Z]+(-[a-zA-Z0-9]+)*$/, { message: 'Invalid language tag' }),
    ),
  ),
  datatype: Schema.optionalKey(Schema.String),
  direction: Schema.optionalKey(Direction),
})
  .check(
    Schema.makeFilter(
      (l) =>
        l.lang !== undefined &&
        l.datatype !== undefined &&
        l.datatype !== RDF_LANG_STRING &&
        l.datatype !== RDF_DIR_LANG_STRING
          ? { path: ['datatype'], issue: '"datatype" cannot be combined with "lang"' }
          : undefined,
      {
        identifier: 'LiteralLangDatatype',
        title: 'Language or datatype',
        description: 'A literal with a "lang" has no "datatype" other than rdf:langString',
      },
    ),
    Schema.makeFilter(
      (l) =>
        l.direction !== undefined && l.lang === undefined
          ? { path: ['direction'], issue: '"direction" requires "lang"' }
          : undefined,
      {
        identifier: 'LiteralDirectionLang',
        title: 'Direction requires language',
        description: 'A literal with a "direction" also has a "lang"',
      },
    ),
  )
  .annotate({ identifier: 'LiteralValue', description: 'An RDF/JSON literal value' });

const SubjectValue = Schema.Union([UriValue, BlankNodeValue]);

/**
 * An RDF 1.2 triple term (extension).
 *
 * @since 0.1.0
 * @category schemas
 */
export const TripleTermValue: Schema.Codec<TripleTermValue> = Schema.Struct({
  type: Schema.Literal('triple'),
  value: Schema.Struct({
    subject: SubjectValue,
    predicate: UriValue,
    object: Schema.suspend((): Schema.Codec<ObjectValue> => ObjectValue),
  }),
}).annotate({ identifier: 'TripleTermValue', description: 'An RDF 1.2 triple term (extension)' });

/**
 * Any object value, including the RDF 1.2 extensions.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ObjectValue: Schema.Codec<ObjectValue> = Schema.Union([
  UriValue,
  BlankNodeValue,
  LiteralValue,
  TripleTermValue,
]).annotate({
  expected: 'an RDF/JSON value ("type" must be "uri", "bnode", "literal" or "triple")',
});

/**
 * The type of an object value in strict RDF/JSON (the `StrictObjectValue`
 * schema's decoded type).
 *
 * @since 0.1.0
 * @category models
 */
export type StrictObjectValue = typeof StrictObjectValue.Type;

/**
 * An object value in strict RDF/JSON: no triple terms and no base
 * direction.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StrictObjectValue: Schema.Codec<UriValue | BlankNodeValue | LiteralValue> =
  Schema.Union([
    UriValue,
    BlankNodeValue,
    LiteralValue.check(
      Schema.makeFilter(
        (l) =>
          l.direction !== undefined
            ? {
                path: ['direction'],
                issue: '"direction" is an RDF 1.2 extension (disabled in strict mode)',
              }
            : undefined,
        {
          identifier: 'StrictLiteralDirection',
          title: 'No base direction',
          description: 'A strict RDF/JSON literal has no "direction"',
        },
      ),
    ),
  ]).annotate({
    expected: 'an RDF/JSON value ("type" must be "uri", "bnode" or "literal")',
  });

const makeDocument = (value: Schema.Codec<ObjectValue>): Schema.Codec<Document> =>
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Array(value)));

/**
 * An RDF/JSON document, accepting the RDF 1.2 extensions.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Document: Schema.Codec<Document> = makeDocument(ObjectValue).annotate({
  description: 'An RDF/JSON document (with the RDF 1.2 extensions)',
});

/**
 * A strict RDF/JSON document, rejecting the RDF 1.2 extensions.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StrictDocument: Schema.Codec<Document> = makeDocument(StrictObjectValue).annotate({
  description: 'A strict RDF/JSON document',
});

/**
 * The decoded type of `RdfJsonFromString`: a validated `Document`.
 *
 * @since 0.1.0
 * @category models
 */
export type RdfJsonFromString = typeof RdfJsonFromString.Type;

/**
 * Decodes RDF/JSON text into a validated `Document` (and encodes documents
 * as JSON text).
 *
 * @since 0.1.0
 * @category schemas
 */
export const RdfJsonFromString: Schema.Codec<Document, string> = Schema.fromJsonString(Document);

// -----------------------------------------------------------------------------
// Conversions
// -----------------------------------------------------------------------------

/**
 * Options for converting RDF/JSON documents to datasets.
 *
 * @since 0.1.0
 * @category models
 */
export interface ToDatasetOptions {
  /** The graph to place triples in. Defaults to the default graph. */
  readonly graph?: Term.Graph | undefined;
  /**
   * Prefix for blank node labels. Defaults to a fresh prefix per document,
   * so that blank nodes from different documents never clash.
   */
  readonly blankNodePrefix?: string | undefined;
}

/**
 * Converts a (validated) RDF/JSON document to a dataset.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toDataset = (document: Document, options?: ToDatasetOptions): Dataset.Dataset => {
  const prefix = options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix();
  const graph = options?.graph ?? Term.defaultGraph;
  const blank = (label: string) => new Term.BlankNode(prefix + label.slice(2));
  const subjectTerm = (key: string): Term.NamedNode | Term.BlankNode =>
    key.startsWith('_:') ? blank(key) : new Term.NamedNode(key);
  const objectTerm = (v: ObjectValue): Term.Object => {
    switch (v.type) {
      case 'uri':
        return new Term.NamedNode(v.value);
      case 'bnode':
        return blank(v.value);
      case 'literal':
        if (v.lang !== undefined) {
          return Term.literal(
            v.value,
            v.direction !== undefined ? { language: v.lang, direction: v.direction } : v.lang,
          );
        }
        return Term.literal(v.value, new Term.NamedNode(v.datatype ?? XSD_STRING));
      case 'triple':
        return new Term.Triple(
          v.value.subject.type === 'uri'
            ? new Term.NamedNode(v.value.subject.value)
            : blank(v.value.subject.value),
          new Term.NamedNode(v.value.predicate.value),
          objectTerm(v.value.object),
        );
    }
  };
  return Dataset.mutate(Dataset.empty, (b) => {
    for (const [s, predicates] of Object.entries(document)) {
      const subject = subjectTerm(s);
      for (const [p, objects] of Object.entries(predicates)) {
        const predicate = new Term.NamedNode(p);
        for (const o of objects) b.add(new Term.Quad(subject, predicate, objectTerm(o), graph));
      }
    }
  });
};

/**
 * Options for converting quads to RDF/JSON.
 *
 * @since 0.1.0
 * @category models
 */
export interface FromQuadsOptions {
  /**
   * Whether to use the RDF 1.2 extensions (base direction and triple terms).
   * When `false` (the default), data that needs them is rejected with an
   * `RdfSerializeError`.
   */
  readonly extensions?: boolean | undefined;
  /**
   * Whether to merge quads from named graphs into the single RDF/JSON graph.
   * When `false` (the default), quads in named graphs are rejected.
   */
  readonly mergeGraphs?: boolean | undefined;
}

class SerializeFailure {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

const quadOrder: Order.Order<Term.Quad> = Order.combineAll([
  Order.mapInput(Term.compare, (q: Term.Quad) => q.subject),
  Order.mapInput(Term.compare, (q: Term.Quad) => q.predicate),
  Order.mapInput(Term.compare, (q: Term.Quad) => q.object),
]);

const fromQuadsUnsafe = (quads: Iterable<Term.Quad>, options: FromQuadsOptions): Document => {
  const extensions = options.extensions ?? false;
  const fail = (message: string): never => {
    throw new SerializeFailure(message);
  };
  const resource = (t: Term.NamedNode | Term.BlankNode): UriValue | BlankNodeValue =>
    t._tag === 'NamedNode'
      ? { type: 'uri', value: t.value }
      : { type: 'bnode', value: `_:${t.value}` };
  const objectValue = (t: Term.Object): ObjectValue => {
    switch (t._tag) {
      case 'NamedNode':
      case 'BlankNode':
        return resource(t);
      case 'Literal': {
        if (t.language !== '') {
          if (t.direction === undefined)
            return { type: 'literal', value: t.value, lang: t.language };
          if (!extensions) {
            fail(
              `The literal ${t.key} has a base direction, which requires the RDF/JSON extensions`,
            );
          }
          return { type: 'literal', value: t.value, lang: t.language, direction: t.direction };
        }
        return t.datatype.value === XSD_STRING
          ? { type: 'literal', value: t.value }
          : { type: 'literal', value: t.value, datatype: t.datatype.value };
      }
      case 'Triple': {
        if (!extensions) {
          fail(`The triple term ${t.key} requires the RDF/JSON extensions`);
        }
        const subject = t.subject;
        if (subject._tag === 'Triple') {
          throw new SerializeFailure(`Triple terms cannot have triple terms as subjects: ${t.key}`);
        }
        return {
          type: 'triple',
          value: {
            subject: resource(subject),
            predicate: { type: 'uri', value: t.predicate.value },
            object: objectValue(t.object),
          },
        };
      }
    }
  };
  const merge = options.mergeGraphs ?? false;
  const seen = new Set<string>();
  const sorted = Arr.sort(quads, quadOrder);
  const document: Record<string, Record<string, Array<ObjectValue>>> = {};
  for (const q of sorted) {
    if (q.graph._tag !== 'DefaultGraph' && !merge) {
      fail(`RDF/JSON cannot represent named graphs (found graph ${q.graph.key})`);
    }
    const tripleKey = `${q.subject.key} ${q.predicate.key} ${q.object.key}`;
    if (seen.has(tripleKey)) continue;
    seen.add(tripleKey);
    const subject = q.subject;
    if (subject._tag === 'Triple') {
      throw new SerializeFailure('RDF/JSON cannot represent triple terms as subjects');
    }
    const s = subject._tag === 'NamedNode' ? subject.value : `_:${subject.value}`;
    const predicates = (document[s] ??= {});
    (predicates[q.predicate.value] ??= []).push(objectValue(q.object));
  }
  return document;
};

/**
 * Converts quads to an RDF/JSON document.
 *
 * @since 0.1.0
 * @category conversions
 */
export const fromQuads = (
  quads: Iterable<Term.Quad>,
  options?: FromQuadsOptions,
): Effect.Effect<Document, Serialization.RdfSerializeError> =>
  Effect.try({
    try: () => fromQuadsUnsafe(quads, options ?? {}),
    // Anything but a `SerializeFailure` is a bug: rethrown, it becomes a defect.
    catch: (e) => {
      if (e instanceof SerializeFailure) {
        return new Serialization.RdfSerializeError({ format: FORMAT_NAME, message: e.message });
      }
      throw e;
    },
  });

/**
 * Builds a schema transforming RDF/JSON documents into datasets and back,
 * with the given conversion options.
 *
 * @since 0.1.0
 * @category schemas
 */
export const makeDatasetSchema = (
  options?: ToDatasetOptions & FromQuadsOptions & { readonly strict?: boolean | undefined },
): Schema.Codec<Dataset.Dataset, Document> =>
  (options?.strict === true ? StrictDocument : Document).pipe(
    Schema.decodeTo(
      Dataset.DatasetSchema,
      SchemaTransformation.transformEffect({
        decode: (document: Document) => Effect.sync(() => toDataset(document, options)),
        encode: (dataset: Dataset.Dataset) =>
          fromQuads(dataset, options).pipe(
            Effect.mapError((e) => new SchemaIssue.InvalidValue({ message: e.message }, dataset)),
          ),
      }),
    ),
  );

/**
 * A schema transforming RDF/JSON documents into datasets and back. Decoding
 * accepts the RDF 1.2 extensions; encoding writes strict RDF/JSON and fails
 * for data that needs the extensions or uses named graphs.
 *
 * @since 0.1.0
 * @category schemas
 */
export const DatasetFromRdfJson: Schema.Codec<Dataset.Dataset, Document> = makeDatasetSchema();

/**
 * The decoded type of `DatasetFromString`: a `Dataset`.
 *
 * @since 0.1.0
 * @category models
 */
export type DatasetFromString = typeof DatasetFromString.Type;

/**
 * A schema transforming RDF/JSON text into datasets and back.
 *
 * @since 0.1.0
 * @category schemas
 */
export const DatasetFromString: Schema.Codec<Dataset.Dataset, string> = Schema.fromJsonString(
  DatasetFromRdfJson,
  { space: 2 },
);

// -----------------------------------------------------------------------------
// Parser / serializer
// -----------------------------------------------------------------------------

/**
 * Options for parsing RDF/JSON.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions extends Serialization.ParseOptions {
  /** Reject the RDF 1.2 extensions. Defaults to `false`. */
  readonly strict?: boolean | undefined;
}

/**
 * Finds the offset of the first JSON syntax error (JavaScript engines do not
 * always report one). Only used once `JSON.parse` has failed.
 */
const jsonErrorOffset = (input: string): number => {
  let i = 0;
  const ws = () => {
    while (i < input.length && ' \t\n\r'.includes(input[i]!)) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const string = () => {
    i++;
    for (;;) {
      if (i >= input.length) fail();
      const c = input.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return;
      }
      if (c < 0x20) fail();
      if (c === 0x5c) {
        const e = input[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(input.slice(i + 2, i + 6))) fail();
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail();
      } else i++;
    }
  };
  const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (): void => {
    ws();
    const c = input[i];
    if (c === '{') {
      i++;
      ws();
      if (input[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (input[i] !== '"') fail();
        string();
        ws();
        if (input[i] !== ':') fail();
        i++;
        value();
        ws();
        if (input[i] === ',') i++;
        else if (input[i] === '}') {
          i++;
          return;
        } else fail();
      }
    } else if (c === '[') {
      i++;
      ws();
      if (input[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (input[i] === ',') i++;
        else if (input[i] === ']') {
          i++;
          return;
        } else fail();
      }
    } else if (c === '"') string();
    else if (input.startsWith('true', i)) i += 4;
    else if (input.startsWith('false', i)) i += 5;
    else if (input.startsWith('null', i)) i += 4;
    else {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(input);
      if (m === null) return fail();
      i += m[0].length;
    }
  };
  // `fail` throws at the offending offset, which is `i`.
  return Result.merge(
    Result.try({
      try: () => {
        value();
        ws();
        return i;
      },
      catch: () => i,
    }),
  );
};

const jsonErrorPosition = (input: string) => {
  const offset = jsonErrorOffset(input);
  const before = input.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
};

/**
 * Parses RDF/JSON text into a dataset. The document shape is validated with
 * the `Document` schema (or `StrictDocument` when `strict` is set), and
 * validation failures are reported as `RdfParseError`s.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.gen(function* () {
    const json = yield* Effect.fromResult(parseJson(input)).pipe(
      Effect.mapError(
        (e) =>
          new Serialization.RdfParseError({
            format: FORMAT_NAME,
            message: `Invalid JSON: ${e.message}`,
            ...jsonErrorPosition(input),
          }),
      ),
    );
    const document = yield* Schema.decodeUnknownEffect(
      options?.strict === true ? StrictDocument : Document,
    )(json).pipe(
      Effect.mapError(
        (e) => new Serialization.RdfParseError({ format: FORMAT_NAME, message: e.message }),
      ),
    );
    return {
      dataset: toDataset(document, options),
      prefixes: PrefixMap.empty,
      baseIri: options?.baseIri,
    };
  });

/**
 * Options for serialising RDF/JSON.
 *
 * @since 0.1.0
 * @category models
 */
export interface SerializeOptions extends Serialization.SerializeOptions, FromQuadsOptions {
  /** Indentation passed to `JSON.stringify`. Defaults to 2 spaces. */
  readonly space?: number | string | undefined;
}

/**
 * Serialises quads as RDF/JSON text.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serialize = (
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  fromQuads(quads, options).pipe(
    Effect.flatMap((document) =>
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: options?.space ?? 2 }))(
        document,
      ).pipe(
        Effect.mapError(
          (e) => new Serialization.RdfSerializeError({ format: FORMAT_NAME, message: e.message }),
        ),
      ),
    ),
    Effect.map((text) => `${text}\n`),
  );

/**
 * The RDF/JSON parser.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parser: Serialization.Parser<ParseOptions> = Serialization.makeParser({
  format,
  parse,
});

/**
 * The RDF/JSON serializer.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializer: Serialization.Serializer<SerializeOptions> = Serialization.makeSerializer({
  format,
  serialize,
});

/**
 * The RDF/JSON codec. Its `schema` is `DatasetFromString`, so decoding
 * errors carry the precise schema issue.
 *
 * @since 0.1.0
 * @category codecs
 */
export const codec: Serialization.Codec<ParseOptions, SerializeOptions> = {
  ...Serialization.makeCodec(parser, serializer),
  schema: DatasetFromString,
};
