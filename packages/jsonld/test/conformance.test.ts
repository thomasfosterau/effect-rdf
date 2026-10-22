/**
 * W3C JSON-LD 1.1 API conformance tests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Isomorphism from '@thomasfosterau/effect-rdf/Isomorphism';
import { afterAll, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as JsonLd from '../src/JsonLd.ts';
import * as JsonLdError from '../src/JsonLdError.ts';
import {
  type Json,
  SUITES,
  jsonLdEqual,
  makeLoader,
  parseJsonText,
  parseNQuads,
  toJsonText,
} from './support.ts';

const DIR = path.join(SUITES, 'json-ld-api', 'tests');
const BASE = 'https://w3c.github.io/json-ld-api/tests/';
const exists = fs.existsSync(path.join(DIR, 'expand-manifest.jsonld'));

/** Tests deliberately skipped, with the reason. */
const SKIP: Record<string, string> = {};

interface TestEntry {
  readonly '@id': string;
  readonly '@type': ReadonlyArray<string>;
  readonly name: string;
  readonly input: string;
  readonly expect?: string;
  readonly context?: string;
  readonly expectErrorCode?: string;
  readonly requires?: string;
  readonly option?: Record<string, Json>;
}

const readJson = (file: string): Json =>
  parseJsonText(fs.readFileSync(path.join(DIR, file), 'utf8'));

const stats: Record<string, { pass: number; fail: number; skip: number }> = {};

const runManifest = (
  name: string,
  manifestFile: string,
  run: (
    test: TestEntry,
    options: JsonLd.ToRdfOptions & JsonLd.FromRdfOptions,
  ) => Effect.Effect<{ readonly ok: boolean; readonly actual?: unknown }, JsonLdError.JsonLdError>,
) => {
  (exists ? describe : describe.skip)(name, () => {
    if (!exists) return;
    const manifest = readJson(manifestFile);
    const entry = (stats[name] = { pass: 0, fail: 0, skip: 0 });
    for (const test of manifest.sequence as ReadonlyArray<TestEntry>) {
      const id = `${manifestFile.replace('-manifest.jsonld', '')}${test['@id']}`;
      const option = test.option ?? {};
      const skipReason =
        SKIP[id] ??
        (option['specVersion'] === 'json-ld-1.0' ? 'JSON-LD 1.0 only' : undefined) ??
        (option['processorFeature'] !== undefined &&
        option['processorFeature'] !== 'HTML Script Extraction'
          ? `requires ${option['processorFeature']}`
          : undefined) ??
        (test.requires === 'GeneralizedRdf'
          ? 'generalized RDF is not representable in the core term model'
          : undefined);
      if (skipReason !== undefined) entry.skip++;
      it.skipIf(skipReason !== undefined)(`${id} ${test.name} ${skipReason ?? ''}`, async () => {
        const result = await evaluate(test, run);
        entry[result.ok ? 'pass' : 'fail']++;
        expect(result.ok ? 'ok' : result.detail).toBe('ok');
      });
    }
  });
};

const OPTION_KEYS = [
  'base',
  'processingMode',
  'compactArrays',
  'compactToRelative',
  'rdfDirection',
  'useNativeTypes',
  'useRdfType',
  'produceGeneralizedRdf',
  'extractAllScripts',
];

async function evaluate(
  test: TestEntry,
  run: (
    test: TestEntry,
    options: JsonLd.ToRdfOptions & JsonLd.FromRdfOptions,
  ) => Effect.Effect<{ readonly ok: boolean; readonly actual?: unknown }, JsonLdError.JsonLdError>,
): Promise<{ ok: boolean; detail: string }> {
  const option = test.option ?? {};
  const options: Record<string, Json> = {};
  options['documentLoader'] = makeLoader(BASE, DIR, { url: BASE + test.input, options: option });
  for (const key of OPTION_KEYS) {
    if (key in option) options[key] = option[key];
  }
  if ('expandContext' in option) options['expandContext'] = BASE + option['expandContext'];
  const exit = await Effect.runPromiseExit(run(test, options));
  if (test['@type'].includes('jld:NegativeEvaluationTest')) {
    if (Exit.isSuccess(exit)) {
      return {
        ok: false,
        detail: `expected error ${test.expectErrorCode}, got ${toJsonText(exit.value.actual)}`,
      };
    }
    const failure = toJsonText(exit.cause);
    return {
      ok: failure.includes(`"code":"${test.expectErrorCode}"`),
      detail: `expected ${test.expectErrorCode}, got ${failure}`,
    };
  }
  if (Exit.isSuccess(exit)) {
    return { ok: exit.value.ok, detail: `got ${toJsonText(exit.value.actual, 1)}` };
  }
  return { ok: false, detail: `failed: ${String(exit.cause)}` };
}

const jsonResult = (actual: Json, test: TestEntry) => {
  if (test.expect === undefined) return { ok: true, actual };
  const expected = readJson(test.expect);
  return { ok: jsonLdEqual(actual, expected), actual };
};

runManifest('expand', 'expand-manifest.jsonld', (test, options) =>
  Effect.map(JsonLd.expand(BASE + test.input, options), (a) => jsonResult(a, test)),
);

runManifest('compact', 'compact-manifest.jsonld', (test, options) =>
  Effect.map(
    JsonLd.compact(BASE + test.input, test.context ? readJson(test.context) : {}, options),
    (a) => jsonResult(a, test),
  ),
);

runManifest('flatten', 'flatten-manifest.jsonld', (test, options) =>
  Effect.map(
    JsonLd.flatten(BASE + test.input, test.context ? readJson(test.context) : undefined, options),
    (a) => jsonResult(a, test),
  ),
);

runManifest('toRdf', 'toRdf-manifest.jsonld', (test, options) =>
  Effect.map(JsonLd.toRdf(BASE + test.input, options), (actual) => {
    if (test.expect === undefined) return { ok: true, actual: Dataset.toNQuads(actual) };
    const expected = Dataset.fromIterable(
      parseNQuads(fs.readFileSync(path.join(DIR, test.expect), 'utf8')),
    );
    return {
      ok: Isomorphism.isomorphic(actual, expected),
      actual: Dataset.toNQuads(actual),
    };
  }),
);

runManifest('fromRdf', 'fromRdf-manifest.jsonld', (test, options) =>
  Effect.suspend(() => {
    const quads = parseNQuads(fs.readFileSync(path.join(DIR, test.input), 'utf8'));
    return Effect.map(JsonLd.fromRdf(quads, options), (a) => jsonResult(a, test));
  }),
);

runManifest('remote-doc', 'remote-doc-manifest.jsonld', (test, options) =>
  Effect.map(JsonLd.expand(BASE + test.input, options), (a) => jsonResult(a, test)),
);

afterAll(() => {
  if (!exists) return;
  // eslint-disable-next-line no-console
  console.log(
    Object.entries(stats)
      .map(([k, v]) => `${k}: ${v.pass} passed, ${v.fail} failed, ${v.skip} skipped`)
      .join('\n'),
  );
});
