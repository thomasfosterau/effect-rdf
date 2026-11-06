/**
 * The driver-agnostic SQL storage layer of `@thomasfosterau/effect-rdf/sparql`,
 * built on Effect's SQL abstraction (`effect/sql` only): a term dictionary
 * and quad tables, a `QuadStore` implementation and SPARQL-to-SQL
 * translation, in the SQLite and PostgreSQL dialects. It runs over the
 * `SqlClient` in the context; a backend for a specific driver is its own
 * package, `@thomasfosterau/effect-sparql-<driver>`.
 *
 * @since 0.1.0
 */

/** @since 0.1.0 */
export * as Dialect from './Dialect.ts';
/** @since 0.1.0 */
export * as SqlStore from './SqlStore.ts';
/** @since 0.1.0 */
export * as Translation from './Translation.ts';
