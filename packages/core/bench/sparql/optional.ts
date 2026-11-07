/**
 * Benchmarks `OPTIONAL` with a dependent filter over a synthetic graph
 * (effect-rdf#112): a chain of `:knows` links, every other node with an
 * `:age`.
 *
 *   node --experimental-strip-types bench/sparql/optional.ts [people] [fan-out]
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Engine from '../../src/sparql/Engine.ts';
import * as Store from '../../src/sparql/Store.ts';

const people = Number(process.argv[2] ?? 50_000);
const fanOut = Number(process.argv[3] ?? 1);
const ex = (local: string) => Term.namedNode(`http://example.org/${local}`);
const XSD_INTEGER = Term.namedNode('http://www.w3.org/2001/XMLSchema#integer');
const dataset = Dataset.fromIterable(
  Arr.makeBy(people, (i) => [
    ...Arr.makeBy(fanOut, (k) =>
      Term.quad(ex(`p${i}`), ex('knows'), ex(`p${(i * 7 + k * 13 + 1) % people}`)),
    ),
    ...(i % 2 === 0
      ? [Term.quad(ex(`p${i}`), ex('age'), Term.literal(String(i % 80), XSD_INTEGER))]
      : []),
  ]).flat(),
);

const queries: ReadonlyArray<readonly [string, string]> = [
  [
    'join',
    'SELECT * WHERE { ?a <http://example.org/knows> ?b . ?b <http://example.org/age> ?age }',
  ],
  [
    'optional',
    'SELECT * WHERE { ?a <http://example.org/knows> ?b . OPTIONAL { ?b <http://example.org/age> ?age } }',
  ],
  [
    'optional + filter',
    'SELECT * WHERE { ?a <http://example.org/knows> ?b . OPTIONAL { ?b <http://example.org/age> ?age . FILTER(?age > 30) } }',
  ],
  [
    'optional + left-dependent filter',
    'SELECT * WHERE { ?a <http://example.org/knows> ?b . ?a <http://example.org/age> ?min . OPTIONAL { ?b <http://example.org/age> ?age . FILTER(?age > ?min) } }',
  ],
  [
    'optional + erroring filter',
    'SELECT * WHERE { ?a <http://example.org/knows> ?b . OPTIONAL { ?b <http://example.org/age> ?age . FILTER(?age > "30") } }',
  ],
  [
    'optional + filter (no hash)',
    'SELECT * WHERE { ?a <http://example.org/knows> ?b . OPTIONAL { { ?b <http://example.org/age> ?age } UNION { ?b <http://example.org/name> ?age } FILTER(?age > 30) } }',
  ],
];

const time = Effect.fn('time')(function* (
  engine: Engine.SparqlEngineShape,
  name: string,
  query: string,
) {
  const start = performance.now();
  const result = yield* engine.select(query);
  const rows = yield* Stream.runCount(result.bindings);
  // oxlint-disable-next-line no-console -- benchmark output
  console.log(`${name.padEnd(34)} ${rows} rows  ${(performance.now() - start).toFixed(0)} ms`);
});

const program = Effect.fn('program')(function* () {
  const engine = Engine.make(yield* Store.makeMemory(dataset));
  yield* Effect.forEach(queries, ([name, query]) => time(engine, name, query), {
    concurrency: 1,
  });
});

// oxlint-disable-next-line no-console -- benchmark output
console.log(`${people} people`);
await Effect.runPromise(program());
