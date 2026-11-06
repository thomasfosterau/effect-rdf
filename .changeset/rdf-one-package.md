---
'@thomasfosterau/effect-rdf': minor
---

effect-rdf is now the whole toolkit in one package. The syntax, SPARQL and ShEx packages (`effect-ntriples`, `effect-turtle`, `effect-n3`, `effect-jsonld`, `effect-rdfxml`, `effect-xmp`, `effect-shex`, `effect-sparql`, `effect-sparql-sql`; never published) are nested subpaths, each a barrel (`./<subpath>`) with one entry point per module (`./<subpath>/<Module>`), none of them on the root barrel:

- `@thomasfosterau/effect-rdf/ntriples`, `/turtle`, `/n3`, `/jsonld`, `/rdfxml`, `/xmp` and `/shex`;
- `@thomasfosterau/effect-rdf/sparql` (the engine, results formats, typed builder, the platform-neutral Protocol / Graph Store server `SparqlServer` with `handler`, `layerRoutes` and `layerServe`, the `Testing` harness and the client), with `/sparql/shacl` and `/sparql/ai` nested below it;
- `@thomasfosterau/effect-rdf/sparql/sql`: the driver-agnostic SQL store (`Dialect` for SQLite and PostgreSQL, `SqlStore`, `Translation`) on `effect/sql` only. `SqlStore.layerSqlite` is gone: provide a `SqlClient` (for example `@effect/sql-sqlite-node`'s) to `SqlStore.layer`. A store layer for a specific driver is a package of its own, `@thomasfosterau/effect-sparql-<driver>`.

The Node server (`SparqlServer.layer`, `layerMemory`, `ServeOptions`), the CLI and `SparqlApi` / `SparqlApiBuilder` / `SparqlApiClient` move to `@thomasfosterau/effect-sparql-node`, and `Testing.makeApiClient` becomes its `SparqlApiBuilder.makeTestClient`. Service keys follow the import paths (`@thomasfosterau/effect-rdf/sparql/SparqlEngine`, `@thomasfosterau/effect-rdf/jsonld/DocumentLoader`, …).

`effect` stays a `^4.0.0` peer. `@thomasfosterau/effect-parse` (`^0.4.0`) is an optional peer, needed only by the syntax and SPARQL-parser subpaths: the root entry, `/rdfjson`, `/csvw`, `/shacl` and `/sparql/sql` never import it. effect-rdf has no runtime dependencies.
