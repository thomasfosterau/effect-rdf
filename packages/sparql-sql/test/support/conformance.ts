/**
 * A W3C SPARQL evaluation test harness (SPARQL 1.0, 1.1, 1.2) for SQL
 * backends: data is loaded into an empty store, and the engine evaluates
 * queries and updates through the store's SPARQL-to-SQL translation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, describe, expect, it } from '@effect/vitest';
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as Str from 'effect/String';
import * as Effect from 'effect/Effect';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Rec from 'effect/Record';
import * as Result from 'effect/Result';
import * as Stream from 'effect/Stream';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import type * as Ast from '@thomasfosterau/effect-sparql/Ast';
import type { Bindings } from '@thomasfosterau/effect-sparql/Bindings';
import * as Engine from '@thomasfosterau/effect-sparql/Engine';
import * as Parser from '@thomasfosterau/effect-sparql/Parser';
import * as Results from '@thomasfosterau/effect-sparql/Results';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import type * as SqlStore from '../../src/SqlStore.ts';
import { fromRdf, normalize, sameResults } from '../../../sparql/test/support/compare.ts';
import {
  expectedResultFile,
  queryFile,
  readManifest,
  suitesDir,
  type TestCase,
} from '../../../sparql/test/support/manifest.ts';
import { parseFile } from '../../../sparql/test/support/rdf.ts';

const sparqlDir = path.join(suitesDir, 'rdf-tests', 'sparql');
const exists = fs.existsSync(sparqlDir);

/** Tests that are deliberately not run, with the reason. */
const skipped: Readonly<Record<string, string>> = {};

const SKIPPED_DIRECTORIES: ReadonlyArray<readonly [string, string]> = [
  ['sparql11/service', 'SERVICE federation requires remote endpoints'],
  ['sparql11/entailment', 'Entailment regimes are not supported'],
  ['sparql11/protocol', 'Protocol tests belong to the HTTP server package'],
  ['sparql11/graph-store-protocol', 'Graph Store Protocol tests belong to the HTTP server package'],
  ['sparql11/http-rdf-update', 'Graph Store Protocol tests belong to the HTTP server package'],
  ['sparql11/service-description', 'Service descriptions belong to the HTTP server package'],
];

const EVAL_TYPES = MutableHashSet.make(
  'QueryEvaluationTest',
  'UpdateEvaluationTest',
  'CSVResultFormatTest',
);

const manifests = ['sparql10/manifest.ttl', 'sparql11/manifest-all.ttl', 'sparql12/manifest.ttl'];

const loadTests = (): Array<TestCase> => {
  if (!exists) return [];
  const seen = MutableHashSet.empty<string>();
  return manifests.flatMap((m) =>
    readManifest(path.join(sparqlDir, m)).filter((t) => {
      if (!MutableHashSet.has(EVAL_TYPES, t.type) || MutableHashSet.has(seen, t.id)) return false;
      MutableHashSet.add(seen, t.id);
      return true;
    }),
  );
};

const skipReason = (t: TestCase): Option.Option<string> => {
  const rel = path.relative(sparqlDir, t.manifest);
  return Arr.findFirst(SKIPPED_DIRECTORIES, ([dir]) => rel.startsWith(`${dir}/`)).pipe(
    Option.map(([, reason]) => reason),
    Option.orElse(() => Rec.get(skipped, t.id)),
  );
};

/** Asserts isomorphism, showing both graphs as N-Quads when they differ. */
const expectIsomorphic = (actual: Dataset.Dataset, expected: Dataset.Dataset): void => {
  const same = Isomorphism.isomorphic(actual, expected);
  expect(same ? '' : Dataset.toNQuads(actual)).toBe(same ? '' : Dataset.toNQuads(expected));
};

const expectFailure = (outcome: { readonly _tag: 'Success' | 'Failure' }): void => {
  expect(outcome._tag).toBe('Failure');
};

