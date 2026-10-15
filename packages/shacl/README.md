# @thomasfosterau/effect-shacl

An Effect-native [SHACL Core](https://www.w3.org/TR/shacl/) validator for
[`@thomasfosterau/effect-rdf`](../core).

- **`Vocabulary`**: the `sh:` namespace as a typed vocabulary (`sh.NodeShape`, `sh.minCount`, …).
- **`Shapes`**: parses a shapes graph (`Dataset`) into a typed model of node and
  property shapes, targets and constraints. Ill-formed shapes graphs fail with a
  `ShapesGraphError`.
- **`Path`**: SHACL property paths (predicate, sequence, alternative, inverse,
  zero-or-more, one-or-more, zero-or-one): model, evaluation, RDF encoding.
- **`Validator`**: `validate(data, shapes, options)`, a `Validator` service and
  layer that pre-compiles a shapes graph, and a `Schema` that only accepts
  conforming datasets.
- **`ValidationReport`**: the typed report model, convertible to and from the
  standard RDF validation report graph.
- **`Sparql`**: the `SparqlConstraintEvaluator` service interface, the extension
  point for SHACL-SPARQL (`sh:sparql`, SPARQL-based constraint components,
  `sh:target`), implemented by `@thomasfosterau/effect-shacl-sparql`.
- **`Message`**: `{?var}` / `{$var}` message template substitution.

All 98 SHACL Core tests of the W3C test suite pass. The 22 `sparql/` tests
need a SPARQL evaluator and are run (and pass) by
[`@thomasfosterau/effect-shacl-sparql`](../shacl-sparql), which implements
`Sparql.SparqlConstraintEvaluator` on `@thomasfosterau/effect-sparql`.

## Validating a data graph

```ts
import { Effect } from 'effect';
import { Validator, ValidationReport } from '@thomasfosterau/effect-shacl';

const program = Effect.gen(function* () {
  // shapesGraph and dataGraph are core `Dataset`s, e.g. parsed from Turtle.
  const report = yield* Validator.validate(dataGraph, shapesGraph);
  if (!report.conforms) {
    console.log(ValidationReport.format(report));
    for (const result of report.results) {
      result.focusNode; // Term
      result.resultPath; // Option<Path>
      result.value; // Option<Term>
      result.sourceShape; // NamedNode | BlankNode
      result.sourceConstraintComponent; // e.g. sh:MinCountConstraintComponent
      result.severity; // sh:Violation | sh:Warning | sh:Info | custom
      result.messages; // sh:message values, or a default English message
    }
  }
  // The standard RDF validation report:
  const reportGraph = ValidationReport.toDataset(report);
});
```

`validate` fails with a typed error when validation cannot produce a report:
`ShapesGraphError` (ill-formed shapes graph), `RecursiveShapeError`,
`UnsupportedFeatureError` (SHACL-SPARQL without an evaluator) or
`SparqlEvaluationError`.

### Options

```ts
Validator.validate(dataGraph, shapesGraph, {
  // Validate data ∪ shapes graph (e.g. when the data graph declares sh:shapesGraph,
  // or shapes and data live in the same document).
  includeShapesGraph: true,
  // SHACL-SPARQL constructs without a SparqlConstraintEvaluator: 'fail' (default) | 'ignore'.
  sparql: 'ignore',
  // A shape reached again for the same focus node while validating it:
  // 'fail' (default, RecursiveShapeError) | 'ignore' (treat as conforming).
  recursion: 'fail',
  // Attach nested results of sh:node / sh:not / sh:and / sh:or / sh:xone as sh:detail.
  details: true,
});
```

Class-based targets (`sh:targetClass`, implicit class targets) and `sh:class`
use `rdfs:subClassOf` from the data graph, as the specification requires.

## A pre-compiled validator service

```ts
import { Effect } from 'effect';
import { Validator } from '@thomasfosterau/effect-shacl';

const program = Effect.gen(function* () {
  const validator = yield* Validator.Validator;
  const report = yield* validator.validate(dataGraph);
  const ok = yield* validator.conforms(otherGraph);
  // Fails with ConformanceError (carrying the report) unless the graph conforms.
  const checked = yield* validator.check(dataGraph);
}).pipe(Effect.provide(Validator.layer(shapesGraph)));
```

`Validator.layer` parses the shapes graph once (failing the layer with a
`ShapesGraphError` if it is ill-formed).

## As a Schema

```ts
import { Effect, Schema } from 'effect';
import { Shapes, Validator } from '@thomasfosterau/effect-shacl';

const program = Effect.gen(function* () {
  const shapes = yield* Shapes.parse(shapesGraph);
  const PersonData = Validator.schema(shapes); // Schema<Dataset, Dataset>
  const valid = yield* Schema.decodeEffect(PersonData)(dataGraph);
});
```

## Inspecting a shapes graph

```ts
const shapes = yield * Shapes.parse(shapesGraph);
for (const shape of shapes.shapes) {
  shape._tag; // 'NodeShape' | 'PropertyShape'
  shape.targets; // TargetNode | TargetClass | TargetSubjectsOf | TargetObjectsOf | SparqlTarget
  shape.constraints; // tagged union: MinCount, Datatype, Pattern, Node, Or, QualifiedMinCount, …
}
```

## SHACL-SPARQL

The core validator does not execute SPARQL. Provide a
`Sparql.SparqlConstraintEvaluator` to evaluate `sh:sparql` constraints,
SPARQL-based constraint components and `sh:target` — normally the one from
`@thomasfosterau/effect-shacl-sparql`:

```ts
import { Evaluator } from '@thomasfosterau/effect-shacl-sparql';

Validator.validate(dataGraph, shapesGraph).pipe(Effect.provide(Evaluator.layer()));
```

or a custom implementation:

```ts
import { Effect, Layer } from 'effect';
import { Sparql, Validator } from '@thomasfosterau/effect-shacl';

const EvaluatorLive = Layer.succeed(Sparql.SparqlConstraintEvaluator, {
  // One call per (shape, constraint, focus node); return the solutions as violations.
  evaluateConstraint: ({ dataGraph, shapesGraph, shape, constraint, focusNode, valueNodes }) =>
    Effect.succeed([{ value: focusNode }]),
  selectTargets: ({ dataGraph, target }) => Effect.succeed([]),
});

Validator.validate(dataGraph, shapesGraph).pipe(Effect.provide(EvaluatorLive));
```

Without an evaluator, shapes graphs using these features fail with
`UnsupportedFeatureError`, or the constructs are skipped with `{ sparql: 'ignore' }`.

## Notes

- Validating recursive shapes is undefined in SHACL; this validator detects it.
- `sh:message` templates are substituted: `{?var}` / `{$var}` refer to
  `this`, `value`, `path` and the constraint's parameters by local name
  (`{$minCount}`, `{$datatype}`, …); for SPARQL-based constraints also to
  the solution variables (`Violation.bindings`). Unknown placeholders are
  left as they are.
- Literal comparisons (`sh:minInclusive`, `sh:lessThan`, …) follow SPARQL `<`:
  numerics across types, strings, booleans, date/time values (with the 14-hour
  timezone rule) and durations; incomparable values are violations.
