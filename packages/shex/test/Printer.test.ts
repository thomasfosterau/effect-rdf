/* eslint-disable vitest/valid-title, vitest/valid-expect, vitest/no-conditional-expect, vitest/expect-expect -- conformance tests are generated from manifests */
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as ShExC from '../src/ShExC.ts';
import * as ShExJ from '../src/ShExJ.ts';
import { canonical } from './utils/canonical.ts';
import { hasShexTest, readJson, suiteBase } from './utils/suite.ts';

const entries: ReadonlyArray<{ name: string; json: string }> = hasShexTest
  ? readJson('schemas', 'manifest.jsonld')['@graph'][0].entries
  : [];

/**
 * Removes value expressions that are the empty shape `{ }` (ShExC writes
 * these as `.`, which means "no value expression").
 */
const normalise = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (
        k === 'valueExpr' &&
        typeof x === 'object' &&
        x !== null &&
        Object.keys(x).length === 1 &&
        (x as { type?: string }).type === 'Shape'
      )
        continue;
      out[k] = normalise(x);
    }
    return out;
  }
  return v;
};

describe.skipIf(!hasShexTest)('ShExC printer round trip (ShExJ → ShExC → ShExJ)', () => {
  for (const entry of entries) {
    it(entry.name, () => {
      const { '@context': _, ...json } = readJson('schemas', entry.json);
      const schema = ShExJ.resolveIris(json, `${suiteBase}schemas/${entry.json}`);
      const text = ShExC.print(schema, {
        prefixes: PrefixMap.make({ xsd: 'http://www.w3.org/2001/XMLSchema#' }),
      });
      const exit = Effect.runSyncExit(ShExC.parse(text));
      if (Exit.isFailure(exit)) throw new Error(`${String(exit.cause)}\n${text}`);
      expect(normalise(canonical(exit.value)), text).toEqual(normalise(canonical(schema)));
    });
  }
});
