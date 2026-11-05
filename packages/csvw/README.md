# @thomasfosterau/effect-csvw

[CSV on the Web](https://www.w3.org/TR/tabular-data-primer/) (CSVW) for
[`@thomasfosterau/effect-rdf`](../core): the
[metadata vocabulary](https://www.w3.org/TR/tabular-metadata/), the
[annotated tabular data model](https://www.w3.org/TR/tabular-data-model/) with
validation, and the [CSV2RDF](https://www.w3.org/TR/csv2rdf/) and
[CSV2JSON](https://www.w3.org/TR/csv2json/) conversions.

The package works on **already-parsed tables**: a `Table.Source` is a URL and
its records as cell strings, in file order. Splitting CSV text into records is
the job of a CSV scanner (`@thomasfosterau/effect-csv`, which will plug in
here); everything after that — the dialect's skipped rows, header rows, comment
rows, blank rows, skipped columns and trimming, embedded metadata, datatypes,
keys and the conversions — is done by this package.

## Usage

```ts
import * as Effect from 'effect/Effect';
import { Csv2Json, Csv2Rdf, Processor, Report } from '@thomasfosterau/effect-csvw';

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
// json: [{ "@id": "http://example.org/tree-ops.csv#gid-1", "GID": 1,
//          "on_street": "ADDISON AV", "inventory_date": "2010-10-18" }, …]
```

This example is run by [`test/readme-example.test.ts`](test/readme-example.test.ts).

## Modules

| Module      | Contents                                                                                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Processor` | `fromMetadata(url, text, options)` and `fromTabular(url, options)` → `Processed` (`group`, `metadata`, `report`); the `Loader` service (`table(url, dialect)`, `document(url)`) with `makeLoader(sources, documents)` and `layerSources`; `defaultLocations(url)`; `LoadError`                            |
| `Metadata`  | The normalized description model as `Schema`s (`TableGroup`, `Table`, `TableSchema`, `Column`, `Dialect`, `ForeignKey`, `Reference`, `Transformation`, `Inherited`, `LanguageMap`, `CommonProperties`); `decode` / `decodeJson`; `defaultDialect`; inheritance and compatibility helpers; `MetadataError` |
| `Table`     | `Source` (the parsed input); the annotated model (`TableGroup`, `Table`, `Column`, `Row`, `Cell`, `CellValue`); `read` (dialect row flags and embedded metadata), `annotate`, `parseCell`, `validateKeys`                                                                                                 |
| `Datatype`  | The built-in datatypes (`builtIn`, `iri`, `isNumeric`, …), the `Datatype` description schema, `parse` (formats, length and value constraints) and `checkFormat`                                                                                                                                           |
| `Report`    | `Issue` (`level`, `message`, `table`, `row`, `column`) and `Report` schemas; `errors`, `warnings`, `isValid`                                                                                                                                                                                              |
| `Csv2Rdf`   | `toDataset(group, { mode })` → core `Dataset` (`standard` or `minimal`); `convert` (an Effect with a span)                                                                                                                                                                                                |
| `Csv2Json`  | `toJson(group, { mode })` → JSON (`standard` or `minimal`, with nested objects); `convert`                                                                                                                                                                                                                |

### Processing

`fromMetadata` starts from a metadata document: it is decoded (schemas and
dialects referenced by URL are fetched through the `Loader`), and each table
it describes is read through the `Loader` with the table's dialect. Every
table's embedded metadata (the titles in its header rows) is checked for
compatibility with its schema.

`fromTabular` starts from a tabular data file and takes its metadata from the
`metadata` option (user-supplied, overriding metadata), else the first
document at a default location (`{+url}-metadata.json`, `csv-metadata.json`)
that describes the file, else the file's embedded metadata (column titles from
the header row).

With `validate: true` the processor is a validator: metadata incompatible with
the data and invalid cells are **errors**, and primary keys and foreign keys
(across the group's tables) are checked. Without it, those are **warnings**
and keys are not checked. Metadata problems the specification calls errors
(invalid JSON, a bad `@context`, a blank-node `@id`, conflicting datatype
constraints, a foreign key to a missing table, …) fail with `MetadataError`;
properties with invalid values are dropped with a warning. Every issue carries
the table URL and, for cells and rows, the source row and column numbers.

### Metadata and datatypes

Decoding implements the metadata vocabulary's property checks and
normalization: link properties are resolved against `@base` (or the document
URL), natural-language properties become language maps (`und` when no
`@language`), common properties are checked against the JSON-LD restrictions
and normalized (`@id` expanded and resolved, strings to value objects), and
inherited properties are resolved column → schema → table → group.

Cells are parsed per the tabular data model: whitespace normalization,
`default`, `null`, `separator` lists, `required`, `lang`, `textDirection` and
virtual columns. Datatypes cover every built-in XSD type and the CSVW
aliases; `format` patterns for numbers (the UAX 35 subset: `0`, `#`, grouping,
`E`, `+`, `-`, `%`, `‰`, and `decimalChar` / `groupChar`), dates and times
(`yyyy`, `MM`, `M`, `dd`, `d`, `HH`, `mm`, `ss`, `S…`, `X…`, `x…`), booleans
(`true|false`) and regular expressions for other types, with `length`,
`minLength`, `maxLength` and `minimum` / `maximum` / `min|maxInclusive` /
`min|maxExclusive` constraints. URI templates (`aboutUrl`, `propertyUrl`,
`valueUrl`) are expanded with RFC 6570 level 4.

## Not yet supported

- **Locating metadata over HTTP**: `Link: rel="describedby"` headers on a
  tabular data file and a site-wide `/.well-known/csvm` configuration are not
  consulted (the default locations are, through the `Loader`). A caller that
  has fetched such metadata can pass it as `metadata`.
- **Parsing CSV text**: the `Loader` hands back parsed records; a CSV scanner
  (`@thomasfosterau/effect-csv`) will provide them.
- **Provenance**: the optional PROV triples of CSV2RDF are not generated.
- **Transformations** are decoded and annotated but not run.

## Conformance

The tests run the [W3C CSVW test suite](https://github.com/w3c/csvw/tree/gh-pages/tests)
when it is checked out under `.test-suites/csvw` (`scripts/fetch-test-suites.sh`, or set
`RDF_TEST_SUITES`). The suite's CSV files are split into records by a test-only stand-in
for `effect-csv` (`test/support/csv.ts`).

| Manifest                   | Result                    |
| -------------------------- | ------------------------- |
| `manifest-validation.ttl`  | 276 / 276 run (6 skipped) |
| `manifest-rdf.ttl` (RDF)   | 264 / 264 run (6 skipped) |
| `manifest-json.ttl` (JSON) | 264 / 264 run (6 skipped) |

RDF results are compared with `Isomorphism.isomorphic`, JSON results
structurally. The skipped tests need metadata discovery over HTTP, which this
slice does not do: `test014`, `test016`, `test120` and `test122` (an HTTP `Link`
header) and `test259` and `test260` (a site-wide `/.well-known/csvm` file).
