---
'@thomasfosterau/effect-rdf': patch
---

The ShExR reader now checks IRI, literal and language stem / stem-range values against the ShExJ schema: a malformed `sx:IriStem` and the like fails with a `ShExRError` instead of producing invalid ShExJ. `SemAct.make`'s handler record is now spelled `Record.ReadonlyRecord<string, …>` in the declarations (same type). Internals are rewritten onto Effect collections and `Option`; parsing is about 10% and validation about 11% slower.
