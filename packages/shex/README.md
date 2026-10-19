# @thomasfosterau/effect-shex

[ShEx (Shape Expressions)](https://shex.io/shex-semantics/) for
[`@thomasfosterau/effect-rdf`](../core), written with Effect.

- **ShExJ** (`ShExJ`): the abstract syntax as plain immutable values, with
  Effect `Schema`s to decode, validate and encode ShExJ JSON. `resolveIris`
  resolves the relative IRIs in a ShExJ document.
- **ShExC** (`ShExC`): a hand-written parser for the compact syntax. It
  handles `BASE`/`PREFIX`/`IMPORT`, `start=`, `EXTERNAL`, node kinds,
  datatypes, every string and numeric facet, regular expressions with flags
  and escapes, value sets with IRI, literal and language stems, ranges and
  exclusions, `$label` and `&include`, inverse `^`, every cardinality form,
  annotations `//`, semantic actions `%iri{ code %}`, and the ShEx 2.2
  `ABSTRACT`, `EXTENDS` and `RESTRICTS`. Errors are `RdfParseError`s with line
  and column. The lexer and the grammar (over the lexer's tokens) are
  compiled `@thomasfosterau/effect-parse` parsers; `pnpm bench` times them on
  the shexTest schemas and a large synthetic schema. `ShExC.print` writes a
  schema back as ShExC.
- **ShExR** (`ShExR`): reads a schema from a core `Dataset` that holds its RDF
  representation, and writes one (`toQuads` / `toDataset`).
- **Structural checks** (`Structure`): every reference resolves, inclusions
  name triple expressions, no shape refers to itself except through a triple
  constraint, no reference cycle passes through negation (`NOT` or `EXTRA`),
  and the extension hierarchy has no cycles.
- **ShapeMaps** (`ShapeMap`): the compact syntax for fixed maps
  (`node@shape`, `node@START`), query maps with `{FOCUS p _}` / `{_ p FOCUS}`
  selectors, and the JSON form. The compact syntax is parsed with
  [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
  (a peer dependency, next to `effect`). Errors are `RdfParseError`s with
  line and column.
- **Validation** (`Validator`): the ShEx 2.1 semantics plus ShEx 2.2
  `EXTENDS`/`ABSTRACT`/`RESTRICTS`.
  - Triple expressions are matched by searching for a partition of the
    neighbourhood, then checking the bag of triple-constraint counts against
    `EachOf`/`OneOf`/cardinalities with a bag-derivative algorithm.
  - `CLOSED` and `EXTRA` are supported.
  - Recursion uses the maximal typing: it is evaluated coinductively and
    memoised, and stratified negation is guaranteed by the structural checks.
  - Imports are loaded through the `SchemaLoader` service.
  - Semantic actions go to a pluggable `SemAct.SemActHandler`. Unknown actions
    are ignored, and the ShEx Test extension is included.

## Validating data

```ts
import { Effect } from 'effect';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { ShapeMap, ShExC, Validator } from '@thomasfosterau/effect-shex';

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);

const program = Effect.gen(function* () {
  const schema = yield* ShExC.parse(`
    PREFIX ex: <http://example.org/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    start = @ex:Person
    ex:Person CLOSED {
      ex:name xsd:string MINLENGTH 1 ;
      ex:age xsd:integer MININCLUSIVE 0 ? ;
      ex:knows @ex:Person *
    }
  `);

  const data = Dataset.make(
    Term.quad(ex('alice'), ex('name'), Term.literal('Alice')),
    Term.quad(ex('alice'), ex('knows'), ex('bob')),
    Term.quad(ex('bob'), ex('name'), Term.literal('Bob')),
  );

  // A shape map: fixed associations or triple-pattern queries.
  const map = yield* ShapeMap.parse('{FOCUS ex:name _}@START, ex:alice@ex:Person', {
    prefixes: { ex: 'http://example.org/' },
  });

  const report = yield* Validator.validate(data, schema, map);
  for (const r of report.results) {
    console.log(r.node.key, ShapeMap.formatShape(r.shape), r.status, r.reason ?? '');
  }
  return report.conformant;
});
```

`Validator.validate` returns
`Effect<ValidationReport, ShExValidationError | ShExImportError | ShExStructureError>`.
The report has one `ShapeResult` (`conformant` or `nonconformant`, with a
`reason`) for each association. If you validate many shape maps against the
same schema, call `Validator.make(schema)` once and reuse the validator. It
loads the imports and runs the structural checks a single time.

## Imports

`IMPORT` is resolved through the `SchemaLoader` reference. By default it fails
on every import, so provide a loader:

```ts
const loader: Validator.Loader = {
  load: (iri) =>
    fetchText(iri).pipe(
      Effect.flatMap((text) => ShExC.parse(text, { baseIri: iri })),
      Effect.mapError((e) => new ShExError.ShExImportError({ iri, message: String(e) })),
    ),
};

Validator.validate(data, schema, map).pipe(Effect.provide(Validator.loaderLayer(loader)));
```

`Validator.loaderFromRecord({ iri: schema })` serves schemas you already have
in memory.

## Semantic actions

```ts
import { Option } from 'effect';
import { SemAct } from '@thomasfosterau/effect-shex';

// Dispatch on action names (a name ending in / or # covers its namespace).
const handler = SemAct.make({
  'http://example.org/ext/check': (code, ctx) => ctx.triple !== undefined && code !== 'reject',
});

Validator.validate(data, schema, map).pipe(
  Effect.provideService(
    SemAct.SemActHandler,
    SemAct.combine(
      handler,
      SemAct.testExtension((line) => console.log(line)),
    ),
  ),
);
```

Pass `externalSemActs` to supply code for actions written as `%<name>%`. Pass
`externalShapes` to supply definitions for `EXTERNAL` shapes.

## Other representations

```ts
const json = ShExJ.stringify(schema); // ShExJ text
const back = yield * ShExJ.parse(json); // decoded and validated with Effect Schema
const shexc = ShExC.print(schema, { prefixes }); // ShExC text
const rdf = ShExR.toDataset(schema); // ShExR as a Dataset
const fromRdf = yield * ShExR.fromDataset(rdf);
```

## Conformance

The tests run the [shexTest](https://github.com/shexSpec/shexTest) suite when
it is checked out under `.test-suites/shexTest` (or set `RDF_TEST_SUITES`):

| Suite                                               | Result                                |
| --------------------------------------------------- | ------------------------------------- |
| `schemas`: ShExC → ShExJ                            | 484 / 484                             |
| `schemas`: ShExJ → ShExC → ShExJ (printer)          | 484 / 484                             |
| `schemas`: ShExR → ShExJ, and ShExJ → ShExR → ShExJ | 482 / 484 each (2 skipped, see below) |
| `negativeSyntax`                                    | 105 / 105                             |
| `negativeStructure`                                 | 19 / 19                               |
| `validation` (status, plus Test-extension output)   | 1309 / 1309                           |

These two ShExR tests are skipped because the RDF is ambiguous. In both, a
labelled triple expression is used in several places, and RDF cannot record
which use defines it: `1Include1` and `ShExR`. The `TwoNegation_pass`
representation test is not checked structurally, because its schema
deliberately breaks the negation requirement.
