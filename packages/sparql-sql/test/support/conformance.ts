/**
 * A W3C SPARQL evaluation test harness (SPARQL 1.0, 1.1, 1.2) for SQL
 * backends: data is loaded into an empty store, and the engine evaluates
 * queries and updates through the store's SPARQL-to-SQL translation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import type * as Ast from '@thomasfosterau/effect-sparql/Ast';
import type { Bindings } from '@thomasfosterau/effect-sparql/Bindings';
import * as Engine from '@thomasfosterau/effect-sparql/Engine';
import * as Parser from '@thomasfosterau/effect-sparql/Parser';
import * as Results from '@thomasfosterau/effect-sparql/Results';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import type * as SqlStore from '../../src/SqlStore.ts';
import { fromRdf, normalize, sameResults } from './compare.ts';
import { readManifest, suitesDir, type TestCase } from './manifest.ts';
import { parseFile } from './rdf.ts';

const sparqlDir = path.join(suitesDir, 'rdf-tests', 'sparql');
const exists = fs.existsSync(sparqlDir);

/** Tests that are deliberately not run, with the reason. */
const skipped: Readonly<Record<string, string>> = {};

const SKIPPED_DIRECTORIES: Readonly<Record<string, string>> = {
  'sparql11/service': 'SERVICE federation requires remote endpoints',
  'sparql11/entailment': 'Entailment regimes are not supported',
  'sparql11/protocol': 'Protocol tests belong to the HTTP server package',
  'sparql11/graph-store-protocol': 'Graph Store Protocol tests belong to the HTTP server package',
  'sparql11/http-rdf-update': 'Graph Store Protocol tests belong to the HTTP server package',
  'sparql11/service-description': 'Service descriptions belong to the HTTP server package',
};

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
  return skipped[t.id];
};

const loadQuads = (t: TestCase): Array<Term.Quad> => {
  const quads: Array<Term.Quad> = [];
  for (const file of t.data) quads.push(...parseFile(file));
  for (const g of t.graphData) {
    const name = g.name !== '' ? g.name : pathToFileURL(g.file).href;
    quads.push(...parseFile(g.file, Term.namedNode(name)));
  }
  return quads;
};

/** Loads the graphs named in FROM / FROM NAMED clauses from files. */
const datasetClauseQuads = (query: Ast.Query, loaded: Dataset.Dataset): Array<Term.Quad> => {
  const out: Array<Term.Quad> = [];
  const graphs = [...(query.dataset?.default ?? []), ...(query.dataset?.named ?? [])];
  for (const g of graphs) {
    if (!g.value.startsWith('file:') || Dataset.match(loaded, { graph: g }).length > 0) continue;
    const file = fileURLToPath(g.value);
    if (fs.existsSync(file)) out.push(...parseFile(file, g));
  }
  return out;
};

const readExpected = (file: string): Results.ParsedResult | Dataset.Dataset => {
  const ext = file.slice(file.lastIndexOf('.') + 1);
  const text = fs.readFileSync(file, 'utf8');
  const codec = { srx: Results.Xml, srj: Results.Json, tsv: Results.Tsv, csv: Results.Csv }[ext];
  if (codec !== undefined) return Effect.runSync(codec.parse(text));
  const quads = parseFile(file);
  return fromRdf(quads) ?? Dataset.fromIterable(quads);
};

const orderVariables = (query: Ast.Query): ReadonlyArray<string> =>
  query.orderBy.every((o) => o.expression._tag === 'Variable')
    ? query.orderBy.map((o) => (o.expression as Term.Variable).value)
    : [];

const orderKey = (b: Bindings, vars: ReadonlyArray<string>): string =>
  vars
    .map((v) => {
      const t = b.map.get(v);
      return t === undefined ? '' : t._tag === 'BlankNode' ? '_' : normalize(t).key;
    })
    .join('|');

/**
 * A SQL backend under test: `run` evaluates an effect against an empty store
 * whose query events go to `onQuery`.
 */
export interface Backend {
  /**
   * The minimum share of queries expected to run entirely in SQL (lower when
   * the database is shared between tests, as the comparison classes of all
   * data seen so far make the store more conservative).
   */
  readonly minRootShare: number;
  readonly run: <A, E>(
    f: (store: SqlStore.SqlStoreShape) => Effect.Effect<A, E>,
    onQuery: (event: SqlStore.QueryEvent) => void,
  ) => Promise<A>;
}

