/**
 * A SQL storage backend for the SPARQL engine, built on Effect's SQL
 * abstraction (`effect/sql`).
 *
 * The store keeps a dictionary of interned terms (RDF 1.2 triple terms
 * included, referencing their components) and a table of quads of term ids
 * indexed in four orders (`spog`, `posg`, `ospg`, `gspo`). It implements the
 * `QuadStore` service of `@thomasfosterau/effect-sparql` — streaming pattern
 * matching, statistics, updates, named graph management and transactions
 * (mapped to `SqlClient.withTransaction`) — and a `QueryCapability` that
 * translates SPARQL algebra to SQL (see `Translation`), so that the engine
 * runs whole queries (or the largest translatable subtrees) in the database.
 *
 * SQLite (via `@effect/sql-sqlite-node`, `layerSqlite`) and PostgreSQL (via
 * `@effect/sql-pg`, providing a `SqlClient` to `layer`) are supported.
 *
 * @since 0.1.0
 */
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Migrator from 'effect/sql/Migrator';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SqlError from 'effect/sql/SqlError';
import * as Stream from 'effect/Stream';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Algebra from '@thomasfosterau/effect-sparql/Algebra';
import * as B from '@thomasfosterau/effect-sparql/Bindings';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import * as Dialect from './Dialect.ts';
import * as Enc from './internal/encoding.ts';
import * as Translation from './Translation.ts';

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * An event reported to `SqlStoreOptions.onQuery` for every algebra node the
 * engine offers to the store: either it was translated to SQL and executed,
 * or it was declined (and evaluated by the engine).
 *
 * @since 0.1.0
 * @category models
 */
export type QueryEvent =
  | {
      readonly _tag: 'Executed';
      readonly operation: Algebra.Operation;
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
      readonly rows: number;
    }
  | {
      readonly _tag: 'Declined';
      readonly operation: Algebra.Operation;
      readonly reason: string;
    };

/**
 * Options of the SQL store.
 *
 * @since 0.1.0
 * @category models
 */
export interface SqlStoreOptions {
  /** The SQL dialect; detected from the `SqlClient` by default. */
  readonly dialect?: Dialect.Dialect | undefined;
  /** The prefix of the table names (default `rdf_`). */
  readonly tablePrefix?: string | undefined;
  /** Whether to create / migrate the schema when the store is built (default `true`). */
  readonly migrate?: boolean | undefined;
  /** Whether to translate SPARQL algebra to SQL (default `true`). */
  readonly translate?: boolean | undefined;
  /** The number of quads per insert / delete statement (default 500). */
  readonly batchSize?: number | undefined;
  /** The number of quads per page of `match` (default 5000). */
  readonly pageSize?: number | undefined;
  /** Debug hook: called for every algebra node offered to the store. */
  readonly onQuery?: ((event: QueryEvent) => void) | undefined;
}

/**
 * The SQL store: a `QuadStore` with native SPARQL-to-SQL evaluation and some
 * SQL-specific extras.
 *
 * @since 0.1.0
 * @category models
 */
export interface SqlStoreShape extends Store.QuadStoreShape {
  readonly dialect: Dialect.Dialect;
  readonly tables: Dialect.Tables;
  /** The native algebra evaluation (also available as `query`). */
  readonly capability: Store.QueryCapability;
  /**
   * Translates an algebra tree for the given evaluation context, resolving
   * constants against the dictionary (for inspection and debugging).
   */
  readonly compile: (
    op: Algebra.Operation,
    context?: Partial<Pick<Store.EvaluationContext, 'dataset' | 'activeGraph'>>,
  ) => Effect.Effect<Result.Result<Translation.CompiledQuery, string>, Store.StoreError>;
  /** The number of terms in the dictionary. */
  readonly termCount: Effect.Effect<number, Store.StoreError>;
}

/**
 * The SQL store service.
 *
 * @since 0.1.0
 * @category services
 */
