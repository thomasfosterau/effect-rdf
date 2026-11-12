---
'@thomasfosterau/effect-rdf': minor
---

Public maps and sets are Effect's immutable `HashMap` / `HashSet` instead of native `ReadonlyMap` / `ReadonlySet` (the `effect/avoid-native-object-helpers` lint rule is now an error).

**Breaking.** Changed public types:

| Module                      | Field                                                    | Was                                   | Now                               |
| --------------------------- | -------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| `PrefixMap`                 | `PrefixMap.prefixes`                                     | `ReadonlyMap<string, string>`         | `HashMap<string, string>`         |
| `Isomorphism`               | `bijection` result                                       | `Option<ReadonlyMap<string, string>>` | `Option<HashMap<string, string>>` |
| `Xsd`                       | `numericDatatypes`                                       | `ReadonlySet<string>`                 | `HashSet<string>`                 |
| `/shex` `Structure`         | `SchemaIndex.shapes`, `.tripleExprs`, `.descendants`     | `ReadonlyMap<string, …>`              | `HashMap<string, …>`              |
| `/shacl` `Shapes`           | `ShapesGraph.index`                                      | `ReadonlyMap<string, Shape>`          | `HashMap<string, Shape>`          |
| `/shacl` `Sparql`           | `Violation.bindings`                                     | `ReadonlyMap<string, GroundTerm>`     | `HashMap<string, GroundTerm>`     |
| `/rdfxml` `Xml`             | `Element.inScopeNamespaces`                              | `ReadonlyMap<string, string>`         | `HashMap<string, string>`         |
| `/rdfxml` `Xml`             | `DocumentType.entities`                                  | `ReadonlyMap<string, string>`         | `HashMap<string, string>`         |
| `/sparql` `Algebra`         | `variables`, `certainVariables`, `expressionVariables`   | `ReadonlySet<string>`                 | `HashSet<string>`                 |
| `/sparql/shacl` `Query`     | `optionalPrebound`                                       | `ReadonlySet<string>`                 | `HashSet<string>`                 |
| `/sparql/sql` `Translation` | `CompiledQuery.locals`                                   | `ReadonlyMap<number, GroundTerm>`     | `HashMap<number, GroundTerm>`     |
| `/sparql/sql` `Translation` | `CompiledQuery.localClasses`, `isRisky`'s `storeClasses` | `ReadonlySet<number>`                 | `HashSet<number>`                 |

Migration: `map.get(k)` becomes `HashMap.get(map, k)` (an `Option`), `map.has(k)` / `set.has(a)` become `HashMap.has(map, k)` / `HashSet.has(set, a)`, `map.size` becomes `HashMap.size(map)`; both are still `Iterable`, so `[...map]` and `for … of` work.

A `HashMap` has no insertion order. Writers that declare prefixes (Turtle, TriG, N3, RDF/XML, ShExC, XMP, JSON-LD contexts) now emit them sorted by prefix, and `PrefixMap.compact` breaks a tie between two prefixes for equally long namespaces by choosing the smaller prefix. `PrefixMap.entries` returns the entries sorted by prefix.
