/* eslint-disable vitest/valid-title, vitest/valid-expect, vitest/no-conditional-expect, vitest/expect-expect -- conformance tests are generated from manifests */
import { assert, describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Order from 'effect/Order';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as SemAct from '../src/SemAct.ts';
import * as ShapeMap from '../src/ShapeMap.ts';
import * as ShExC from '../src/ShExC.ts';
import { ShExImportError } from '../src/ShExError.ts';
import type * as ShExJ from '../src/ShExJ.ts';
import * as Validator from '../src/Validator.ts';
import { exists, hasShexTest, readJson, readText, suiteBase } from './utils/suite.ts';
import { parseTurtle } from './utils/turtle.ts';

interface Entry {
  readonly name: string;
  readonly status: 'conformant' | 'nonconformant';
  readonly trait?: ReadonlyArray<string>;
  readonly schemaURL: string;
  readonly dataURL: string;
  readonly node?: string;
  readonly shape?: string;
  readonly queryMap?: string;
  readonly queryMapURL?: string;
  readonly semActsURL?: string;
  readonly shapeExternsURL?: string;
  readonly 'tst:parms'?: { readonly prints?: ReadonlyArray<string | { readonly line: string }> };
}

const manifest: { entries: ReadonlyArray<Entry> } = hasShexTest
  ? readJson('validation', 'manifest-ld.jsonld')
  : { entries: [] };

const validationBase = `${suiteBase}validation/`;

/** Tests skipped deliberately, with the reason. */
export const validationSkips: Readonly<Record<string, string>> = {};

/** Maps a suite IRI to a path relative to the suite directory. */
const suitePath = (iri: string): string | undefined =>
  iri.startsWith(suiteBase) ? iri.slice(suiteBase.length) : undefined;

const loadShExC = (iri: string): Effect.Effect<ShExJ.Schema, ShExImportError> => {
  const rel = suitePath(iri);
  const candidates = rel === undefined ? [] : /\.[a-z]+$/.test(rel) ? [rel] : [`${rel}.shex`];
  const file = candidates.find((c) => exists(c));
  if (file === undefined)
    return Effect.fail(new ShExImportError({ iri, message: 'not found in the test suite' }));
  return ShExC.parse(readText(file), { baseIri: suiteBase + file }).pipe(
    Effect.mapError((e) => new ShExImportError({ iri, message: e.message })),
  );
};

const loader: Validator.Loader = { load: loadShExC };

const runEntry = (entry: Entry) =>
  Effect.gen(function* () {
    const schemaIri = Iri.resolve(entry.schemaURL, validationBase);
    const schema = yield* loadShExC(schemaIri);
    const dataIri = Iri.resolve(entry.dataURL, validationBase);
    const dataset = parseTurtle(readText(suitePath(dataIri)!), dataIri);
    let map: ShapeMap.QueryShapeMap;
    if (entry.queryMap !== undefined) {
      map = yield* ShapeMap.parse(entry.queryMap, { baseIri: validationBase });
    } else if (entry.queryMapURL !== undefined) {
      map = ShapeMap.fromJson(readJson('validation', entry.queryMapURL), {
        baseIri: validationBase,
      });
    } else {
      map = [
        {
          node: ShapeMap.parseTerm(entry.node!, { baseIri: validationBase }),
          shape:
            entry.shape === undefined
              ? ShapeMap.start
              : entry.shape.startsWith('_:')
                ? entry.shape
                : Iri.resolve(entry.shape, validationBase),
        },
      ];
    }
    const externalSemActs =
      entry.semActsURL === undefined
        ? undefined
        : (yield* loadShExC(Iri.resolve(entry.semActsURL, validationBase))).startActs;
    const externalShapes =
      entry.shapeExternsURL === undefined
        ? undefined
        : yield* loadShExC(Iri.resolve(entry.shapeExternsURL, validationBase));
    const prints: Array<string> = [];
    const report = yield* Validator.validate(dataset, schema, map, {
      schemaIri,
      externalSemActs,
      externalShapes,
    }).pipe(
      Effect.provideService(Validator.SchemaLoader, loader),
      Effect.provideService(
        SemAct.SemActHandler,
        SemAct.testExtension((line) => prints.push(line)),
      ),
    );
    return { report, prints };
  });

describe.skipIf(!hasShexTest)('shexTest validation', () => {
  for (const entry of manifest.entries) {
    const skip = validationSkips[entry.name];
    it.skipIf(skip !== undefined)(entry.name, () => {
      const exit = Effect.runSyncExit(runEntry(entry));
      if (Exit.isFailure(exit)) {
        // A schema the validator rejects can only be a nonconformant test.
        assert.strictEqual(entry.status, 'nonconformant', String(exit.cause));
        return;
      }
      const { report } = exit.value;
      const reasons = report.results
        .filter((r) => r.status === 'nonconformant')
        .map((r) => `${r.node.key}@${ShapeMap.formatShape(r.shape)}: ${r.reason}`)
        .join('\n');
      expect(report.conformant ? 'conformant' : 'nonconformant', reasons).toBe(entry.status);
      // Test extension output (compared as a multiset: evaluation order is unspecified).
      const expectedPrints = entry['tst:parms']?.prints;
      if (expectedPrints !== undefined && entry.status === 'conformant') {
        const expected = Arr.sort(
          expectedPrints.map((p) => (typeof p === 'string' ? p : p.line)),
          Order.String,
        );
        assert.deepStrictEqual(Arr.sort(exit.value.prints, Order.String), expected);
      }
    });
  }
});
