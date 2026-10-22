/**
 * The W3C SPARQL query and update evaluation tests, run over the protocol:
 * each test's data is loaded into an in-process server, the query or update
 * is sent with the client, and the results are parsed by the client (in
 * JSON, XML and TSV) and compared with the expected results. This exercises
 * the whole server ↔ client round trip on the full variety of terms and
 * result shapes of the suites.
 *
 * The test manifests are read with the test support of the sparql package.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import { type Ast, type Bindings, Parser, Results, Store } from '@thomasfosterau/effect-sparql';
import { SparqlServer, Testing } from '@thomasfosterau/effect-sparql-server';
import * as SparqlClient from '../src/SparqlClient.ts';
import { fromRdf, normalize, sameResults } from '../../sparql/test/support/compare.ts';
import { readManifest, type TestCase } from '../../sparql/test/support/manifest.ts';
import { parseFile } from '../../sparql/test/support/rdf.ts';

const suitesDir =
  process.env.RDF_TEST_SUITES ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.test-suites');
const sparqlDir = path.join(suitesDir, 'rdf-tests', 'sparql');
const exists = fs.existsSync(sparqlDir);

/** Directories whose tests are not run here, with the reason. */
const SKIPPED_DIRECTORIES = {
  'sparql11/service': 'Run by Federation.test.ts with one server per endpoint',
  'sparql11/entailment': 'Entailment regimes are not supported by the engine',
};

/**
 * Individual tests that cannot pass over the protocol, with the reason.
 */
const SKIPPED: Readonly<Record<string, string>> = {};

const EVAL_TYPES = new Set(['QueryEvaluationTest', 'UpdateEvaluationTest', 'CSVResultFormatTest']);
const manifests = ['sparql10/manifest.ttl', 'sparql11/manifest-all.ttl', 'sparql12/manifest.ttl'];

