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
import { describe, expect, it } from 'vite-plus/test';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Result from 'effect/Result';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';
import { Isomorphism, Model, N3, Reasoner } from '../src/index.ts';

const suites =
  process.env['RDF_TEST_SUITES'] ?? path.resolve(import.meta.dirname, '../../../.test-suites');
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
  readonly options: ReadonlySet<string>;
  readonly rejected: boolean;
}

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
  if (entries === undefined || entries._tag !== 'Collection') return [];
  return entries.items.map((e) => {
    const options = new Set<string>();
    for (const o of objects(e, `${TEST}options`)) {
      for (const t of statements.filter((t) => t.subject.key === o.key)) {
        if (t.object.key.startsWith('"true"'))
          options.add((t.predicate as Term.NamedNode).value.slice(TEST.length));
      }
    }
    return {
      id: (e as Term.NamedNode).value.slice((e as Term.NamedNode).value.lastIndexOf('#') + 1),
      action: (objects(e, `${MF}action`)[0] as Term.NamedNode).value,
      result: (objects(e, `${MF}result`)[0] as Term.NamedNode).value,
      options,
      rejected: objects(e, `${RDFT}approval`).some((a) => a.key === `<${RDFT}Rejected>`),
    };
  });
};

const hasFormula = (t: Model.N3Term | Model.Statement): boolean =>
  t._tag === 'Formula' ||
  (t._tag === 'Collection' && t.items.some(hasFormula)) ||
  (t._tag === 'Statement' &&
    (hasFormula(t.subject) || hasFormula(t.predicate) || hasFormula(t.object)));

/** Canonicalises numeric literals, so `0.0e0` and `0.0E0` compare equal. */
const canonical = (f: Model.Formula): Model.Formula =>
  Model.mapTerms(f, (t) => (t._tag === 'Literal' ? Xsd.canonicalize(t) : t));

/** Runs a reasoner test; returns an error message, or `undefined` when it passes. */
const run = (entry: Entry): string | undefined =>
  Result.match(
    Result.try(() => runUnsafe(entry)),
    {
      onSuccess: (message) => message,
      onFailure: (e) => String(e),
    },
  );

const runUnsafe = (entry: Entry): string | undefined => {
  const input = parseFile(entry.action);
  const exit = Effect.runSyncExit(Reasoner.reason(input.formula, { maxRounds: 200 }));
  if (!Exit.isSuccess(exit)) return String(exit.cause);
  // `test:conclusions`: only the inferred statements; otherwise the closure.
  // `test:data`: only plain data (statements without formulas or variables).
  let closure = entry.options.has('conclusions') ? exit.value.inferred : exit.value.closure;
  if (entry.options.has('data')) {
    closure = Model.formula(closure.statements.filter((s) => Model.isGround(s) && !hasFormula(s)));
  }
  const expected = canonical(parseFile(entry.result).formula);
  closure = canonical(closure);
  return Isomorphism.isomorphic(closure, expected)
    ? undefined
    : `Not isomorphic:\n${N3.serializeDocument(closure)}`;
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
    expect(run(entry)).toBeUndefined();
  });

  it.each(entries.filter((e) => unsupported[e.id] !== undefined))('$id (unsupported)', (entry) => {
    expect(run(entry)).toBeDefined();
  });
});
