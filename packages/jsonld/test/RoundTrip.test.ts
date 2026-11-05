import { describe, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import { JsonLd } from '../src/index.ts';

// JSON-LD 1.1 has no triple terms, and its `rdfDirection` modes map `@direction` to `i18n`
// datatypes or compound literals rather than RDF 1.2 directional language-tagged strings, so quads
// whose object is either are dropped from the input (directional strings: effect-rdf#70).
const representable = (ds: Dataset.Dataset): Dataset.Dataset =>
  Dataset.filter(
    ds,
    (q) =>
      !Term.isTriple(q.object) && !(Term.isLiteral(q.object) && q.object.direction !== undefined),
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
});
