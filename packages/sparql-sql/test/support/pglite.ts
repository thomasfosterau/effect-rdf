/**
 * A minimal Effect `SqlClient` over PGlite (PostgreSQL compiled to WASM), so
 * that the PostgreSQL dialect can be tested without a server. It uses the
 * PostgreSQL statement compiler of `@effect/sql-pg`.
 */
import * as Predicate from 'effect/Predicate';
import { PGlite } from '@electric-sql/pglite';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Reactivity from 'effect/reactivity/Reactivity';
import * as Semaphore from 'effect/Semaphore';
import * as SqlClient from 'effect/sql/SqlClient';
import type { Connection } from 'effect/sql/SqlConnection';
import { SqlError, UnknownError } from 'effect/sql/SqlError';
import * as Stream from 'effect/Stream';

export const layer: Layer.Layer<SqlClient.SqlClient, SqlError> = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const d = new PGlite();
          await d.waitReady;
          return d;
        },
        catch: (cause) =>
          new SqlError({
            reason: new UnknownError({ cause, message: 'PGlite failed to start' }),
          }),
      }),
      // A failure to close is a defect: there is nothing left to recover.
      (d) => Effect.orDie(Effect.tryPromise(() => d.close())),
    );
    // SAFETY: PGlite takes a mutable parameter array but does not modify it.
    const query = (sql: string, params: ReadonlyArray<unknown>, rowMode: 'array' | 'object') =>
      Effect.tryPromise({
        try: () => db.query<any>(sql, params as Array<unknown>, { rowMode }),
        catch: (cause) =>
          new SqlError({
            reason: new UnknownError({
              cause,
              message: `${Predicate.isError(cause) ? cause.message : 'error'} in: ${sql}`,
              operation: 'execute',
            }),
          }),
      });
    // SAFETY: rows in `object` mode are records keyed by column name.
    const rows = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.map(query(sql, params, 'object'), (r) => r.rows as ReadonlyArray<any>);
    // SAFETY: rows in `array` mode are arrays of column values.
    const values = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.map(
        query(sql, params, 'array'),
        (r) => r.rows as ReadonlyArray<ReadonlyArray<unknown>>,
      );
    const connection: Connection = {
      execute: (sql, params, transform) =>
        Effect.map(rows(sql, params), (r) => (transform ? transform(r) : r)),
      executeRaw: (sql, params) => query(sql, params, 'object'),
      executeStream: (sql, params) => Stream.fromIterableEffect(rows(sql, params)),
      executeValues: values,
      executeValuesUnprepared: values,
      executeUnprepared: (sql, params, transform) =>
        Effect.map(rows(sql, params), (r) => (transform ? transform(r) : r)),
    };
    const { acquirer, borrower, onCommitFailure, transactionAcquirer } =
      SqlClient.makeSqliteAcquirers({
        connection: Effect.succeed(connection),
        semaphore: yield* Semaphore.make(1),
      });
    return yield* SqlClient.make({
      acquirer,
      borrower,
      transactionAcquirer,
      onCommitFailure,
      compiler: PgClient.makeCompiler(),
      spanAttributes: [],
    });
  }),
).pipe(Layer.provide(Reactivity.layer));
