import { describe, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import { JsonLd } from '../../src/jsonld/index.ts';

// JSON-LD 1.1 has no triple terms, so quads whose object is one are dropped from the input.
const noTripleTerms = (ds: Dataset.Dataset): Dataset.Dataset =>
  Dataset.filter(ds, (q) => !Term.isTriple(q.object));

// JSON-LD 1.1's `rdfDirection` modes map `@direction` to `i18n` datatypes or compound literals,
// not RDF 1.2 directional language-tagged strings; only `rdf-1.2` gives those back (#70).
const representable = (ds: Dataset.Dataset): Dataset.Dataset =>
  Dataset.filter(
    noTripleTerms(ds),
    (q) => !(Term.isLiteral(q.object) && q.object.direction !== undefined),
  );

// Property: parsing what the serialiser writes gives back an isomorphic dataset, over generated
// datasets (core's `DatasetSchema` arbitrary).
describe('round trip (property)', () => {
  it.effect.prop(
    'JSON-LD: parse(serialize(ds)) is isomorphic to ds',
    { ds: Dataset.DatasetSchema },
    ({ ds }) =>
      Effect.gen(function* () {
        const input = representable(ds);
        const text = yield* JsonLd.serialize(input);
        const back = yield* JsonLd.parse(text);
        return Isomorphism.isomorphic(back.dataset, input);
      }),
    { arbitrary: { runs: 50 } },
  );

  it.effect.prop(
    "JSON-LD with rdfDirection 'rdf-1.2': parse(serialize(ds)) keeps directional strings",
    { ds: Dataset.DatasetSchema },
    ({ ds }) =>
      Effect.gen(function* () {
        const input = noTripleTerms(ds);
        const text = yield* JsonLd.serialize(input);
        const back = yield* JsonLd.parse(text, { rdfDirection: 'rdf-1.2' });
        return Isomorphism.isomorphic(back.dataset, input);
      }),
    { arbitrary: { runs: 50 } },
  );
});
