/**
 * XMP packets as an RDF syntax: the parser reads an XMP packet (or a
 * sidecar `.xmp` file, or any XML document embedding `rdf:RDF`) to a
 * dataset, and the serializer writes the canonical XMP form of ISO 16684-1
 * §7: an `<x:xmpmeta>` wrapper, one `rdf:Description` per schema namespace,
 * property elements only, and the packet wrapper with padding. Most XMP
 * consumers are not general RDF/XML parsers, so the serializer never uses
 * the RDF/XML abbreviations they may not accept.
 *
 * `parseMetadata` / `serializeMetadata` work on the XMP data model
 * (`Metadata`) directly.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xml from './internal/xml.ts';
import * as Metadata from './Metadata.ts';
import * as Namespaces from './Namespaces.ts';
import * as Packet from './Packet.ts';

const FORMAT_NAME = 'XMP';

/**
 * The XMP format description. XMP's registered media type is RDF/XML's
 * (`application/rdf+xml`); the `.xmp` extension tells the two apart.
 *
 * @since 0.1.0
 * @category formats
 */
export const format: Serialization.Format = Serialization.makeFormat({
  name: FORMAT_NAME,
  mediaType: 'application/rdf+xml',
  extensions: ['xmp'],
  datasets: false,
});

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/**
 * Parses the text of an XMP packet: a packet, a bare `<x:xmpmeta>` (or
 * older `<x:xapmeta>`) element, a bare `rdf:RDF` element or any XML document
 * containing one (an SVG's `<metadata>`). The first `rdf:RDF` element is
 * read as RDF/XML.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options?: Serialization.ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.suspend(() => Xml.parseRdf(input, options));

/**
 * The XMP parser.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parser: Serialization.Parser = Serialization.makeParser({ format, parse });

const decode = (input: string | Uint8Array): string =>
  Predicate.isString(input)
    ? input
    : Option.match(Packet.find(input), {
        onNone: () => new TextDecoder().decode(input),
        onSome: (packet) => packet.text,
      });

/**
 * Reads the XMP data model from text, or from bytes: the first packet in
 * them, or the whole of them as UTF-8 when they hold no packet (a sidecar
 * `.xmp` file written without one).
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseMetadata = (
  input: string | Uint8Array,
  options?: Serialization.ParseOptions,
): Effect.Effect<Metadata.Metadata, Serialization.RdfParseError> =>
  Effect.gen(function* () {
    const result = yield* parse(decode(input), options);
    return yield* Metadata.fromDataset(result.dataset).pipe(
      Effect.mapError(
        (e) => new Serialization.RdfParseError({ format: FORMAT_NAME, message: e.message }),
      ),
    );
  });

// -----------------------------------------------------------------------------
// Serializing
// -----------------------------------------------------------------------------

/**
 * Options for serializing XMP.
 *
 * @since 0.1.0
 * @category models
 */
export interface SerializeOptions extends Serialization.SerializeOptions {
  /** Whether to wrap the XMP in an `<?xpacket?>` packet. Defaults to `true`. */
  readonly packet?: boolean | undefined;
  /** Whether the packet trailer is `end="w"`. Defaults to `true`. */
  readonly writable?: boolean | undefined;
  /**
   * Bytes of padding before the trailer. Defaults to `Packet.DEFAULT_PADDING`
   * for a writable packet and 0 for a read-only one.
   */
  readonly padding?: number | undefined;
  /**
   * The exact byte length of the packet, padding the difference: how a
   * packet is updated in place. Serialization fails when the XMP does not
   * fit. Overrides `padding`.
   */
  readonly size?: number | undefined;
  /** The `x:xmptk` attribute naming the writing toolkit. Omitted by default. */
  readonly toolkit?: string | undefined;
  /** The indentation unit. Defaults to one space, as Adobe's toolkit writes. */
  readonly indent?: string | undefined;
}

const fail = (message: string): never => {
  throw new Serialization.RdfSerializeError({ format: FORMAT_NAME, message });
};

const split = (iri: string): readonly [string, string] =>
  Option.getOrElse(Xml.splitIri(iri), () =>
    fail(`The IRI <${iri}> cannot be written as an XML element name`),
  );

const namespaceOf = (iri: string): string => split(iri)[0];

/** Every property, field and qualifier IRI in a value, in document order. */
const iris = (value: Metadata.Value): ReadonlyArray<string> => [
  ...entryIris(value.qualifiers),
  ...(Metadata.isStruct(value)
    ? entryIris(value.fields)
    : Metadata.isArray(value)
      ? Arr.flatMap(value.items, iris)
      : []),
];

const entryIris = (entries: Metadata.Entries): ReadonlyArray<string> =>
  Arr.flatMap(entries, ([iri, value]) => [iri, ...iris(value)]);