const loadQuads = (t: TestCase): Array<Term.Quad> => [
  ...t.data.flatMap((file) => parseFile(file)),
  ...t.graphData.flatMap((g) =>
    parseFile(g.file, Term.namedNode(g.name !== '' ? g.name : pathToFileURL(g.file).href)),
  ),
];

/** Loads the graphs named in FROM / FROM NAMED clauses from files. */
const datasetClauseQuads = (query: Ast.Query, loaded: Dataset.Dataset): Array<Term.Quad> => {
  const graphs = [...(query.dataset?.default ?? []), ...(query.dataset?.named ?? [])];
  return graphs.flatMap((g) => {
    if (
      !g.value.startsWith('file:') ||
      Arr.isReadonlyArrayNonEmpty(Dataset.match(loaded, { graph: g }))
    )
      return [];
    const file = fileURLToPath(g.value);
    return fs.existsSync(file) ? parseFile(file, g) : [];
  });
};

const readExpected = (file: string): Results.ParsedResult | Dataset.Dataset => {
  const ext = file.slice(file.lastIndexOf('.') + 1);
  const text = fs.readFileSync(file, 'utf8');
  const codec = { srx: Results.Xml, srj: Results.Json, tsv: Results.Tsv, csv: Results.Csv }[ext];
  if (codec !== undefined) return Effect.runSync(codec.parse(text));
  const quads = parseFile(file);
  return fromRdf(quads) ?? Dataset.fromIterable(quads);
};

/** The variables of the order keys, when every key is a variable. */
const orderVariables = (query: Ast.Query): ReadonlyArray<string> => {
  const vars = Arr.filterMap(query.orderBy, (o) =>
    Term.isVariable(o.expression) ? Result.succeed(o.expression.value) : Result.failVoid,
  );
  return vars.length === query.orderBy.length ? vars : [];
};

const orderKey = (b: Bindings, vars: ReadonlyArray<string>): string =>
  vars
    .map((v) => {
      const t = b.map.get(v);
      return t === undefined ? '' : Term.isBlankNode(t) ? '_' : normalize(t).key;
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
    const text = fs.readFileSync(queryFile(t), 'utf8');
    const baseIri = pathToFileURL(queryFile(t)).href;
    const query = yield* Parser.parseQuery(text, { baseIri });
    const loaded = Dataset.fromIterable(loadQuads(t));
    yield* store.insert(Dataset.addAll(loaded, datasetClauseQuads(query, loaded)));
    const engine = Engine.make(store, { baseIri });
    const answer = yield* engine.query(query);
    const expected = readExpected(expectedResultFile(t));
    return yield* Match.value(answer).pipe(
      Match.tag('Ask', (result) =>
        Effect.sync(() => {
          expect(Dataset.isDataset(expected) ? undefined : expected).toEqual({
            _tag: 'Boolean',
            value: result.value,
          });
        }),
      ),
      Match.tag('Graph', (result) =>
        Effect.gen(function* () {
          const quads = yield* Stream.runCollect(result.quads);
          const actual = Dataset.fromIterable(quads);
          // A CONSTRUCT or DESCRIBE test's expected result is a graph.
          assert(Dataset.isDataset(expected), 'Expected a graph result');
          return expectIsomorphic(actual, expected);
        }),
      ),
      Match.tag('Select', (result) =>
        Effect.gen(function* () {
          const set = yield* Results.collect(result);
          let actual = set.bindings;
          // A SELECT test's expected result is a result set.
          assert(Predicate.isTagged(expected, 'ResultSet'), 'Expected a result set');
          const exp = expected.bindings;
          if (t.type === 'CSVResultFormatTest' || expectedResultFile(t).endsWith('.csv')) {
            const csv = Results.Csv.serializeString(set);
            // The CSV serialization of a result set parses back to a result set.
            const parsed = yield* Results.Csv.parse(csv);
            assert(
              Predicate.isTagged(parsed, 'ResultSet'),
              'CSV results did not parse to a result set',
            );
            actual = parsed.bindings;
          }
          const ok = sameResults(actual, exp, { lax: t.laxCardinality });
          // On a mismatch, show the sorted rows; equal rows that still differ
          // differ only in blank node structure.
          const sorted = (rows: ReadonlyArray<Bindings>) =>
            ok
              ? []
              : Arr.sort(
                  rows.map((b) => b.toString()),
                  Order.String,
                );
          expect(sorted(actual)).toEqual(sorted(exp));
          assert(ok, 'Results differ only in blank node structure');
          // Ordered queries also agree on the order of the solutions.
          const vars = orderVariables(query);
          const ordered = Arr.isReadonlyArrayNonEmpty(vars) && !t.laxCardinality;
          const order = (rows: ReadonlyArray<Bindings>) =>
            ordered ? rows.map((b) => orderKey(b, vars)) : [];
          expect(order(actual)).toEqual(order(exp));
        }),
      ),
      Match.exhaustive,
    );
  });

