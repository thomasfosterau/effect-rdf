import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { N3, Reasoner } from '../../src/n3/index.ts';

const EX = 'http://example.org/';

const run = (value: string) =>
  Effect.gen(function* () {
    const doc = yield* N3.parse(`
      @prefix : <${EX}> .
      @prefix string: <http://www.w3.org/2000/10/swap/string#> .
      :a :v "${value}" .
      { ?x :v ?v . ?v string:matches "^(a+)+$" } => { ?x :ok true } .
    `);
    const { inferred } = yield* Reasoner.reason(doc);
    return inferred.statements.map((s) => s.key);
  });

describe('N3 string:matches bounds', () => {
  it.effect('a catastrophic pattern is evaluated in linear time', () =>
    Effect.gen(function* () {
      const start = performance.now();
      const bad = yield* run(`${'a'.repeat(32)}!`);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(bad.filter((k) => k.includes('ok'))).toEqual([]);
      const good = yield* run('a'.repeat(32));
      expect(good.filter((k) => k.includes('ok'))).toHaveLength(1);
    }),
  );
});
