# @thomasfosterau/effect-shacl-sparql

[SHACL-SPARQL](https://www.w3.org/TR/shacl/#sparql-constraints) for
[`@thomasfosterau/effect-shacl`](../shacl), evaluated with the
[`@thomasfosterau/effect-sparql`](../sparql) engine. It implements the
`Sparql.SparqlConstraintEvaluator` service that the SHACL validator delegates
SPARQL features to, so `effect-shacl` itself stays free of a SPARQL
dependency.

- **`Evaluator`**: `Evaluator.layer(options?)` / `Evaluator.make(options?)`
  providing the evaluator.
- **`Query`**: reading `sh:select` / `sh:ask` queries with their prefix
  declarations, the pre-binding restrictions and `$PATH` substitution.

Supported:

- SPARQL-based constraints (`sh:sparql` with `sh:select`, `sh:message`,
  `sh:deactivated`) on node and property shapes;
- SPARQL-based constraint components: parameters (mandatory and
  `sh:optional`), `sh:nodeValidator` / `sh:propertyValidator` (SELECT) and
  `sh:validator` (ASK), validator and component messages;
- SPARQL-based targets (`sh:SPARQLTarget`) and target types
  (`sh:SPARQLTargetType` with parameters) from SHACL Advanced Features;
- pre-bound `$this`, `$value` (ASK validators), `$currentShape`,
  `$shapesGraph` and parameters, with the exact pre-binding semantics of the
  specification (values insertion, see `Algebra.prebind` in
  `effect-sparql`) and its restrictions: `MINUS`, `VALUES`, `SERVICE`,
  `AS ?prebound` and sub-queries that drop pre-bound variables are failures;
- `$PATH` substitution with the property shape's path (any other use of
  `$PATH` is a failure);
- prefixes via `sh:prefixes` / `owl:imports` / `sh:declare` (conflicting
  declarations are failures);
- the result variables `?this`, `?value`, `?path`, `?message` and `?failure`;
- `{?var}` / `{$param}` placeholders in messages (substituted by the
  validator from the solution and parameters).

## Usage

```ts
import { Effect } from 'effect';
import { ValidationReport, Validator } from '@thomasfosterau/effect-shacl';
import { Evaluator } from '@thomasfosterau/effect-shacl-sparql';
import { Turtle } from '@thomasfosterau/effect-turtle';

const program = Effect.gen(function* () {
  const { dataset: shapes } = yield* Turtle.parse(`
    @prefix sh: <http://www.w3.org/ns/shacl#> .
    @prefix ex: <http://example.org/> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    ex: sh:declare [ sh:prefix "ex" ; sh:namespace "http://example.org/"^^xsd:anyURI ] .

    ex:PersonShape a sh:NodeShape ;
      sh:targetClass ex:Person ;
      sh:sparql [
        sh:prefixes ex: ;
        sh:message "{$this} is their own parent" ;
        sh:select """
          SELECT $this WHERE { $this ex:parent $this }
        """ ;
      ] .
  `);
  const { dataset: data } = yield* Turtle.parse(`
    @prefix ex: <http://example.org/> .
    ex:alice a ex:Person ; ex:parent ex:alice .
  `);
  const report = yield* Validator.validate(data, shapes);
  console.log(ValidationReport.format(report));
}).pipe(Effect.provide(Evaluator.layer()));
```

### Constraint components

```turtle
ex:MaxWordsComponent a sh:ConstraintComponent ;
  sh:parameter [ sh:path ex:maxWords ] ;
  sh:message "Value has more than {$maxWords} words" ;
  sh:validator [
    a sh:SPARQLAskValidator ;
    sh:ask """ASK { FILTER (strlen(replace(str($value), "[^ ]", "")) < $maxWords) }""" ;
  ] .

ex:BookShape a sh:NodeShape ;
  sh:targetClass ex:Book ;
  sh:property [ sh:path ex:title ; ex:maxWords 8 ] .
```

### Options

```ts
Evaluator.layer({
  // The IRI of the named graph holding the shapes graph ($shapesGraph).
  shapesGraphIri: 'urn:x-shacl:shapesGraph',
  // Options of the SPARQL engine, e.g. extension functions.
  engine: { functions },
});
```

The data graph is the default graph of the queried dataset (named graphs of
the data are merged into it, as the core validator sees them). Per data graph
the evaluator builds one in-memory store and caches compiled queries.

## Conformance

The W3C SHACL test suite (`.test-suites/data-shapes`, or
`$RDF_TEST_SUITES`): all **22 / 22** SHACL-SPARQL tests (`sparql/`: node,
property, component and pre-binding tests) pass, and all 98 Core tests pass
with the evaluator installed.
