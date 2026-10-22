/**
 * Benchmarks the SPARQL parser on every query (`.rq`) and update (`.ru`) of
 * the SPARQL conformance suites, and on large synthetic ones.
 *
 *   node --experimental-strip-types bench/parser.ts
 */
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Parser from '../src/Parser.ts';

const suites =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../.test-suites');

const walk = (dir: string): Array<string> =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
    : [];

const files = walk(path.join(suites, 'rdf-tests/sparql'));
const docs = files
  .filter((f) => f.endsWith('.rq') || f.endsWith('.ru'))
  .map((f) => ({
    text: fs.readFileSync(f, 'utf8'),
    update: f.endsWith('.ru'),
    baseIri: `file://${f}`,
  }));

const select = (i: number) => `
SELECT DISTINCT ?s ?label (COUNT(?o) AS ?n${i}) WHERE {
  ?s a ex:Thing ; rdfs:label ?label ; ex:p${i % 7} [ ex:q ?o ; ex:r ( 1 2 "three" ) ] .
  OPTIONAL { ?s ex:knows/ex:name* ?name FILTER (LANG(?name) = "en" && STRLEN(?name) > ${i % 5}) }
  { ?s ex:a ?a } UNION { ?s ^ex:b|ex:c ?a . BIND (CONCAT(STR(?a), "-${i}") AS ?x${i}) }
  MINUS { ?s ex:deleted true }
  VALUES ?k { ex:k1 ex:k2 "k3"@en 4.5 }
  FILTER (?o >= ${i} || REGEX(?label, "^a.*b$", "i") || ?o IN (1, 2, 3))
}
GROUP BY ?s ?label HAVING (COUNT(?o) > 1) ORDER BY DESC(?n${i}) ?s LIMIT 10 OFFSET ${i}
`;
const prologue = `PREFIX ex: <http://example.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;
const bigQuery = `${prologue}SELECT * WHERE {\n${Array.from({ length: 400 }, (_, i) => `{ ${select(i)} }`).join(' UNION\n')}\n}`;
const bigUpdate = Array.from(
  { length: 400 },
  (
    _,
    i,
  ) => `${prologue}INSERT DATA { ex:s${i} ex:p "v${i}"@en , ${i} , ex:o${i} . GRAPH ex:g { ex:s${i} ex:q ( 1 2 ) } } ;
DELETE { ?s ex:p ?o } INSERT { ?s ex:p2 [ ex:v ?o ] } WHERE { ?s ex:p ?o FILTER (isLiteral(?o) && ?o != ${i}) }`,
).join(' ;\n');

const bench = (
  name: string,
  inputs: ReadonlyArray<{ text: string; update: boolean; baseIri: string }>,
) => {
  const size = inputs.reduce((n, d) => n + d.text.length, 0);
  const run = () => {
    for (const d of inputs) {
      if (d.update) Parser.parseUpdateResult(d.text, { baseIri: d.baseIri });
      else Parser.parseQueryResult(d.text, { baseIri: d.baseIri });
    }
  };
  for (let i = 0; i < 3; i++) run();
  const samples: Array<number> = [];
  for (let i = 0; i < 11; i++) {
    const t = performance.now();
    run();
    samples.push(performance.now() - t);
  }
  const median = Arr.sort(samples, Order.Number)[Math.floor(samples.length / 2)]!;
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(
    `${name}: ${inputs.length} docs, ${(size / 1e3).toFixed(0)} kB, median ${median.toFixed(1)} ms` +
      ` (${(size / 1e3 / median).toFixed(1)} MB/s)`,
  );
};

bench('suite', docs);
bench('synthetic query', [{ text: bigQuery, update: false, baseIri: 'http://example.org/' }]);
bench('synthetic update', [{ text: bigUpdate, update: true, baseIri: 'http://example.org/' }]);
