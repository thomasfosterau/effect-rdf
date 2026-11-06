/**
 * W3C SHACL test suite (data-shapes-test-suite) with the SHACL-SPARQL
 * evaluator: runs the `sparql/` tests (SPARQL-based constraints, constraint
 * components and pre-binding) and, to check that the evaluator does not
 * change Core results, every Core test too. Reports are compared on the
 * `sh:conforms` flag and the multiset of results matched on focusNode /
 * resultPath / value / sourceShape / sourceConstraintComponent / severity
 * (and expected `sh:resultMessage`s), ignoring blank node identity.
 */
import { assert, describe, expect, it } from '@effect/vitest';
import { Dataset, Term, Vocab } from '@thomasfosterau/effect-rdf';
import { Path, Sparql, ValidationReport, Validator } from '@thomasfosterau/effect-rdf/shacl';
import { Turtle } from '@thomasfosterau/effect-turtle';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Evaluator } from '../../src/shacl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const suites = process.env['RDF_TEST_SUITES'] ?? resolve(here, '../../../../.test-suites');
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

/** The IRI of a manifest node the suite names with an IRI. */
const iri = (t: Term.Term): Term.NamedNode =>
  Term.isNamedNode(t) ? t : assert.fail(`expected an IRI in the manifest, got ${t.key}`);

const loaded = MutableHashMap.empty<string, Dataset.Dataset>();
const load = (iriText: string): Dataset.Dataset => {
  const file = fileURLToPath(iriText.split('#')[0] ?? iriText);
  return Option.getOrElse(MutableHashMap.get(loaded, file), () => {
    const ds = Effect.runSync(
      Turtle.parse(readFileSync(file, 'utf8'), { baseIri: pathToFileURL(file).href }),
    ).dataset;
    MutableHashMap.set(loaded, file, ds);
    return ds;
  });
};

const collect = (manifestIri: string, out: Array<TestCase>): void => {
  const ds = load(manifestIri);
  const self = Term.namedNode(manifestIri);
  Arr.forEach(Dataset.objectsOf(ds, self, mf('include')), (inc) => collect(iri(inc).value, out));
  Arr.forEach(Dataset.objectsOf(ds, self, mf('entries')), (list) =>
    Arr.forEach(
      Option.getOrElse(Dataset.list(ds, list), () => []),
      (entry) => {
        const node = iri(entry);
        const name = node.value.slice(pathToFileURL(root).href.length + 1);
        out.push({ name, ds, node });
      },
    ),
  );
};

const cases: Array<TestCase> = [];
if (exists) collect(pathToFileURL(resolve(root, 'manifest.ttl')).href, cases);

const blankKeys = (ds: Dataset.Dataset): ReadonlyArray<string> =>
  Arr.flatMap(Arr.fromIterable(ds), (q) =>
    Arr.map(Arr.filter([q.subject, q.object], Term.isBlankNode), (b) => b.key),
  );

const optMatches = <A>(e: Option.Option<A>, a: Option.Option<A>, f: (x: A, y: A) => boolean) =>
  Option.isNone(e) ? Option.isNone(a) : Option.isSome(a) && f(e.value, a.value);

const describeResults = (rs: ReadonlyArray<ValidationReport.ValidationResult>) =>
  ValidationReport.format({
    _tag: 'ValidationReport',
    conforms: Arr.isReadonlyArrayEmpty(rs),
    results: rs,
  });

const runCase = (tc: TestCase) =>
  Effect.gen(function* () {
    const one = (s: Term.Term, p: Term.NamedNode): Term.Object =>
      Option.getOrElse(
        Term.isSubject(s) ? Arr.head(Dataset.objectsOf(tc.ds, s, p)) : Option.none(),
        () => assert.fail(`${s.key} has no ${p.key}`),
      );
    const action = one(tc.node, mf('action'));
    const data = load(iri(one(action, sht('dataGraph'))).value);
    const shapes = load(iri(one(action, sht('shapesGraph'))).value);
    const expectedNode = one(tc.node, mf('result'));

    const exit = yield* Effect.exit(
      Validator.validate(data, shapes).pipe(
        Effect.provideService(Sparql.SparqlConstraintEvaluator, Evaluator.make()),
      ),
    );
    if (expectedNode.key === sht('Failure').key) {
      assert.isTrue(Exit.isFailure(exit));
      return;
    }
    if (Exit.isFailure(exit)) assert.fail(`validation failed: ${String(exit.cause)}`);
    const actual = exit.value;

    const expectedResult = ValidationReport.fromDataset(
      tc.ds,
      Term.isResource(expectedNode) ? expectedNode : assert.fail('mf:result is not a report node'),
    );
    if (Result.isFailure(expectedResult)) assert.fail(expectedResult.failure.message);
    const expected = expectedResult.success;

    const known = MutableHashSet.fromIterable([...blankKeys(data), ...blankKeys(shapes)]);
    const termMatches = (e: Term.Term, a: Term.Term) =>
      Term.isBlankNode(e) && Term.isBlankNode(a) && !MutableHashSet.has(known, e.key)
        ? true
        : e.key === a.key;
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

    const used = MutableHashSet.empty<number>();
    const match = (i: number): boolean =>
      Option.match(Arr.get(expected.results, i), {
        onNone: () => true,
        onSome: (e) =>
          actual.results.some((a, j) => {
            if (MutableHashSet.has(used, j) || !resultMatches(e, a)) return false;
            MutableHashSet.add(used, j);
            if (match(i + 1)) return true;
            MutableHashSet.remove(used, j);
            return false;
          }),
      });
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
  Arr.forEach(sparqlCases, (tc) => it.effect(tc.name, () => runCase(tc)));
});

describe.skipIf(!exists)('SHACL Core test suite with the SPARQL evaluator', () => {
  Arr.forEach(coreCases, (tc) => it.effect(tc.name, () => runCase(tc)));
});
