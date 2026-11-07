---
'@thomasfosterau/effect-rdf': patch
---

JSON-LD framing no longer overflows the stack on long chains. Framing embeds at most 256 levels, and a deeper chain fails with the new `JsonLdError` code `maximum nesting exceeded`. Any JSON-LD algorithm given input nested deeper than the stack allows now fails with the same code instead of a `RangeError` defect. Framing also copies values without `structuredClone`, whose native recursion overflowed first.