const runUpdateTest = (store: SqlStore.SqlStoreShape, t: TestCase) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(queryFile(t), 'utf8');
    const baseIri = pathToFileURL(queryFile(t)).href;
    yield* store.insert(loadQuads(t));
    const engine = Engine.make(store, { baseIri });
    const outcome = yield* Effect.result(engine.update(text));
    // A negative update test passes when the update fails.
    if (!t.updateSuccess) return expectFailure(outcome);
    if (Result.isFailure(outcome)) return yield* outcome.failure;
    const expected = Dataset.fromIterable([
      ...t.resultData.flatMap((file) => parseFile(file)),
      ...t.resultGraphData.flatMap((g) => parseFile(g.file, Term.namedNode(g.name))),
    ]);
    const actual = yield* Store.toDataset(store);
    return expectIsomorphic(actual, expected);
  });

const tests = loadTests();

const label = (t: TestCase) => `${path.relative(sparqlDir, path.dirname(t.manifest))}: ${t.name}`;

/**
 * Registers the conformance suite for a backend.
 */
export const conformanceSuite = (name: string, backend: Backend): void => {
  /** How the root of each query was evaluated (`Executed` = entirely in SQL). */
  const outcomes = MutableHashMap.empty<string, SqlStore.QueryEvent['_tag']>();
  /** The tests for which at least one subtree was evaluated in SQL. */
  const executed = MutableHashSet.empty<string>();
  const run = <E>(
    t: TestCase,
    f: (store: SqlStore.SqlStoreShape, t: TestCase) => Effect.Effect<void, E>,
  ) =>
    backend.run(
      (store) => f(store, t),
      (e) => {
        if (!MutableHashMap.has(outcomes, t.id)) MutableHashMap.set(outcomes, t.id, e._tag);
        if (Predicate.isTagged(e, 'Executed')) MutableHashSet.add(executed, t.id);
      },
    );
  describe.skipIf(!exists)(`SPARQL evaluation conformance (${name})`, () => {
    const runnable = tests.filter((t) => Option.isNone(skipReason(t)));
    it('documents every skipped test', () => {
      const skippedTests = tests.filter((t) => Option.isSome(skipReason(t)));
      expect(skippedTests.every((t) => Option.exists(skipReason(t), Str.isNonEmpty))).toBe(true);
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
      const root = queries.filter((t) =>
        Option.exists(MutableHashMap.get(outcomes, t.id), (o) => o === 'Executed'),
      ).length;
      const some = runnable.filter((t) => MutableHashSet.has(executed, t.id)).length;
      // The whole query (the root of the algebra) runs as one SQL statement for
      // more than half of the queries (the rest use ORDER BY, property paths,
      // REGEX, arithmetic, … in the engine), and SQL evaluates subtrees of
      // nearly all tests.
      expect(root).toBeGreaterThan(queries.length * backend.minRootShare);
      expect(some).toBeGreaterThan(runnable.length * 0.85);
    });
  });
};
