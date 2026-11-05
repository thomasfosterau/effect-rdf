import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Str from 'effect/String';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Stream from 'effect/Stream';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import * as Ast from '../src/Ast.ts';
import type { Bindings } from '../src/Bindings.ts';
import * as Engine from '../src/Engine.ts';
import * as Parser from '../src/Parser.ts';
import * as Results from '../src/Results.ts';
import * as Store from '../src/Store.ts';
import { fromRdf, normalize, sameResults } from './support/compare.ts';
import {
  expectedResultFile,
  queryFile,
  readManifest,
  suitesDir,
  type TestCase,
} from './support/manifest.ts';
import { parseFile } from './support/rdf.ts';

const sparqlDir = path.join(suitesDir, 'rdf-tests', 'sparql');
const exists = fs.existsSync(sparqlDir);

/** Tests that are deliberately not run, with the reason. */
export const skipped: Readonly<Record<string, string>> = {};

const SKIPPED_DIRECTORIES = {
  'sparql11/service': 'SERVICE federation requires remote endpoints',
  'sparql11/entailment': 'Entailment regimes are not supported',
  'sparql11/protocol': 'Protocol tests belong to the HTTP server package',
  'sparql11/graph-store-protocol': 'Graph Store Protocol tests belong to the HTTP server package',
  'sparql11/http-rdf-update': 'Graph Store Protocol tests belong to the HTTP server package',
  'sparql11/service-description': 'Service descriptions belong to the HTTP server package',
} satisfies Readonly<Record<string, string>>;

const EVAL_TYPES = MutableHashSet.make(
  'QueryEvaluationTest',
  'UpdateEvaluationTest',
  'CSVResultFormatTest',
);

const manifests = ['sparql10/manifest.ttl', 'sparql11/manifest-all.ttl', 'sparql12/manifest.ttl'];

const loadTests = (): Array<TestCase> => {
  if (!exists) return [];
  const seen = MutableHashSet.empty<string>();
  return manifests
    .flatMap((m) => readManifest(path.join(sparqlDir, m)))
    .filter((t) => {
      if (!MutableHashSet.has(EVAL_TYPES, t.type) || MutableHashSet.has(seen, t.id)) return false;
      MutableHashSet.add(seen, t.id);
      return true;
    });
};

const skipReason = (t: TestCase): Option.Option<string> => {
  const rel = path.relative(sparqlDir, t.manifest);
  return Option.orElse(
    Option.map(
      Arr.findFirst(Record.toEntries(SKIPPED_DIRECTORIES), ([dir]) => rel.startsWith(`${dir}/`)),
      ([, reason]) => reason,
    ),
    () => Record.get(skipped, t.id),
  );
};

const loadDataset = (t: TestCase, update: boolean): Dataset.Dataset => {
  void update;
  return Dataset.fromIterable([
    ...t.data.flatMap((file) => parseFile(file)),
    ...t.graphData.flatMap((g) =>
      parseFile(g.file, Term.namedNode(g.name !== '' ? g.name : pathToFileURL(g.file).href)),
    ),
  ]);
};

/** Loads the graphs named in FROM / FROM NAMED clauses from files. */
const datasetClauseQuads = (query: Ast.Query, loaded: Dataset.Dataset): Array<Term.Quad> =>
  [...(query.dataset?.default ?? []), ...(query.dataset?.named ?? [])]
    .filter(
      (g) =>
        g.value.startsWith('file:') &&
        Arr.isReadonlyArrayEmpty(Dataset.match(loaded, { graph: g })) &&
        fs.existsSync(fileURLToPath(g.value)),
    )
    .flatMap((g) => parseFile(fileURLToPath(g.value), g));

const readExpected = (file: string): Results.ParsedResult | Dataset.Dataset => {
  const ext = file.slice(file.lastIndexOf('.') + 1);
  const text = fs.readFileSync(file, 'utf8');
  const codec = { srx: Results.Xml, srj: Results.Json, tsv: Results.Tsv, csv: Results.Csv }[ext];
  if (codec !== undefined) return Effect.runSync(codec.parse(text));
  const quads = parseFile(file);
  return fromRdf(quads) ?? Dataset.fromIterable(quads);
};

/** The `ORDER BY` variables, when every order key is a variable. */
const orderVariables = (query: Ast.Query): ReadonlyArray<string> =>
  query.orderBy.every((o) => Term.isVariable(o.expression))
    ? query.orderBy.flatMap((o) => (Term.isVariable(o.expression) ? [o.expression.value] : []))
    : [];

const orderKey = (b: Bindings, vars: ReadonlyArray<string>): string =>
  vars
    .map((v) => {
      const t = b.map.get(v);
      return t === undefined ? '' : Term.isBlankNode(t) ? '_' : normalize(t).key;
    })
    .join('|');

/** Fails with an N-Quads diff unless the graphs are isomorphic. */
const expectIsomorphic = (actual: Dataset.Dataset, expected: Dataset.Dataset): void => {
  const want = Dataset.toNQuads(expected);
  expect(Isomorphism.isomorphic(actual, expected) ? want : Dataset.toNQuads(actual)).toBe(want);
};

const rowStrings = (rows: ReadonlyArray<Bindings>): ReadonlyArray<string> =>
  Arr.sort(
    rows.map((b) => b.toString()),
    Order.String,
  );

/**
 * Fails unless the solutions match (as multisets, or as sets when `lax`), and
 * in `ORDER BY` order when the query has one and the test is not lax.
 */
