/**
 * A SQLite-backed store for the tests: the driver-agnostic `SqlStore.layer`
 * over `@effect/sql-sqlite-node` (a core devDependency only, never a runtime
 * dependency or peer). `filename` may be `":memory:"`. Also provides the
 * `SqlClient`.
 */
import * as Layer from 'effect/Layer';
import type * as SqlClient from 'effect/sql/SqlClient';
import type * as SqlError from 'effect/sql/SqlError';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import type * as Store from '../../../../src/sparql/Store.ts';
import * as SqlStore from '../../../../src/sparql/sql/SqlStore.ts';

export const layerSqlite = (
  options: SqlStore.SqlStoreOptions & { readonly filename: string },
): Layer.Layer<
  SqlStore.SqlStore | Store.QuadStore | SqlClient.SqlClient,
  Store.StoreError | SqlError.SqlError
> =>
  SqlStore.layer(options).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: options.filename })),
  );
