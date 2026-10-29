/**
 * Serialisation interfaces shared by every RDF syntax package.
 *
 * A syntax package (Turtle, JSON-LD, RDF/XML, …) provides a `Parser` and a
 * `Serializer`, usually combined into a `Codec`. Codecs expose an Effect
 * `Schema` transforming `string ⇄ Dataset`, and can be registered in the
 * `Formats` service for media-type based lookup and content negotiation.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as Stream from 'effect/Stream';
import * as Dataset from './Dataset.ts';
import * as PrefixMap from './PrefixMap.ts';
import type * as Term from './Term.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * A syntax or semantic error encountered while parsing an RDF document.
 *
 * @since 0.1.0
 * @category errors
 */
export class RdfParseError extends Schema.TaggedError<RdfParseError>()('RdfParseError', {
  format: Schema.String,
  message: Schema.String,
  line: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number),
}) {}

/**
 * An error encountered while serialising quads, e.g. a quad that cannot be
 * represented in the target syntax (a named graph in Turtle).
 *
 * @since 0.1.0
 * @category errors
 */
export class RdfSerializeError extends Schema.TaggedError<RdfSerializeError>()(
  'RdfSerializeError',
  {
    format: Schema.String,
    message: Schema.String,
  },
) {}

// -----------------------------------------------------------------------------
// Formats
// -----------------------------------------------------------------------------

/**
 * Metadata describing an RDF concrete syntax.
 *
 * @since 0.1.0
 * @category models
 */
