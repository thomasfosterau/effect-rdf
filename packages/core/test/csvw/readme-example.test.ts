/**
 * The README's usage example, type-checked and run. Keep the two in step.
 */
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { Csv2Json, Csv2Rdf, Processor, Report } from '../../src/csvw/index.ts';

const metadata = `{
  "@context": "http://www.w3.org/ns/csvw",
  "url": "tree-ops.csv",
  "tableSchema": {
    "columns": [
      {"name": "GID", "titles": "GID", "datatype": "integer"},
      {"name": "on_street", "titles": "On Street"},
      {"name": "inventory_date", "titles": "Inventory Date",
       "datatype": {"base": "date", "format": "M/d/yyyy"}}
    ],
    "aboutUrl": "#gid-{GID}"
  }
}`;

const program = Effect.gen(function* () {
  const { group, report } = yield* Processor.fromMetadata(
    'http://example.org/tree-ops.csv-metadata.json',
    metadata,
    { validate: true },
  );
  return {
    valid: Report.isValid(report),
    dataset: Csv2Rdf.toDataset(group), // standard mode
    json: Csv2Json.toJson(group, { mode: 'minimal' }),
  };
}).pipe(
  Effect.provideService(
    Processor.Loader,
    Processor.makeLoader([
      {
        url: 'http://example.org/tree-ops.csv',
        rows: [
          ['GID', 'On Street', 'Inventory Date'],
          ['1', 'ADDISON AV', '10/18/2010'],
          ['2', 'EMERSON ST', '6/2/2010'],
        ],
      },
    ]),
  ),
);

describe('README example', () => {
  it.effect('validates and converts a table', () =>
    Effect.gen(function* () {
      const { valid, dataset, json } = yield* program;
      expect(valid).toBe(true);
      expect(dataset.size).toBeGreaterThan(6);
      expect(json).toEqual([
        {
          '@id': 'http://example.org/tree-ops.csv#gid-1',
          GID: 1,
          on_street: 'ADDISON AV',
          inventory_date: '2010-10-18',
        },
        {
          '@id': 'http://example.org/tree-ops.csv#gid-2',
          GID: 2,
          on_street: 'EMERSON ST',
          inventory_date: '2010-06-02',
        },
      ]);
    }),
  );
});