const expectSameSolutions = (
  actual: ReadonlyArray<Bindings>,
  exp: ReadonlyArray<Bindings>,
  vars: ReadonlyArray<string>,
  lax: boolean,
): void => {
  const ok = sameResults(actual, exp, { lax });
  // On a mismatch, show the rows; equal rows differ only in blank nodes.
  expect(ok ? [] : rowStrings(actual)).toEqual(ok ? [] : rowStrings(exp));
  assert.isTrue(ok, 'Results differ only in blank node structure');
  if (Arr.isReadonlyArrayEmpty(vars) || lax) return;
  expect(actual.map((b) => orderKey(b, vars))).toEqual(exp.map((b) => orderKey(b, vars)));
};

const runQueryTest = (t: TestCase, optimize = true) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(queryFile(t), 'utf8');
    const baseIri = pathToFileURL(queryFile(t)).href;
    const query = yield* Parser.parseQuery(text, { baseIri });
    const loaded = loadDataset(t, false);
    const initial = Dataset.addAll(loaded, datasetClauseQuads(query, loaded));
    const store = yield* Store.makeMemory(initial);
    const engine = Engine.make(store, { baseIri, optimize });
    const result = yield* engine.query(query);
    const expected = readExpected(expectedResultFile(t));
    yield* Match.value(result).pipe(
      Match.tag('Ask', (ask) =>
        Effect.sync(() => {
          expect(Dataset.isDataset(expected) ? undefined : expected).toEqual({
            _tag: 'Boolean',
            value: ask.value,
          });
        }),
      ),
      Match.tag('Graph', (graph) =>
        Effect.map(Stream.runCollect(graph.quads), (quads) => {
          const actual = Dataset.fromIterable(quads);
          // A CONSTRUCT or DESCRIBE test's expected result is loaded as a dataset.
          assert(Dataset.isDataset(expected), 'expected a graph result');
          expectIsomorphic(actual, expected);
        }),
      ),
      Match.tag('Select', (select) =>
        Effect.gen(function* () {
          const set = yield* Results.collect(select);
          let actual = set.bindings;
          // A SELECT test's expected result is loaded as a result set.
          assert(Predicate.isTagged(expected, 'ResultSet'), 'expected a result set');
          let exp = expected.bindings;
          if (t.type === 'CSVResultFormatTest' || expectedResultFile(t).endsWith('.csv')) {
            // Round-trip our results through CSV, as CSV is lossy.
            const csv = Results.Csv.serializeString(set);
            const back = yield* Results.Csv.parse(csv);
            assert(Predicate.isTagged(back, 'ResultSet'), 'CSV results parse to a result set');
            actual = back.bindings;
          }
          if (expectedResultFile(t).endsWith('.tsv') || expectedResultFile(t).endsWith('.csv')) {
            exp = exp.map((b) => b);
          }
          expectSameSolutions(actual, exp, orderVariables(query), t.laxCardinality);
        }),
      ),
      Match.exhaustive,
    );
  });

const updateEngine = (t: TestCase) =>
  Effect.gen(function* () {
    const baseIri = pathToFileURL(queryFile(t)).href;
    const store = yield* Store.makeMemory(loadDataset(t, true));
    return { store, engine: Engine.make(store, { baseIri }) };
  });

const runFailingUpdateTest = (t: TestCase) =>
  Effect.gen(function* () {
    const { engine } = yield* updateEngine(t);
    const outcome = yield* Effect.result(engine.update(fs.readFileSync(queryFile(t), 'utf8')));
    expect(outcome._tag).toBe('Failure');
  });

const runUpdateTest = (t: TestCase) =>
  Effect.gen(function* () {
    const { store, engine } = yield* updateEngine(t);
    yield* engine.update(fs.readFileSync(queryFile(t), 'utf8'));
    const expected = Dataset.fromIterable([
      ...t.resultData.flatMap((file) => parseFile(file)),
      ...t.resultGraphData.flatMap((g) => parseFile(g.file, Term.namedNode(g.name))),
    ]);
    expectIsomorphic(yield* store.snapshot, expected);
  });

const tests = loadTests();

const label = (t: TestCase) => `${path.relative(sparqlDir, path.dirname(t.manifest))}: ${t.name}`;

describe.skipIf(!exists)('SPARQL evaluation conformance', () => {
  const runnable = tests.filter((t) => Option.isNone(skipReason(t)));
  it('documents every skipped test', () => {
    const skippedTests = tests.filter((t) => Option.isSome(skipReason(t)));
    // Skipped: SERVICE federation, entailment regimes and protocol tests.
    expect(skippedTests.every((t) => Option.exists(skipReason(t), Str.isNonEmpty))).toBe(true);
  });
  it.each(
    runnable.filter((t) => t.type !== 'UpdateEvaluationTest').map((t) => [label(t), t] as const),
  )(
    '%s',
    async (_, t) => {
      expect(await Effect.runPromise(Effect.as(runQueryTest(t), true))).toBe(true);
      // The optimizer must not change results.
      expect(await Effect.runPromise(Effect.as(runQueryTest(t, false), true))).toBe(true);
    },
    20_000,
  );
  it.each(
    runnable.filter((t) => t.type === 'UpdateEvaluationTest').map((t) => [label(t), t] as const),
  )(
    '%s',
    async (_, t) => {
      const run = t.updateSuccess ? runUpdateTest(t) : runFailingUpdateTest(t);
      expect(await Effect.runPromise(Effect.as(run, true))).toBe(true);
    },
    20_000,
  );
});
