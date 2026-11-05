/**
 * The RDF syntaxes the client reads (`CONSTRUCT` / `DESCRIBE` responses,
 * Graph Store `GET`) and writes (Graph Store `PUT` / `POST`) by default.
 *
 * The client uses the `Serialization.Formats` service when one is provided,
 * and falls back to these codecs otherwise.
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
 * The default codecs, in order of preference (N-Triples first, because it
 * is parsed incrementally).
 *
 * @since 0.1.0
 * @category formats
 */
export const codecs: ReadonlyArray<Serialization.Codec<any, any>> = [
  NTriples.codec,
  Turtle.codec,
  NQuads.codec,
  TriG.codec,
  RdfXml.codec,
  JsonLd.codec,
  N3.codec,
  RdfJson.codec,
];

/**
 * The default `Formats` service.
 *
 * @since 0.1.0
 * @category formats
 */
export const defaults: Serialization.Formats['Service'] = {
  parsers: codecs,
  serializers: codecs,
};

/**
 * A `Formats` layer with the default codecs.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<Serialization.Formats> = Serialization.layer(...codecs);

/**
 * An `Accept` header preferring the registered parsers in order.
 *
 * @since 0.1.0
 * @category negotiation
 */
export const acceptHeader = (formats: Serialization.Formats['Service']): string => {
  const types = Array.from(new Set(formats.parsers.map((p) => p.format.mediaType)));
  return types
    .map((t, i) => (i === 0 ? t : `${t};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`))
    .join(', ');
};