const RESERVED: ReadonlyArray<string> = ['x', 'rdf', 'xml', 'xmlns'];

/** `[namespace, prefix]` pairs. */
type Prefixes = ReadonlyArray<readonly [string, string]>;

const prefixFor = (prefixes: Prefixes, ns: string): Option.Option<string> =>
  Option.map(
    Arr.findFirst(prefixes, ([n]) => n === ns),
    ([, prefix]) => prefix,
  );

const usable = (map: PrefixMap.PrefixMap): Prefixes =>
  Arr.map(
    Arr.filter(
      Arr.fromIterable(map.prefixes),
      ([prefix]) => prefix !== '' && !RESERVED.includes(prefix.toLowerCase()),
    ),
    ([prefix, ns]) => [ns, prefix] as const,
  );

/** Assigns every namespace a prefix: the caller's, the conventional one, or `nsN`. */
const assignPrefixes = (
  namespaces: ReadonlyArray<string>,
  given: PrefixMap.PrefixMap,
): Prefixes => {
  const preferred = [...usable(given), ...usable(Namespaces.prefixes)];
  const initial: Prefixes = [[Namespaces.RDF, 'rdf']];
  return Arr.reduce(Arr.dedupe(namespaces), initial, (assigned, ns) => {
    if (Option.isSome(prefixFor(assigned, ns))) return assigned;
    const isFree = (p: string) => !Arr.some(assigned, ([, taken]) => taken === p);
    const generated = () =>
      Option.getOrElse(
        Arr.findFirst(
          Arr.makeBy(assigned.length + 1, (i) => `ns${i + 1}`),
          isFree,
        ),
        () => `ns${assigned.length + 1}`,
      );
    const prefix = Option.getOrElse(Option.filter(prefixFor(preferred, ns), isFree), generated);
    return [...assigned, [ns, prefix] as const];
  });
};

interface Writer {
  readonly prefixes: Prefixes;
  readonly indent: string;
}

const prefixOf = (writer: Writer, ns: string): string =>
  Option.getOrElse(prefixFor(writer.prefixes, ns), () => fail(`No prefix for <${ns}>`));

const qname = (writer: Writer, iri: string): string => {
  const [ns, local] = split(iri);
  return `${prefixOf(writer, ns)}:${local}`;
};

const unqualified = <V extends Metadata.Value>(value: V): V => ({ ...value, qualifiers: [] });

const simpleLines = (pad: string, name: string, value: Metadata.Simple): ReadonlyArray<string> => {
  if (value.isUri) return [`${pad}<${name} rdf:resource="${Xml.escapeAttribute(value.value)}"/>`];
  const lang = Option.match(value.language, {
    onNone: () => '',
    onSome: (l) => ` xml:lang="${Xml.escapeAttribute(l)}"`,
  });
  return [`${pad}<${name}${lang}>${Xml.escapeText(value.value)}</${name}>`];
};

const structLines = (
  writer: Writer,
  pad: string,
  name: string,
  entries: Metadata.Entries,
  depth: number,
): ReadonlyArray<string> =>
  Arr.isReadonlyArrayNonEmpty(entries)
    ? [
        `${pad}<${name} rdf:parseType="Resource">`,
        ...entryLines(writer, entries, depth + 1),
        `${pad}</${name}>`,
      ]
    : [`${pad}<${name} rdf:parseType="Resource"/>`];

const arrayLines = (
  writer: Writer,
  pad: string,
  name: string,
  value: Metadata.ArrayValue,
  depth: number,
): ReadonlyArray<string> => {
  const inner = writer.indent.repeat(depth + 1);
  const container = `rdf:${value.form}`;
  return [
    `${pad}<${name}>`,
    ...(Arr.isReadonlyArrayNonEmpty(value.items)
      ? [
          `${inner}<${container}>`,
          ...Arr.flatMap(value.items, (item) => elementLines(writer, 'rdf:li', item, depth + 2)),
          `${inner}</${container}>`,
        ]
      : [`${inner}<${container}/>`]),
    `${pad}</${name}>`,
  ];
};

const elementLines = (
  writer: Writer,
  name: string,
  value: Metadata.Value,
  depth: number,
): ReadonlyArray<string> => {
  const pad = writer.indent.repeat(depth);
  if (Arr.isReadonlyArrayNonEmpty(value.qualifiers)) {
    return [
      `${pad}<${name} rdf:parseType="Resource">`,
      ...elementLines(writer, 'rdf:value', unqualified(value), depth + 1),
      ...entryLines(writer, value.qualifiers, depth + 1),
      `${pad}</${name}>`,
    ];
  }
  if (Metadata.isSimple(value)) return simpleLines(pad, name, value);
  if (Metadata.isStruct(value)) return structLines(writer, pad, name, value.fields, depth);
  return arrayLines(writer, pad, name, value, depth);
};

