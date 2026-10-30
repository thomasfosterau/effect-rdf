import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import * as Result from 'effect/Result';
import type * as Ast from '../src/Ast.ts';
import * as Generator from '../src/Generator.ts';
import * as Parser from '../src/Parser.ts';
import { readManifest, suitesDir, type TestCase } from './support/manifest.ts';

const sparqlDir = path.join(suitesDir, 'rdf-tests', 'sparql');
const exists = fs.existsSync(sparqlDir);

const SYNTAX_TYPES = new Set([
  'PositiveSyntaxTest',
  'PositiveSyntaxTest11',
  'NegativeSyntaxTest',
  'NegativeSyntaxTest11',
  'PositiveUpdateSyntaxTest',
  'PositiveUpdateSyntaxTest11',
  'NegativeUpdateSyntaxTest',
  'NegativeUpdateSyntaxTest11',
]);

const manifests = ['sparql10/manifest.ttl', 'sparql11/manifest-all.ttl', 'sparql12/manifest.ttl'];

const loadTests = (): Array<TestCase> => {
  if (!exists) return [];
  const seen = new Set<string>();
  const out: Array<TestCase> = [];
  for (const m of manifests) {
    for (const t of readManifest(path.join(sparqlDir, m))) {
      if (!SYNTAX_TYPES.has(t.type) || seen.has(t.id) || t.query === undefined) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
};

const tests = loadTests();
const positive = tests.filter((t) => t.type.startsWith('Positive'));
const negative = tests.filter((t) => t.type.startsWith('Negative'));

const parse = (
  text: string,
  file: string,
  update: boolean,
): Result.Result<Ast.Query | Ast.Update, Parser.SparqlParseError> => {
  const options = { baseIri: pathToFileURL(file).href };
  // SAFETY: an update parse result is assignable to the wider query-or-update result; the cast only
  // widens it.
  return update ? Parser.parseUpdateResult(text, options) : Parser.parseQueryResult(text, options);
};

const isUpdate = (t: TestCase): boolean => t.type.includes('Update') || t.query!.endsWith('.ru');

/** Parses, prints, re-parses and re-prints; returns both printed texts. */
const roundTrip = (t: TestCase): readonly [string, string] => {
  const parsed = parse(fs.readFileSync(t.query!, 'utf8'), t.query!, isUpdate(t));
  if (Result.isFailure(parsed)) return expect.fail(parsed.failure.message);
  const printed = Generator.print(parsed.success);
  const reparsed = parse(printed, t.query!, isUpdate(t));
  if (Result.isFailure(reparsed)) {
    return expect.fail(`Re-parse failed: ${reparsed.failure.message}\n${printed}`);
  }
  return [printed, Generator.print(reparsed.success)];
};

const cases = (list: ReadonlyArray<TestCase>) =>
  list.map((t) => [path.relative(sparqlDir, t.query!), t] as const);

describe.skipIf(!exists)('SPARQL syntax conformance (positive)', () => {
  it.each(cases(positive))('%s', (_, t) => {
    const [printed, reprinted] = roundTrip(t);
    expect(reprinted).toBe(printed);
  });
});

describe.skipIf(!exists)('SPARQL syntax conformance (negative)', () => {
  it.each(cases(negative))('%s', (_, t) => {
    const result = parse(fs.readFileSync(t.query!, 'utf8'), t.query!, isUpdate(t));
    expect(Result.isFailure(result)).toBe(true);
  });
});