const runQueryTest = (store: SqlStore.SqlStoreShape, t: TestCase) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(t.query!, 'utf8');
    const baseIri = pathToFileURL(t.query!).href;
    const query = yield* Parser.parseQuery(text, { baseIri });
    const loaded = Dataset.fromIterable(loadQuads(t));
    yield* store.insert(Dataset.addAll(loaded, datasetClauseQuads(query, loaded)));
    const engine = Engine.make(store, { baseIri });
    const result = yield* engine.query(query);
    const expected = readExpected(t.result!);
    switch (result._tag) {
      case 'Ask':
        expect(Dataset.isDataset(expected) ? undefined : expected).toEqual({
          _tag: 'Boolean',
          value: result.value,
        });
        return;
      case 'Graph': {
        const quads = yield* Stream.runCollect(result.quads);
        const actual = Dataset.fromIterable(quads);
        const exp = expected as Dataset.Dataset;
        if (!Isomorphism.isomorphic(actual, exp)) {
          expect(Dataset.toNQuads(actual)).toBe(Dataset.toNQuads(exp));
        }
        return;
      }
      case 'Select': {
        const set = yield* Results.collect(result);
        let actual = set.bindings;
        const exp = (expected as Results.ResultSet).bindings;
        if (t.type === 'CSVResultFormatTest' || t.result!.endsWith('.csv')) {
          const csv = Results.Csv.serializeString(set);
          actual = ((yield* Results.Csv.parse(csv)) as Results.ResultSet).bindings;
        }
        const ok = sameResults(actual, exp, { lax: t.laxCardinality });
        if (!ok) {
          expect(actual.map((b) => b.toString()).sort()).toEqual(
            exp.map((b) => b.toString()).sort(),
          );
          expect.fail('Results differ only in blank node structure');
        }
        const vars = orderVariables(query);
        if (vars.length > 0 && !t.laxCardinality) {
          expect(actual.map((b) => orderKey(b, vars))).toEqual(exp.map((b) => orderKey(b, vars)));
        }
        return;
      }
    }
  });

const runUpdateTest = (store: SqlStore.SqlStoreShape, t: TestCase) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(t.query!, 'utf8');
    const baseIri = pathToFileURL(t.query!).href;
    yield* store.insert(loadQuads(t));
    const engine = Engine.make(store, { baseIri });
    const outcome = yield* Effect.result(engine.update(text));
    if (!t.updateSuccess) {
      expect(outcome._tag).toBe('Failure');
      return;
    }
    if (outcome._tag === 'Failure') return yield* Effect.fail(outcome.failure);
    const quads: Array<Term.Quad> = [];
    for (const file of t.resultData) quads.push(...parseFile(file));
    for (const g of t.resultGraphData) quads.push(...parseFile(g.file, Term.namedNode(g.name)));
    const expected = Dataset.fromIterable(quads);
    const actual = yield* Store.toDataset(store);
    if (!Isomorphism.isomorphic(actual, expected)) {
      expect(Dataset.toNQuads(actual)).toBe(Dataset.toNQuads(expected));
    }
  });

const tests = loadTests();

const label = (t: TestCase) => `${path.relative(sparqlDir, path.dirname(t.manifest))}: ${t.name}`;

/**
 * Registers the conformance suite for a backend.
 */
export const conformanceSuite = (name: string, backend: Backend): void => {
  /** How the root of each query was evaluated (`Executed` = entirely in SQL). */
  const outcomes = new Map<string, SqlStore.QueryEvent['_tag']>();
  /** The tests for which at least one subtree was evaluated in SQL. */
  const executed = new Set<string>();
  const run = (
    t: TestCase,
    f: (store: SqlStore.SqlStoreShape, t: TestCase) => Effect.Effect<void, unknown>,
  ) =>
    backend.run(
      (store) => f(store, t),
      (e) => {
        if (!outcomes.has(t.id)) outcomes.set(t.id, e._tag);
        if (e._tag === 'Executed') executed.add(t.id);
      },
    );
  describe.skipIf(!exists)(`SPARQL evaluation conformance (${name})`, () => {
    const runnable = tests.filter((t) => skipReason(t) === undefined);
    it('documents every skipped test', () => {
      const skippedTests = tests.filter((t) => skipReason(t) !== undefined);
      expect(skippedTests.every((t) => skipReason(t)!.length > 0)).toBe(true);
    });
    it.each(
      runnable.filter((t) => t.type !== 'UpdateEvaluationTest').map((t) => [label(t), t] as const),
    )(
      '%s',
      async (_, t) => {
        await run(t, runQueryTest);
      },
      20_000,
    );
    it.each(
      runnable.filter((t) => t.type === 'UpdateEvaluationTest').map((t) => [label(t), t] as const),
    )(
      '%s',
      async (_, t) => {
        await run(t, runUpdateTest);
      },
      20_000,
    );
    it('evaluates most queries in SQL', () => {
      const queries = runnable.filter((t) => t.type !== 'UpdateEvaluationTest');
      const root = queries.filter((t) => outcomes.get(t.id) === 'Executed').length;
      const some = runnable.filter((t) => executed.has(t.id)).length;
      // The whole query (the root of the algebra) runs as one SQL statement for
      // more than half of the queries (the rest use ORDER BY, property paths,
      // REGEX, arithmetic, … in the engine), and SQL evaluates subtrees of
      // nearly all tests.
      expect(root).toBeGreaterThan(queries.length * backend.minRootShare);
      expect(some).toBeGreaterThan(runnable.length * 0.85);
    });
  });
};
