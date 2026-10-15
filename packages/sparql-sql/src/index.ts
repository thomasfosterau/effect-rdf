/**
 * A swappable SQL storage backend for `@thomasfosterau/effect-sparql`, built
 * on Effect's SQL abstraction: a term dictionary and quad tables, a
 * `QuadStore` implementation and SPARQL-to-SQL translation (SQLite and
 * PostgreSQL).
 *
 * @since 0.1.0
 */

/** @since 0.1.0 */
export * as Dialect from './Dialect.ts';
/** @since 0.1.0 */
export * as SqlStore from './SqlStore.ts';
/** @since 0.1.0 */
export * as Translation from './Translation.ts';
