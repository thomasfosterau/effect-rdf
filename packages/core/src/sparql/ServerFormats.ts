/**
 * The RDF syntaxes the server reads and writes by default: Turtle,
 * N-Triples, RDF/XML, JSON-LD, N3, TriG, N-Quads and RDF/JSON, registered in
 * the core `Serialization.Formats` service.
 *
 * Graph Store request bodies are parsed with the parser registered for their
 * `Content-Type`, and `CONSTRUCT` / `DESCRIBE` results and Graph Store
 * responses are serialised with the serializer selected by content
 * negotiation, in the order of `codecs` (the first one is the default).
 *
 * @since 0.1.0
 */
import type * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Serialization from '../Serialization.ts';
import * as JsonLd from '../jsonld/JsonLd.ts';
import * as N3 from '../n3/N3.ts';
import * as NQuads from '../ntriples/NQuads.ts';
import * as NTriples from '../ntriples/NTriples.ts';
import * as RdfJson from '../rdfjson/RdfJson.ts';
import * as RdfXml from '../rdfxml/RdfXml.ts';
import * as TriG from '../turtle/TriG.ts';
import * as Turtle from '../turtle/Turtle.ts';

/**
 * The default codecs, in order of preference for content negotiation.
 *
 * @since 0.1.0
 * @category formats
 */
export const codecs: ReadonlyArray<Serialization.Codec<any, any>> = [
  Turtle.codec,
  NTriples.codec,
  RdfXml.codec,
  JsonLd.codec,
  N3.codec,
  TriG.codec,
  NQuads.codec,
  RdfJson.codec,
];

/**
 * A `Formats` layer with the default codecs.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<Serialization.Formats> = Serialization.layer(...codecs);

/**
 * The media types of a set of serializers, in order.
 *
 * @since 0.1.0
 * @category negotiation
 */
export const serializerMediaTypes = (
  formats: Serialization.Formats['Service'],
): ReadonlyArray<string> => formats.serializers.flatMap((s) => s.format.mediaTypes);

/**
 * Chooses a serializer for an `Accept` header (the first registered
 * serializer when the header is absent or `*` / `*`).
 *
 * @since 0.1.0
 * @category negotiation
 */
export const negotiateSerializer = (
  formats: Serialization.Formats['Service'],
  accept: string | undefined,
): Serialization.Serializer<any> | undefined => {
  const mediaType = Serialization.negotiate(accept, serializerMediaTypes(formats));
  if (Option.isNone(mediaType)) return undefined;
  const serializer = Serialization.serializerFor(formats, mediaType.value);
  return Option.getOrUndefined(serializer);
};
