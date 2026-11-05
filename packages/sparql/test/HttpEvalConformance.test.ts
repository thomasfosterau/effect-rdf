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
import { assert, describe, expect, it } from '@effect/vitest';
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as HashSet from 'effect/HashSet';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Str from 'effect/String';
import * as Order from 'effect/Order';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import {
  type Ast,
  type Bindings,
  Parser,
  Results,
  SparqlServer,
  Store,
  Testing,
} from '../src/index.ts';
import * as SparqlClient from '../src/SparqlClient.ts';
import { fromRdf, normalize, sameResults } from './support/compare.ts';
import { expectedResultFile, queryFile, readManifest, type TestCase } from './support/manifest.ts';
import { withLayer } from './support/layer.ts';
import { parseFile } from './support/rdf.ts';

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

const EVAL_TYPES = HashSet.make(
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
      if (!HashSet.has(EVAL_TYPES, t.type) || MutableHashSet.has(seen, t.id)) return false;
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
    () => Record.get(SKIPPED, t.id),
  );
};

const loadDataset = (t: TestCase, query?: Ast.Query): Dataset.Dataset => {
  const quads = [
    ...t.data.flatMap((file) => parseFile(file)),
    ...t.graphData.flatMap((g) =>
      parseFile(g.file, Term.namedNode(g.name !== '' ? g.name : pathToFileURL(g.file).href)),
    ),
  ];
  const loaded = Dataset.fromIterable(quads);
  // Graphs named in FROM / FROM NAMED are loaded from files.
  const graphs = [...(query?.dataset?.default ?? []), ...(query?.dataset?.named ?? [])];
  const fromFiles = graphs.flatMap((g) => {
    if (
      !g.value.startsWith('file:') ||
      Arr.isReadonlyArrayNonEmpty(Dataset.match(loaded, { graph: g }))
    )
      return [];
    const file = fileURLToPath(g.value);
    return fs.existsSync(file) ? parseFile(file, g) : [];
  });
  return Dataset.fromIterable([...quads, ...fromFiles]);
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
      return t === undefined ? '' : Term.isBlankNode(t) ? '_' : normalize(t).key;
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
const orderVariables = (query: Ast.Query): ReadonlyArray<string> => {
  const vars = Arr.filterMap(query.orderBy, (o) =>
    Term.isVariable(o.expression) ? Result.succeed(o.expression.value) : Result.failVoid,
  );
  return vars.length === query.orderBy.length ? vars : [];
};

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
  if (Arr.isReadonlyArrayEmpty(vars) || lax) return;
  expect(actual.map((b) => orderKey(b, vars))).toEqual(exp.map((b) => orderKey(b, vars)));
};

const runQueryTest = (t: TestCase, accept: string) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(queryFile(t), 'utf8');
    const baseIri = pathToFileURL(queryFile(t)).href;
    const parsed = yield* Parser.parseQuery(text, { baseIri });
    const expected = readExpected(expectedResultFile(t));
    yield* Effect.gen(function* () {
      const client = yield* SparqlClient.SparqlClient;
      return yield* Match.value(parsed).pipe(
        Match.tag('Ask', () =>
          Effect.gen(function* () {
            const value = yield* client.ask(text);
            expect(expected).toEqual({ _tag: 'Boolean', value });
            return;
          }),
        ),
        Match.tag('Construct', 'Describe', () =>
          Effect.gen(function* () {
            const actual = yield* client.constructDataset(text);
            // A CONSTRUCT or DESCRIBE test's expected result was loaded as a dataset.
            assert(Dataset.isDataset(expected), 'Expected a dataset');
            expectIsomorphic(actual, expected);
            return;
          }),
        ),
        Match.tag('Select', (query) =>
          Effect.gen(function* () {
            const set = yield* client.selectAll(text);
            let actual = set.bindings;
            if (t.type === 'CSVResultFormatTest' || expectedResultFile(t).endsWith('.csv')) {
              const csv = Results.Csv.serializeString(set);
              // The CSV serialization of a result set parses back to a result set.
              const reparsed = yield* Results.Csv.parse(csv);
              assert(Predicate.isTagged(reparsed, 'ResultSet'), 'Expected a result set');
              actual = reparsed.bindings;
            }
            // A SELECT test's expected result was loaded as a result set.
            assert(
              !Dataset.isDataset(expected) && Predicate.isTagged(expected, 'ResultSet'),
              'Expected a result set',
            );
            expectSameSolutions(actual, expected.bindings, orderVariables(query), t.laxCardinality);
            return;
          }),
        ),
        Match.exhaustive,
      );
    }).pipe(withLayer(clientLayer(loadDataset(t, parsed), baseIri, accept)));
  });

const runUpdateTest = (t: TestCase) =>
  Effect.gen(function* () {
    const text = fs.readFileSync(queryFile(t), 'utf8');
    const baseIri = pathToFileURL(queryFile(t)).href;
    yield* Effect.gen(function* () {
      const client = yield* SparqlClient.SparqlClient;
      const outcome = yield* Effect.result(client.update(text));
      expect(t.updateSuccess ? 'Failure' : outcome._tag).toBe('Failure');
      if (!t.updateSuccess) return;
      yield* Effect.fromResult(outcome);
      const expected = Dataset.fromIterable([
        ...t.resultData.flatMap((file) => parseFile(file)),
        ...t.resultGraphData.flatMap((g) => parseFile(g.file, Term.namedNode(g.name))),
      ]);
      const actual = yield* Store.toDataset(yield* Store.QuadStore);
      const isomorphic = Isomorphism.isomorphic(actual, expected);
      expect(isomorphic ? '' : Dataset.toNQuads(actual)).toBe(
        isomorphic ? '' : Dataset.toNQuads(expected),
      );
    }).pipe(withLayer(clientLayer(loadDataset(t), baseIri, FORMATS[0])));
  });

const tests = loadTests();
const label = (t: TestCase) => `${path.relative(sparqlDir, path.dirname(t.manifest))}: ${t.name}`;

describe.skipIf(!exists)('SPARQL evaluation conformance over HTTP (client ↔ server)', () => {
  const runnable = tests.filter((t) => Option.isNone(skipReason(t)));
  it('runs every evaluation test outside the skipped directories', () => {
    expect(
      tests
        .filter((t) => Option.isSome(skipReason(t)))
        .every((t) => Str.isNonEmpty(Option.getOrElse(skipReason(t), () => ''))),
    ).toBe(true);
    expect(runnable.length).toBeGreaterThan(600);
  });
  it.each(
    runnable.filter((t) => t.type !== 'UpdateEvaluationTest').map((t) => [label(t), t] as const),
  )(
    '%s',
    async (_, t) => {
      // One format at a time, as the loop this replaced did.
      const passed = await Effect.runPromise(
        Effect.as(
          Effect.forEach(FORMATS, (accept) => runQueryTest(t, accept), {
            concurrency: 1,
            discard: true,
          }),
          true,
        ),
      );
      expect(passed).toBe(true);
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
