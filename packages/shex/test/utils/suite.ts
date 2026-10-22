import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Schema from 'effect/Schema';

/** Test name → why the test is skipped or treated specially. */
export interface Reasons {
  readonly [name: string]: string;
}

/** The directory holding the conformance test suites. */
export const suitesDir: string =
  process.env.RDF_TEST_SUITES ?? path.resolve(import.meta.dirname, '../../../../.test-suites');

/** The shexTest checkout. */
export const shexTestDir: string = path.join(suitesDir, 'shexTest');

/** Whether the shexTest suite is available. */
export const hasShexTest: boolean = fs.existsSync(path.join(shexTestDir, 'schemas'));

/** The base IRI the suite's manifests use for their directories. */
export const suiteBase = 'https://raw.githubusercontent.com/shexSpec/shexTest/master/';

export const readText = (...segments: ReadonlyArray<string>): string =>
  fs.readFileSync(path.join(shexTestDir, ...segments), 'utf8');

/** Parses JSON text; the manifests and fixtures are read structurally. */
const parseJson = Schema.decodeSync(Schema.fromJsonString(Schema.Any));

export const readJson = (...segments: ReadonlyArray<string>): any =>
  parseJson(readText(...segments));

export const exists = (...segments: ReadonlyArray<string>): boolean =>
  fs.existsSync(path.join(shexTestDir, ...segments));
