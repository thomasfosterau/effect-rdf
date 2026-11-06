/**
 * SQL dialects: the (small) differences between the databases supported by
 * the SQL store — DDL, placeholders, typed `NULL`s, string functions,
 * binary collation and `LIMIT`/`OFFSET`.
 *
 * A dialect only produces SQL text; the queries are executed through Effect's
 * `SqlClient`, so adding a database means adding a `Dialect` (and using the
 * matching `@effect/sql-*` driver).
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import type * as SqlClient from 'effect/sql/SqlClient';

/**
 * A database the store has no `Dialect` for, or table names it cannot use.
 *
 * @since 0.1.0
 * @category errors
 */
export class DialectError extends Schema.TaggedError<DialectError>()('DialectError', {
  message: Schema.String,
}) {}

/**
 * The names of the tables used by the store.
 *
 * @since 0.1.0
 * @category models
 */
export interface Tables {
  /** The term dictionary. */
  readonly terms: string;
  /** Quads of term ids. */
  readonly quads: string;
  /** Explicitly created (possibly empty) named graphs. */
  readonly graphs: string;
  /** The comparison classes of the terms in the dictionary. */
  readonly classes: string;
  /** The migrations table of the store's schema. */
  readonly migrations: string;
}

/**
 * Table names from a prefix (default `rdf_`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const tables = (prefix = 'rdf_'): Tables => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix))
    throw new DialectError({ message: `Invalid table prefix: ${prefix}` });
  return {
    terms: `${prefix}terms`,
    quads: `${prefix}quads`,
    graphs: `${prefix}graphs`,
    classes: `${prefix}term_classes`,
    migrations: `${prefix}migrations`,
  };
};

/**
 * A SQL dialect.
 *
 * @since 0.1.0
 * @category models
 */
export interface Dialect {
  readonly name: string;
  /** The placeholder of the `index`-th (1-based) parameter. */
  readonly placeholder: (index: number) => string;
  /**
   * Whether placeholders are anonymous (`?`): parameters are then bound in
   * order of appearance (and repeated for repeated uses).
   */
  readonly anonymousParameters: boolean;
  /** The schema: idempotent DDL statements. */
  readonly schema: (tables: Tables) => ReadonlyArray<string>;
  /**
   * The SQL expression of the dictionary key on the `value` column, used by
   * lookups (it must match the unique index of the term table).
   */
  readonly valueKey: (value: string) => string;
  /** A typed SQL `NULL` term id. */
  readonly nullId: string;
  /** Casts an expression to the term id type. */
  readonly castId: (sql: string) => string;
  /** Casts an expression to text. */
  readonly castText: (sql: string) => string;
  /** Casts an expression to a double. */
  readonly castDouble: (sql: string) => string;
  /** Casts an expression to an integer. */
  readonly castInt: (sql: string) => string;
  /** Applies binary (code point) collation to a text expression. */
  readonly binary: (sql: string) => string;
  /** `a` starts with `b`. */
  readonly startsWith: (a: string, b: string) => string;
  /** `a` ends with `b`. */
  readonly endsWith: (a: string, b: string) => string;
  /** `a` contains `b`. */
  readonly contains: (a: string, b: string) => string;
  /** The text contains a digit other than `0`. */
  readonly hasNonZeroDigit: (sql: string) => string;
  /** The number of characters (code points) of a text. */
  readonly length: (sql: string) => string;
  /** The `LIMIT` / `OFFSET` clause. */
  readonly limitOffset: (limit: number | undefined, offset: number) => string;
  /** The maximum number of parameters of a statement. */
  readonly maxParameters: number;
}

const ddlCommon = (t: Tables, id: string): Array<string> => [
  `CREATE INDEX IF NOT EXISTS ${t.terms}_triples ON ${t.terms} (sub, pre, obj) WHERE kind = 4`,
  `CREATE INDEX IF NOT EXISTS ${t.quads}_posg ON ${t.quads} (p, o, s, g)`,
  `CREATE INDEX IF NOT EXISTS ${t.quads}_ospg ON ${t.quads} (o, s, p, g)`,
  `CREATE INDEX IF NOT EXISTS ${t.quads}_gspo ON ${t.quads} (g, s, p, o)`,
  `CREATE TABLE IF NOT EXISTS ${t.graphs} (id ${id} PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS ${t.classes} (cls INTEGER PRIMARY KEY)`,
];

/**
 * SQLite (3.35 or later), e.g. through `@effect/sql-sqlite-node`.
 *
 * @since 0.1.0
 * @category dialects
 */
