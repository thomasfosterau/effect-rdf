/**
 * W3C SHACL test suite (data-shapes-test-suite) with the SHACL-SPARQL
 * evaluator: runs the `sparql/` tests (SPARQL-based constraints, constraint
 * components and pre-binding) and, to check that the evaluator does not
 * change Core results, every Core test too. Reports are compared on the
 * `sh:conforms` flag and the multiset of results matched on focusNode /
 * resultPath / value / sourceShape / sourceConstraintComponent / severity
 * (and expected `sh:resultMessage`s), ignoring blank node identity.
 */
import { describe, expect, it } from '@effect/vitest';
import { Dataset, Term, Vocab } from '@thomasfosterau/effect-rdf';
import { Path, ValidationReport, Validator } from '@thomasfosterau/effect-shacl';
import { Turtle } from '@thomasfosterau/effect-turtle';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Evaluator } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const suites = process.env['RDF_TEST_SUITES'] ?? resolve(here, '../../../.test-suites');
const root = resolve(suites, 'data-shapes/data-shapes-test-suite/tests');
const exists = existsSync(resolve(root, 'manifest.ttl'));

const mf = (local: string) =>
  Term.namedNode(`http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#${local}`);
const sht = (local: string) => Term.namedNode(`http://www.w3.org/ns/shacl-test#${local}`);
const { rdf } = Vocab;

interface TestCase {
  readonly name: string;
  readonly ds: Dataset.Dataset;
  readonly node: Term.Subject;
}

const loaded = new Map<string, Dataset.Dataset>();
const load = (iri: string): Dataset.Dataset => {
  const file = fileURLToPath(iri.split('#')[0]!);
  let ds = loaded.get(file);
  if (ds === undefined) {
    ds = Effect.runSync(
      Turtle.parse(readFileSync(file, 'utf8'), { baseIri: pathToFileURL(file).href }),
    ).dataset;
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
      out.push({ name, ds, node: entry as Term.Subject });
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
    const data = load((one(action, sht('dataGraph')) as Term.NamedNode).value);
    const shapes = load((one(action, sht('shapesGraph')) as Term.NamedNode).value);
    const expectedNode = one(tc.node, mf('result'))!;

    const exit = yield* Effect.exit(
      Validator.validate(data, shapes).pipe(Effect.provide(Evaluator.layer())),
    );
    if (expectedNode.key === sht('Failure').key) {
      expect(Exit.isFailure(exit)).toBe(true);
      return;
    }
    if (Exit.isFailure(exit)) throw new Error(`validation failed: ${String(exit.cause)}`);
    const actual = exit.value;

    const expectedResult = ValidationReport.fromDataset(tc.ds, expectedNode as Term.BlankNode);
    if (Result.isFailure(expectedResult)) throw new Error(expectedResult.failure.message);
    const expected = expectedResult.success;

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
      optMatches(e.sourceConstraint, a.sourceConstraint, termMatches) &&
      e.severity.key === a.severity.key &&
      optMatches(e.value, a.value, termMatches) &&
      optMatches(e.resultPath, a.resultPath, Path.equals) &&
      e.messages.every((m) => a.messages.some((n) => n.key === m.key));

    const describeResults = (rs: ReadonlyArray<ValidationReport.ValidationResult>) =>
      ValidationReport.format({ _tag: 'ValidationReport', conforms: rs.length === 0, results: rs });

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
    const ok =
      actual.conforms === expected.conforms &&
      actual.results.length === expected.results.length &&
      match(0);
    expect(
      ok
        ? 'match'
        : `expected (conforms=${expected.conforms}):\n${describeResults(expected.results)}\nactual (conforms=${actual.conforms}):\n${describeResults(actual.results)}`,
    ).toBe('match');
  });

const validateCases = cases.filter(
  (tc) => Dataset.objectsOf(tc.ds, tc.node, rdf.type)[0]?.key === sht('Validate').key,
);
const sparqlCases = validateCases.filter((tc) => tc.name.startsWith('sparql/'));
const coreCases = validateCases.filter((tc) => !tc.name.startsWith('sparql/'));

describe.skipIf(!exists)('SHACL-SPARQL test suite', () => {
  it('finds the SHACL-SPARQL tests', () => {
    expect(sparqlCases.length).toBe(22);
  });
  for (const tc of sparqlCases) it.effect(tc.name, () => runCase(tc));
});

describe.skipIf(!exists)('SHACL Core test suite with the SPARQL evaluator', () => {
  for (const tc of coreCases) it.effect(tc.name, () => runCase(tc));
});