export class SqlStore extends Context.Service<SqlStore, SqlStoreShape>()(
  '@thomasfosterau/effect-sparql-sql/SqlStore',
) {}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const storeError = (message: string) => (cause: unknown) =>
  cause instanceof Store.StoreError
    ? cause
    : new Store.StoreError({
        message: `${message}: ${Predicate.isError(cause) ? cause.message : String(cause)}`,
        cause,
      });

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const num = (v: unknown): number => (Predicate.isNumber(v) ? v : Number(v));
const str = (v: unknown): string =>
  Predicate.isString(v) ? v : v === null || v === undefined ? '' : String(v as number);

const depth = (t: Term.GroundTerm): number =>
  t._tag === 'Triple'
    ? 1 +
      Math.max(
        depth(t.subject as Term.GroundTerm),
        depth(t.predicate),
        depth(t.object as Term.GroundTerm),
      )
    : 0;

const CACHE_LIMIT = 200_000;

const DEFAULT_DATASET: Store.DatasetSpec = { defaultGraph: 'default', namedGraphs: 'all' };

/**
 * The schema migrations of the store (for `effect/sql/Migrator`): a record of
 * `<id>_<name>` to migration effect.
 *
 * @since 0.1.0
 * @category schema
 */
export const migrations = (dialect: Dialect.Dialect, tables: Dialect.Tables) => ({
  '1_create_rdf_store': Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forEach(dialect.schema(tables), (statement) => sql.unsafe(statement), {
      concurrency: 1,
      discard: true,
    });
  }),
});

/**
 * Creates or migrates the store's schema.
 *
 * @since 0.1.0
 * @category schema
 */
export const migrate = (
  options: Pick<SqlStoreOptions, 'dialect' | 'tablePrefix'> = {},
): Effect.Effect<void, Store.StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = options.dialect ?? (yield* Dialect.fromClient(sql));
    const tables = Dialect.tables(options.tablePrefix);
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(migrations(dialect, tables)),
      table: tables.migrations,
    });
  }).pipe(Effect.mapError(storeError('Migration failed')));

// -----------------------------------------------------------------------------
// Constructor
// -----------------------------------------------------------------------------

interface DecodeState {
  readonly known: Map<number, Term.GroundTerm>;
  readonly triples: Map<number, readonly [number, number, number]>;
}

/**
 * The term with id `id` of a decode state that `complete` has filled: every
 * id is known, so a missing one is a defect.
 */
const termOf = (state: DecodeState, id: number): Term.GroundTerm => {
  const known = state.known.get(id);
  if (known !== undefined) return known;
  const comps = state.triples.get(id);
  if (comps === undefined) throw new Store.StoreError({ message: `Unknown term id ${id}` });
  const t = Term.triple(
    termOf(state, comps[0]) as Term.Subject,
    termOf(state, comps[1]) as Term.Predicate,
    termOf(state, comps[2]) as Term.Object,
  );
  state.known.set(id, t);
  return t;
};

