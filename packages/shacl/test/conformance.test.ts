/**
 * W3C SHACL test suite (data-shapes-test-suite). Runs every `sht:Validate`
 * entry of the core manifests and compares the produced report with the
 * expected one: the `sh:conforms` flag and the multiset of results matched on
 * focusNode / resultPath / value / sourceShape / sourceConstraintComponent /
 * severity (and expected `sh:resultMessage`s), ignoring blank node identity.
 *
 * SHACL-SPARQL tests (the `sparql/` folder) are skipped here: SPARQL
 * constraints require a `Sparql.SparqlConstraintEvaluator`, provided by
 * `@thomasfosterau/effect-shacl-sparql`, whose conformance test runs them.
 */
import { assert, describe, expect, it } from '@effect/vitest';
import { Dataset, Term, Vocab } from '@thomasfosterau/effect-rdf';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Path, ValidationReport, Validator } from '../src/index.ts';
import { parseTurtle } from './utils/turtle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const suites = process.env['RDF_TEST_SUITES'] ?? resolve(here, '../../../.test-suites');
const root = resolve(suites, 'data-shapes/data-shapes-test-suite/tests');
const exists = existsSync(resolve(root, 'manifest.ttl'));

const mf = (local: string) =>
  Term.namedNode(`http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#${local}`);
const sht = (local: string) => Term.namedNode(`http://www.w3.org/ns/shacl-test#${local}`);
const { rdf } = Vocab;

/** Tests deliberately not run, with the reason. */
const skipList: ReadonlyMap<string, string> = new Map([
  // Every test under sparql/ is skipped (see below); nothing in core is skipped.
]);

interface TestCase {
  readonly name: string;
  readonly manifest: string;
  readonly ds: Dataset.Dataset;
  readonly node: Term.Subject;
}

const loaded = new Map<string, Dataset.Dataset>();
const load = (iri: string): Dataset.Dataset => {
  const file = fileURLToPath(iri.split('#')[0]!);
  let ds = loaded.get(file);
  if (ds === undefined) {
    ds = parseTurtle(readFileSync(file, 'utf8'), pathToFileURL(file).href);
    loaded.set(file, ds);
  }
  return ds;
};

const collect = (manifestIri: string, out: Array<TestCase>) => {
  const ds = load(manifestIri);
  const self = Term.namedNode(manifestIri);
  for (const inc of Dataset.objectsOf(ds, self, mf('include'))) {
    collect((inc as Term.NamedNode).value, out);
  }
  for (const list of Dataset.objectsOf(ds, self, mf('entries'))) {
    for (const entry of Option.getOrElse(Dataset.list(ds, list), () => [])) {
      const name = (entry as Term.NamedNode).value.slice(pathToFileURL(root).href.length + 1);
      out.push({ name, manifest: manifestIri, ds, node: entry as Term.Subject });
    }
  }
};

const cases: Array<TestCase> = [];
if (exists) collect(pathToFileURL(resolve(root, 'manifest.ttl')).href, cases);

const blankKeys = (ds: Dataset.Dataset): Set<string> => {
  const out = new Set<string>();
  for (const q of ds) {
    if (q.subject._tag === 'BlankNode') out.add(q.subject.key);
    if (q.object._tag === 'BlankNode') out.add(q.object.key);
  }
  return out;
};

