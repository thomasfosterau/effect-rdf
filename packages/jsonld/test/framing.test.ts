/**
 * W3C JSON-LD 1.1 Framing conformance tests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as JsonLd from '../src/JsonLd.ts';
import { SUITES, jsonLdEqual, makeLoader } from './support.ts';

const DIR = path.join(SUITES, 'json-ld-framing', 'tests');
const BASE = 'https://w3c.github.io/json-ld-framing/tests/';
const exists = fs.existsSync(path.join(DIR, 'frame-manifest.jsonld'));

/** Tests deliberately skipped, with the reason. */
const SKIP: Record<string, string> = {};

interface TestEntry {
  readonly '@id': string;
  readonly '@type': ReadonlyArray<string>;
  readonly name: string;
  readonly input: string;
  readonly frame: string;
  readonly expect?: string;
  readonly expectErrorCode?: string;
  readonly option?: Record<string, any>;
}

const readJson = (file: string): any => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));

async function evaluate(test: TestEntry): Promise<{ ok: boolean; detail: string }> {
  const option = test.option ?? {};
  const options: Record<string, any> = {
    documentLoader: makeLoader(BASE, DIR, { url: BASE + test.input, options: option }),
  };
  for (const key of ['base', 'processingMode', 'omitGraph', 'ordered', 'compactArrays']) {
    if (key in option) options[key] = option[key];
  }
  const exit = await Effect.runPromiseExit(
    JsonLd.frame(BASE + test.input, BASE + test.frame, options),
  );
  if (test['@type'].includes('jld:NegativeEvaluationTest')) {
    if (Exit.isSuccess(exit)) {
      return { ok: false, detail: `expected ${test.expectErrorCode}, got success` };
    }
    const failure = JSON.stringify(exit.cause);
    return {
      ok: failure.includes(`"code":"${test.expectErrorCode}"`),
      detail: `expected ${test.expectErrorCode}, got ${failure}`,
    };
  }
  if (Exit.isFailure(exit)) return { ok: false, detail: `failed: ${String(exit.cause)}` };
  const expected = readJson(test.expect!);
  return {
    ok: jsonLdEqual(exit.value, expected),
    detail: `got ${JSON.stringify(exit.value, null, 1)}`,
  };
}

(exists ? describe : describe.skip)('frame', () => {
  const manifest = exists ? readJson('frame-manifest.jsonld') : { sequence: [] };
  for (const test of manifest.sequence as ReadonlyArray<TestEntry>) {
    const id = `frame${test['@id']}`;
    const skipReason =
      SKIP[id] ?? (test.option?.['specVersion'] === 'json-ld-1.0' ? 'JSON-LD 1.0 only' : undefined);
    it.skipIf(skipReason !== undefined)(`${id} ${test.name} ${skipReason ?? ''}`, async () => {
      const result = await evaluate(test);
      expect(result.ok ? 'ok' : result.detail).toBe('ok');
    });
  }
});
