/**
 * W3C RDF 1.1 / RDF 1.2 Turtle and TriG conformance tests.
 */
import { describe, expect, it } from '@effect/vitest';
import { Dataset, Isomorphism, type Term } from '@thomasfosterau/effect-rdf';
import { NQuads, NTriples } from '@thomasfosterau/effect-ntriples';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manifest, TriG, Turtle } from '../src/index.ts';

const suites =
  process.env['RDF_TEST_SUITES'] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.test-suites');
const rdfTests = path.join(suites, 'rdf-tests') + path.sep;
const exists = fs.existsSync(path.join(rdfTests, 'rdf'));
const IRI_ROOT = 'https://w3c.github.io/rdf-tests/';

const read = Manifest.fileReader(IRI_ROOT, rdfTests, (p) =>
  Effect.sync(() => fs.readFileSync(p, 'utf8')),
);

const loadEntries = (manifest: string): ReadonlyArray<Manifest.Entry> =>
  exists ? Effect.runSync(Manifest.load(`${IRI_ROOT}${manifest}`, read)) : [];

const chunked = (text: string, size: number): Stream.Stream<string> => {
  const chunks: Array<string> = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return Stream.fromIterable(chunks);
};

type Suite = (typeof suitesUnderTest)[number];
type Options = { readonly baseIri: string; readonly blankNodePrefix: string };

/** A negative test: both the strict and the streaming parser reject the input. */
const expectRejected = Effect.fn(function* (suite: Suite, input: string, options: Options) {
  const error = yield* Effect.flip(suite.syntax.parse(input, options));
  expect(error._tag).toBe('RdfParseError');
  const streamed = yield* Effect.flip(
    Stream.runCollect(suite.syntax.parseStream(chunked(input, 7), options)),
  );
  expect(streamed._tag).toBe('RdfParseError');
});

/** An evaluation test: the parsed graph is isomorphic to the expected result. */
const expectEvaluatesTo = Effect.fn(function* (
  suite: Suite,
  dataset: Dataset.Dataset,
  result: string,
) {
  const expected = yield* suite.expected.parse(yield* read(result));
  expect(
    Isomorphism.isomorphic(dataset, expected.dataset),
    `expected:\n${Dataset.toNQuads(expected.dataset)}\nactual:\n${Dataset.toNQuads(dataset)}`,
  ).toBe(true);
});

const suitesUnderTest = [
  { manifest: 'rdf/rdf12/rdf-turtle/manifest.ttl', syntax: Turtle, expected: NTriples },
  { manifest: 'rdf/rdf12/rdf-trig/manifest.ttl', syntax: TriG, expected: NQuads },
] as const;

describe.skipIf(!exists)('Turtle / TriG conformance', () => {
  for (const suite of suitesUnderTest) {
    const entries = loadEntries(suite.manifest);
    describe(`suite ${suite.manifest}`, () => {
      it('has entries', () => {
        expect(entries.length).toBeGreaterThan(200);
      });
      for (const entry of entries) {
        it.effect(`${entry.name} (${entry.kind})`, () =>
          Effect.gen(function* () {
            const action = yield* Effect.fromOption(entry.action);
            const input = yield* read(action);
            const options = { baseIri: action, blankNodePrefix: 'x' };
            if (entry.kind.endsWith('NegativeSyntax') || entry.kind.endsWith('NegativeEval')) {
              return yield* expectRejected(suite, input, options);
            }
            const { quads, prefixes } = yield* suite.syntax.parseQuads(input, options);
            for (const size of [1, 5, 64]) {
              const streamed = yield* Stream.runCollect(
                suite.syntax.parseStream(chunked(input, size), options),
              );
              expect(streamed.map((q: Term.Quad) => q.key)).toEqual(quads.map((q) => q.key));
            }
            const dataset = Dataset.fromIterable(quads);
            // The serializers round-trip: pretty (with prefixes and base, or with
            // auto-detected prefixes) and streaming output parse back to the same graph.
            const variants = [
              yield* suite.syntax.serialize(dataset, { prefixes, baseIri: action }),
              yield* suite.syntax.serialize(dataset, {
                autoPrefixes: true,
                sparqlDirectives: true,
              }),
              yield* Stream.mkString(
                suite.syntax.serializeStream(Stream.fromIterable(quads), { prefixes }),
              ),
            ];
            for (const text of variants) {
              const reparsed = yield* suite.syntax.parse(text, { baseIri: action });
              expect(
                Isomorphism.isomorphic(reparsed.dataset, dataset),
                `serialised:\n${text}\nexpected:\n${Dataset.toNQuads(dataset)}\nactual:\n${Dataset.toNQuads(reparsed.dataset)}`,
              ).toBe(true);
            }
            if (entry.kind.endsWith('Eval')) {
              yield* expectEvaluatesTo(suite, dataset, yield* Effect.fromOption(entry.result));
            }
          }),
        );
      }
    });
  }
});
