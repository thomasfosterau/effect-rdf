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
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as JsonLd from '@thomasfosterau/effect-jsonld/JsonLd';
import * as N3 from '@thomasfosterau/effect-n3/N3';
import * as NQuads from '@thomasfosterau/effect-ntriples/NQuads';
import * as NTriples from '@thomasfosterau/effect-ntriples/NTriples';
import * as RdfJson from '@thomasfosterau/effect-rdfjson/RdfJson';
import * as RdfXml from '@thomasfosterau/effect-rdfxml/RdfXml';
import * as TriG from '@thomasfosterau/effect-turtle/TriG';
import * as Turtle from '@thomasfosterau/effect-turtle/Turtle';

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
  if (mediaType._tag === 'None') return undefined;
  const serializer = Serialization.serializerFor(formats, mediaType.value);
  return serializer._tag === 'Some' ? serializer.value : undefined;
};
