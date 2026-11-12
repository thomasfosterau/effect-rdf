import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { Validator } from '@thomasfosterau/effect-rdf/shacl';
import { parseTurtle } from './utils/turtle.ts';

const prefixes = `
@prefix ex: <http://example.org/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
`;
const ttl = (s: string) => parseTurtle(prefixes + s);

const shapes = ttl(`
ex:S a sh:NodeShape ; sh:targetNode ex:n ;
  sh:property [ sh:path ex:v ; sh:pattern "^(a+)+$" ] .
`);

describe('SHACL sh:pattern bounds', () => {
  it.effect('a catastrophic pattern is evaluated in linear time', () =>
    Effect.gen(function* () {
      const start = performance.now();
      const bad = yield* Validator.validate(ttl(`ex:n ex:v "${'a'.repeat(32)}!" .`), shapes);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(bad.conforms).toBe(false);
      const good = yield* Validator.validate(ttl(`ex:n ex:v "${'a'.repeat(32)}" .`), shapes);
      expect(good.conforms).toBe(true);
    }),
  );
});
