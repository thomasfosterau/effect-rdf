/**
 * W3C N3 Community Group test suite (https://github.com/w3c/N3/tree/master/tests).
 *
 * Manifests are read with this package's own parser. Syntax tests check that
 * the action parses (or fails to parse); evaluation tests compare the parsed
 * action with the parsed expected result using N3 isomorphism (blank nodes,
 * variables, nested formulas; collections compared in RDF list form).
 *
 * Tests marked `rdft:Rejected` (legacy syntax removed from the current
 * specification, e.g. `@keywords`) are run separately and reported as
 * compatibility tests; Turtle negative syntax tests whose input is valid N3
 * (formulas, literal subjects, `=`, paths, …) are listed in
 * `validInN3` with the reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert, describe, expect, it } from 'vite-plus/test';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import { Isomorphism, Mapping, Model, N3 } from '../src/index.ts';

const suites =
  process.env['RDF_TEST_SUITES'] ?? path.resolve(import.meta.dirname, '../../../.test-suites');
const root = path.join(suites, 'N3', 'tests');
const exists = fs.existsSync(path.join(root, 'manifest.ttl'));
const BASE = 'https://w3c.github.io/N3/tests/';

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const RDFT = 'http://www.w3.org/ns/rdftest#';
const TEST = 'https://w3c.github.io/N3/tests/test.n3#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

interface Entry {
  readonly id: string;
  readonly type: string;
  readonly action: string;
  readonly result: string | undefined;
  readonly rejected: boolean;
}

const localPath = (iri: string): string => path.join(root, iri.slice(BASE.length));

const parseFile = (iri: string) =>
  Effect.runSyncExit(N3.parse(fs.readFileSync(localPath(iri), 'utf8'), { baseIri: iri }));

const readManifest = (relative: string): ReadonlyArray<Entry> => {
  const iri = BASE + relative;
  const exit = parseFile(iri);
  if (!Exit.isSuccess(exit)) assert.fail(`Cannot parse manifest ${relative}`);
  const statements = exit.value.formula.statements;
  const objects = (s: Model.N3Term, p: string) =>
    statements
      .filter((t) => t.subject.key === s.key && t.predicate.key === `<${p}>`)
      .map((t) => t.object);
  const one = (s: Model.N3Term, p: string) => objects(s, p)[0];
  const manifest = new Term.NamedNode(iri);
  const entries = one(manifest, `${MF}entries`);
  if (entries === undefined || entries._tag !== 'Collection') return [];
  return entries.items.map((e) => {
    // SAFETY: manifest types are IRIs.
    const types = objects(e, `${RDF}type`).map((t) => (t as Term.NamedNode).value);
    const type =
      types.map((t) => t.replace(TEST, '').replace(RDFT, '')).find((t) => t.startsWith('Test')) ??
      '';
    const result = one(e, `${MF}result`);
    // SAFETY: test actions and results are IRIs in the N3 manifests.
    return {
      id: e._tag === 'NamedNode' ? e.value.slice(e.value.lastIndexOf('#') + 1) : e.key,
      type,
      action: (one(e, `${MF}action`) as Term.NamedNode).value,
      result: result === undefined ? undefined : (result as Term.NamedNode).value,
      rejected: objects(e, `${RDFT}approval`).some((a) => a.key === `<${RDFT}Rejected>`),
    };
  });
};

/** Test id → why the test is treated specially. */
interface Reasons {
  readonly [id: string]: string;
}

/** Turtle negative syntax tests whose input is valid N3. */
const validInN3: Reasons = {
  'turtle-syntax-bad-prefix-01': 'the empty prefix defaults to <#> in N3',
  'turtle-syntax-bad-struct-02': '`=` is owl:sameAs in N3',
  'turtle-syntax-bad-struct-04': 'literals may be subjects in N3',
  'turtle-syntax-bad-struct-05': 'literals may be predicates in N3',
  'turtle-syntax-bad-struct-06': 'blank nodes may be predicates in N3',
  'turtle-syntax-bad-struct-07': 'blank nodes may be predicates in N3',
  'turtle-syntax-bad-struct-14': 'literals may be subjects in N3',
  'turtle-syntax-bad-struct-15': 'literals may be predicates in N3',
  'turtle-syntax-bad-struct-16': 'blank nodes may be predicates in N3',
  'turtle-syntax-bad-struct-17': 'blank nodes may be predicates in N3',
  'turtle-syntax-bad-kw-04': '`true` may be a subject in N3',
  'turtle-syntax-bad-kw-05': '`true` may be a predicate in N3',
  'turtle-syntax-bad-n3-extras-01': 'formulas are N3',
  'turtle-syntax-bad-n3-extras-02': '`=` is N3',
  'turtle-syntax-bad-n3-extras-03': 'paths are N3',
  'turtle-syntax-bad-n3-extras-04': 'paths are N3',
  'turtle-syntax-bad-n3-extras-05': '`is … of` is N3',
  'turtle-syntax-bad-n3-extras-06': 'paths are N3',
  'turtle-syntax-bad-n3-extras-09': '`=>` is N3',
  'turtle-syntax-bad-n3-extras-10': '`<=` is N3',
  'turtle-syntax-bad-n3-extras-11': '@forSome is (legacy) N3',
  'turtle-syntax-bad-n3-extras-12': '@forAll is (legacy) N3',
};

