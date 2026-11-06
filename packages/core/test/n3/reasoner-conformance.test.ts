/**
 * W3C N3 CG reasoner tests (`N3Tests/manifest-reasoner.ttl`).
 *
 * The reasoner is a bonus feature with a limited set of builtins, so only a
 * subset of the suite is expected to pass; the remaining tests are listed in
 * `unsupported` with the reason and are checked to still be unsupported, so
 * the list stays accurate as the reasoner improves.
 *
 * Options (cwm semantics): `test:conclusions` compares only the inferred
 * statements, otherwise the whole closure; with `test:data` only plain data
 * (statements without formulas or variables) is compared. `test:rules`
 * (a single application of the rules) is approximated by the fixpoint.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert, describe, expect, it } from 'vite-plus/test';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';
import { Isomorphism, Model, N3, Reasoner } from '../../src/n3/index.ts';

const suites =
  process.env['RDF_TEST_SUITES'] ?? path.resolve(import.meta.dirname, '../../../../.test-suites');
const root = path.join(suites, 'N3', 'tests');
const manifestPath = path.join(root, 'N3Tests', 'manifest-reasoner.ttl');
const exists = fs.existsSync(manifestPath);
const BASE = 'https://w3c.github.io/N3/tests/';
const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const TEST = 'https://w3c.github.io/N3/tests/test.n3#';
const RDFT = 'http://www.w3.org/ns/rdftest#';

interface Entry {
  readonly id: string;
  readonly action: string;
  readonly result: string;
  readonly options: MutableHashSet.MutableHashSet<string>;
  readonly rejected: boolean;
}

/** The IRI of a manifest term (entries, actions, results and option names are IRIs). */
const iriOf = (t: Model.N3Term): string =>
  Term.isNamedNode(t) ? t.value : assert.fail(`Expected an IRI in the manifest, found ${t.key}`);

/** The IRI of the first of the terms. */
const firstIri = (ts: ReadonlyArray<Model.N3Term>): string => {
  const [t] = ts;
  return t === undefined ? assert.fail('Missing manifest value') : iriOf(t);
};

const parseFile = (iri: string) =>
  Effect.runSync(
    N3.parse(fs.readFileSync(path.join(root, iri.slice(BASE.length)), 'utf8'), { baseIri: iri }),
  );

const readManifest = (): ReadonlyArray<Entry> => {
  const iri = `${BASE}N3Tests/manifest-reasoner.ttl`;
  const statements = parseFile(iri).formula.statements;
  const objects = (s: Model.N3Term, p: string) =>
    statements
      .filter((t) => t.subject.key === s.key && t.predicate.key === `<${p}>`)
      .map((t) => t.object);
  const entries = objects(new Term.NamedNode(iri), `${MF}entries`)[0];
  if (!Model.isCollection(entries)) return [];
  return entries.items.map((e) => {
    const options = MutableHashSet.empty<string>();
    objects(e, `${TEST}options`).forEach((o) => {
      statements
        .filter((t) => t.subject.key === o.key && t.object.key.startsWith('"true"'))
        .forEach((t) => MutableHashSet.add(options, iriOf(t.predicate).slice(TEST.length)));
    });
    const id = iriOf(e);
    return {
      id: id.slice(id.lastIndexOf('#') + 1),
      action: firstIri(objects(e, `${MF}action`)),
      result: firstIri(objects(e, `${MF}result`)),
      options,
      rejected: objects(e, `${RDFT}approval`).some((a) => a.key === `<${RDFT}Rejected>`),
    };
  });
};

const hasFormula = (t: Model.N3Term | Model.Statement): boolean =>
  Model.isFormula(t) ||
  (Model.isCollection(t) && t.items.some(hasFormula)) ||
  (Model.isStatement(t) &&
    (hasFormula(t.subject) || hasFormula(t.predicate) || hasFormula(t.object)));

/** Canonicalises numeric literals, so `0.0e0` and `0.0E0` compare equal. */
const canonical = (f: Model.Formula): Model.Formula =>
  Model.mapTerms(f, (t) => (Term.isLiteral(t) ? Xsd.canonicalize(t) : t));

/** Runs a reasoner test; returns an error message, or `None` when it passes. */
const run = (entry: Entry): Option.Option<string> =>
  Result.match(
    Result.try(() => runUnsafe(entry)),
    {
      onSuccess: (message) => message,
      onFailure: (e) => Option.some(String(e)),
    },
  );

const runUnsafe = (entry: Entry): Option.Option<string> => {
  const input = parseFile(entry.action);
  const exit = Effect.runSyncExit(Reasoner.reason(input.formula, { maxRounds: 200 }));
  if (!Exit.isSuccess(exit)) return Option.some(String(exit.cause));
  // `test:conclusions`: only the inferred statements; otherwise the closure.
  // `test:data`: only plain data (statements without formulas or variables).
  let closure = MutableHashSet.has(entry.options, 'conclusions')
    ? exit.value.inferred
    : exit.value.closure;
  if (MutableHashSet.has(entry.options, 'data')) {
    closure = Model.formula(closure.statements.filter((s) => Model.isGround(s) && !hasFormula(s)));
  }
  const expected = canonical(parseFile(entry.result).formula);
  closure = canonical(closure);
  return Isomorphism.isomorphic(closure, expected)
    ? Option.none()
    : Option.some(`Not isomorphic:\n${N3.serializeDocument(closure)}`);
};

/** Test id → why the reasoner does not pass it. */
interface Reasons {
  readonly [id: string]: string;
}

/** Tests the reasoner does not (yet) pass, with the reason. */
const unsupported: Reasons = {
  cwm_includes_conclusion_simple: 'expected result uses the undeclared prefix log:',
  cwm_includes_conclusion: 'expected result uses the undeclared prefix rdfs:',
  cwm_includes_t6: 'expected result does not declare the `:` prefix',
  cwm_unify_unify1: 'expected result relies on @keywords (`:a` read as `a`)',
  cwm_includes_t10: 'log:semantics (dereferencing documents) is not supported',
  cwm_includes_t11: 'log:semantics (dereferencing documents) is not supported',
  log_content: 'log:content (dereferencing documents) is not supported',
  log_parsedAsN3: 'log:parsedAsN3 is not supported',
  cwm_includes_xsd: 'expects log:outputString text output',
  cwm_string_roughly: 'cwm-specific string builtins are not supported',
  cwm_string_uriEncode: 'string:encodeForURI / encodeForFragId are not supported',
  cwm_supports_simple: 'log:supports is not supported',
  cwm_time_t1: 'time: builtins are not supported',
};

const entries = exists ? readManifest() : [];

describe.skipIf(!exists)('N3 reasoner test suite', () => {
  it.each(entries.filter((e) => unsupported[e.id] === undefined))('$id', (entry) => {
    expect(Option.getOrUndefined(run(entry))).toBeUndefined();
  });

  it.each(entries.filter((e) => unsupported[e.id] !== undefined))('$id (unsupported)', (entry) => {
    expect(Option.isSome(run(entry))).toBe(true);
  });
});
