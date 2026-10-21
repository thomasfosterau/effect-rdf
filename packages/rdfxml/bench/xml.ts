/**
 * Benchmarks the XML parser on every RDF/XML and SPARQL XML results file of
 * the W3C test suites and on a large synthetic RDF/XML document.
 *
 *   node --experimental-strip-types bench/xml.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Xml from '../src/Xml.ts';

const suites =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../.test-suites');

const walk = (dir: string): Array<string> =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
    : [];

const suite = walk(suites)
  .filter((f) => f.endsWith('.rdf') || f.endsWith('.srx'))
  .map((f) => fs.readFileSync(f, 'utf8'));

const description = (i: number) => `
  <rdf:Description rdf:about="http://example.org/s${i}" ex:label="thing ${i}">
    <rdf:type rdf:resource="http://example.org/Thing"/>
    <ex:name xml:lang="en">Thing &amp; number ${i}</ex:name>
    <ex:n rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">${i}</ex:n>
    <ex:knows>
      <ex:Person rdf:nodeID="b${i}"><ex:name>Someone &lt;${i}&gt;</ex:name></ex:Person>
    </ex:knows>
    <!-- a comment -->
    <ex:xml rdf:parseType="Literal"><b xmlns="http://www.w3.org/1999/xhtml">bold</b> text</ex:xml>
  </rdf:Description>`;
const big = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="http://example.org/">${Array.from({ length: 20_000 }, (_, i) => description(i)).join('')}
</rdf:RDF>`;

const bench = (name: string, docs: ReadonlyArray<string>) => {
  const size = docs.reduce((n, d) => n + d.length, 0);
  const all = () => {
    for (const d of docs) Xml.parseResult(d);
  };
  for (let i = 0; i < 3; i++) all();
  const samples: Array<number> = [];
  for (let i = 0; i < 9; i++) {
    const t = performance.now();
    all();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(
    `${name}: ${docs.length} docs, ${(size / 1e6).toFixed(2)} MB, median ${median.toFixed(1)} ms` +
      ` (${(size / 1e3 / median).toFixed(1)} MB/s)`,
  );
};

bench('suite', suite);
bench('synthetic RDF/XML', [big]);
