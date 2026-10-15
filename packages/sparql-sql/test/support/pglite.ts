/**
 * A minimal Effect `SqlClient` over PGlite (PostgreSQL compiled to WASM), so
 * that the PostgreSQL dialect can be tested without a server. It uses the
 * PostgreSQL statement compiler of `@effect/sql-pg`.
 */
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
      Effect.promise(async () => {
        const d = new PGlite();
        await d.waitReady;
        return d;
      }),
      (d) => Effect.promise(() => d.close()),
    );
    const query = (sql: string, params: ReadonlyArray<unknown>, rowMode: 'array' | 'object') =>
      Effect.tryPromise({
        try: () => db.query<any>(sql, params as Array<unknown>, { rowMode }),
        catch: (cause) =>
          new SqlError({
            reason: new UnknownError({
              cause,
              message: `${cause instanceof Error ? cause.message : 'error'} in: ${sql}`,
              operation: 'execute',
            }),
          }),
      });
    const rows = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.map(query(sql, params, 'object'), (r) => r.rows as ReadonlyArray<any>);
    const values = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.map(query(sql, params, 'array'), (r) => r.rows as ReadonlyArray<ReadonlyArray<unknown>>);
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
