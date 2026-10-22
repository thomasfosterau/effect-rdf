import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { Dataset, Isomorphism } from '@thomasfosterau/effect-rdf';
import { RdfXml } from '../src/index.ts';
import { parseNTriples, readManifest, type TestCase } from './support.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = process.env['RDF_TEST_SUITES'] ?? path.resolve(here, '../../../.test-suites');
const manifest = path.join(suites, 'rdf-tests/rdf/rdf12/rdf-xml/manifest.ttl');
const exists = fs.existsSync(manifest);

/**
 * Tests deliberately skipped, with the reason. Currently empty: every test
 * in the rdf11 and rdf12 RDF/XML suites passes.
 */
const skipList: ReadonlyMap<string, string> = new Map();

const tests: Array<TestCase> = (exists ? readManifest(manifest) : []).filter(
  (t) => !skipList.has(t.name),
);
const evalTests = tests.filter((t) => t.type === 'TestXMLEval');
const negativeTests = tests.filter((t) => t.type === 'TestXMLNegativeSyntax');

const parseFile = (test: TestCase) =>
  RdfXml.parse(fs.readFileSync(test.action, 'utf8'), { baseIri: test.baseIri });

describe.skipIf(!exists)('RDF/XML conformance (rdf11 + rdf12 rdf-xml)', () => {
  it('found the test manifests', () => {
    expect(tests.length).toBeGreaterThanOrEqual(197);
    expect(evalTests.length + negativeTests.length).toBe(tests.length);
  });

  for (const test of evalTests) {
    it.effect(`${test.name} (eval)`, () =>
      Effect.gen(function* () {
        const result = yield* parseFile(test);
        const expected = parseNTriples(fs.readFileSync(test.result!, 'utf8'));
        const isomorphic = Isomorphism.isomorphic(result.dataset, expected);
        // On a mismatch, compare the N-Quads first so the failure shows a diff.
        expect(isomorphic ? '' : Dataset.toNQuads(result.dataset)).toEqual(
          isomorphic ? '' : Dataset.toNQuads(expected),
        );
        expect(isomorphic).toBe(true);
      }),
    );
    it.effect(`${test.name} (round-trip)`, () =>
      Effect.gen(function* () {
        const result = yield* parseFile(test);
        const xml = yield* RdfXml.serialize(result.dataset, { prefixes: result.prefixes });
        const again = yield* RdfXml.parse(xml);
        expect({ xml, isomorphic: Isomorphism.isomorphic(result.dataset, again.dataset) }).toEqual({
          xml,
          isomorphic: true,
        });
      }),
    );
  }

  for (const test of negativeTests) {
    it.effect(`${test.name} (negative syntax)`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(parseFile(test));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  }
});
