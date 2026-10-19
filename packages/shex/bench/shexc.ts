/**
 * Benchmarks the ShExC parser on every `.shex` file in the shexTest suite
 * (schemas, negative syntax and structure, validation).
 *
 *   node --experimental-strip-types bench/shexc.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Effect from 'effect/Effect';
import * as ShExC from '../src/ShExC.ts';

const suites =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../.test-suites');

const walk = (dir: string): Array<string> =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
    : [];

const docs = walk(path.join(suites, 'shexTest'))
  .filter((f) => f.endsWith('.shex') && !f.includes('node_modules'))
  .map((f) => ({ text: fs.readFileSync(f, 'utf8'), baseIri: `file://${f}` }));

const shape = (i: number) => `
# shape ${i}
ex:S${i} EXTRA a CLOSED {
  ex:name xsd:string MINLENGTH 1 MAXLENGTH 100 /^[A-Z]/i ;
  ex:age xsd:integer MININCLUSIVE 0 MAXEXCLUSIVE 150 ? ;
  ex:status [ ex:active ex:inactive "pending"@en <http://example.org/s>~ - <http://example.org/s/x> ] ;
  $ex:t${i} ( ex:knows @ex:S${(i + 1) % 2000} * | ^ex:member IRI @<S${i}b> {1,3} ) ;
  ex:label LITERAL OR ( BNODE AND NOT @ex:S0 ) // rdfs:comment 'a \\'label\\'' ;
  ex:score xsd:decimal TOTALDIGITS 5 FRACTIONDIGITS 2 + %ex:act{ print(o) %} ;
  &ex:t${i === 0 ? 1 : i - 1}
}
<S${i}b> { ex:p . ; ex:q [ 1 2.5 3e2 true ] }
`;
const big = [
  'PREFIX ex: <http://example.org/>',
  'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
  'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
  'BASE <http://example.org/base/>',
  ...Array.from({ length: 2000 }, (_, i) => shape(i)),
].join('\n');

const bench = (name: string, inputs: ReadonlyArray<{ text: string; baseIri: string }>) => {
  const size = inputs.reduce((n, d) => n + d.text.length, 0);
  const run = () => {
    for (const d of inputs) {
      Effect.runSync(Effect.result(ShExC.parse(d.text, { baseIri: d.baseIri })));
    }
  };
  for (let i = 0; i < 5; i++) run();
  const samples: Array<number> = [];
  for (let i = 0; i < 15; i++) {
    const t = performance.now();
    run();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(
    `${name}: ${inputs.length} docs, ${(size / 1e3).toFixed(0)} kB, median ${median.toFixed(1)} ms` +
      ` (${(size / 1e3 / median).toFixed(1)} MB/s)`,
  );
};

bench('shexTest', docs);
bench('synthetic', [{ text: big, baseIri: 'http://example.org/' }]);
