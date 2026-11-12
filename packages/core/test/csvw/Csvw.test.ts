import { assert, describe, expect, it } from '@effect/vitest';
import { Dataset, Term } from '../../src/index.ts';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import {
  Csv2Json,
  Csv2Rdf,
  Datatype,
  Metadata,
  Processor,
  Report,
  Table,
} from '../../src/csvw/index.ts';
import * as UriTemplate from '../../src/csvw/internal/uriTemplate.ts';
import * as Url from '../../src/csvw/internal/url.ts';

const countries: Table.Source = {
  url: 'http://example.org/countries.csv',
  rows: [
    ['countryCode', 'latitude', 'longitude', 'name'],
    ['AD', '42.546245', '1.601554', 'Andorra'],
    ['AE', '23.424076', '53.847818', 'United Arab Emirates'],
  ],
};

const metadata = `{
  "@context": ["http://www.w3.org/ns/csvw", {"@language": "en"}],
  "url": "countries.csv",
  "dc:title": "Countries",
  "tableSchema": {
    "columns": [
      {"name": "countryCode", "titles": "countryCode", "datatype": "string", "required": true},
      {"name": "latitude", "titles": "latitude", "datatype": "number"},
      {"name": "longitude", "titles": "longitude", "datatype": "number"},
      {"name": "name", "titles": "name"}
    ],
    "aboutUrl": "#{countryCode}",
    "primaryKey": "countryCode"
  }
}`;

const loader = Processor.makeLoader([countries], {
  'http://example.org/countries.csv-metadata.json': metadata,
});

