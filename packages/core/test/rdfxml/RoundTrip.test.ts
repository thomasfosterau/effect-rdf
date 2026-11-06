import { describe, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import { RdfXml, Xml } from '../../src/rdfxml/index.ts';

// RDF/XML describes one graph, so every quad is moved into the default graph, and XML 1.0 cannot
// carry every character (control characters, lone surrogates), so quads whose literals hold one
// are dropped.
const xmlSafe = (t: Term.Term): boolean =>
  Term.isTriple(t)
    ? xmlSafe(t.subject) && xmlSafe(t.object)
    : !Term.isLiteral(t) || Xml.isValidText(t.value);

const representable = (ds: Dataset.Dataset): Dataset.Dataset =>
  Dataset.map(
    Dataset.filter(ds, (q) => xmlSafe(q.object)),
    (q) => Term.quad(q.subject, q.predicate, q.object),
  );

// Property: parsing what the serialiser writes gives back an isomorphic graph, over generated
// datasets (core's `DatasetSchema` arbitrary).
describe('round trip (property)', () => {
  it.effect.prop(
    'RDF/XML: parse(serialize(g)) is isomorphic to g',
    { ds: Dataset.DatasetSchema },
    ({ ds }) =>
      Effect.gen(function* () {
        const input = representable(ds);
        const text = yield* RdfXml.serialize(input);
        const back = yield* RdfXml.parse(text);
        return Isomorphism.isomorphic(back.dataset, input);
      }),
    { arbitrary: { runs: 50 } },
  );
});
