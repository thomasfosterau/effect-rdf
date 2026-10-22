/* eslint-disable vitest/valid-title, vitest/valid-expect, vitest/no-conditional-expect, vitest/expect-expect -- conformance tests are generated from manifests */
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as ShExC from '../src/ShExC.ts';
import * as ShExJ from '../src/ShExJ.ts';
import { hasShexTest, readJson, readText, suiteBase } from './utils/suite.ts';

interface SchemaEntry {
  readonly name: string;
  readonly shex: string;
  readonly json: string;
  readonly ttl: string;
}

const entries: ReadonlyArray<SchemaEntry> = hasShexTest
  ? readJson('schemas', 'manifest.jsonld')['@graph'][0].entries
  : [];

/** Tests whose expected ShExJ cannot be produced from the ShExC, with reasons. */
export const schemaSkips: Readonly<Record<string, string>> = {};

const stripContext = (json: any) => {
  const { '@context': _, ...rest } = json;
  return rest;
};

describe.skipIf(!hasShexTest)('shexTest schemas (ShExC → ShExJ)', () => {
  for (const entry of entries) {
    const skip = schemaSkips[entry.name];
    it.skipIf(skip !== undefined)(entry.name, () => {
      const input = readText('schemas', entry.shex);
      const expected = ShExJ.resolveIris(
        stripContext(readJson('schemas', entry.json)),
        `${suiteBase}schemas/${entry.json}`,
      );
      const exit = Effect.runSyncExit(
        ShExC.parse(input, { baseIri: `${suiteBase}schemas/${entry.shex}` }),
      );
      if (Exit.isFailure(exit)) assert.fail(String(exit.cause));
      expect(exit.value).toEqual(expected);
      // The ShExJ itself must decode with the ShExJ schema.
      const decoded = Effect.runSyncExit(ShExJ.decode(expected));
      if (Exit.isFailure(decoded)) assert.fail(String(decoded.cause));
    });
  }
});