describe('Processor', () => {
  it.effect('annotates a table from metadata and converts it', () =>
    Effect.gen(function* () {
      const { group, report } = yield* Processor.fromMetadata(
        'http://example.org/countries.json',
        metadata,
        { validate: true },
      );
      expect(Report.isValid(report)).toBe(true);
      expect(Report.warnings(report)).toEqual([]);
      const json = Csv2Json.toJson(group, { mode: 'minimal' });
      expect(json).toEqual([
        {
          '@id': 'http://example.org/countries.csv#AD',
          countryCode: 'AD',
          latitude: 42.546245,
          longitude: 1.601554,
          name: 'Andorra',
        },
        {
          '@id': 'http://example.org/countries.csv#AE',
          countryCode: 'AE',
          latitude: 23.424076,
          longitude: 53.847818,
          name: 'United Arab Emirates',
        },
      ]);
      const dataset = Csv2Rdf.toDataset(group, { mode: 'minimal' });
      expect(dataset.size).toBe(8);
      expect(
        Dataset.has(
          dataset,
          Term.quad(
            Term.namedNode('http://example.org/countries.csv#AD'),
            Term.namedNode('http://example.org/countries.csv#name'),
            Term.literal('Andorra', 'en'),
          ),
        ),
      ).toBe(false);
      expect(
        Option.isSome(
          Dataset.objectOf(
            dataset,
            Term.namedNode('http://example.org/countries.csv#AD'),
            Term.namedNode('http://example.org/countries.csv#latitude'),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.provideService(Processor.Loader, loader)),
  );

  it.effect('finds metadata at a default location', () =>
    Effect.gen(function* () {
      const { group } = yield* Processor.fromTabular('http://example.org/countries.csv');
      expect(Csv2Json.toJson(group)).toMatchObject({
        tables: [{ url: 'http://example.org/countries.csv', 'dc:title': 'Countries' }],
      });
      const [table] = group.tables;
      expect(table?.common['dc:title']).toEqual({ '@value': 'Countries', '@language': 'en' });
    }).pipe(Effect.provideService(Processor.Loader, loader)),
  );

  it.effect('falls back to embedded metadata', () =>
    Effect.gen(function* () {
      const { group, report } = yield* Processor.fromTabular('http://example.org/countries.csv', {
        locate: false,
      });
      expect(report.issues).toEqual([]);
      expect(group.tables[0]?.columns.map((c) => c.name)).toEqual([
        'countryCode',
        'latitude',
        'longitude',
        'name',
      ]);
    }).pipe(Effect.provideService(Processor.Loader, loader)),
  );

  it.effect('reports cell errors as errors only when validating', () =>
    Effect.gen(function* () {
      const bad = `{
        "@context": "http://www.w3.org/ns/csvw",
        "url": "countries.csv",
        "tableSchema": {"columns": [
          {"titles": "countryCode"}, {"titles": "latitude", "datatype": "integer"},
          {"titles": "longitude"}, {"titles": "name"}
        ]}
      }`;
      const converted = yield* Processor.fromMetadata('http://example.org/m.json', bad);
      expect(Report.errors(converted.report)).toEqual([]);
      expect(Report.warnings(converted.report)[0]).toMatchObject({ row: 2, column: 2 });
      const validated = yield* Processor.fromMetadata('http://example.org/m.json', bad, {
        validate: true,
      });
      expect(Report.errors(validated.report)).toHaveLength(2);
    }).pipe(Effect.provideService(Processor.Loader, loader)),
  );

  it.effect('fails on a missing table', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Processor.fromMetadata(
          'http://example.org/m.json',
          '{"@context": "http://www.w3.org/ns/csvw", "url": "nope.csv"}',
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provideService(Processor.Loader, loader)),
  );

  it('lists the default metadata locations', () => {
    expect(Processor.defaultLocations('http://example.org/a/b.csv#x')).toEqual([
      'http://example.org/a/b.csv-metadata.json',
      'http://example.org/a/csv-metadata.json',
    ]);
  });
});

const document = (url: string, title: string) =>
  `{"@context": "http://www.w3.org/ns/csvw", "url": "${url}", "dc:title": "${title}"}`;

const titleOf = (processed: Processor.Processed) => processed.group.tables[0]?.common['dc:title'];

describe('Processor metadata discovery', () => {
  const table = 'http://example.org/data/countries.csv';
  const source: Table.Source = { url: table, rows: countries.rows };
  const discover = (
    documents: Readonly<Record<string, string>>,
    linkHeaders: Readonly<Record<string, string>> = {},
  ) =>
    Effect.provideService(
      Processor.fromTabular(table),
      Processor.Loader,
      Processor.makeLoader([source], documents, linkHeaders),
    );

  it.effect('prefers a Link header to the site-wide and default locations', () =>
    Effect.gen(function* () {
      const processed = yield* discover(
        {
          'http://example.org/data/linked.json': document('countries.csv', 'linked'),
          'http://example.org/data/countries.csv-metadata.json': document(
            'countries.csv',
            'default',
          ),
        },
        { [table]: '<linked.json>; rel="describedby"; type="application/csvm+json"' },
      );
      expect(titleOf(processed)).toEqual({ '@value': 'linked' });
    }),
  );

  it.effect('ignores Link headers that are not metadata links', () =>
    Effect.gen(function* () {
      const processed = yield* discover(
        {
          'http://example.org/data/other.html': document('countries.csv', 'html'),
          'http://example.org/data/next.json': document('countries.csv', 'next'),
          'http://example.org/data/countries.csv-metadata.json': document(
            'countries.csv',
            'default',
          ),
        },
        { [table]: '<other.html>; rel="describedby"; type="text/html", <next.json>; rel="next"' },
      );
      expect(titleOf(processed)).toEqual({ '@value': 'default' });
    }),
  );

  it.effect('reads the templates of /.well-known/csvm, replacing the defaults', () =>
    Effect.gen(function* () {
      const processed = yield* discover({
        'http://example.org/.well-known/csvm': 'meta/{+url}.json\r\n\r\n/site-metadata.json\n',
        'http://example.org/data/countries.csv-metadata.json': document('countries.csv', 'default'),
        'http://example.org/site-metadata.json': document(table, 'site'),
      });
      expect(titleOf(processed)).toEqual({ '@value': 'site' });
    }),
  );

  it.effect('ignores a located document that does not describe the table, with a warning', () =>
    Effect.gen(function* () {
      const processed = yield* discover(
        {
          'http://example.org/data/linked.json': document('other.csv', 'other'),
          'http://example.org/data/countries.csv-metadata.json': document(
            'countries.csv',
            'default',
          ),
        },
        { [table]: '<linked.json>; rel=describedby' },
      );
      expect(titleOf(processed)).toEqual({ '@value': 'default' });
      expect(processed.report.issues.map((i) => i.message)).toEqual([
        'http://example.org/data/linked.json does not describe http://example.org/data/countries.csv',
      ]);
    }),
  );

  it.effect('falls back to the defaults with no Link header and no site configuration', () =>
    Effect.gen(function* () {
      const processed = yield* discover({
        'http://example.org/data/csv-metadata.json': document('countries.csv', 'directory'),
      });
      expect(titleOf(processed)).toEqual({ '@value': 'directory' });
      const embedded = yield* discover({});
      expect(embedded.group.tables[0]?.common).toEqual({});
      expect(embedded.report.issues).toEqual([]);
    }),
  );

  it('expands the Link header targets against the table', () => {
    expect(Processor.linkedLocations(`${table}#x`, '</m.json>; rel="describedby"')).toEqual([
      'http://example.org/m.json',
    ]);
  });
});

describe('Metadata', () => {
  it.effect('normalizes natural-language and common properties', () =>
    Effect.gen(function* () {
      const { group, warnings } = yield* Metadata.decode(
        `{
          "@context": ["http://www.w3.org/ns/csvw", {"@base": "http://example.org/base/", "@language": "de"}],
          "url": "data.csv",
          "dc:source": {"@id": "src"},
          "tableSchema": {"columns": [{"titles": ["Name", 3]}]},
          "foo": 1
        }`,
        'http://example.org/metadata.json',
        Metadata.noFetch,
      );
      const table = group.tables[0];
      expect(table?.url).toBe('http://example.org/base/data.csv');
      expect(table?.common['dc:source']).toEqual({ '@id': 'http://example.org/base/src' });
      expect(table?.tableSchema?.columns[0]?.titles).toEqual({ de: ['Name'] });
      expect(warnings.map((w) => w.level)).toEqual(['warning', 'warning']);
    }),
  );

  it.effect('fails on an invalid @context', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Metadata.decode('{"url": "a.csv"}', 'http://example.org/m.json', Metadata.noFetch),
      );
      assert(Exit.isFailure(exit));
      const invalid = yield* Effect.exit(
        Metadata.decode('{', 'http://example.org/m.json', Metadata.noFetch),
      );
      expect(Exit.isFailure(invalid)).toBe(true);
    }),
  );

  it('checks title compatibility with languages', () => {
    expect(Metadata.languagesMatch('en-US', 'en')).toBe(true);
    expect(Metadata.languagesMatch('und', 'fr')).toBe(true);
    expect(Metadata.languagesMatch('de', 'en')).toBe(false);
  });
});

const parse = (text: string, datatype: Datatype.Datatype) =>
  Result.map(Datatype.parse(text, datatype, Option.none()), (v) => v.lexical);

const decimal = (format: Datatype.Datatype['format']): Datatype.Datatype =>
  format === undefined ? { base: 'decimal', common: {} } : { base: 'decimal', format, common: {} };

describe('Datatype', () => {
  it('parses numbers with patterns, group and decimal characters', () => {
    expect(parse('1,234.5', decimal({ groupChar: ',' }))).toEqual(Result.succeed('1234.5'));
    expect(parse('12,5%', decimal({ decimalChar: ',' }))).toEqual(Result.succeed('0.125'));
    expect(parse('1,23,456', decimal('#,##,##0'))).toEqual(Result.succeed('123456'));
    expect(Result.isFailure(parse('1234', decimal('#,##0')))).toBe(true);
    expect(Result.isFailure(parse('1e3', decimal(undefined)))).toBe(true);
  });

  it('parses dates and times with formats', () => {
    expect(
      parse('22/3/2015 15:02', { base: 'dateTime', format: 'd/M/yyyy HH:mm', common: {} }),
    ).toEqual(Result.succeed('2015-03-22T15:02:00'));
    expect(parse('1502 +0530', { base: 'time', format: 'HHmm xx', common: {} })).toEqual(
      Result.succeed('15:02:00+05:30'),
    );
    expect(
      Result.isFailure(parse('31/2/2015', { base: 'date', format: 'd/M/yyyy', common: {} })),
    ).toBe(true);
  });

  it('parses booleans and checks constraints', () => {
    expect(parse('Y', { base: 'boolean', format: 'Y|N', common: {} })).toEqual(
      Result.succeed('true'),
    );
    expect(Result.isFailure(parse('12', { base: 'integer', maxInclusive: 10, common: {} }))).toBe(
      true,
    );
    expect(Result.isFailure(parse('abc', { base: 'string', minLength: 4, common: {} }))).toBe(true);
    expect(Datatype.checkFormat('integer', '[')).toEqual(
      Option.some('invalid number format pattern "["'),
    );
    expect(Datatype.iri('number')).toBe('http://www.w3.org/2001/XMLSchema#double');
  });
});

describe('Table', () => {
  it('reads skipped rows, comments and header rows', () => {
    const embedded = Table.read(
      {
        url: 'http://example.org/t.csv',
        rows: [['skip me'], ['#', 'a comment'], ['a', 'b'], ['1', ' 2 '], ['', '']],
      },
      { ...Metadata.defaultDialect, skipRows: 1, commentPrefix: '#', shouldSkipBlankRows: true },
      'en',
    );
    expect(embedded.comments).toEqual(['skip me', ',a comment']);
    expect(embedded.columns.map((c) => c.titles)).toEqual([{ en: ['a'] }, { en: ['b'] }]);
    expect(embedded.rows).toEqual([{ sourceNumber: 4, cells: ['1', '2'] }]);
  });
});

describe('URI templates', () => {
  it('expands RFC 6570 expressions', () => {
    const vars = { var: 'value', hello: 'Hello World!', list: ['red', 'green', 'blue'] };
    expect(UriTemplate.expand('{var}', vars)).toBe('value');
    expect(UriTemplate.expand('{+hello}', vars)).toBe('Hello%20World!');
    expect(UriTemplate.expand('{#hello}', vars)).toBe('#Hello%20World!');
    expect(UriTemplate.expand('{?var,list}', vars)).toBe('?var=value&list=red,green,blue');
    expect(UriTemplate.expand('{/list*}', vars)).toBe('/red/green/blue');
    expect(UriTemplate.expand('{;list*}', vars)).toBe(';list=red;list=green;list=blue');
    expect(UriTemplate.expand('{.var:3}', vars)).toBe('.val');
    expect(UriTemplate.expand('{&undef}x', vars)).toBe('x');
  });

  it('normalizes URLs and encodes column names', () => {
    expect(Url.normalize('HTTP://Example.ORG:80/a/./b/%7euser')).toBe(
      'http://example.org/a/b/~user',
    );
    expect(Url.encodeName('On Street-1')).toBe('On%20Street%2D1');
    expect(Url.decodeName('On%20Street%2D1')).toBe('On Street-1');
  });
});

describe('Report', () => {
  it('separates errors and warnings', () => {
    const report = Report.combine(
      Report.make([Report.warning('w')]),
      Report.make([Report.error('e', { row: 2 })]),
    );
    expect(Report.isValid(report)).toBe(false);
    expect(Report.errors(report)).toEqual([{ level: 'error', message: 'e', row: 2 }]);
    expect(Report.warnings(report)).toHaveLength(1);
    expect(Report.isValid(Report.empty)).toBe(true);
  });
});