export const sqlite: Dialect = {
  name: 'sqlite',
  // Numbered `?NNN` parameters are much slower to bind with node:sqlite.
  placeholder: () => '?',
  anonymousParameters: true,
  schema: (t) => [
    `CREATE TABLE IF NOT EXISTS ${t.terms} (
  id INTEGER PRIMARY KEY,
  kind INTEGER NOT NULL,
  value TEXT NOT NULL,
  datatype TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  dir TEXT NOT NULL DEFAULT '',
  sub INTEGER,
  pre INTEGER,
  obj INTEGER,
  cls INTEGER NOT NULL,
  num REAL
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${t.terms}_key ON ${t.terms} (value, kind, datatype, lang, dir)`,
    `CREATE TABLE IF NOT EXISTS ${t.quads} (
  s INTEGER NOT NULL,
  p INTEGER NOT NULL,
  o INTEGER NOT NULL,
  g INTEGER NOT NULL,
  PRIMARY KEY (s, p, o, g)
) WITHOUT ROWID`,
    ...ddlCommon(t, 'INTEGER'),
  ],
  valueKey: (value) => value,
  nullId: 'NULL',
  castId: (sql) => sql,
  castText: (sql) => sql,
  castDouble: (sql) => sql,
  castInt: (sql) => sql,
  binary: (sql) => sql,
  startsWith: (a, b) => `(substr(${a}, 1, length(${b})) = ${b})`,
  endsWith: (a, b) =>
    `(length(${a}) >= length(${b}) AND substr(${a}, length(${a}) - length(${b}) + 1) = ${b})`,
  contains: (a, b) => `(instr(${a}, ${b}) > 0)`,
  hasNonZeroDigit: (sql) => `(${sql} GLOB '*[1-9]*')`,
  length: (sql) => `length(${sql})`,
  limitOffset: (limit, offset) =>
    limit === undefined
      ? offset > 0
        ? ` LIMIT -1 OFFSET ${offset}`
        : ''
      : ` LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ''}`,
  maxParameters: 32_000,
};

/**
 * PostgreSQL (11 or later), e.g. through `@effect/sql-pg`.
 *
 * @since 0.1.0
 * @category dialects
 */
export const postgres: Dialect = {
  name: 'pg',
  placeholder: (i) => `$${i}`,
  anonymousParameters: false,
  schema: (t) => [
    `CREATE TABLE IF NOT EXISTS ${t.terms} (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind SMALLINT NOT NULL,
  value TEXT NOT NULL,
  datatype TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  dir TEXT NOT NULL DEFAULT '',
  sub BIGINT,
  pre BIGINT,
  obj BIGINT,
  cls SMALLINT NOT NULL,
  num DOUBLE PRECISION
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${t.terms}_key ON ${t.terms} (md5(value), kind, datatype, lang, dir)`,
    `CREATE TABLE IF NOT EXISTS ${t.quads} (
  s BIGINT NOT NULL,
  p BIGINT NOT NULL,
  o BIGINT NOT NULL,
  g BIGINT NOT NULL,
  PRIMARY KEY (s, p, o, g)
)`,
    ...ddlCommon(t, 'BIGINT'),
  ],
  valueKey: (value) => `md5(${value})`,
  nullId: 'CAST(NULL AS BIGINT)',
  castId: (sql) => `CAST(${sql} AS BIGINT)`,
  castText: (sql) => `CAST(${sql} AS TEXT)`,
  castDouble: (sql) => `CAST(${sql} AS DOUBLE PRECISION)`,
  castInt: (sql) => `CAST(${sql} AS INTEGER)`,
  binary: (sql) => `(${sql} COLLATE "C")`,
  startsWith: (a, b) => `(left(${a}, length(${b})) = ${b})`,
  endsWith: (a, b) => `(right(${a}, length(${b})) = ${b})`,
  contains: (a, b) => `(strpos(${a}, ${b}) > 0)`,
  hasNonZeroDigit: (sql) => `(${sql} ~ '[1-9]')`,
  length: (sql) => `char_length(${sql})`,
  limitOffset: (limit, offset) =>
    `${limit === undefined ? '' : ` LIMIT ${limit}`}${offset > 0 ? ` OFFSET ${offset}` : ''}`,
  maxParameters: 60_000,
};

/**
 * The dialect matching a `SqlClient` (SQLite or PostgreSQL).
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromClient = (sql: SqlClient.SqlClient): Effect.Effect<Dialect, Error> =>
  sql.onDialectOrElse({
    sqlite: () => Effect.succeed(sqlite),
    pg: () => Effect.succeed(postgres),
    orElse: () =>
      Effect.fail(
        new DialectError({
          message: 'Unsupported SQL dialect: pass a Dialect to SqlStore.make for this database',
        }),
      ),
  });
