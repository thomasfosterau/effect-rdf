import { describe, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { Dataset, Isomorphism } from '@thomasfosterau/effect-rdf';
import { NQuads } from '../src/index.ts';

// Property: parsing what the serialiser writes gives back an isomorphic dataset, over generated
// datasets (core's `DatasetSchema` arbitrary).
describe('round trip (property)', () => {
  it.effect.prop(
    'N-Quads: parse(serialize(ds)) is isomorphic to ds',
    { ds: Dataset.DatasetSchema },
    ({ ds }) =>
      Effect.gen(function* () {
        const input = ds;
        const text = yield* NQuads.serialize(input);
        const back = yield* NQuads.parse(text);
        return Isomorphism.isomorphic(back.dataset, input);
      }),
    { arbitrary: { runs: 50 } },
  );
});
