/**
 * The parser seam: the one module that touches an XML implementation.
 * Everything else in this package sees only `parseRdf` (text → RDF) and the
 * three writing helpers below, so moving from effect-rdfxml's `Xml` parser
 * to the effect-sax DOM replaces this file and nothing else.
 */
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as RdfXml from '@thomasfosterau/effect-rdfxml/RdfXml';
import * as Xml from '@thomasfosterau/effect-rdfxml/Xml';
import { RDF } from '../Namespaces.ts';

const isRdf = (el: Xml.Element) => el.namespace === RDF && el.localName === 'RDF';

const children = (el: Xml.Element): ReadonlyArray<Xml.Element> =>
  el.children.filter((c): c is Xml.Element => Predicate.isTagged(c, 'Element'));

/**
 * The first `rdf:RDF` element in document order. XMP puts it inside
 * `<x:xmpmeta>` (or the older `<x:xapmeta>`), or at the root when the
 * wrapper is omitted; SVG puts either inside `<metadata>`.
 */
const findRdf = (el: Xml.Element): Option.Option<Xml.Element> =>
  isRdf(el) ? Option.some(el) : Option.firstSomeOf(children(el).map(findRdf));

const FORMAT = 'XMP';

const toParseError = (e: {
  readonly message: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}) =>
  new Serialization.RdfParseError({
    format: FORMAT,
    message: e.message,
    line: e.line,
    column: e.column,
  });

/** Parses the text of an XMP packet (or a document embedding one) to RDF. */
export const parseRdf = (
  text: string,
  options: Serialization.ParseOptions | undefined,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.gen(function* () {
    const doc = yield* Xml.parse(text).pipe(Effect.mapError(toParseError));
    const root = yield* Effect.fromOption(findRdf(doc.root)).pipe(
      Effect.mapError(
        () =>
          new Serialization.RdfParseError({ format: FORMAT, message: 'No rdf:RDF element found' }),
      ),
    );
    return yield* RdfXml.parseDocument({ ...doc, root }, options).pipe(
      Effect.mapError(toParseError),
    );
  });

/** Escapes XML character data. */
export const escapeText: (value: string) => string = Xml.escapeText;

/** Escapes an XML attribute value. */
export const escapeAttribute: (value: string) => string = Xml.escapeAttribute;

/** Splits an IRI into a namespace and an `NCName` local name. */
export const splitIri: (iri: string) => Option.Option<readonly [string, string]> = RdfXml.splitIri;
