# @thomasfosterau/effect-turtle

RDF 1.2 [Turtle](https://www.w3.org/TR/rdf12-turtle/) and
[TriG](https://www.w3.org/TR/rdf12-trig/) for
[`@thomasfosterau/effect-rdf`](../core).

- Full RDF 1.2 grammar: triple terms `<<( s p o )>>`, reified triples
  `<< s p o ~ r >>`, annotations `{| ... |}`, `VERSION`, base direction, plus
  RDF 1.1 documents.
- `parse` returns the dataset, the declared prefixes and the final base IRI;
  `parseQuads` returns statements in document order.
- `parseStream` is incremental: statements are emitted as soon as they are
  complete, whatever the chunk boundaries.
- Pretty serializers: prefixed names (from `prefixes`, optionally
  `autoPrefixes`), `@base` relativisation, `;`/`,` grouping, `a`, inline `[]`
  blank nodes, `( ... )` collections, numeric/boolean shorthand, annotation
  syntax for reified asserted triples, deterministic order.
  `serializeStream` writes in constant memory (grouping consecutive
  statements only).
- Passes every W3C rdf11/rdf12 Turtle and TriG syntax and evaluation test, and
  every positive test round-trips through the serializers.

```ts
import { Effect } from 'effect';
import { Turtle, TriG } from '@thomasfosterau/effect-turtle';

const program = Effect.gen(function* () {
  const { dataset, prefixes, baseIri } = yield* Turtle.parse(`
    PREFIX ex: <http://example.org/>
    ex:alice a ex:Person ;
      ex:knows [ ex:name "Bob" ] ;
      ex:age 42 {| ex:source ex:census |} .
  `);
  return yield* Turtle.serialize(dataset, { prefixes, autoPrefixes: true });
});
```

## Grammar

`Grammar` exposes the Turtle grammar's terminals as
[`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
parsers (a peer dependency, next to `effect`), for the grammars that include
them: N3 (`effect-n3`) and ShExC (`effect-shex`) are built on them.

| Parser                                           | Terminal                           | Value                                        |
| ------------------------------------------------ | ---------------------------------- | -------------------------------------------- |
| `iriRef`                                         | `IRIREF`                           | the IRI, `UCHAR`s decoded (not resolved)     |
| `prefixedName`                                   | `PNAME_LN`, `PNAME_NS`             | `{ prefix, local }`, `PN_LOCAL_ESC`s decoded |
| `pnPrefix`, `pnLocal`, `plx`                     | `PN_PREFIX`, `PN_LOCAL`, `PLX`     | the text                                     |
| `blankNodeLabel`                                 | `BLANK_NODE_LABEL`                 | the label after `_:`                         |
| `langTag`, `langDir`                             | `LANGTAG`, `LANG_DIR`              | the tag, or `{ language, direction }`        |
| `stringLiteral` (and the four forms)             | `STRING_LITERAL_QUOTE`, …          | the value, escapes decoded                   |
| `integer`, `decimal`, `double`, `numericLiteral` | `INTEGER`, `DECIMAL`, `DOUBLE`     | the lexical form (and datatype)              |
| `uchar`, `echar`, `booleanLiteral`               | `UCHAR`, `ECHAR`, `true` / `false` | the character or keyword                     |
| `ws`, `comment`, `skip`                          | `WS`, comments                     | —                                            |

The character classes (`pnCharsBase`, `pnCharsU`, `pnChars`, `hex`, …) are
token sets for `Token.oneOf` / `Token.takeWhile`. The parsers neither skip
whitespace (except `skip`) nor resolve IRIs: a grammar adds its own
whitespace and resolves names, typically after parsing so that it can be
compiled.

```ts
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import { Grammar } from '@thomasfosterau/effect-turtle';

const iri = Parser.preceded(Grammar.skip, Parser.alt(Grammar.iriRef, Grammar.prefixedName));
Parser.parse(iri, '  ex:alice'); // Result.succeed({ prefix: 'ex', local: 'alice' })
```

## Test manifests

`Manifest` reads W3C test manifests (following `mf:include`) and is meant for
other packages' conformance tests:

```ts
import * as fs from 'node:fs';
import { Effect } from 'effect';
import { Manifest } from '@thomasfosterau/effect-turtle';

const read = Manifest.fileReader('https://w3c.github.io/rdf-tests/', '/path/to/rdf-tests/', (p) =>
  Effect.sync(() => fs.readFileSync(p, 'utf8')),
);
const entries = Effect.runSync(
  Manifest.load('https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-turtle/manifest.ttl', read),
);
// entries: { id, kind: 'TestTurtleEval', name, action: Option<iri>, result: Option<iri>, dataset, ... }
```
