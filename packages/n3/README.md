# @thomasfosterau/effect-n3

Effect-idiomatic [Notation3](https://w3c.github.io/N3/spec/) for
[`@thomasfosterau/effect-rdf`](../core):

- **`Model`** — the N3 data model: core IRIs, blank nodes, literals and
  variables plus N3 `Collection`s (lists) and `Formula`s (graph terms), with
  statements allowing any term in any position.
- **`N3`** — a conformant parser (`parse` → `Model.Document`), a
  pretty-printing serializer (`serializeDocument`), and the core
  `Serialization` `parser` / `serializer` / `codec` over RDF `Dataset`s.
- **`Mapping`** — the documented mapping between N3 and RDF datasets
  (formulas ⇄ named graphs identified by blank nodes, collections ⇄
  `rdf:first`/`rdf:rest` lists).
- **`Isomorphism`** — blank-node- and variable-aware comparison of formulas.
- **`Reasoner`** — a forward-chaining reasoner for `{ … } => { … }` rules
  with a few `math:`, `string:`, `list:` and `log:` builtins.

## Usage

```ts
import { Effect } from 'effect';
import { N3, Model } from '@thomasfosterau/effect-n3';

const program = Effect.gen(function* () {
  const doc = yield* N3.parse(`
    @prefix : <http://example.org/> .
    :socrates a :Man .
    { ?x a :Man } => { ?x a :Mortal } .
  `);
  doc.formula.statements.length; // 2
  Model.variables(doc.formula); // [?x]

  // Pretty-print with the document's prefixes
  const text = N3.serializeDocument(doc);

  // RDF-compatible documents can be read as core datasets; formulas become
  // named graphs identified by blank nodes.
  const { dataset } = yield* N3.parser.parse(
    '@prefix : <http://example.org/> . :alice :believes { :bob :knows :carol } .',
  );
  // …and datasets serialise back to N3 with nested formulas.
  const n3 = yield* N3.serialize(dataset);
});
```

### Reasoning

```ts
import { Reasoner } from '@thomasfosterau/effect-n3';

const closure = yield* Reasoner.reason(doc.formula); // Formula with all inferences
```

## Mapping to RDF datasets

| N3                                  | RDF dataset                                         |
| ----------------------------------- | --------------------------------------------------- |
| top-level statement                 | quad in the default graph                           |
| formula `{ … }` (each occurrence)   | fresh blank node `_:g`; contents in named graph `_:g` |
| collection `( a b )` / `()`         | `rdf:first`/`rdf:rest` chain / `rdf:nil`            |
| variable `?x`, literal subject, non-IRI predicate | `RdfParseError` (not representable) |

Serialising a dataset writes graphs named by blank nodes that are used as
terms as nested formulas and folds well-formed lists into collections; graphs
named by IRIs, or unreferenced blank-node graphs, fail with
`RdfSerializeError`.

## Syntax notes

Following the current CG specification and its test suite:

- `<=` is `log:isImpliedBy`, `=` is `owl:sameAs`, `=>` is `log:implies`.
- `{}` (an empty formula) is the literal `true`.
- An undeclared empty prefix `:` means `<#>`.
- Blank node labels are scoped to the whole document.
- Legacy `@forAll` / `@forSome` are accepted (mapped to variables / fresh
  blank nodes); `@keywords` is rejected.
- `"…"^^i18n:ar-eg_rtl` is read (and written) as a directional
  language-tagged string.

## Conformance

`test/conformance.test.ts` runs the W3C N3 CG suite (`.test-suites/N3/tests`):
the Turtle, N3 parser and extended N3 parser manifests, positive and
negative syntax and evaluation tests. Every positive test is additionally
round-tripped through the serializer (and, where RDF-compatible, through a
core dataset). See the test file for the documented skip list.
