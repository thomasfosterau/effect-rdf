/* eslint-disable vitest/valid-title, vitest/valid-expect, vitest/no-conditional-expect, vitest/expect-expect -- conformance tests are generated from manifests */
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as ShExJ from '../src/ShExJ.ts';
import * as ShExR from '../src/ShExR.ts';
import { canonical } from './utils/canonical.ts';
import { hasShexTest, readJson, readText, suiteBase } from './utils/suite.ts';
import { parseTurtle } from './utils/turtle.ts';

interface SchemaEntry {
  readonly name: string;
  readonly json: string;
  readonly ttl: string;
}

const entries: ReadonlyArray<SchemaEntry> = hasShexTest
  ? readJson('schemas', 'manifest.jsonld')['@graph'][0].entries
  : [];

const expectedJson = (entry: SchemaEntry): ShExJ.Schema => {
  const { '@context': _, ...json } = readJson('schemas', entry.json);
  return ShExJ.resolveIris(json, `${suiteBase}schemas/${entry.json}`);
};

/** ShExR documents whose ShExJ cannot be recovered unambiguously. */
export const shexrSkips: Readonly<Record<string, string>> = {
  '1Include1':
    'the labelled triple expression is the sx:expression of two shapes; RDF cannot say which one defines it',
  ShExR:
    'labelled triple expressions are used in several expression lists; RDF cannot say which use defines them',
};

describe.skipIf(!hasShexTest)('shexTest schemas (ShExR → ShExJ)', () => {
  for (const entry of entries) {
    it.skipIf(entry.name in shexrSkips)(entry.name, () => {
      const base = `${suiteBase}schemas/${entry.ttl}`;
      const dataset = parseTurtle(readText('schemas', entry.ttl), base);
      const exit = Effect.runSyncExit(ShExR.fromDataset(dataset));
      if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
      expect(canonical(exit.value)).toEqual(canonical(expectedJson(entry)));
    });
  }
});

describe.skipIf(!hasShexTest)('shexTest schemas (ShExJ → ShExR → ShExJ)', () => {
  for (const entry of entries) {
    it.skipIf(entry.name in shexrSkips)(entry.name, () => {
      const schema = expectedJson(entry);
      const exit = Effect.runSyncExit(ShExR.fromDataset(ShExR.toDataset(schema)));
      if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
      expect(canonical(exit.value)).toEqual(canonical(schema));
    });
  }
});