const loadTests = (): Array<TestCase> => {
  if (!exists) return [];
  const seen = new Set<string>();
  const out: Array<TestCase> = [];
  for (const m of manifests) {
    for (const t of readManifest(path.join(sparqlDir, m))) {
      if (!EVAL_TYPES.has(t.type) || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
};

const skipReason = (t: TestCase): string | undefined => {
  const rel = path.relative(sparqlDir, t.manifest);
  for (const [dir, reason] of Object.entries(SKIPPED_DIRECTORIES)) {
    if (rel.startsWith(`${dir}/`)) return reason;
  }
  return SKIPPED[t.id];
};

const loadDataset = (t: TestCase, query: Ast.Query | undefined): Dataset.Dataset => {
  const quads: Array<Term.Quad> = [];
  for (const file of t.data) quads.push(...parseFile(file));
  for (const g of t.graphData) {
    quads.push(
      ...parseFile(g.file, Term.namedNode(g.name !== '' ? g.name : pathToFileURL(g.file).href)),
    );
  }
  const loaded = Dataset.fromIterable(quads);
  // Graphs named in FROM / FROM NAMED are loaded from files.
  const graphs = [...(query?.dataset?.default ?? []), ...(query?.dataset?.named ?? [])];
  for (const g of graphs) {
    if (!g.value.startsWith('file:') || Dataset.match(loaded, { graph: g }).length > 0) continue;
    const file = fileURLToPath(g.value);
    if (fs.existsSync(file)) quads.push(...parseFile(file, g));
  }
  return Dataset.fromIterable(quads);
};

const readExpected = (file: string): Results.ParsedResult | Dataset.Dataset => {
  const ext = file.slice(file.lastIndexOf('.') + 1);
  const text = fs.readFileSync(file, 'utf8');
  const codec = { srx: Results.Xml, srj: Results.Json, tsv: Results.Tsv, csv: Results.Csv }[ext];
  if (codec !== undefined) return Effect.runSync(codec.parse(text));
  const quads = parseFile(file);
  return fromRdf(quads) ?? Dataset.fromIterable(quads);
};

const orderKey = (
  b: { readonly map: ReadonlyMap<string, Term.GroundTerm> },
  vars: ReadonlyArray<string>,
) =>
  vars
    .map((v) => {
      const t = b.map.get(v);
      return t === undefined ? '' : t._tag === 'BlankNode' ? '_' : normalize(t).key;
    })
    .join('|');

const sortedStrings = (bindings: ReadonlyArray<{ readonly toString: () => string }>) =>
  Arr.sort(
    bindings.map((b) => b.toString()),
    Order.String,
  );

const ENDPOINT = 'http://sparql.test/sparql';

const clientLayer = (data: Dataset.Dataset, baseIri: string, resultsAccept: string) =>
  SparqlClient.layer({ endpoint: ENDPOINT, resultsAccept, method: 'post' }).pipe(
    Layer.provide(Testing.layerClient({ baseIri })),
    Layer.provideMerge(SparqlServer.layerMemoryServices(data, { baseIri })),
  );

const FORMATS = [
  'application/sparql-results+json',
  'application/sparql-results+xml',
  'text/tab-separated-values',
] as const;

/** Fails with an N-Quads diff unless the graphs are isomorphic. */
const expectIsomorphic = (actual: Dataset.Dataset, exp: Dataset.Dataset): void => {
  const isomorphic = Isomorphism.isomorphic(actual, exp);
  expect(isomorphic ? '' : Dataset.toNQuads(actual)).toBe(isomorphic ? '' : Dataset.toNQuads(exp));
};

/** The `ORDER BY` variables of a query, when every key is a plain variable. */
const orderVariables = (query: Ast.Query): ReadonlyArray<string> =>
  query.orderBy.every((o) => Term.isVariable(o.expression))
    ? query.orderBy.map((o) => (o.expression as Term.Variable).value)
    : [];

/**
 * Fails unless the solutions match (as multisets, or as sets when `lax`), and
 * in `ORDER BY` order when the query has one and the test is not lax.
 */
const expectSameSolutions = (
  actual: ReadonlyArray<Bindings.Bindings>,
  exp: ReadonlyArray<Bindings.Bindings>,
  vars: ReadonlyArray<string>,
  lax: boolean,
): void => {
  const same = sameResults(actual, exp, { lax });
  expect(same ? [] : sortedStrings(actual)).toEqual(same ? [] : sortedStrings(exp));
  expect(same, 'Results differ only in blank node structure').toBe(true);
  if (vars.length === 0 || lax) return;
  expect(actual.map((b) => orderKey(b, vars))).toEqual(exp.map((b) => orderKey(b, vars)));
};

const runQueryTest = (t: TestCase, accept: string) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(t.query!, 'utf8');
    const baseIri = pathToFileURL(t.query!).href;
    const query = yield* Parser.parseQuery(text, { baseIri });
    const expected = readExpected(t.result!);
    yield* Effect.gen(function* () {
      const client = yield* SparqlClient.SparqlClient;
      switch (query._tag) {
        case 'Ask': {
          const value = yield* client.ask(text);
          expect(expected).toEqual({ _tag: 'Boolean', value });
          return;
        }
        case 'Construct':
        case 'Describe': {
          const actual = yield* client.constructDataset(text);
          expectIsomorphic(actual, expected as Dataset.Dataset);
          return;
        }
        case 'Select': {
          const set = yield* client.selectAll(text);
          let actual = set.bindings;
          if (t.type === 'CSVResultFormatTest' || t.result!.endsWith('.csv')) {
            const csv = Results.Csv.serializeString(set);
            actual = ((yield* Results.Csv.parse(csv)) as Results.ResultSet).bindings;
          }
          expectSameSolutions(
            actual,
            (expected as Results.ResultSet).bindings,
            orderVariables(query),
            t.laxCardinality,
          );
          return;
        }
      }
    }).pipe(Effect.provide(clientLayer(loadDataset(t, query), baseIri, accept)));
  });

const runUpdateTest = (t: TestCase) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(t.query!, 'utf8');
    const baseIri = pathToFileURL(t.query!).href;
    yield* Effect.gen(function* () {
      const client = yield* SparqlClient.SparqlClient;
      const outcome = yield* Effect.result(client.update(text));
      expect(t.updateSuccess ? 'Failure' : outcome._tag).toBe('Failure');
      if (!t.updateSuccess) return;
      if (outcome._tag === 'Failure') return yield* outcome.failure;
      const quads: Array<Term.Quad> = [];
      for (const file of t.resultData) quads.push(...parseFile(file));
      for (const g of t.resultGraphData) quads.push(...parseFile(g.file, Term.namedNode(g.name)));
      const expected = Dataset.fromIterable(quads);
      const actual = yield* Store.toDataset(yield* Store.QuadStore);
      const isomorphic = Isomorphism.isomorphic(actual, expected);
      expect(isomorphic ? '' : Dataset.toNQuads(actual)).toBe(
        isomorphic ? '' : Dataset.toNQuads(expected),
      );
    }).pipe(Effect.provide(clientLayer(loadDataset(t, undefined), baseIri, FORMATS[0])));
  });

const tests = loadTests();
const label = (t: TestCase) => `${path.relative(sparqlDir, path.dirname(t.manifest))}: ${t.name}`;

describe.skipIf(!exists)('SPARQL evaluation conformance over HTTP (client ↔ server)', () => {
  const runnable = tests.filter((t) => skipReason(t) === undefined);
  it('runs every evaluation test outside the skipped directories', () => {
    expect(
      tests.filter((t) => skipReason(t) !== undefined).every((t) => skipReason(t)!.length > 0),
    ).toBe(true);
    expect(runnable.length).toBeGreaterThan(600);
  });
  it.each(
    runnable.filter((t) => t.type !== 'UpdateEvaluationTest').map((t) => [label(t), t] as const),
  )(
    '%s',
    async (_, t) => {
      for (const accept of FORMATS) {
        expect(await Effect.runPromise(Effect.as(runQueryTest(t, accept), true))).toBe(true);
      }
    },
    20_000,
  );
  it.each(
    runnable.filter((t) => t.type === 'UpdateEvaluationTest').map((t) => [label(t), t] as const),
  )(
    '%s',
    async (_, t) => {
      expect(await Effect.runPromise(Effect.as(runUpdateTest(t), true))).toBe(true);
    },
    20_000,
  );
});