const entryLines = (
  writer: Writer,
  entries: Metadata.Entries,
  depth: number,
): ReadonlyArray<string> =>
  Arr.flatMap(entries, ([iri, value]) => elementLines(writer, qname(writer, iri), value, depth));

const descriptionLines = (
  writer: Writer,
  about: string,
  properties: Metadata.Entries,
): ReadonlyArray<string> => {
  const pad = writer.indent.repeat(2);
  const open = `${pad}<rdf:Description rdf:about="${Xml.escapeAttribute(about)}"`;
  if (!Arr.isReadonlyArrayNonEmpty(properties)) return [`${open}/>`];
  const declared = Arr.dedupe(Arr.map(entryIris(properties), namespaceOf));
  const declarations = Arr.map(
    Arr.filter(declared, (ns) => ns !== Namespaces.RDF),
    (ns) =>
      `\n${pad}${writer.indent.repeat(2)}xmlns:${prefixOf(writer, ns)}="${Xml.escapeAttribute(ns)}"`,
  );
  return [
    `${open}${declarations.join('')}>`,
    ...entryLines(writer, properties, 3),
    `${pad}</rdf:Description>`,
  ];
};

const xmpmeta = (meta: Metadata.Metadata, options: SerializeOptions): string => {
  const entries = meta.properties;
  const writer: Writer = {
    prefixes: assignPrefixes(
      Arr.map(entryIris(entries), namespaceOf),
      options.prefixes ?? PrefixMap.empty,
    ),
    indent: options.indent ?? ' ',
  };
  // One rdf:Description per schema namespace, in the order each first occurs.
  const descriptions = Arr.isReadonlyArrayNonEmpty(entries)
    ? Arr.flatMap(Arr.dedupe(Arr.map(entries, ([iri]) => namespaceOf(iri))), (ns) =>
        descriptionLines(
          writer,
          meta.about,
          Arr.filter(entries, ([iri]) => namespaceOf(iri) === ns),
        ),
      )
    : descriptionLines(writer, meta.about, []);
  const toolkit =
    options.toolkit === undefined ? '' : ` x:xmptk="${Xml.escapeAttribute(options.toolkit)}"`;
  return [
    `<x:xmpmeta xmlns:x="${Namespaces.X}"${toolkit}>`,
    `${writer.indent}<rdf:RDF xmlns:rdf="${Namespaces.RDF}">`,
    ...descriptions,
    `${writer.indent}</rdf:RDF>`,
    '</x:xmpmeta>',
  ].join('\n');
};

const write = (meta: Metadata.Metadata, options: SerializeOptions): string => {
  const xml = xmpmeta(meta, options);
  if (options.packet === false) return `${xml}\n`;
  const writable = options.writable ?? true;
  if (options.size === undefined) {
    return Packet.wrap(xml, { writable, padding: options.padding });
  }
  const size = options.size;
  return Option.getOrElse(Packet.wrapToSize(xml, size, { writable }), () =>
    fail(`The XMP packet does not fit in ${size} bytes`),
  );
};

/**
 * Serializes the XMP data model, returning a `Result`.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializeMetadataResult = (
  meta: Metadata.Metadata,
  options?: SerializeOptions,
): Result.Result<string, Serialization.RdfSerializeError> =>
  Result.try({
    try: () => write(meta, options ?? {}),
    catch: (e) => {
      if (e instanceof Serialization.RdfSerializeError) return e;
      throw e;
    },
  });

/**
 * Serializes the XMP data model as a canonical XMP packet. Fails with
 * `RdfSerializeError` when a property IRI does not end in an XML name, or
 * the packet does not fit `options.size`.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializeMetadata = (
  meta: Metadata.Metadata,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  Effect.suspend(() => Effect.fromResult(serializeMetadataResult(meta, options)));

/**
 * Serializes quads as a canonical XMP packet. The quads must have the shape
 * of the XMP data model (see `Metadata.fromDataset`); named graphs are
 * merged.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serialize = (
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  Effect.gen(function* () {
    const meta = yield* Metadata.fromDataset(Dataset.fromIterable(quads)).pipe(
      Effect.mapError(
        (e) => new Serialization.RdfSerializeError({ format: FORMAT_NAME, message: e.message }),
      ),
    );
    return yield* serializeMetadata(meta, options);
  });

/**
 * The XMP serializer.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializer: Serialization.Serializer<SerializeOptions> = Serialization.makeSerializer({
  format,
  serialize,
});

/**
 * The XMP codec, including a `Schema` transforming XMP packets to datasets
 * and back.
 *
 * @since 0.1.0
 * @category codecs
 */
export const codec: Serialization.Codec<Serialization.ParseOptions, SerializeOptions> =
  Serialization.makeCodec(parser, serializer);
