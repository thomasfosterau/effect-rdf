/**
 * Benchmarks the XML parser on every RDF/XML and SPARQL XML results file of
 * the W3C test suites and on a large synthetic RDF/XML document, and the
 * RDF/XML parser and serializer on that document.
 *
 *   node --experimental-strip-types bench/xml.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Order from 'effect/Order';
import * as RdfXml from '../../src/rdfxml/RdfXml.ts';
import * as Xml from '../../src/rdfxml/Xml.ts';

const suites =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../../.test-suites');

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

// A quarter of the document: trunk's serializer overflowed the stack on all of it.
const bigQuads = Effect.runSync(RdfXml.parseQuads(big, { blankNodePrefix: 'b' })).quads.slice(
  0,
  40_000,
);

const bench = (name: string, size: number, unit: string, run: () => void) => {
  // Warm up, then sample.
  Arr.makeBy(3, run);
  const samples = Arr.makeBy(9, () => {
    const t = performance.now();
    run();
    return performance.now() - t;
  });
  const sorted = Arr.sort(samples, Order.Number);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(
    `${name}: ${unit}, median ${median.toFixed(1)} ms (${(size / median).toFixed(1)}/ms)`,
  );
};

const bytes = (docs: ReadonlyArray<string>) => docs.reduce((n, d) => n + d.length, 0);

bench(
  'XML suite',
  bytes(suite),
  `${suite.length} docs, ${(bytes(suite) / 1e6).toFixed(2)} MB`,
  () =>
    suite.forEach((d) => {
      Xml.parseResult(d);
    }),
);
bench('XML synthetic', big.length, `${(big.length / 1e6).toFixed(2)} MB`, () => {
  Xml.parseResult(big);
});
bench('RDF/XML parse', big.length, `${(big.length / 1e6).toFixed(2)} MB`, () => {
  Effect.runSync(RdfXml.parse(big));
});
bench('RDF/XML serialize', bigQuads.length, `${bigQuads.length} quads`, () => {
  Effect.runSync(RdfXml.serialize(bigQuads));
});