/**
 * Creates a SQL store over the `SqlClient` service.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  options: SqlStoreOptions = {},
): Effect.Effect<SqlStoreShape, Store.StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect =
      options.dialect ??
      (yield* Effect.mapError(Dialect.fromClient(sql), storeError('Unsupported database')));
    const tables = Dialect.tables(options.tablePrefix);
    if (options.migrate !== false) yield* migrate({ dialect, tablePrefix: options.tablePrefix });

    const T = tables.terms;
    const Qt = tables.quads;
    const Gt = tables.graphs;
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 1000));
    const pageSize = Math.max(1, options.pageSize ?? 5000);
    const onQuery = options.onQuery;
    const ph = dialect.placeholder;

    // Caches of the (append-only) dictionary, only filled outside transactions.
    const idCache = new Map<string, number>();
    const termCache = new Map<number, Term.GroundTerm>();

    const inTransaction = Effect.map(Effect.serviceOption(sql.transactionService), Option.isSome);

    const run = (text: string, params: ReadonlyArray<unknown> = []) =>
      sql.unsafe(text, params).values;
    const exec = (text: string, params: ReadonlyArray<unknown> = []) =>
      Effect.asVoid(sql.unsafe(text, params).raw);

    // --- term dictionary ------------------------------------------------------

    /** The dictionary key of a `id, kind, value, datatype, lang, dir` result row. */
    const rowKeyOf = (r: ReadonlyArray<unknown>) =>
      Enc.rowKey({
        kind: num(r[1]),
        value: str(r[2]),
        datatype: str(r[3]),
        lang: str(r[4]),
        dir: str(r[5]),
      });

    const lookupRows = (rows: ReadonlyArray<Enc.TermRow>) => {
      const found = new Map<string, number>();
      const values = Array.from(new Set(rows.map((r) => r.value)));
      return Effect.as(
        Effect.forEach(
          chunks(values, 500),
          (chunk) => {
            const list = chunk
              .map((_, i) => dialect.valueKey(dialect.castText(ph(i + 1))))
              .join(', ');
            return Effect.map(
              run(
                `SELECT id, kind, value, datatype, lang, dir FROM ${T} WHERE ${dialect.valueKey('value')} IN (${list})`,
                chunk,
              ),
              (result) => {
                for (const r of result) {
                  found.set(rowKeyOf(r), num(r[0]));
                }
              },
            );
          },
          { concurrency: 1, discard: true },
        ),
        found,
      );
    };

    /** Inserts dictionary rows; returns the ids of the rows that were new. */
    const insertRows = (rows: ReadonlyArray<Enc.TermRow>) =>
      Effect.gen(function* () {
        const inserted = new Map<string, number>();
        yield* Effect.forEach(
          chunks(rows, 500),
          Effect.fnUntraced(function* (chunk) {
            const params: Array<unknown> = [];
            const tuples = chunk.map((r) => {
              const base = params.length;
              params.push(
                r.kind,
                r.value,
                r.datatype,
                r.lang,
                r.dir,
                r.sub,
                r.pre,
                r.obj,
                r.cls,
                r.num,
              );
              return `(${Array.from({ length: 10 }, (_, i) => {
                const p = ph(base + i + 1);
                return i >= 1 && i <= 4
                  ? dialect.castText(p)
                  : i === 9
                    ? dialect.castDouble(p)
                    : dialect.castId(p);
              }).join(', ')})`;
            });
            const result = yield* run(
              `INSERT INTO ${T} (kind, value, datatype, lang, dir, sub, pre, obj, cls, num) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING RETURNING id, kind, value, datatype, lang, dir`,
              params,
            );
            for (const r of result) {
              inserted.set(rowKeyOf(r), num(r[0]));
            }
          }),
          { concurrency: 1, discard: true },
        );
        const classes = Array.from(new Set(rows.map((r) => r.cls)));
        if (classes.length > 0) {
          yield* exec(
            `INSERT INTO ${tables.classes} (cls) VALUES ${classes.map((c) => `(${c})`).join(', ')} ON CONFLICT DO NOTHING`,
          );
        }
        return inserted;
      });

    /**
     * The dictionary rows of one depth level of terms; a triple term whose
     * components have no id yet is left out.
     */
    const encodeLevel = (
      level: ReadonlyMap<string, Term.GroundTerm>,
      ids: ReadonlyMap<string, number>,
    ) => {
      const rows: Array<{ readonly term: Term.GroundTerm; readonly row: Enc.TermRow }> = [];
      for (const t of level.values()) {
        if (t._tag === 'Triple') {
          const s = ids.get(t.subject.key);
          const p = ids.get(t.predicate.key);
          const o = ids.get(t.object.key);
          if (s === undefined || p === undefined || o === undefined) continue;
          rows.push({ term: t, row: Enc.encode(t, [s, p, o]) });
        } else rows.push({ term: t, row: Enc.encode(t) });
      }
      return rows;
    };

    /**
     * The ids of dictionary rows by key. With `create`, rows are inserted first
     * (new rows come back with their ids) and the rest looked up.
     */
    const findIds = (rows: ReadonlyArray<Enc.TermRow>, create: boolean) =>
      Effect.gen(function* () {
        if (!create) return yield* lookupRows(rows);
        const found = yield* insertRows(rows);
        const existing = rows.filter((r) => !found.has(Enc.rowKey(r)));
        if (existing.length > 0) {
          const more = yield* lookupRows(existing);
          for (const [k, id] of more) found.set(k, id);
        }
        return found;
      });

    /**
     * The dictionary ids of terms (by key). With `create`, missing terms are
     * interned; otherwise they are absent from the result.
     */
    const resolveTerms = (terms: Iterable<Term.GroundTerm>, create: boolean) =>
      Effect.gen(function* () {
        const cacheable = !(yield* inTransaction);
        const result = new Map<string, number>();
        const levels: Array<Map<string, Term.GroundTerm>> = [];
        const add = (t: Term.GroundTerm) => {
          if (result.has(t.key)) return;
          const cached = idCache.get(t.key);
          if (cached !== undefined) {
            result.set(t.key, cached);
            return;
          }
          const d = depth(t);
          while (levels.length <= d) levels.push(new Map());
          if (levels[d]!.has(t.key)) return;
          levels[d]!.set(t.key, t);
          if (t._tag === 'Triple') {
            add(t.subject as Term.GroundTerm);
            add(t.predicate);
            add(t.object as Term.GroundTerm);
          }
        };
        for (const t of terms) add(t);
        yield* Effect.forEach(
          levels,
          Effect.fnUntraced(function* (level) {
            const rows = encodeLevel(level, result);
            if (rows.length === 0) return;
            const found = yield* findIds(
              rows.map((r) => r.row),
              create,
            );
            for (const { term, row } of rows) {
              const id = found.get(Enc.rowKey(row));
              if (id === undefined) continue;
              result.set(term.key, id);
              if (cacheable) {
                if (idCache.size >= CACHE_LIMIT) idCache.clear();
                idCache.set(term.key, id);
              }
            }
          }),
          { concurrency: 1, discard: true },
        );
        return result;
      });

    // --- decoding -------------------------------------------------------------

    const newState = (): DecodeState => ({ known: new Map(), triples: new Map() });

    /**
     * Records the term with id `id` whose `kind, value, datatype, lang, dir`
     * columns start at `row[at]` (`kind` is null for an id with no term row).
     */
    const addRow = (state: DecodeState, id: number, row: ReadonlyArray<unknown>, at: number) => {
      if (state.known.has(id) || state.triples.has(id)) return;
      const cached = termCache.get(id);
      if (cached !== undefined) {
        state.known.set(id, cached);
        return;
      }
      const kind = row[at];
      if (kind === null || kind === undefined) return;
      const t = Enc.decode(
        num(kind),
        str(row[at + 1]),
        str(row[at + 2]),
        str(row[at + 3]),
        str(row[at + 4]),
      );
      if (Array.isArray(t)) state.triples.set(id, t as readonly [number, number, number]);
      else state.known.set(id, t as Term.GroundTerm);
    };

    /** Reads the dictionary rows of `ids` (one chunk) into a decode state. */
    const fetchTerms = (state: DecodeState, ids: ReadonlyArray<number>) =>
      Effect.map(
        run(
          `SELECT id, kind, value, datatype, lang, dir FROM ${T} WHERE id IN (${ids.join(', ')})`,
        ),
        (rows) => {
          for (const r of rows) addRow(state, num(r[0]), r, 1);
        },
      );

    const isResolved = (state: DecodeState, c: number) =>
      state.known.has(c) || state.triples.has(c);

    /** Fetches the components of the triple terms of a decode state, until none is missing. */
    const complete = (
      state: DecodeState,
    ): Effect.Effect<void, Store.StoreError | SqlError.SqlError> =>
      Effect.suspend(() => {
        const missing = new Set<number>();
        for (const comps of state.triples.values()) {
          for (const c of comps) if (!isResolved(state, c)) missing.add(c);
        }
        for (const c of missing) {
          const cached = termCache.get(c);
          if (cached !== undefined) {
            state.known.set(c, cached);
            missing.delete(c);
          }
        }
        if (missing.size === 0) return Effect.void;
        return Effect.forEach(
          chunks(Array.from(missing), 500),
          (chunk) =>
            Effect.flatMap(fetchTerms(state, chunk), () => {
              const unknown = chunk.find((c) => !isResolved(state, c));
              return unknown === undefined
                ? Effect.void
                : Effect.fail(new Store.StoreError({ message: `Unknown term id ${unknown}` }));
            }),
          { concurrency: 1, discard: true },
        ).pipe(Effect.flatMap(() => complete(state)));
      });

    const remember = (state: DecodeState) =>
      Effect.map(inTransaction, (inTx) => {
        if (inTx) return;
        if (termCache.size + state.known.size > CACHE_LIMIT) termCache.clear();
        for (const [id, t] of state.known) termCache.set(id, t);
      });

    // --- quads ------------------------------------------------------------------

    const graphId = (g: Term.Graph, ids: ReadonlyMap<string, number>): number | undefined =>
      g._tag === 'DefaultGraph' ? 0 : ids.get(g.key);

    const patternConditions = (pattern: Store.QuadPattern) =>
      Effect.gen(function* () {
        const terms: Array<Term.GroundTerm> = [];
        for (const t of [pattern.subject, pattern.predicate, pattern.object, pattern.graph]) {
          if (t !== undefined && t._tag !== 'DefaultGraph') terms.push(t as Term.GroundTerm);
        }
        const ids = yield* resolveTerms(terms, false);
        const conds: Array<readonly [string, number]> = [];
        const positions = [
          ['s', pattern.subject],
          ['p', pattern.predicate],
          ['o', pattern.object],
          ['g', pattern.graph],
        ] as const;
        for (const [column, t] of positions) {
          if (t === undefined) continue;
          const id = t._tag === 'DefaultGraph' ? 0 : ids.get(t.key);
          if (id === undefined) return Option.none<ReadonlyArray<readonly [string, number]>>();
          conds.push([column, id]);
        }
        return Option.some<ReadonlyArray<readonly [string, number]>>(conds);
      });

    const INDEXES = [
      ['s', 'p', 'o', 'g'],
      ['p', 'o', 's', 'g'],
      ['o', 's', 'p', 'g'],
      ['g', 's', 'p', 'o'],
    ] as const;

    const indexFor = (bound: ReadonlySet<string>): ReadonlyArray<string> => {
      let best: ReadonlyArray<string> = INDEXES[0];
      let bestPrefix = -1;
      for (const idx of INDEXES) {
        let n = 0;
        while (n < idx.length && bound.has(idx[n]!)) n++;
        if (n > bestPrefix) {
          best = idx;
          bestPrefix = n;
        }
      }
      return best;
    };

    const decodeQuads = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
      Effect.gen(function* () {
        const state = newState();
        for (const r of rows) {
          for (let i = 0; i < 4; i++) {
            const id = num(r[i]);
            if (i === 3 && id === 0) continue;
            const base = 4 + i * 5;
            addRow(state, id, r, base);
          }
        }
        yield* complete(state);
        yield* remember(state);
        return rows.map((r) => {
          const g = num(r[3]);
          return new Term.Quad(
            termOf(state, num(r[0])) as Term.Subject,
            termOf(state, num(r[1])) as Term.Predicate,
            termOf(state, num(r[2])) as Term.Object,
            g === 0 ? Term.defaultGraph : (termOf(state, g) as Term.NamedNode | Term.BlankNode),
          );
        });
      });

    const match = (pattern: Store.QuadPattern): Stream.Stream<Term.Quad, Store.StoreError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const conds = yield* patternConditions(pattern);
          if (Option.isNone(conds)) return Stream.empty;
          const bound = new Set(conds.value.map(([c]) => c));
          const order = indexFor(bound);
          const where = conds.value.map(([c, id]) => `${c} = ${id}`);
          const attrs = ['s', 'p', 'o', 'g']
            .map((c) => `m${c}.kind, m${c}.value, m${c}.datatype, m${c}.lang, m${c}.dir`)
            .join(', ');
          const joins = ['s', 'p', 'o', 'g']
            .map((c) => ` LEFT JOIN ${T} m${c} ON m${c}.id = q.${c}`)
            .join('');
          const page = (after: ReadonlyArray<number> | undefined) => {
            const w = [...where];
            if (after !== undefined) {
              w.push(`(${order.join(', ')}) > (${after.join(', ')})`);
            }
            return `SELECT q.s, q.p, q.o, q.g, ${attrs} FROM (SELECT s, p, o, g FROM ${Qt}${w.length > 0 ? ` WHERE ${w.join(' AND ')}` : ''} ORDER BY ${order.join(', ')} LIMIT ${pageSize}) q${joins}`;
          };
          return Stream.paginate(undefined as ReadonlyArray<number> | undefined, (after) =>
            Effect.gen(function* () {
              const rows = yield* run(page(after));
              const quads = yield* decodeQuads(rows);
              const last = rows[rows.length - 1];
              const next =
                rows.length < pageSize || last === undefined
                  ? Option.none<ReadonlyArray<number>>()
                  : Option.some(order.map((c) => num(last[['s', 'p', 'o', 'g'].indexOf(c)])));
              return [quads, next] as const;
            }),
          );
        }),
      ).pipe(Stream.mapError(storeError('match failed')));

    const countWhere = (pattern: Store.QuadPattern, limit: number | undefined) =>
      Effect.gen(function* () {
        const conds = yield* patternConditions(pattern);
        if (Option.isNone(conds)) return 0;
        const where = conds.value.map(([c, id]) => `${c} = ${id}`);
        const filter = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
        const rows = yield* run(
          limit === undefined
            ? `SELECT COUNT(*) FROM ${Qt}${filter}`
            : `SELECT COUNT(*) FROM (SELECT 1 FROM ${Qt}${filter} LIMIT ${limit}) x`,
        );
        return num(rows[0]?.[0] ?? 0);
      }).pipe(Effect.mapError(storeError('count failed')));

    const quadIds = (quads: Iterable<Term.Quad>, create: boolean) =>
      Effect.gen(function* () {
        const list = Array.from(quads);
        const terms: Array<Term.GroundTerm> = [];
        for (const q of list) {
          terms.push(q.subject, q.predicate, q.object);
          if (q.graph._tag !== 'DefaultGraph') terms.push(q.graph);
        }
        const ids = yield* resolveTerms(terms, create);
        const out: Array<readonly [number, number, number, number]> = [];
        for (const q of list) {
          const s = ids.get(q.subject.key);
          const p = ids.get(q.predicate.key);
          const o = ids.get(q.object.key);
          const g = graphId(q.graph, ids);
          if (s === undefined || p === undefined || o === undefined || g === undefined) continue;
          out.push([s, p, o, g]);
        }
        return out;
      });

    const tuples = (rows: ReadonlyArray<readonly [number, number, number, number]>) => {
      const params: Array<number> = [];
      const text = rows
        .map((r) => {
          const base = params.length;
          params.push(...r);
          return `(${r.map((_, i) => dialect.castId(ph(base + i + 1))).join(', ')})`;
        })
        .join(', ');
      return { text, params };
    };

    /** Runs one statement per `batchSize` quad-id rows, `statement` building it from the tuples. */
    const execBatches = (
      rows: ReadonlyArray<readonly [number, number, number, number]>,
      statement: (tuplesText: string) => string,
    ) =>
      Effect.forEach(
        chunks(rows, batchSize),
        (chunk) => {
          const { text, params } = tuples(chunk);
          return exec(statement(text), params);
        },
        { concurrency: 1, discard: true },
      );

    const insert = (quads: Iterable<Term.Quad>) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const list = Array.from(quads);
            yield* Effect.forEach(
              chunks(list, batchSize * 4),
              (batch) =>
                Effect.flatMap(quadIds(batch, true), (rows) =>
                  execBatches(
                    rows,
                    (text) =>
                      `INSERT INTO ${Qt} (s, p, o, g) VALUES ${text} ON CONFLICT DO NOTHING`,
                  ),
                ),
              { concurrency: 1, discard: true },
            );
          }),
        )
        .pipe(Effect.mapError(storeError('insert failed')));

    const del = (quads: Iterable<Term.Quad>) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* quadIds(quads, false);
            yield* execBatches(
              rows,
              (text) => `DELETE FROM ${Qt} WHERE (s, p, o, g) IN (VALUES ${text})`,
            );
          }),
        )
        .pipe(Effect.mapError(storeError('delete failed')));

    const decodeIds = (ids: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const state = newState();
        yield* Effect.forEach(chunks(ids, 500), (chunk) => fetchTerms(state, chunk), {
          concurrency: 1,
          discard: true,
        });
        yield* complete(state);
        yield* remember(state);
        return ids.map((id) => termOf(state, id));
      });

    const graphs: Stream.Stream<Term.NamedNode | Term.BlankNode, Store.StoreError> = Stream.unwrap(
      Effect.gen(function* () {
        const rows = yield* run(
          `SELECT id FROM ${Gt} UNION SELECT DISTINCT g FROM ${Qt} WHERE g <> 0`,
        );
        const terms = yield* decodeIds(rows.map((r) => num(r[0])));
        return Stream.fromArray(terms as ReadonlyArray<Term.NamedNode | Term.BlankNode>);
      }),
    ).pipe(Stream.mapError(storeError('graphs failed')));

    const graphIdOf = (graph: Term.NamedNode | Term.BlankNode, create: boolean) =>
      Effect.map(resolveTerms([graph], create), (ids) => ids.get(graph.key));

    const hasGraph = (graph: Term.NamedNode | Term.BlankNode) =>
      Effect.gen(function* () {
        const id = yield* graphIdOf(graph, false);
        if (id === undefined) return false;
        const rows = yield* run(
          `SELECT 1 WHERE EXISTS (SELECT 1 FROM ${Gt} WHERE id = ${id}) OR EXISTS (SELECT 1 FROM ${Qt} WHERE g = ${id})`,
        );
        return rows.length > 0;
      }).pipe(Effect.mapError(storeError('hasGraph failed')));

    const createGraph = (graph: Term.NamedNode | Term.BlankNode) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const id = yield* graphIdOf(graph, true);
            if (id === undefined) return;
            yield* exec(`INSERT INTO ${Gt} (id) VALUES (${id}) ON CONFLICT DO NOTHING`);
          }),
        )
        .pipe(Effect.mapError(storeError('createGraph failed')));

    const dropGraph = (graph: Term.NamedNode | Term.BlankNode) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const id = yield* graphIdOf(graph, false);
            if (id === undefined) return;
            yield* exec(`DELETE FROM ${Qt} WHERE g = ${id}`);
            yield* exec(`DELETE FROM ${Gt} WHERE id = ${id}`);
          }),
        )
        .pipe(Effect.mapError(storeError('dropGraph failed')));

    const clear = (graph: Term.Graph) =>
      Effect.gen(function* () {
        const id = graph._tag === 'DefaultGraph' ? 0 : yield* graphIdOf(graph, false);
        if (id === undefined) return;
        yield* exec(`DELETE FROM ${Qt} WHERE g = ${id}`);
      }).pipe(Effect.mapError(storeError('clear failed')));

    const transaction = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | Store.StoreError, R> =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.mapError((e) =>
            SqlError.isSqlError(e) ? storeError('transaction failed')(e) : (e as E),
          ),
        );

    // --- SPARQL to SQL ------------------------------------------------------------

    const storeClasses = Effect.map(
      run(`SELECT cls FROM ${tables.classes}`),
      (rows) => new Set(rows.map((r) => num(r[0]))),
    );

    const translationContext = (
      context: Partial<Pick<Store.EvaluationContext, 'dataset' | 'activeGraph'>> | undefined,
    ): Translation.TranslationContext => ({
      dialect,
      tables,
      dataset: context?.dataset ?? DEFAULT_DATASET,
      activeGraph: context?.activeGraph ?? { _tag: 'DefaultGraph' },
    });

    const compile: SqlStoreShape['compile'] = (op, context) =>
      Effect.gen(function* () {
        const ctx = translationContext(context);
        const ids = yield* resolveTerms(Translation.constants(op, ctx), false);
        return Translation.compile(op, ctx, (t) => ids.get(t.key));
      }).pipe(Effect.mapError(storeError('compile failed')));

    const decodeSolutions = (
      compiled: Translation.CompiledQuery,
      rows: ReadonlyArray<ReadonlyArray<unknown>>,
    ) =>
      Effect.gen(function* () {
        const state = newState();
        for (const [id, t] of compiled.locals) state.known.set(id, t);
        for (const r of rows) {
          let i = 0;
          for (const c of compiled.columns) {
            if (c.type === 'int') {
              i += 1;
              continue;
            }
            const v = r[i];
            if (v !== null && v !== undefined) {
              const id = num(v);
              if (id > 0) addRow(state, id, r, i + 1);
            }
            i += 6;
          }
        }
        yield* complete(state);
        for (const [id] of compiled.locals) state.known.delete(id);
        yield* remember(state);
        for (const [id, t] of compiled.locals) state.known.set(id, t);
        return rows.map((r) => {
          const map = new Map<string, Term.GroundTerm>();
          let i = 0;
          for (const c of compiled.columns) {
            const v = r[i];
            if (c.type === 'int') {
              if (v !== null && v !== undefined) {
                map.set(c.variable, new Term.Literal(str(v), INTEGER));
              }
              i += 1;
              continue;
            }
            if (v !== null && v !== undefined) map.set(c.variable, termOf(state, num(v)));
            i += 6;
          }
          return new B.Bindings(map);
        });
      });

    const declined = new WeakSet<Algebra.Operation>();

    const capability: Store.QueryCapability = {
      evaluate: (op, context) => {
        if (options.translate === false) return Option.none();
        if (declined.has(op)) {
          declined.delete(op);
          return Option.none();
        }
        const ctx = translationContext(context);
        const check = Translation.compile(op, ctx, () => undefined);
        if (Result.isFailure(check)) {
          onQuery?.({ _tag: 'Declined', operation: op, reason: check.failure });
          return Option.none();
        }
        const stream: Stream.Stream<B.Bindings, Store.StoreError> = Stream.unwrap(
          Effect.gen(function* () {
            const ids = yield* resolveTerms(Translation.constants(op, ctx), false);
            const compiled = Translation.compile(op, ctx, (t) => ids.get(t.key));
            if (Result.isFailure(compiled)) {
              return yield* new Store.StoreError({ message: compiled.failure });
            }
            const q = compiled.success;
            if (q.risks.length > 0 && Translation.isRisky(q, yield* storeClasses)) {
              onQuery?.({
                _tag: 'Declined',
                operation: op,
                reason: 'The data contains values SQL cannot compare exactly',
              });
              declined.add(op);
              return Stream.mapError(context.evaluate(op), storeError('evaluation failed'));
            }
            const rows = yield* run(q.sql, q.params).pipe(
              Effect.withSpan('SqlStore.query', { attributes: { 'db.query.text': q.sql } }),
            );
            onQuery?.({
              _tag: 'Executed',
              operation: op,
              sql: q.sql,
              params: q.params,
              rows: rows.length,
            });
            return Stream.fromArray(yield* decodeSolutions(q, rows));
          }).pipe(Effect.mapError(storeError('SQL query failed'))),
        );
        return Option.some(stream);
      },
    };

    const termCount = Effect.map(run(`SELECT COUNT(*) FROM ${T}`), (rows) =>
      num(rows[0]?.[0] ?? 0),
    ).pipe(Effect.mapError(storeError('termCount failed')));

    const store: SqlStoreShape = {
      dialect,
      tables,
      capability,
      compile,
      termCount,
      match,
      estimate: (pattern) => countWhere(pattern, 10_000),
      count: (pattern) => countWhere(pattern, undefined),
      graphs,
      hasGraph,
      insert,
      delete: del,
      createGraph,
      dropGraph,
      clear,
      transaction,
      query: capability,
    };
    return store;
  });

const INTEGER = Term.namedNode('http://www.w3.org/2001/XMLSchema#integer');

// -----------------------------------------------------------------------------
// Layers
// -----------------------------------------------------------------------------

/**
 * A layer providing the SQL store as both `SqlStore` and the engine's
 * `QuadStore` (whose `query` is the SPARQL-to-SQL `QueryCapability`), over
 * the `SqlClient` service.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  options: SqlStoreOptions = {},
): Layer.Layer<SqlStore | Store.QuadStore, Store.StoreError, SqlClient.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(options), (store) =>
      Context.make(SqlStore, store).pipe(Context.add(Store.QuadStore, store)),
    ),
  );

/**
 * A SQLite-backed store (via `@effect/sql-sqlite-node`); `filename` may be
 * `":memory:"`. Also provides the `SqlClient`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerSqlite = (
  options: SqlStoreOptions & { readonly filename: string },
): Layer.Layer<
  SqlStore | Store.QuadStore | SqlClient.SqlClient,
  Store.StoreError | SqlError.SqlError
> => layer(options).pipe(Layer.provideMerge(SqliteClient.layer({ filename: options.filename })));
