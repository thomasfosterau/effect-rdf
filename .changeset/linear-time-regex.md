---
'@thomasfosterau/effect-rdf': minor
---

Patterns that arrive in the data are now matched in bounded time (a ReDoS fix). SPARQL `REGEX` / `REPLACE`, SHACL `sh:pattern`, ShEx `pattern`, CSVW string `format` and the N3 `string:matches` / `notMatches` / `replace` / `scrape` built-ins no longer compile their pattern with `new RegExp`: effect-rdf parses it and runs it on its own matcher, so `FILTER REGEX(?s, "^(a+)+$")` over a long literal takes time linear in the literal instead of pinning the thread, and the SPARQL server's time limit holds.

- A pattern without back-references or lookahead costs at most (compiled size × input length) steps. One with a back-reference or lookahead runs under a step budget; running out is an expression error in SPARQL and a non-match in SHACL, ShEx, CSVW and N3.
- A pattern that compiles to more than 10,000 instructions (counted repetition is expanded: `(a{100}){100}`), nests groups more than 200 deep, or uses lookbehind is rejected as invalid.
- SPARQL and SHACL patterns now have the XPath / XML Schema meaning the specifications give them, as ShEx patterns already had: `\d`, `\w` and `\s` are the Unicode classes, `.` excludes only `\n` and `\r`, and `\i`, `\c`, class subtraction (`[a-z-[aeiou]]`) and `\p{IsGreek}` work. `\b`, `\B`, lookahead and the JavaScript character escapes are still accepted.
- In a repeated group, an inner group keeps the text it last matched (as XPath has it) where JavaScript reset it on each iteration; this shows only in `$n` references of CSVW-style ECMAScript patterns and the N3 built-ins.

**Breaking:** `/shacl`'s `Shapes.Constraint` member `Pattern` carries `test: (value: string) => boolean` in place of `regex: RegExp`, and `/sparql`'s `Functions.compileRegex` is no longer exported.
