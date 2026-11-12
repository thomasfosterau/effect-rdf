import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { ShExC, Validator } from '../../src/shex/index.ts';

const ex = (l: string) => Term.namedNode(`http://ex.example/${l}`);

const schemaText = `
PREFIX ex: <http://ex.example/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
ex:S { ex:v xsd:string /^(a+)+$/ }
`;

const data = Dataset.make(
  Term.quad(ex('hostile'), ex('v'), Term.literal(`${'a'.repeat(32)}!`)),
  Term.quad(ex('matching'), ex('v'), Term.literal('a'.repeat(32))),
);

describe('ShEx pattern facet bounds', () => {
  it.effect('a catastrophic pattern is evaluated in linear time', () =>
    Effect.gen(function* () {
      const schema = yield* ShExC.parse(schemaText);
      const shape = 'http://ex.example/S';
      const start = performance.now();
      const bad = yield* Validator.validateNode(data, schema, ex('hostile'), shape);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(bad.status).toBe('nonconformant');
      const good = yield* Validator.validateNode(data, schema, ex('matching'), shape);
      expect(good.status).toBe('conformant');
    }),
  );
});
