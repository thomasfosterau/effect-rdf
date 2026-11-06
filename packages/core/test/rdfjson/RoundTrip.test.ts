import { describe, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { Dataset, Isomorphism, Term } from '../../src/index.ts';
import { RdfJson } from '../../src/rdfjson/index.ts';

// RDF/JSON describes one graph: every quad is moved into the default graph.
const representable = (ds: Dataset.Dataset): Dataset.Dataset =>
  Dataset.map(ds, (q) => Term.quad(q.subject, q.predicate, q.object));

// Property: parsing what the serialiser writes gives back an isomorphic graph, over generated
// datasets (core's `DatasetSchema` arbitrary). Triple terms and base directions need the RDF 1.2
// extensions.
describe('round trip (property)', () => {
  it.effect.prop(
    'RDF/JSON: parse(serialize(g)) is isomorphic to g',
    { ds: Dataset.DatasetSchema },
    ({ ds }) =>
      Effect.gen(function* () {
        const input = representable(ds);
        const text = yield* RdfJson.serialize(input, { extensions: true });
        const back = yield* RdfJson.parse(text);
        return Isomorphism.isomorphic(back.dataset, input);
      }),
    { arbitrary: { runs: 50 } },
  );
});