export interface Format {
  /** Human-readable name, e.g. `"Turtle"`. */
  readonly name: string;
  /** The preferred media type. */
  readonly mediaType: string;
  /** All media types (including the preferred one) that identify the syntax. */
  readonly mediaTypes: ReadonlyArray<string>;
  /** File extensions without the leading dot. */
  readonly extensions: ReadonlyArray<string>;
  /** Whether the syntax can represent named graphs. */
  readonly datasets: boolean;
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const makeFormat = (
  format: Omit<Format, 'mediaTypes'> & { readonly mediaTypes?: ReadonlyArray<string> },
): Format => ({
  ...format,
  mediaTypes: format.mediaTypes ?? [format.mediaType],
});

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions {
  /** The base IRI against which relative IRIs are resolved. */
  readonly baseIri?: string | undefined;
  /**
   * The graph in which triples are placed when parsing a triples-only syntax.
   * Defaults to the default graph.
   */
  readonly graph?: Term.Graph | undefined;
  /**
   * Prefix for generated blank node labels. Defaults to a fresh prefix per
   * document so that blank nodes from different documents never clash.
   */
  readonly blankNodePrefix?: string | undefined;
}

/**
 * The result of parsing a complete document.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParseResult {
  readonly dataset: Dataset.Dataset;
  /** Prefixes declared by the document, if the syntax supports them. */
  readonly prefixes: PrefixMap.PrefixMap;
  /** The final base IRI of the document, if any. */
  readonly baseIri: string | undefined;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Parser<Options extends ParseOptions = ParseOptions> {
  readonly format: Format;
  /** Parses a complete document. */
  readonly parse: (input: string, options?: Options) => Effect.Effect<ParseResult, RdfParseError>;
  /** Parses a stream of text chunks into a stream of quads. */
  readonly parseStream: <E, R>(
    input: Stream.Stream<string, E, R>,
    options?: Options,
  ) => Stream.Stream<Term.Quad, RdfParseError | E, R>;
}

/**
 * Builds a `Parser`. When `parseStream` is not provided the stream is
 * buffered and parsed as a whole.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeParser = <Options extends ParseOptions = ParseOptions>(options: {
  readonly format: Format;
  readonly parse: (input: string, options?: Options) => Effect.Effect<ParseResult, RdfParseError>;
  readonly parseStream?: Parser<Options>['parseStream'];
}): Parser<Options> => ({
  format: options.format,
  parse: options.parse,
  parseStream:
    options.parseStream ??
    (<E, R>(input: Stream.Stream<string, E, R>, parseOptions?: Options) =>
      Stream.mkString(input).pipe(
        Effect.flatMap((text) => options.parse(text, parseOptions)),
        Effect.map((result) => result.dataset),
        Stream.fromIterableEffect,
      )),
});

// -----------------------------------------------------------------------------
// Serialising
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category models
 */
export interface SerializeOptions {
  /** Prefixes to use for abbreviating IRIs, if the syntax supports them. */
  readonly prefixes?: PrefixMap.PrefixMap | undefined;
  /** The base IRI used to relativise IRIs, if the syntax supports it. */
  readonly baseIri?: string | undefined;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Serializer<Options extends SerializeOptions = SerializeOptions> {
  readonly format: Format;
  /** Serialises quads to a complete document. */
  readonly serialize: (
    quads: Iterable<Term.Quad>,
    options?: Options,
  ) => Effect.Effect<string, RdfSerializeError>;
  /** Serialises a stream of quads to a stream of text chunks. */
  readonly serializeStream: <E, R>(
    quads: Stream.Stream<Term.Quad, E, R>,
    options?: Options,
  ) => Stream.Stream<string, RdfSerializeError | E, R>;
}

/**
 * Builds a `Serializer`. When `serializeStream` is not provided the stream is
 * buffered and serialised as a whole.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeSerializer = <Options extends SerializeOptions = SerializeOptions>(options: {
  readonly format: Format;
  readonly serialize: (
    quads: Iterable<Term.Quad>,
    options?: Options,
  ) => Effect.Effect<string, RdfSerializeError>;
  readonly serializeStream?: Serializer<Options>['serializeStream'];
}): Serializer<Options> => ({
  format: options.format,
  serialize: options.serialize,
  serializeStream:
    options.serializeStream ??
    (<E, R>(quads: Stream.Stream<Term.Quad, E, R>, serializeOptions?: Options) =>
      Stream.runCollect(quads).pipe(
        Effect.flatMap((all) => options.serialize(all, serializeOptions)),
        Stream.fromEffect,
      )),
});

// -----------------------------------------------------------------------------
// Codecs
// -----------------------------------------------------------------------------

/**
 * A parser and serializer for the same syntax.
 *
 * @since 0.1.0
 * @category models
 */
export interface Codec<
  ParseOpts extends ParseOptions = ParseOptions,
  SerializeOpts extends SerializeOptions = SerializeOptions,
>
  extends Parser<ParseOpts>, Serializer<SerializeOpts> {
  /** A schema transforming documents (`string`) to `Dataset`s and back. */
  readonly schema: Schema.Codec<Dataset.Dataset, string>;
}

/**
 * Combines a parser and serializer into a `Codec`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeCodec = <ParseOpts extends ParseOptions, SerializeOpts extends SerializeOptions>(
  parser: Parser<ParseOpts>,
  serializer: Serializer<SerializeOpts>,
): Codec<ParseOpts, SerializeOpts> => ({
  format: parser.format,
  parse: parser.parse,
  parseStream: parser.parseStream,
  serialize: serializer.serialize,
  serializeStream: serializer.serializeStream,
  schema: toSchema(parser, serializer),
});

/**
 * Builds a `Schema` that decodes documents to datasets with `parser` and
 * encodes datasets with `serializer`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const toSchema = (
  parser: Parser<any>,
  serializer: Serializer<any>,
): Schema.Codec<Dataset.Dataset, string> =>
  Schema.String.pipe(
    Schema.decodeTo(
      Dataset.DatasetSchema,
      SchemaTransformation.transformEffect({
        decode: (input: string) =>
          parser.parse(input).pipe(
            Effect.map((r) => r.dataset),
            Effect.mapError(
              (e) => new SchemaIssue.InvalidValue({ message: formatError(e) }, input),
            ),
          ),
        encode: (dataset: Dataset.Dataset) =>
          serializer
            .serialize(dataset)
            .pipe(
              Effect.mapError((e) => new SchemaIssue.InvalidValue({ message: e.message }, dataset)),
            ),
      }),
    ),
  );

/**
 * Formats a parse error with its position.
 *
 * @since 0.1.0
 * @category errors
 */
export const formatError = (error: RdfParseError): string =>
  error.line !== undefined
    ? `${error.format} parse error at line ${error.line}${error.column !== undefined ? `, column ${error.column}` : ''}: ${error.message}`
    : `${error.format} parse error: ${error.message}`;

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

/**
 * A registry of available parsers and serializers, used for media-type
 * lookup and HTTP content negotiation.
 *
 * @since 0.1.0
 * @category services
 */
export class Formats extends Context.Service<
  Formats,
  {
    readonly parsers: ReadonlyArray<Parser<any>>;
    readonly serializers: ReadonlyArray<Serializer<any>>;
  }
>()('@thomasfosterau/effect-rdf/Formats') {}

/**
 * Creates a `Formats` layer from codecs, parsers and serializers.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  ...entries: ReadonlyArray<Codec<any, any> | Parser<any> | Serializer<any>>
): Layer.Layer<Formats> =>
  Layer.succeed(Formats, {
    parsers: entries.filter((e): e is Parser<any> => 'parse' in e),
    serializers: entries.filter((e): e is Serializer<any> => 'serialize' in e),
  });

const normalizeMediaType = (mediaType: string): string =>
  mediaType.split(';')[0]!.trim().toLowerCase();

/**
 * Finds a parser for a media type (parameters such as `charset` are ignored).
 *
 * @since 0.1.0
 * @category lookup
 */
export const parserFor = (
  formats: Formats['Service'],
  mediaType: string,
): Option.Option<Parser<any>> => {
  const mt = normalizeMediaType(mediaType);
  return Option.fromNullishOr(formats.parsers.find((p) => p.format.mediaTypes.includes(mt)));
};

/**
 * Finds a serializer for a media type.
 *
 * @since 0.1.0
 * @category lookup
 */
export const serializerFor = (
  formats: Formats['Service'],
  mediaType: string,
): Option.Option<Serializer<any>> => {
  const mt = normalizeMediaType(mediaType);
  return Option.fromNullishOr(formats.serializers.find((s) => s.format.mediaTypes.includes(mt)));
};

/**
 * Finds a parser for a file extension (with or without leading dot).
 *
 * @since 0.1.0
 * @category lookup
 */
export const parserForExtension = (
  formats: Formats['Service'],
  extension: string,
): Option.Option<Parser<any>> => {
  const ext = extension.replace(/^\./, '').toLowerCase();
  return Option.fromNullishOr(formats.parsers.find((p) => p.format.extensions.includes(ext)));
};

/**
 * A parsed `Accept` header entry.
 *
 * @since 0.1.0
 * @category negotiation
 */
export interface AcceptEntry {
  readonly mediaType: string;
  readonly q: number;
}

/**
 * Parses an HTTP `Accept` header, sorted by preference.
 *
 * @since 0.1.0
 * @category negotiation
 */
export const parseAccept = (header: string): ReadonlyArray<AcceptEntry> =>
  Arr.sort(
    header
      .split(',')
      .map((part, index) => {
        const [type, ...params] = part.split(';').map((s) => s.trim());
        let q = 1;
        for (const p of params) {
          const [k, v] = p.split('=').map((s) => s.trim());
          if (k === 'q' && v !== undefined) q = Number(v);
        }
        return { mediaType: (type ?? '').toLowerCase(), q: Number.isNaN(q) ? 0 : q, index };
      })
      .filter((e) => e.mediaType !== '' && e.q > 0),
    acceptOrder,
  ).map(({ mediaType, q }) => ({ mediaType, q }));

interface AcceptCandidate {
  readonly mediaType: string;
  readonly q: number;
  readonly index: number;
}

/** Highest quality first, then the most specific range, then header order. */
const acceptOrder: Order.Order<AcceptCandidate> = Order.combineAll([
  Order.flip(Order.mapInput(Order.Number, (e: AcceptCandidate) => e.q)),
  Order.flip(Order.mapInput(Order.Number, (e: AcceptCandidate) => specificity(e.mediaType))),
  Order.mapInput(Order.Number, (e: AcceptCandidate) => e.index),
]);

const specificity = (mt: string): number => (mt === '*/*' ? 0 : mt.endsWith('/*') ? 1 : 2);

/**
 * Selects the best of `available` media types for an `Accept` header.
 * Returns the first available type when the header is empty or absent.
 *
 * @since 0.1.0
 * @category negotiation
 */
export const negotiate = (
  accept: string | undefined,
  available: ReadonlyArray<string>,
): Option.Option<string> => {
  if (Arr.isReadonlyArrayEmpty(available)) return Option.none();
  if (accept === undefined || accept.trim() === '') return Option.some(available[0]!);
  for (const entry of parseAccept(accept)) {
    if (entry.mediaType === '*/*') return Option.some(available[0]!);
    if (entry.mediaType.endsWith('/*')) {
      const prefix = entry.mediaType.slice(0, -1);
      const found = available.find((a) => a.startsWith(prefix));
      if (found !== undefined) return Option.some(found);
    } else if (available.includes(entry.mediaType)) {
      return Option.some(entry.mediaType);
    }
  }
  return Option.none();
};

/**
 * Generates a fresh blank node label prefix for a parsed document.
 *
 * @since 0.1.0
 * @category utils
 */
export const freshBlankNodePrefix = (): string => `b${(documentCounter++).toString(36)}_`;

let documentCounter = 0;
