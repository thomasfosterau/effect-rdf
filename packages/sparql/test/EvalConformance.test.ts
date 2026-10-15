import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import * as Ast from '../src/Ast.ts';
import type { Bindings } from '../src/Bindings.ts';
import * as Engine from '../src/Engine.ts';
import * as Parser from '../src/Parser.ts';
import * as Results from '../src/Results.ts';
import * as Store from '../src/Store.ts';
import { fromRdf, normalize, sameResults } from './support/compare.ts';
import { readManifest, suitesDir, type TestCase } from './support/manifest.ts';
import { parseFile } from './support/rdf.ts';

const sparqlDir = path.join(suitesDir, 'rdf-tests', 'sparql');
const exists = fs.existsSync(sparqlDir);

/** Tests that are deliberately not run, with the reason. */
export const skipped: Readonly<Record<string, string>> = {};

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

const loadDataset = (t: TestCase, update: boolean): Dataset.Dataset => {
  const quads: Array<Term.Quad> = [];
  for (const file of t.data) quads.push(...parseFile(file));
  for (const g of t.graphData) {
    const name = g.name !== '' ? g.name : pathToFileURL(g.file).href;
    void update;
    quads.push(...parseFile(g.file, Term.namedNode(name)));
  }
  return Dataset.fromIterable(quads);
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

const runQueryTest = (t: TestCase) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(t.query!, 'utf8');
    const baseIri = pathToFileURL(t.query!).href;
    const query = yield* Parser.parseQuery(text, { baseIri });
    const loaded = loadDataset(t, false);
    const initial = Dataset.addAll(loaded, datasetClauseQuads(query, loaded));
    const store = yield* Store.makeMemory(initial);
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
        let exp = (expected as Results.ResultSet).bindings;
        if (t.type === 'CSVResultFormatTest' || t.result!.endsWith('.csv')) {
          // Round-trip our results through CSV, as CSV is lossy.
          const csv = Results.Csv.serializeString(set);
          actual = ((yield* Results.Csv.parse(csv)) as Results.ResultSet).bindings;
        }
        if (t.result!.endsWith('.tsv') || t.result!.endsWith('.csv')) {
          exp = exp.map((b) => b);
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

const runUpdateTest = (t: TestCase) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(t.query!, 'utf8');
    const baseIri = pathToFileURL(t.query!).href;
    const store = yield* Store.makeMemory(loadDataset(t, true));
    const engine = Engine.make(store, { baseIri });
    const outcome = yield* Effect.result(engine.update(text));
    if (!t.updateSuccess) {
      expect(outcome._tag).toBe('Failure');
      return;
    }
    if (outcome._tag === 'Failure') throw outcome.failure;
    const quads: Array<Term.Quad> = [];
    for (const file of t.resultData) quads.push(...parseFile(file));
    for (const g of t.resultGraphData) quads.push(...parseFile(g.file, Term.namedNode(g.name)));
    const expected = Dataset.fromIterable(quads);
    const actual = yield* store.snapshot;
    if (!Isomorphism.isomorphic(actual, expected)) {
      expect(Dataset.toNQuads(actual)).toBe(Dataset.toNQuads(expected));
    }
  });

const tests = loadTests();

const label = (t: TestCase) => `${path.relative(sparqlDir, path.dirname(t.manifest))}: ${t.name}`;

describe.skipIf(!exists)('SPARQL evaluation conformance', () => {
  const runnable = tests.filter((t) => skipReason(t) === undefined);
  it('documents every skipped test', () => {
    const skippedTests = tests.filter((t) => skipReason(t) !== undefined);
    // Skipped: SERVICE federation, entailment regimes and protocol tests.
    expect(skippedTests.every((t) => skipReason(t)!.length > 0)).toBe(true);
  });
  it.each(
    runnable.filter((t) => t.type !== 'UpdateEvaluationTest').map((t) => [label(t), t] as const),
  )(
    '%s',
    async (_, t) => {
      expect(await Effect.runPromise(Effect.as(runQueryTest(t), true))).toBe(true);
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
