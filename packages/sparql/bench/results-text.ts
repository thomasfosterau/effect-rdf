/**
 * Benchmarks the TSV and CSV results parsers.
 *
 * Corpus: every SRX / SRJ results file in the SPARQL conformance suites,
 * re-serialised as TSV and CSV, plus a synthetic document of mixed terms.
 *
 *   node --experimental-strip-types bench/results-text.ts
 */
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Effect from 'effect/Effect';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as B from '../src/Bindings.ts';
import * as Results from '../src/Results.ts';

const suites =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../.test-suites');
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const walk = (dir: string): Array<string> =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
    : [];

const sets: Array<Results.ResultSet> = [];
for (const file of walk(path.join(suites, 'rdf-tests/sparql'))) {
  const codec = file.endsWith('.srx') ? Results.Xml : file.endsWith('.srj') ? Results.Json : null;
  if (codec === null) continue;
  const parsed = Effect.runSync(Effect.result(codec.parse(fs.readFileSync(file, 'utf8'))));
  if (parsed._tag === 'Success' && parsed.success._tag === 'ResultSet') sets.push(parsed.success);
}

const terms: Array<Term.GroundTerm> = [
  Term.namedNode('http://example.org/resource/item'),
  Term.blankNode('b0'),
  Term.literal('plain string with "quotes" and \\ escapes\nand a newline'),
  Term.literal('chat', 'fr'),
  Term.literal('مرحبا', { language: 'ar', direction: 'rtl' }),
  Term.literal('12345', Term.namedNode(`${XSD}integer`)),
  Term.literal('3.14', Term.namedNode(`${XSD}decimal`)),
  Term.literal('1.0e6', Term.namedNode(`${XSD}double`)),
  Term.literal('true', Term.namedNode(`${XSD}boolean`)),
  Term.literal('2024-01-01', Term.namedNode(`${XSD}date`)),
  Term.triple(
    Term.namedNode('http://example.org/s'),
    Term.namedNode('http://example.org/p'),
    Term.literal('o'),
  ),
];
const vars = ['a', 'b', 'c', 'd', 'e'];
sets.push({
  _tag: 'ResultSet',
  variables: vars,
  bindings: Array.from({ length: 20_000 }, (_, i) =>
    B.fromEntries(vars.map((v, j) => [v, terms[(i * 7 + j * 3) % terms.length]] as const)),
  ),
});

const corpus = (codec: Results.ResultsCodec) => sets.map((s) => codec.serializeString(s));

const bench = (name: string, codec: Results.ResultsCodec) => {
  const docs = corpus(codec);
  const bytes = docs.reduce((n, d) => n + d.length, 0);
  const run = () => {
    for (const d of docs) Effect.runSync(codec.parse(d));
  };
  for (let i = 0; i < 5; i++) run();
  const samples: Array<number> = [];
  for (let i = 0; i < 15; i++) {
    const t = performance.now();
    run();
    samples.push(performance.now() - t);
  }
  const median = Arr.sort(samples, Order.Number)[Math.floor(samples.length / 2)]!;
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(
    `${name}: ${docs.length} docs, ${(bytes / 1e6).toFixed(2)} MB, median ${median.toFixed(1)} ms` +
      ` (${(bytes / 1e3 / median).toFixed(1)} MB/s)`,
  );
};

bench('TSV', Results.Tsv);
bench('CSV', Results.Csv);
