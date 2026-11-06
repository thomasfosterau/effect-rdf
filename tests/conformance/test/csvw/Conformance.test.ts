/**
 * W3C CSV on the Web test suite (`w3c/csvw`, `tests/`;
 * `scripts/fetch-test-suites.sh`): the validation, CSV2RDF and CSV2JSON
 * manifests. Skipped when the suite is not present.
 *
 * The suite's CSV files are split into records by `test/support/csv.ts`, a
 * test-only stand-in for `@thomasfosterau/effect-csv`. Metadata at the
 * default locations (`{+url}-metadata.json`, `csv-metadata.json`) is found
 * through the `Loader`; tests that need an HTTP `Link` header or a site-wide
 * `/.well-known/csvm` file are in the skip list.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vite-plus/test';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import { Manifest, Turtle } from '@thomasfosterau/effect-turtle';
import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { Csv2Json, Csv2Rdf, Processor, Report } from '@thomasfosterau/effect-rdf/csvw';
import * as Csv from './support/csv.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = process.env['RDF_TEST_SUITES'] ?? path.resolve(here, '../../../../.test-suites');
const root = path.join(suites, 'csvw', 'tests');
const exists = fs.existsSync(path.join(root, 'manifest-rdf.ttl'));
const BASE = 'http://www.w3.org/2013/csvw/tests/';

const csvt = (local: string) => Term.namedNode(`http://www.w3.org/2013/csvw/tests/vocab#${local}`);

/** Tests deliberately not run, with the reason (by test number). */
const skipList: ReadonlyArray<readonly [string, string]> = [
  ['test014', 'metadata located through an HTTP Link header'],
  ['test016', 'metadata located through an HTTP Link header'],
  ['test120', 'metadata located through an HTTP Link header'],
  ['test122', 'metadata located through an HTTP Link header'],
  ['test259', 'metadata located through a site-wide /.well-known/csvm configuration'],
  ['test260', 'metadata located through a site-wide /.well-known/csvm configuration'],
];

const fileOf = (url: string): string => path.join(root, url.slice(BASE.length));