/** Tests that cannot pass as written, with the reason. */
const skip: Reasons = {
  'cwm_syntax_numbers.n3':
    'expected result contains a stale file:/home/syosi/… IRI and canonicalised numeric lexical forms',
  // rdft:Rejected tests using syntax outside N3 (historical Euler/cwm dialects).
  'extra_bad_prefix2.n3': 'rejected: the current spec allows re-mapping a prefix',
  '04test_icalQ001.n3': 'rejected: Euler `?x^^xsd:dateTime` syntax',
  '04test_icalQ002.n3': 'rejected: Euler `?x^^xsd:dateTime` syntax',
  '04test_icalR.n3': 'rejected: Euler `?x^^xsd:dateTime` syntax',
  '04test_query-survey-13.n3': 'rejected: Euler `?x^^xsd:dateTime` syntax',
  '04test_LanguageQ.n3': 'rejected: Euler `?x@lang` syntax',
  '04test_query-survey-11.n3': 'rejected: Euler `?x@lang` syntax',
  '04test_metastaticP.n3': 'rejected: bare `_:` blank node',
  '04test_metastaticR.n3': 'rejected: bare `_:` blank node',
  '07test_irR.n3': 'rejected: bare `_:` blank node',
  '07test_m3bP.n3': 'rejected: bare `_:` blank node',
  '07test_nbbn_result.n3': 'rejected: bare `_:` blank node',
  '07test_orP.n3': 'rejected: bare `_:` blank node',
  '07test_ptP.n3': 'rejected: bare `_:` blank node',
  '07test_rsP.n3': 'rejected: bare `_:` blank node',
  '05smml_RULESfaces.n3': 'rejected: invalid quick variable name',
  '07test_biR.n3': 'rejected: bare `+` / `-` symbols',
};

/**
 * Serialises the parsed document, re-parses it and checks isomorphism; for
 * RDF-compatible documents also round-trips through a core dataset.
 */
/**
 * Dataset isomorphism via the N3 isomorphism (iterative, so it copes with the
 * large graphs in the suite).
 */
const datasetsIsomorphic = (a: Dataset.Dataset, b: Dataset.Dataset): boolean =>
  Isomorphism.isomorphic(
    Effect.runSync(Mapping.fromDataset(a)),
    Effect.runSync(Mapping.fromDataset(b)),
  );

const roundTrip = (entry: Entry, doc: Model.Document): void => {
  const text = N3.serializeDocument(doc);
  const again = Effect.runSyncExit(N3.parse(text));
  if (!Exit.isSuccess(again)) {
    assert.fail(`Serialised output does not parse: ${String(again.cause)}\n${text}`);
  }
  if (!Isomorphism.isomorphic(doc.formula, again.value.formula)) {
    assert.fail(`Serialised output is not isomorphic:\n${text}`);
  }
  // The dataset round trip is limited to moderately sized documents, as
  // building large core datasets dominates the run time.
  if (doc.formula.size > 2000) return;
  const dataset = Effect.runSyncExit(Mapping.toDataset(doc));
  if (Exit.isSuccess(dataset)) {
    const ttl = Effect.runSync(N3.serialize(dataset.value, { prefixes: doc.prefixes }));
    const back = Effect.runSyncExit(N3.parser.parse(ttl));
    if (!Exit.isSuccess(back) || !datasetsIsomorphic(dataset.value, back.value.dataset)) {
      assert.fail(`Dataset round trip failed for ${entry.id}:\n${ttl}`);
    }
  }
};

const run = (entry: Entry): void => {
  const exit = parseFile(entry.action);
  if (entry.type.includes('Negative')) {
    if (validInN3[entry.id] !== undefined) {
      if (!Exit.isSuccess(exit)) assert.fail(String(exit.cause));
      return;
    }
    if (!Exit.isFailure(exit)) assert.fail('expected a syntax error');
    return;
  }
  if (!Exit.isSuccess(exit)) {
    assert.fail(String(exit.cause));
  }
  roundTrip(entry, exit.value);
  if (entry.result !== undefined && entry.type.includes('Eval')) {
    const expected = parseFile(entry.result);
    if (!Exit.isSuccess(expected))
      assert.fail(`Cannot parse expected result: ${String(expected.cause)}`);
    const ok = Isomorphism.isomorphic(exit.value.formula, expected.value.formula);
    if (!ok) {
      assert.fail(
        `Not isomorphic.\nActual:\n${N3.serializeDocument(exit.value.formula)}\nExpected:\n${N3.serializeDocument(expected.value.formula)}`,
      );
    }
  }
};

const manifests = [
  'TurtleTests/manifest.ttl',
  'N3Tests/manifest-parser.ttl',
  'N3Tests/manifest-extended.ttl',
];

const loaded = exists
  ? manifests.map((manifest) => ({ manifest, entries: readManifest(manifest) }))
  : [];

describe.skipIf(!exists)('N3 test suite', () => {
  for (const { manifest, entries } of loaded) {
    const active = entries.filter((e) => skip[e.id] === undefined);
    describe(manifest, () => {
      it.each(active.filter((e) => !e.rejected))('$type $id', (entry) => {
        expect(() => run(entry)).not.toThrow();
      });
    });
    const rejected = active.filter((e) => e.rejected);
    describe.skipIf(Arr.isReadonlyArrayEmpty(rejected))(
      `${manifest} (rdft:Rejected, legacy compatibility)`,
      () => {
        it.each(rejected)('$type $id', (entry) => {
          expect(() => run(entry)).not.toThrow();
        });
      },
    );
  }

  it('documents every skipped test', () => {
    const ids = new Set(loaded.flatMap(({ entries }) => entries.map((e) => e.id)));
    for (const id of Object.keys(skip)) expect(ids.has(id)).toBe(true);
    for (const id of Object.keys(validInN3)) expect(ids.has(id)).toBe(true);
  });
});
