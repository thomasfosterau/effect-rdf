import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import { Dataset, Isomorphism } from '@thomasfosterau/effect-rdf';
import { RdfXml } from '../../src/rdfxml/index.ts';
import { parseBothWays, parseNTriples, readManifest, type TestCase } from './support.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = process.env['RDF_TEST_SUITES'] ?? path.resolve(here, '../../../../.test-suites');
// The rdf12 manifest no longer includes the rdf11 one (w3c/rdf-tests#396), so both are read.
const manifests = ['rdf11', 'rdf12'].map((version) =>
  path.join(suites, `rdf-tests/rdf/${version}/rdf-xml/manifest.ttl`),
);
const exists = manifests.every((manifest) => fs.existsSync(manifest));

/**
 * Tests deliberately skipped, with the reason. Currently empty: every test
 * in the rdf11 and rdf12 RDF/XML suites passes.
 */
const skipList: HashMap.HashMap<string, string> = HashMap.empty();

const tests: Array<TestCase> = (exists ? manifests.flatMap(readManifest) : []).filter(
  (t) => !HashMap.has(skipList, t.name),
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

  evalTests.forEach((test) => {
    it.effect(`${test.name} (eval)`, () =>
      Effect.gen(function* () {
        const result = yield* parseFile(test);
        const expected = parseNTriples(
          fs.readFileSync(
            Option.getOrElse(test.result, () => assert.fail('eval test has no result')),
            'utf8',
          ),
        );
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
  });

  // `RdfXml.parse` converts node elements as it reads them; reading the whole document first
  // must give the same triples, blank nodes, prefixes, base and errors.
  tests.forEach((test) => {
    it(`${test.name} (streamed as whole)`, () => {
      const { streamed, whole } = parseBothWays(fs.readFileSync(test.action, 'utf8'), {
        baseIri: test.baseIri,
        blankNodePrefix: 'b',
      });
      expect(streamed).toEqual(whole);
    });
  });

  negativeTests.forEach((test) => {
    it.effect(`${test.name} (negative syntax)`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(parseFile(test));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });
});