const loader = Processor.Loader.of({
  table: (url, dialect) =>
    Effect.suspend(() => {
      const file = fileOf(url.replace(/[?#].*$/, ''));
      if (!url.startsWith(BASE) || !fs.existsSync(file))
        return Effect.fail(new Processor.LoadError({ message: `no table at ${url}`, url }));
      return Effect.succeed(
        Csv.parse(Csv.decode(new Uint8Array(fs.readFileSync(file)), dialect.encoding), dialect),
      );
    }),
  document: (url) =>
    Effect.sync(() => {
      const file = fileOf(url.replace(/#.*$/, ''));
      return url.startsWith(BASE) && fs.existsSync(file) && fs.statSync(file).isFile()
        ? Option.some(fs.readFileSync(file, 'utf8'))
        : Option.none();
    }),
});

interface Case {
  readonly id: string;
  readonly kind: string;
  readonly action: string;
  readonly result: Option.Option<string>;
  readonly metadata: Option.Option<string>;
  readonly minimal: boolean;
}

const load = (manifest: string): ReadonlyArray<Case> =>
  exists
    ? Effect.runSync(
        Effect.map(
          Manifest.load(
            `${BASE}${manifest}`,
            Manifest.fileReader(BASE, `${root}/`, (file) =>
              Effect.sync(() => fs.readFileSync(file, 'utf8')),
            ),
          ),
          (entries) =>
            Arr.map(entries, (e): Case => {
              const option = Dataset.objectOf(e.dataset, e.node, csvt('option'));
              const optionValue = (local: string) =>
                Option.flatMap(option, (o) =>
                  Term.isSubject(o) ? Dataset.objectOf(e.dataset, o, csvt(local)) : Option.none(),
                );
              return {
                id: e.id.replace(/^.*#/, '').slice(0, 7),
                kind: e.kind,
                action: Option.getOrElse(e.action, () => ''),
                result: e.result,
                metadata: Option.map(
                  Option.filter(optionValue('metadata'), Term.isNamedNode),
                  (t) => t.value,
                ),
                minimal: Option.exists(
                  optionValue('minimal'),
                  (t) => Term.isLiteral(t) && t.value === 'true',
                ),
              };
            }),
        ),
      )
    : [];

const run = (c: Case, validate: boolean) => {
  const program = c.action.endsWith('.json')
    ? Effect.flatMap(loader.document(c.action), (text) =>
        Processor.fromMetadata(
          c.action,
          Option.getOrElse(text, () => ''),
          { validate },
        ),
      )
    : Option.match(c.metadata, {
        onNone: () => Processor.fromTabular(c.action, { validate }),
        onSome: (url) =>
          Effect.flatMap(loader.document(url), (text) =>
            Processor.fromTabular(c.action, {
              validate,
              metadata: { url, text: Option.getOrElse(text, () => '') },
            }),
          ),
      });
  return Effect.runSyncExit(Effect.provideService(program, Processor.Loader, loader));
};

const readResult = (c: Case): string =>
  fs.readFileSync(fileOf(Option.getOrElse(c.result, () => '')), 'utf8');

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const showJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const showIssues = (issues: ReadonlyArray<Report.Issue>): string =>
  Arr.join(
    Arr.map(issues, (i) => `${i.level}: ${i.message}`),
    '; ',
  );

type Exited = ReturnType<typeof run>;

/**
 * Why a run does not have the outcome its test type expects (`''` when it
 * does): negative tests fail or report an error; the others succeed without
 * errors, with warnings exactly when the type says so, and then pass `check`.
 */
const verdict = (
  c: Case,
  exit: Exited,
  negative: string,
  withWarnings: boolean,
  check: (processed: Processor.Processed) => string,
): string =>
  Exit.match(exit, {
    onFailure: (cause) => (c.kind === negative ? '' : `failed: ${Cause.pretty(cause)}`),
    onSuccess: (processed) => {
      const report = processed.report;
      const errors = Report.errors(report);
      const warnings = Report.warnings(report);
      if (c.kind === negative)
        return Arr.isReadonlyArrayNonEmpty(errors) ? '' : 'expected an error, none raised';
      if (Arr.isReadonlyArrayNonEmpty(errors)) return `unexpected errors: ${showIssues(errors)}`;
      if (withWarnings && !Arr.isReadonlyArrayNonEmpty(warnings))
        return 'expected a warning, none raised';
      if (!withWarnings && Arr.isReadonlyArrayNonEmpty(warnings))
        return `unexpected warnings: ${showIssues(warnings)}`;
      return check(processed);
    },
  });

const cases = (manifest: string) =>
  Arr.map(load(manifest), (c) => [`${c.id} ${c.kind}`, c] as const);

/** One test per manifest entry; entries in the skip list are reported as skipped with their reason. */
const suite = (
  manifest: string,
  validate: boolean,
  negative: string,
  check: (c: Case, processed: Processor.Processed) => string,
) =>
  Arr.forEach(cases(manifest), ([name, c]) => {
    const reason = Option.map(
      Arr.findFirst(skipList, ([id]) => id === c.id),
      ([, why]) => ` (skipped: ${why})`,
    );
    it.skipIf(Option.isSome(reason))(`${name}${Option.getOrElse(reason, () => '')}`, () => {
      const exit = run(c, validate);
      expect(verdict(c, exit, negative, c.kind.includes('Warning'), (p) => check(c, p))).toBe('');
    });
  });

describe.skipIf(!exists)('CSVW validation', () => {
  suite('manifest-validation.ttl', true, 'NegativeValidationTest', () => '');
});

describe.skipIf(!exists)('CSVW csv2rdf', () => {
  suite('manifest-rdf.ttl', false, 'NegativeRdfTest', (c, processed) => {
    const actual = Csv2Rdf.toDataset(processed.group, { mode: c.minimal ? 'minimal' : 'standard' });
    const expected = Effect.runSync(
      Turtle.parse(readResult(c), { baseIri: Option.getOrElse(c.result, () => BASE) }),
    ).dataset;
    return Isomorphism.isomorphic(actual, expected)
      ? ''
      : `not isomorphic\nactual:\n${Dataset.toNQuads(actual)}\nexpected:\n${Dataset.toNQuads(expected)}`;
  });
});

describe.skipIf(!exists)('CSVW csv2json', () => {
  suite('manifest-json.ttl', false, 'NegativeJsonTest', (c, processed) => {
    const actual = Csv2Json.toJson(processed.group, { mode: c.minimal ? 'minimal' : 'standard' });
    const expected = parseJson(readResult(c));
    return isDeepStrictEqual(actual, expected)
      ? ''
      : `JSON differs\nactual:\n${showJson(actual)}\nexpected:\n${showJson(expected)}`;
  });
});
