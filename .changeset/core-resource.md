---
'@thomasfosterau/effect-rdf': minor
---

New `Resource` module (`@thomasfosterau/effect-rdf/Resource`): map the resources of a `Dataset` to typed records with Effect `Schema`. `Resource.property(predicate, codec, { inverse?, languages? })` annotates a struct field with its predicate, `Resource.describe({ type?, id? })` gives the struct an `rdf:type` and an id field, and `Resource.list(codec)` reads an RDF collection. A field's cardinality comes from its schema (a plain codec: exactly one value; `Schema.optional`: at most one; `Schema.Array`: any number in `Term.Order`), and a struct-valued field is a nested resource. `Resource.decode`, `Resource.decodeAll` (every resource of the described type) and `Resource.encode` (to quads) fail with a `SchemaError` at the field's path; `Resource.schema(struct)` is the same mapping as a `Schema` from `{ dataset, subject }`.
