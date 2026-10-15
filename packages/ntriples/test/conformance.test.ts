/**
 * W3C RDF 1.1 / RDF 1.2 N-Triples and N-Quads conformance tests.
 *
 * The manifests are read with a small purpose-built reader (this package
 * cannot depend on the Turtle parser, which depends on it for its own tests).
 */
import { describe, expect, it } from '@effect/vitest';
import { Dataset, Isomorphism } from '@thomasfosterau/effect-rdf';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NQuads, NTriples } from '../src/index.ts';

const suites =
  process.env['RDF_TEST_SUITES'] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.test-suites');
const rdfDir = path.join(suites, 'rdf-tests', 'rdf');
const exists = fs.existsSync(rdfDir);

interface Entry {
  readonly id: string;
  readonly type: string;
  readonly action: string;
  readonly result: string | undefined;
}

/** Reads the entries of a (simple, regular) W3C syntax test manifest. */
const readManifest = (dir: string): ReadonlyArray<Entry> => {
  const text = fs.readFileSync(path.join(dir, 'manifest.ttl'), 'utf8');
  const listed = /mf:entries\s*\(([\s\S]*?)\)/.exec(text)?.[1] ?? '';
  const ids = new Set(
    listed
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .flatMap((l) => l.split(/\s+/))
      .filter((l) => l !== ''),
  );
  // Recover `<#x>` entries whose `#` was stripped above.
  for (const m of listed.matchAll(/<#[^>]+>/g)) ids.add(m[0]);
  const out: Array<Entry> = [];
  const block = /^(\S+)\s+(?:rdf:type|a)\s+rdft:(\w+)\s*;([\s\S]*?)(?:^\s*\.\s*$|\s\.\s*$)/gm;
  for (const m of text.matchAll(block)) {
    const [, id, type, body] = m as unknown as [string, string, string, string];
    if (!ids.has(id)) continue;
    const action = /mf:action\s+<([^>]+)>/.exec(body)?.[1];
    const result = /mf:result\s+<([^>]+)>/.exec(body)?.[1];
    if (action === undefined) continue;
    out.push({
      id,
      type,
      action: path.join(dir, action),
      result: result === undefined ? undefined : path.join(dir, result),
    });
  }
  return out;
};

const manifests = [
  'rdf11/rdf-n-triples',
  'rdf11/rdf-n-quads',
  'rdf12/rdf-n-triples/syntax',
  'rdf12/rdf-n-triples/c14n',
  'rdf12/rdf-n-quads/syntax',
  'rdf12/rdf-n-quads/c14n',
];

const chunked = (text: string, size: number): Stream.Stream<string> => {
  const chunks: Array<string> = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return Stream.fromIterable(chunks);
};

describe.skipIf(!exists)('N-Triples / N-Quads conformance', () => {
  for (const dir of manifests) {
    const entries = exists ? readManifest(path.join(rdfDir, dir)) : [];
    describe(`manifest ${dir}`, () => {
      it('has entries', () => {
        expect(entries.length).toBeGreaterThan(10);
      });
      for (const entry of entries) {
        const codec = entry.type.startsWith('TestNQuads') ? NQuads : NTriples;
        it.effect(`${entry.id} (${entry.type})`, () =>
          Effect.gen(function* () {
            const input = fs.readFileSync(entry.action, 'utf8');
            if (entry.type.endsWith('NegativeSyntax')) {
              const error = yield* Effect.flip(codec.parse(input));
              expect(error._tag).toBe('RdfParseError');
              const streamed = yield* Effect.flip(
                Stream.runCollect(codec.parseStream(chunked(input, 5))),
              );
              expect(streamed._tag).toBe('RdfParseError');
              return;
            }
            const quads = yield* codec.parseQuads(input, { blankNodePrefix: '' });
            // Streaming with arbitrary chunk boundaries yields the same statements.
            for (const size of [1, 3, 17]) {
              const streamed = yield* Stream.runCollect(
                codec.parseStream(chunked(input, size), { blankNodePrefix: '' }),
              );
              expect(streamed.map((q) => q.key)).toEqual(quads.map((q) => q.key));
            }
            // The canonical serialisation round-trips.
            const text = yield* codec.serialize(quads);
            const reparsed = yield* codec.parse(text);
            expect(Isomorphism.isomorphic(reparsed.dataset, Dataset.fromIterable(quads))).toBe(
              true,
            );
            if (entry.type.endsWith('PositiveC14N') && entry.result !== undefined) {
              const expected = fs.readFileSync(entry.result, 'utf8');
              expect(text).toBe(expected);
            }
          }),
        );
      }
    });
  }
});
