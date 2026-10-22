/* eslint-disable vitest/valid-title, vitest/valid-expect, vitest/no-conditional-expect, vitest/expect-expect -- conformance tests are generated from manifests */
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as ShExC from '../src/ShExC.ts';
import * as Structure from '../src/Structure.ts';
import { hasShexTest, readJson, readText, type Reasons, suiteBase } from './utils/suite.ts';

interface NegativeEntry {
  readonly name: string;
  readonly shex: string;
}

const load = (dir: string): ReadonlyArray<NegativeEntry> =>
  hasShexTest ? readJson(dir, 'manifest.jsonld')['@graph'][0].entries : [];

const parseAndCheck = (dir: string, file: string) =>
  ShExC.parse(readText(dir, file), { baseIri: `${suiteBase}${dir}/${file}` }).pipe(
    Effect.flatMap((schema) => Structure.check(schema)),
  );

describe.skipIf(!hasShexTest)('shexTest negativeSyntax', () => {
  for (const entry of load('negativeSyntax')) {
    it(entry.name, () => {
      const exit = Effect.runSyncExit(
        ShExC.parse(readText('negativeSyntax', entry.shex), {
          baseIri: `${suiteBase}negativeSyntax/${entry.shex}`,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  }
});

describe.skipIf(!hasShexTest)('shexTest negativeStructure', () => {
  for (const entry of load('negativeStructure')) {
    it(entry.name, () => {
      const exit = Effect.runSyncExit(parseAndCheck('negativeStructure', entry.shex));
      expect(Exit.isFailure(exit)).toBe(true);
    });
  }
});

describe.skipIf(!hasShexTest)('shexTest schemas are structurally valid', () => {
  const entries: ReadonlyArray<{ name: string; shex: string }> = hasShexTest
    ? readJson('schemas', 'manifest.jsonld')['@graph'][0].entries
    : [];
  // Representation-only tests whose schemas deliberately violate a structural
  // requirement (they are not used by any validation test).
  const notStructural: Reasons = {
    TwoNegation_pass: 'S -> NOT T -> NOT U -> S is a reference cycle through negation',
  };
  for (const entry of entries) {
    it.skipIf(entry.name in notStructural)(entry.name, () => {
      const exit = Effect.runSyncExit(
        ShExC.parse(readText('schemas', entry.shex), {
          baseIri: `${suiteBase}schemas/${entry.shex}`,
        }).pipe(
          Effect.flatMap((schema) =>
            Structure.check(schema, { allowUnresolved: schema.imports !== undefined }),
          ),
        ),
      );
      if (Exit.isFailure(exit)) assert.fail(String(exit.cause));
    });
  }
});
