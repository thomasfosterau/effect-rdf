# @thomasfosterau/effect-rdf-grammar

Building blocks for the RDF syntaxes, written with
[`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse).

Many RDF grammars are defined in terms of others: TriG and N3 extend
Turtle, SPARQL shares Turtle's terminals, and ShExC and the SPARQL results
TSV format reuse them in turn. This package holds those shared pieces once,
under the names the grammars give them, so that each syntax package builds
its grammar from the same parts.

```sh
pnpm add @thomasfosterau/effect-rdf-grammar @thomasfosterau/effect-parse effect
```

## `Terminals`

| Parser                                           | Grammar terminal                | Value                                        |
| ------------------------------------------------ | ------------------------------- | -------------------------------------------- |
| `iriRef`                                         | `IRIREF`                        | the IRI, `UCHAR`s decoded (not resolved)     |
| `prefixedName`                                   | `PNAME_LN`, `PNAME_NS`          | `{ prefix, local }`, `PN_LOCAL_ESC`s decoded |
| `pnPrefix`, `pnLocal`, `plx`                     | `PN_PREFIX`, `PN_LOCAL`, `PLX`  | the text                                     |
| `blankNodeLabel`                                 | `BLANK_NODE_LABEL`              | the label after `_:`                         |
| `langTag`, `langDir`                             | `LANGTAG`, `LANG_DIR` (RDF 1.2) | the tag, or `{ language, direction }`        |
| `stringLiteral` (and the four forms)             | `STRING_LITERAL_QUOTE`, …       | the value, `ECHAR`s and `UCHAR`s decoded     |
| `integer`, `decimal`, `double`, `numericLiteral` | `INTEGER`, `DECIMAL`, `DOUBLE`  | the lexical form (and datatype)              |
| `booleanLiteral`                                 | `'true'`, `'false'`             | the keyword                                  |
| `uchar`, `echar`                                 | `UCHAR`, `ECHAR`                | the character                                |
| `ws`, `comment`, `skip`                          | `WS`, comments                  | —                                            |

The character classes (`pnCharsBase`, `pnCharsU`, `pnChars`, `hex`,
`iriExcluded`, …) are token sets for `Token.oneOf`, `Token.takeWhile` and
so on, and `dottedTail` builds the "may contain dots, but not at the end"
runs of `PN_PREFIX`, `PN_LOCAL` and `BLANK_NODE_LABEL`.

```ts
import { Terminals } from '@thomasfosterau/effect-rdf-grammar';
import * as Parser from '@thomasfosterau/effect-parse/Parser';

// A Turtle-style `iri`: an IRIREF or a prefixed name, after whitespace.
const iri = Parser.preceded(
  Terminals.skip,
  Parser.alt(
    Terminals.iriRef.pipe(Parser.map((value) => ({ _tag: 'IriRef', value }) as const)),
    Terminals.prefixedName.pipe(Parser.map((name) => ({ _tag: 'PName', ...name }) as const)),
  ),
);

Parser.parse(iri, '  ex:alice'); // Result.succeed({ _tag: 'PName', prefix: 'ex', local: 'alice' })
```

The parsers neither skip whitespace (except `skip`) nor resolve IRIs: each
grammar adds its own whitespace and comments, and resolves prefixed names and
relative IRIs, typically in a pass after parsing so that the grammar itself
can be compiled with `Parser.compile`.

## Conformance

The terminals are exercised by the conformance suites of the packages built
on them: `effect-shex` (shexTest) and `effect-n3` (the W3C N3 suites).
