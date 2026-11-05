/* eslint-disable vitest/valid-title, vitest/valid-expect, vitest/no-conditional-expect, vitest/expect-expect -- conformance tests are generated from manifests */
import { assert, describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import type * as Schema from 'effect/Schema';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as ShExC from '../src/ShExC.ts';
import * as ShExJ from '../src/ShExJ.ts';
import { canonical, isJsonObject } from './utils/canonical.ts';
import { hasShexTest, readJson, suiteBase } from './utils/suite.ts';

const entries: ReadonlyArray<{ name: string; json: string }> = hasShexTest
  ? readJson('schemas', 'manifest.jsonld')['@graph'][0].entries
  : [];

/**
 * Removes value expressions that are the empty shape `{ }` (ShExC writes
 * these as `.`, which means "no value expression").
 */
const normalise = (v: Schema.Json): Schema.Json => {
  if (Array.isArray(v)) return v.map(normalise);
  if (isJsonObject(v)) {
    return Record.fromEntries(
      Arr.filterMap(Record.toEntries(v), ([k, x]) =>
        k === 'valueExpr' && isJsonObject(x) && Record.size(x) === 1 && x['type'] === 'Shape'
          ? Result.failVoid
          : Result.succeed([k, normalise(x)] as const),
      ),
    );
  }
  return v;
};

describe.skipIf(!hasShexTest)('ShExC printer round trip (ShExJ → ShExC → ShExJ)', () => {
  entries.forEach((entry) => {
    it(entry.name, () => {
      const { '@context': _, ...json } = readJson('schemas', entry.json);
      const schema = ShExJ.resolveIris(json, `${suiteBase}schemas/${entry.json}`);
      const text = ShExC.print(schema, {
        prefixes: PrefixMap.make({ xsd: 'http://www.w3.org/2001/XMLSchema#' }),
      });
      const exit = Effect.runSyncExit(ShExC.parse(text));
      if (Exit.isFailure(exit)) assert.fail(`${String(exit.cause)}\n${text}`);
      expect(normalise(canonical(exit.value)), text).toEqual(normalise(canonical(schema)));
    });
  });
});