const runCase = (tc: TestCase) =>
  Effect.gen(function* () {
    const one = (s: Term.Term, p: Term.NamedNode) =>
      Dataset.objectsOf(tc.ds, s as Term.Subject, p)[0];
    const action = one(tc.node, mf('action'))!;
    const dataIri = one(action, sht('dataGraph')) as Term.NamedNode;
    const shapesIri = one(action, sht('shapesGraph')) as Term.NamedNode;
    const data = load(dataIri.value);
    const shapes = load(shapesIri.value);
    const expectedNode = one(tc.node, mf('result'))!;

    const exit = yield* Effect.exit(Validator.validate(data, shapes));
    const expectsFailure = expectedNode.key === sht('Failure').key;
    expect(expectsFailure ? Exit.isFailure(exit) : true).toBe(true);
    if (expectsFailure) return;
    if (Exit.isFailure(exit)) assert.fail(`validation failed: ${String(exit.cause)}`);
    const actual = exit.value;

    const expectedResult = ValidationReport.fromDataset(tc.ds, expectedNode as Term.BlankNode);
    if (Result.isFailure(expectedResult)) assert.fail(expectedResult.failure.message);
    const expected = expectedResult.success;

    // Actual reports must also round-trip through RDF.
    const roundTrip = ValidationReport.fromDataset(ValidationReport.toDataset(actual));
    expect(Result.isSuccess(roundTrip)).toBe(true);

    const known = new Set([...blankKeys(data), ...blankKeys(shapes)]);
    const termMatches = (e: Term.Term, a: Term.Term) =>
      e._tag === 'BlankNode' && a._tag === 'BlankNode' && !known.has(e.key)
        ? true
        : e.key === a.key;
    const optMatches = <A>(e: Option.Option<A>, a: Option.Option<A>, f: (x: A, y: A) => boolean) =>
      Option.isNone(e) ? Option.isNone(a) : Option.isSome(a) && f(e.value, a.value);
    const resultMatches = (
      e: ValidationReport.ValidationResult,
      a: ValidationReport.ValidationResult,
    ) =>
      termMatches(e.focusNode, a.focusNode) &&
      termMatches(e.sourceShape, a.sourceShape) &&
      e.sourceConstraintComponent.key === a.sourceConstraintComponent.key &&
      e.severity.key === a.severity.key &&
      optMatches(e.value, a.value, termMatches) &&
      optMatches(e.resultPath, a.resultPath, Path.equals) &&
      e.messages.every((m) => a.messages.some((n) => n.key === m.key));

    const describeResults = (rs: ReadonlyArray<ValidationReport.ValidationResult>) =>
      ValidationReport.format({
        _tag: 'ValidationReport',
        conforms: Arr.isReadonlyArrayEmpty(rs),
        results: rs,
      });

    // Backtracking bipartite matching of expected to actual results.
    const used = new Set<number>();
    const match = (i: number): boolean => {
      if (i === expected.results.length) return true;
      for (let j = 0; j < actual.results.length; j++) {
        if (used.has(j) || !resultMatches(expected.results[i]!, actual.results[j]!)) continue;
        used.add(j);
        if (match(i + 1)) return true;
        used.delete(j);
      }
      return false;
    };
    const summary = (ok: boolean) =>
      ok
        ? 'match'
        : `expected (conforms=${expected.conforms}):\n${describeResults(expected.results)}\nactual (conforms=${actual.conforms}):\n${describeResults(actual.results)}`;
    expect(
      summary(
        actual.conforms === expected.conforms &&
          actual.results.length === expected.results.length &&
          match(0),
      ),
    ).toBe('match');
  });

const classify = (tc: TestCase): string | undefined => {
  const type = Dataset.objectsOf(tc.ds, tc.node, rdf.type)[0];
  return tc.name.startsWith('sparql/')
    ? 'SHACL-SPARQL needs a SparqlConstraintEvaluator; run by @thomasfosterau/effect-shacl-sparql'
    : type?.key !== sht('Validate').key
      ? `unsupported test type ${type?.key}`
      : skipList.get(tc.name);
};
const runnable = cases.filter((tc) => classify(tc) === undefined);
const skipped = cases.flatMap((tc) => {
  const reason = classify(tc);
  return reason === undefined ? [] : [{ tc, reason }];
});

describe.skipIf(!exists)('SHACL test suite', () => {
  for (const tc of runnable) it.effect(tc.name, () => runCase(tc));
  for (const { tc, reason } of skipped) {
    // oxlint-disable-next-line vitest/no-disabled-tests -- deliberately skipped, see reason
    it.skip(`${tc.name} (skipped: ${reason})`, () => {});
  }
});
