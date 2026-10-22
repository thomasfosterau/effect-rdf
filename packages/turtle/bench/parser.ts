/**
 * Benchmarks the Turtle and TriG parsers on every `.ttl` / `.trig` file of
 * the W3C RDF 1.1 and 1.2 test suites and on large synthetic documents,
 * parsed whole and as a stream of 64 kB chunks.
 *
 *   node --experimental-strip-types bench/parser.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Order from 'effect/Order';
import * as Stream from 'effect/Stream';
import { parseQuads, parseStream, type Syntax } from '../src/internal/parse.ts';

const suites =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../.test-suites');

const walk = (dir: string): Array<string> =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
    : [];

const turtle: Syntax = { name: 'Turtle', trig: false };
const trig: Syntax = { name: 'TriG', trig: true };

interface Doc {
  readonly syntax: Syntax;
  readonly text: string;
  readonly baseIri: string;
}

const files = walk(path.join(suites, 'rdf-tests/rdf'));
const suite: Array<Doc> = files
  .filter((f) => f.endsWith('.ttl') || f.endsWith('.trig'))
  .map((f) => ({
    syntax: f.endsWith('.trig') ? trig : turtle,
    text: fs.readFileSync(f, 'utf8'),
    baseIri: `file://${f}`,
  }));

const block = (i: number) => `
ex:s${i} a ex:Thing ; rdfs:label "thing ${i}"@en , "chose ${i}"@fr ;
  ex:n ${i} , ${i}.5 , ${i}e3 , true ;
  ex:knows [ ex:p ex:o${i % 13} ; ex:q ( 1 2 "three" <http://example.org/four> ) ] ;
  ex:dt "2024-01-0${(i % 9) + 1}"^^xsd:date ; ex:text """long
string ${i} with "quotes" and \\u00e9scapes""" .
<http://example.org/r${i}> <http://example.org/p> <http://example.org/o${i}> .
_:b${i} ex:p "plain" ; ex:ref ex:s${i} .
<< ex:s${i} ex:p ex:o >> ex:certainty 0.${i % 10} .
ex:s${i} ex:claims ex:o ~ ex:r${i} {| ex:source <http://example.org/src> |} .
`;
const prologue = `@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
`;
const n = 20_000;
const bigTurtle = prologue + Array.from({ length: n }, (_, i) => block(i)).join('');
const bigTrig =
  prologue +
  Array.from(
    { length: n / 100 },
    (_, g) =>
      `GRAPH ex:g${g} {\n${Array.from({ length: 100 }, (_, i) => block(g * 100 + i)).join('')}}\n`,
  ).join('');
const ntriples = Array.from(
  { length: 200_000 },
  (_, i) =>
    `<http://example.org/s${i % 997}> <http://example.org/p${i % 17}> "value ${i}" .\n` +
    `<http://example.org/s${i % 997}> <http://example.org/q> <http://example.org/o${i}> .\n`,
).join('');

const run = (doc: Doc, stream: boolean) => {
  const options = { baseIri: doc.baseIri };
  if (!stream) return Effect.runSync(Effect.result(parseQuads(doc.syntax, doc.text, options)));
  const chunks: Array<string> = [];
  for (let i = 0; i < doc.text.length; i += 65536) chunks.push(doc.text.slice(i, i + 65536));
  return Effect.runSync(
    Effect.result(Stream.runDrain(parseStream(doc.syntax)(Stream.fromIterable(chunks), options))),
  );
};

const bench = (name: string, docs: ReadonlyArray<Doc>, stream = false, k = 9) => {
  const size = docs.reduce((n, d) => n + d.text.length, 0);
  const all = () => {
    for (const d of docs) run(d, stream);
  };
  for (let i = 0; i < 3; i++) all();
  const samples: Array<number> = [];
  for (let i = 0; i < k; i++) {
    const t = performance.now();
    all();
    samples.push(performance.now() - t);
  }
  const sorted = Arr.sort(samples, Order.Number);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(
    `${name}: ${docs.length} docs, ${(size / 1e6).toFixed(2)} MB, median ${median.toFixed(1)} ms` +
      ` (${(size / 1e3 / median).toFixed(1)} MB/s)`,
  );
};

const base = 'http://example.org/base';
bench('suite', suite);
bench('synthetic Turtle', [{ syntax: turtle, text: bigTurtle, baseIri: base }]);
bench('synthetic Turtle, streamed', [{ syntax: turtle, text: bigTurtle, baseIri: base }], true);
bench('synthetic TriG', [{ syntax: trig, text: bigTrig, baseIri: base }]);
bench('N-Triples-like Turtle', [{ syntax: turtle, text: ntriples, baseIri: base }]);
bench('N-Triples-like Turtle, streamed', [{ syntax: turtle, text: ntriples, baseIri: base }], true);
