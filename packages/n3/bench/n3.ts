/**
 * Benchmarks the N3 parser on every `.n3` and `.ttl` file in the W3C N3
 * test suites, and on a large synthetic document.
 *
 *   node --experimental-strip-types bench/n3.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Effect from 'effect/Effect';
import * as N3 from '../src/N3.ts';

const suites =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../.test-suites');

const walk = (dir: string): Array<string> =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
    : [];

const docs = walk(path.join(suites, 'N3'))
  .filter((f) => f.endsWith('.n3') || f.endsWith('.ttl'))
  .map((f) => ({ text: fs.readFileSync(f, 'utf8'), baseIri: `file://${f}` }));

const block = (i: number) => `
# block ${i}
@prefix ex: <http://example.org/> .
ex:s${i} a ex:Thing ; ex:name "thing ${i}"@en , "chose"@fr ; ex:n ${i} , ${i}.5 , ${i}e3 ;
  ex:knows [ ex:p ex:o ; ex:q ( 1 2 "three" <http://example.org/four> ) ] ;
  ex:says { ex:a ex:b ex:c . ?x ex:d _:b${i} } ;
  ex:path ex:s${i}!ex:p^ex:q ; is ex:inverse of ex:t${i} ; <= { ?y ex:e ?z } .
{ ?x a ex:Thing . ?x ex:n ?n } => { ?x ex:value ?n ; ex:flag true } .
ex:t${i} = ex:u${i} ; ex:label """long
string ${i}""" ; ex:dt "2024-01-0${i % 9}"^^<http://www.w3.org/2001/XMLSchema#date> .
`;
const big = Array.from({ length: 3000 }, (_, i) => block(i)).join('');

const bench = (name: string, inputs: ReadonlyArray<{ text: string; baseIri: string }>) => {
  const size = inputs.reduce((n, d) => n + d.text.length, 0);
  const run = () => {
    for (const d of inputs) Effect.runSync(Effect.result(N3.parse(d.text, { baseIri: d.baseIri })));
  };
  for (let i = 0; i < 3; i++) run();
  const samples: Array<number> = [];
  for (let i = 0; i < 9; i++) {
    const t = performance.now();
    run();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(
    `${name}: ${inputs.length} docs, ${(size / 1e6).toFixed(2)} MB, median ${median.toFixed(0)} ms` +
      ` (${(size / 1e3 / median).toFixed(1)} MB/s)`,
  );
};

bench('N3 suite', docs);
bench('synthetic', [{ text: big, baseIri: 'http://example.org/' }]);
