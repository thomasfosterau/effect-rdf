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
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Order from 'effect/Order';
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

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/** The distinct values of `items`, in order of first occurrence. */
const distinct = <A extends string | number>(items: Iterable<A>): Array<A> =>
  Arr.fromIterable(MutableHashSet.fromIterable(items));

const num = (v: unknown): number => (Predicate.isNumber(v) ? v : Number(v));
// The text columns come back as strings; a count or other numeric cell as a number (or a bigint);
// a missing cell is nullish and reads as the empty string.
const str = (v: unknown): string =>
  Predicate.isString(v)
    ? v
    : Predicate.isNumber(v) || Predicate.isBigInt(v) || Predicate.isBoolean(v)
      ? `${v}`
      : '';

const depth = (t: Term.GroundTerm): number =>
  Term.isTriple(t) ? 1 + Math.max(depth(t.subject), depth(t.predicate), depth(t.object)) : 0;

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
  readonly known: MutableHashMap.MutableHashMap<number, Term.GroundTerm>;
  readonly triples: MutableHashMap.MutableHashMap<number, Enc.ComponentIds>;
}

/** Term ids by term key. */
type Ids = MutableHashMap.MutableHashMap<string, number>;

/**
 * The term with id `id` of a decode state that `complete` has filled: every
 * id is known, so a missing one is a defect.
 */
const termOf = (state: DecodeState, id: number): Term.GroundTerm => {
  const known = MutableHashMap.get(state.known, id);
  if (Option.isSome(known)) return known.value;
  const comps = MutableHashMap.get(state.triples, id);
  if (Option.isNone(comps)) throw new Store.StoreError({ message: `Unknown term id ${id}` });
  const [s, p, o] = comps.value;
  const t = Term.triple(
    termAs(state, s, isSubject, 'subject'),
    termAs(state, p, Term.isNamedNode, 'predicate'),
    termOf(state, o),
  );
  MutableHashMap.set(state.known, id, t);
  return t;
};

/**
 * The term with id `id`, which the store only ever wrote in a position of
 * kind `T` (so another kind is a defect).
 */
const termAs = <T extends Term.GroundTerm>(
  state: DecodeState,
  id: number,
  is: Predicate.Refinement<Term.GroundTerm, T>,
  position: string,
): T => {
  const t = termOf(state, id);
  if (is(t)) return t;
  throw new Store.StoreError({ message: `Term id ${id} cannot be a ${position}` });
};

// A ground term is a subject unless it is a literal, and a graph name unless it is also not a
// triple term (the fewest checks, as these run for every decoded quad).
const isSubject = (t: Term.GroundTerm): t is Term.Subject => !Term.isLiteral(t);

const isGraphName = (t: Term.GroundTerm): t is Term.NamedNode | Term.BlankNode =>
  !Term.isLiteral(t) && !Term.isTriple(t);

/** The dictionary key of a `id, kind, value, datatype, lang, dir` result row. */
const rowKeyOf = (r: ReadonlyArray<unknown>) =>
  Enc.rowKey({
    kind: num(r[1]),
    value: str(r[2]),
    datatype: str(r[3]),
    lang: str(r[4]),
    dir: str(r[5]),
  });

/** A term to intern, its dictionary row and the row's key. */
interface Encoded {
  readonly term: Term.GroundTerm;
  readonly row: Enc.TermRow;
  readonly key: string;
}

/** A dictionary row and its id, if it has one. */
interface Found {
  readonly encoded: Encoded;
  readonly id: Option.Option<number>;
}

const withKey = (term: Term.GroundTerm, row: Enc.TermRow): Encoded => ({
  term,
  row,
  key: Enc.rowKey(row),
});

/**
 * The dictionary rows of one depth level of terms; a triple term whose
 * components have no id yet is left out.
 */
const encodeLevel = (
  level: MutableHashMap.MutableHashMap<string, Term.GroundTerm>,
  ids: Ids,
): Array<Encoded> =>
  Arr.filterMap(MutableHashMap.values(level), (t): Result.Result<Encoded, void> => {
    if (!Term.isTriple(t)) return Result.succeed(withKey(t, Enc.encode(t)));
    const s = MutableHashMap.get(ids, t.subject.key);
    const p = MutableHashMap.get(ids, t.predicate.key);
    const o = MutableHashMap.get(ids, t.object.key);
    return Option.isSome(s) && Option.isSome(p) && Option.isSome(o)
      ? Result.succeed(withKey(t, Enc.encode(t, [s.value, p.value, o.value])))
      : Result.failVoid;
  });

const newState = (): DecodeState => ({
  known: MutableHashMap.empty(),
  triples: MutableHashMap.empty(),
});

const isResolved = (state: DecodeState, c: number) =>
  Option.isSome(MutableHashMap.get(state.known, c)) ||
  Option.isSome(MutableHashMap.get(state.triples, c));

/** The id of a term or graph (`0` for the default graph), if it has one. */
const idIn = (ids: Ids, t: Term.GroundTerm | Term.DefaultGraph): Option.Option<number> =>
  Term.isDefaultGraph(t) ? Option.some(0) : MutableHashMap.get(ids, t.key);

/** The `s, p, o, g` ids of a quad, if all its terms have one. */
const quadRow = (
  ids: Ids,
  q: Term.Quad,
): Result.Result<readonly [number, number, number, number], void> => {
  const s = MutableHashMap.get(ids, q.subject.key);
  const p = MutableHashMap.get(ids, q.predicate.key);
  const o = MutableHashMap.get(ids, q.object.key);
  const g = idIn(ids, q.graph);
  return Option.isSome(s) && Option.isSome(p) && Option.isSome(o) && Option.isSome(g)
    ? Result.succeed([s.value, p.value, o.value, g.value] as const)
    : Result.failVoid;
};

const INDEXES = [
  ['s', 'p', 'o', 'g'],
  ['p', 'o', 's', 'g'],
  ['o', 's', 'p', 'g'],
  ['g', 's', 'p', 'o'],
] as const;

/** The number of leading columns of an index that are bound. */
const boundPrefix = (idx: ReadonlyArray<string>, bound: MutableHashSet.MutableHashSet<string>) => {
  const i = idx.findIndex((c) => !MutableHashSet.has(bound, c));
  return i < 0 ? idx.length : i;
};

/** The index whose longest prefix of columns is bound (the first on a tie). */
interface BestIndex {
  readonly best: ReadonlyArray<string>;
  readonly prefix: number;
}

const indexFor = (bound: MutableHashSet.MutableHashSet<string>): ReadonlyArray<string> => {
  const first: BestIndex = { best: INDEXES[0], prefix: -1 };
  return Arr.reduce(INDEXES, first, (acc, idx): BestIndex => {
    const n = boundPrefix(idx, bound);
    return n > acc.prefix ? { best: idx, prefix: n } : acc;
  }).best;
};

/** Where an output column of a compiled query starts in its result rows. */
interface ColumnAt {
  readonly column: Translation.OutputColumn;
  readonly at: number;
}

const columnLayout = (columns: ReadonlyArray<Translation.OutputColumn>): ReadonlyArray<ColumnAt> =>
  Arr.mapAccum(columns, 0, (at, column) => [
    at + (column.type === 'int' ? 1 : 6),
    { column, at },
  ])[1];

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
    const idCache: Ids = MutableHashMap.empty();
    const termCache = MutableHashMap.empty<number, Term.GroundTerm>();

    const inTransaction = Effect.map(Effect.serviceOption(sql.transactionService), Option.isSome);

    const run = (text: string, params: ReadonlyArray<unknown> = []) =>
      sql.unsafe(text, params).values;
    const exec = (text: string, params: ReadonlyArray<unknown> = []) =>
      Effect.asVoid(sql.unsafe(text, params).raw);

    // --- term dictionary ------------------------------------------------------

    const lookupRows = (rows: ReadonlyArray<Encoded>) => {
      const found: Ids = MutableHashMap.empty();
      const values = distinct(rows.map((r) => r.row.value));
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
              (result) =>
                result.forEach((r) => {
                  MutableHashMap.set(found, rowKeyOf(r), num(r[0]));
                }),
            );
          },
          { concurrency: 1, discard: true },
        ),
        found,
      );
    };

    /** Inserts dictionary rows; returns the ids of the rows that were new. */
    const insertRows = (rows: ReadonlyArray<Encoded>) =>
      Effect.gen(function* () {
        const inserted: Ids = MutableHashMap.empty();
        yield* Effect.forEach(
          chunks(rows, 500),
          Effect.fnUntraced(function* (chunk) {
            const params: Array<unknown> = [];
            const tuples = chunk.map(({ row: r }) => {
              const base = params.length;
              // An absent component or number is SQL `NULL`.
              params.push(
                r.kind,
                r.value,
                r.datatype,
                r.lang,
                r.dir,
                Option.getOrNull(r.sub),
                Option.getOrNull(r.pre),
                Option.getOrNull(r.obj),
                r.cls,
                Option.getOrNull(r.num),
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
            result.forEach((r) => {
              MutableHashMap.set(inserted, rowKeyOf(r), num(r[0]));
            });
          }),
          { concurrency: 1, discard: true },
        );
        const classes = distinct(rows.map((r) => r.row.cls));
        if (Arr.isReadonlyArrayNonEmpty(classes)) {
          yield* exec(
            `INSERT INTO ${tables.classes} (cls) VALUES ${classes.map((c) => `(${c})`).join(', ')} ON CONFLICT DO NOTHING`,
          );
        }
        return inserted;
      });

    /**
     * The ids of dictionary rows (none for a row not in the dictionary). With
     * `create`, rows are inserted first (new rows come back with their ids) and
     * the rest looked up.
     */
    const findIds = (rows: ReadonlyArray<Encoded>, create: boolean) =>
      Effect.gen(function* () {
        if (!create) {
          const found = yield* lookupRows(rows);
          return rows.map((encoded): Found => ({
            encoded,
            id: MutableHashMap.get(found, encoded.key),
          }));
        }
        const inserted = yield* insertRows(rows);
        const first = rows.map((encoded): Found => ({
          encoded,
          id: MutableHashMap.get(inserted, encoded.key),
        }));
        const existing = first.filter(({ id }) => Option.isNone(id)).map(({ encoded }) => encoded);
        if (Arr.isReadonlyArrayEmpty(existing)) return first;
        const more = yield* lookupRows(existing);
        return first.map((f): Found =>
          Option.isSome(f.id)
            ? f
            : { encoded: f.encoded, id: MutableHashMap.get(more, f.encoded.key) },
        );
      });

    /**
     * The dictionary ids of terms (by key). With `create`, missing terms are
     * interned; otherwise they are absent from the result.
     */
    const resolveTerms = (terms: Iterable<Term.GroundTerm>, create: boolean) =>
      Effect.gen(function* () {
        const cacheable = !(yield* inTransaction);
        const result: Ids = MutableHashMap.empty();
        // The terms to look up by depth (components before the triple terms using them).
        const levels = MutableHashMap.empty<
          number,
          MutableHashMap.MutableHashMap<string, Term.GroundTerm>
        >();
        const levelAt = (d: number) => {
          const found = MutableHashMap.get(levels, d);
          if (Option.isSome(found)) return found.value;
          const level = MutableHashMap.empty<string, Term.GroundTerm>();
          MutableHashMap.set(levels, d, level);
          return level;
        };
        const add = (t: Term.GroundTerm): void => {
          if (Option.isSome(MutableHashMap.get(result, t.key))) return;
          const cached = MutableHashMap.get(idCache, t.key);
          if (Option.isSome(cached)) {
            MutableHashMap.set(result, t.key, cached.value);
            return;
          }
          const level = levelAt(depth(t));
          if (Option.isSome(MutableHashMap.get(level, t.key))) return;
          MutableHashMap.set(level, t.key, t);
          if (Term.isTriple(t)) {
            add(t.subject);
            add(t.predicate);
            add(t.object);
          }
        };
        Arr.fromIterable(terms).forEach((t) => add(t));
        const depths = Arr.sort(MutableHashMap.keys(levels), Order.Number);
        yield* Effect.forEach(
          depths,
          Effect.fnUntraced(function* (d) {
            const rows = encodeLevel(levelAt(d), result);
            if (Arr.isReadonlyArrayEmpty(rows)) return;
            const found = yield* findIds(rows, create);
            found.forEach(({ encoded: { term }, id }) => {
              if (Option.isNone(id)) return;
              MutableHashMap.set(result, term.key, id.value);
              if (cacheable) {
                if (MutableHashMap.size(idCache) >= CACHE_LIMIT) MutableHashMap.clear(idCache);
                MutableHashMap.set(idCache, term.key, id.value);
              }
            });
          }),
          { concurrency: 1, discard: true },
        );
        return result;
      });

    // --- decoding -------------------------------------------------------------

    /**
     * Records the term with id `id` whose `kind, value, datatype, lang, dir`
     * columns start at `row[at]` (`kind` is SQL `NULL` for an id with no term
     * row).
     */
    const addRow = (state: DecodeState, id: number, row: ReadonlyArray<unknown>, at: number) => {
      if (isResolved(state, id)) return;
      const cached = MutableHashMap.get(termCache, id);
      if (Option.isSome(cached)) {
        MutableHashMap.set(state.known, id, cached.value);
        return;
      }
      const kind = row[at];
      if (Predicate.isNullish(kind)) return;
      const t = Enc.decode(
        num(kind),
        str(row[at + 1]),
        str(row[at + 2]),
        str(row[at + 3]),
        str(row[at + 4]),
      );
      if (Enc.isComponentIds(t)) MutableHashMap.set(state.triples, id, t);
      else MutableHashMap.set(state.known, id, t);
    };

    /** Reads the dictionary rows of `ids` (one chunk) into a decode state. */
    const fetchTerms = (state: DecodeState, ids: ReadonlyArray<number>) =>
      Effect.map(
        run(
          `SELECT id, kind, value, datatype, lang, dir FROM ${T} WHERE id IN (${ids.join(', ')})`,
        ),
        (rows) =>
          rows.forEach((r) => {
            addRow(state, num(r[0]), r, 1);
          }),
      );

    /** Fetches the components of the triple terms of a decode state, until none is missing. */
    const complete = (
      state: DecodeState,
    ): Effect.Effect<void, Store.StoreError | SqlError.SqlError> =>
      Effect.suspend(() => {
        const missing = MutableHashSet.empty<number>();
        MutableHashMap.forEach(state.triples, (comps) =>
          comps.forEach((c) => {
            if (!isResolved(state, c)) MutableHashSet.add(missing, c);
          }),
        );
        // The cached terms need no query.
        const unknown = Arr.filter(Arr.fromIterable(missing), (c) =>
          Option.match(MutableHashMap.get(termCache, c), {
            onNone: () => true,
            onSome: (cached) => {
              MutableHashMap.set(state.known, c, cached);
              return false;
            },
          }),
        );
        if (Arr.isReadonlyArrayEmpty(unknown)) return Effect.void;
        return Effect.forEach(
          chunks(unknown, 500),
          (chunk) =>
            Effect.flatMap(fetchTerms(state, chunk), () =>
              Option.match(
                Arr.findFirst(chunk, (c) => !isResolved(state, c)),
                {
                  onNone: () => Effect.void,
                  onSome: (c) =>
                    Effect.fail(new Store.StoreError({ message: `Unknown term id ${c}` })),
                },
              ),
            ),
          { concurrency: 1, discard: true },
        ).pipe(Effect.flatMap(() => complete(state)));
      });

    const remember = (state: DecodeState) =>
      Effect.map(inTransaction, (inTx) => {
        if (inTx) return;
        if (MutableHashMap.size(termCache) + MutableHashMap.size(state.known) > CACHE_LIMIT) {
          MutableHashMap.clear(termCache);
        }
        MutableHashMap.forEach(state.known, (t, id) => {
          MutableHashMap.set(termCache, id, t);
        });
      });

    // --- quads ------------------------------------------------------------------

    const patternConditions = (pattern: Store.QuadPattern) =>
      Effect.gen(function* () {
        const positions = [
          ['s', pattern.subject],
          ['p', pattern.predicate],
          ['o', pattern.object],
          ['g', pattern.graph],
        ] as const;
        const present = Arr.filterMap(positions, ([column, t]) =>
          t === undefined ? Result.failVoid : Result.succeed({ column, t }),
        );
        const ids = yield* resolveTerms(
          Arr.filterMap(present, ({ t }) =>
            Term.isDefaultGraph(t) ? Result.failVoid : Result.succeed(t),
          ),
          false,
        );
        // A term that is not in the dictionary matches nothing.
        return Option.all(
          present.map(({ column, t }) =>
            Option.map(idIn(ids, t), (id): readonly [string, number] => [column, id]),
          ),
        );
      });

    const decodeQuads = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
      Effect.gen(function* () {
        const state = newState();
        rows.forEach((r) => {
          addRow(state, num(r[0]), r, 4);
          addRow(state, num(r[1]), r, 9);
          addRow(state, num(r[2]), r, 14);
          const g = num(r[3]);
          if (g !== 0) addRow(state, g, r, 19);
        });
        yield* complete(state);
        yield* remember(state);
        // The store only inserts quads, so each column decodes to its position's kind and a
        // non-zero graph to an IRI or blank node.
        return rows.map((r) => {
          const g = num(r[3]);
          return new Term.Quad(
            termAs(state, num(r[0]), isSubject, 'subject'),
            termAs(state, num(r[1]), Term.isNamedNode, 'predicate'),
            termOf(state, num(r[2])),
            g === 0 ? Term.defaultGraph : termAs(state, g, isGraphName, 'graph name'),
          );
        });
      });

    const match = (pattern: Store.QuadPattern): Stream.Stream<Term.Quad, Store.StoreError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const conds = yield* patternConditions(pattern);
          if (Option.isNone(conds)) return Stream.empty;
          const bound = MutableHashSet.fromIterable(conds.value.map(([c]) => c));
          const order = indexFor(bound);
          const where = conds.value.map(([c, id]) => `${c} = ${id}`);
          const attrs = ['s', 'p', 'o', 'g']
            .map((c) => `m${c}.kind, m${c}.value, m${c}.datatype, m${c}.lang, m${c}.dir`)
            .join(', ');
          const joins = ['s', 'p', 'o', 'g']
            .map((c) => ` LEFT JOIN ${T} m${c} ON m${c}.id = q.${c}`)
            .join('');
          const page = (after: Option.Option<ReadonlyArray<number>>) => {
            const w = Option.match(after, {
              onNone: () => where,
              onSome: (cursor) => [...where, `(${order.join(', ')}) > (${cursor.join(', ')})`],
            });
            return `SELECT q.s, q.p, q.o, q.g, ${attrs} FROM (SELECT s, p, o, g FROM ${Qt}${Arr.isReadonlyArrayNonEmpty(w) ? ` WHERE ${w.join(' AND ')}` : ''} ORDER BY ${order.join(', ')} LIMIT ${pageSize}) q${joins}`;
          };
          // The first page has no cursor.
          return Stream.paginate(Option.none<ReadonlyArray<number>>(), (after) =>
            Effect.gen(function* () {
              const rows = yield* run(page(after));
              const quads = yield* decodeQuads(rows);
              const next =
                rows.length < pageSize
                  ? Option.none()
                  : Option.map(Arr.last(rows), (last) =>
                      Option.some(order.map((c) => num(last[['s', 'p', 'o', 'g'].indexOf(c)]))),
                    );
              return [quads, next] as const;
            }),
          );
        }),
      ).pipe(Stream.mapError(storeError('match failed')));

    const countWhere = (pattern: Store.QuadPattern, limit: Option.Option<number>) =>
      Effect.gen(function* () {
        const conds = yield* patternConditions(pattern);
        if (Option.isNone(conds)) return 0;
        const where = conds.value.map(([c, id]) => `${c} = ${id}`);
        const filter = Arr.isReadonlyArrayNonEmpty(where) ? ` WHERE ${where.join(' AND ')}` : '';
        const rows = yield* run(
          Option.match(limit, {
            onNone: () => `SELECT COUNT(*) FROM ${Qt}${filter}`,
            onSome: (n) => `SELECT COUNT(*) FROM (SELECT 1 FROM ${Qt}${filter} LIMIT ${n}) x`,
          }),
        );
        return num(rows[0]?.[0] ?? 0);
      }).pipe(Effect.mapError(storeError('count failed')));

    const quadIds = (quads: Iterable<Term.Quad>, create: boolean) =>
      Effect.gen(function* () {
        const list = Arr.fromIterable(quads);
        const terms: Array<Term.GroundTerm> = [];
        list.forEach((q) => {
          terms.push(q.subject, q.predicate, q.object);
          if (!Term.isDefaultGraph(q.graph)) terms.push(q.graph);
        });
        const ids = yield* resolveTerms(terms, create);
        return Arr.filterMap(list, (q) => quadRow(ids, q));
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
        // The ids come from the graph table and the quads' graph column, so they decode to IRIs
        // or blank nodes.
        return ids.map((id) => termAs(state, id, isGraphName, 'graph name'));
      });

    const graphs: Stream.Stream<Term.NamedNode | Term.BlankNode, Store.StoreError> = Stream.unwrap(
      Effect.gen(function* () {
        const rows = yield* run(
          `SELECT id FROM ${Gt} UNION SELECT DISTINCT g FROM ${Qt} WHERE g <> 0`,
        );
        return Stream.fromArray(yield* decodeIds(rows.map((r) => num(r[0]))));
      }),
    ).pipe(Stream.mapError(storeError('graphs failed')));

    const graphIdOf = (graph: Term.NamedNode | Term.BlankNode, create: boolean) =>
      Effect.map(resolveTerms([graph], create), (ids) => MutableHashMap.get(ids, graph.key));

    const hasGraph = (graph: Term.NamedNode | Term.BlankNode) =>
      Effect.gen(function* () {
        const found = yield* graphIdOf(graph, false);
        if (Option.isNone(found)) return false;
        const id = found.value;
        const rows = yield* run(
          `SELECT 1 WHERE EXISTS (SELECT 1 FROM ${Gt} WHERE id = ${id}) OR EXISTS (SELECT 1 FROM ${Qt} WHERE g = ${id})`,
        );
        return Arr.isReadonlyArrayNonEmpty(rows);
      }).pipe(Effect.mapError(storeError('hasGraph failed')));

    const createGraph = (graph: Term.NamedNode | Term.BlankNode) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const id = yield* graphIdOf(graph, true);
            if (Option.isNone(id)) return;
            yield* exec(`INSERT INTO ${Gt} (id) VALUES (${id.value}) ON CONFLICT DO NOTHING`);
          }),
        )
        .pipe(Effect.mapError(storeError('createGraph failed')));

    const dropGraph = (graph: Term.NamedNode | Term.BlankNode) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const id = yield* graphIdOf(graph, false);
            if (Option.isNone(id)) return;
            yield* exec(`DELETE FROM ${Qt} WHERE g = ${id.value}`);
            yield* exec(`DELETE FROM ${Gt} WHERE id = ${id.value}`);
          }),
        )
        .pipe(Effect.mapError(storeError('dropGraph failed')));

    const clear = (graph: Term.Graph) =>
      Effect.gen(function* () {
        const id = Term.isDefaultGraph(graph) ? Option.some(0) : yield* graphIdOf(graph, false);
        if (Option.isNone(id)) return;
        yield* exec(`DELETE FROM ${Qt} WHERE g = ${id.value}`);
      }).pipe(Effect.mapError(storeError('clear failed')));

    const transaction = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | Store.StoreError, R> =>
      sql.withTransaction(effect).pipe(
        Effect.mapError((e) =>
          // SAFETY: `withTransaction` adds only `SqlError` to `E`, and that case was handled.
          SqlError.isSqlError(e) ? storeError('transaction failed')(e) : e,
        ),
      );

    // --- SPARQL to SQL ------------------------------------------------------------

    const storeClasses = Effect.map(
      run(`SELECT cls FROM ${tables.classes}`),
      (rows) => new Set(rows.map((r) => num(r[0]))),
    );

    const translationContext = (
      context?: Partial<Pick<Store.EvaluationContext, 'dataset' | 'activeGraph'>>,
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
        return Translation.compile(op, ctx, resolveIn(ids));
      }).pipe(Effect.mapError(storeError('compile failed')));

    const decodeSolutions = (
      compiled: Translation.CompiledQuery,
      rows: ReadonlyArray<ReadonlyArray<unknown>>,
    ) =>
      Effect.gen(function* () {
        const layout = columnLayout(compiled.columns);
        const terms = layout.filter(({ column }) => column.type === 'id');
        const state = newState();
        compiled.locals.forEach((t, id) => {
          MutableHashMap.set(state.known, id, t);
        });
        rows.forEach((r) =>
          terms.forEach(({ at }) => {
            // An unbound variable is SQL `NULL`.
            const v = r[at];
            if (Predicate.isNullish(v)) return;
            const id = num(v);
            if (id > 0) addRow(state, id, r, at + 1);
          }),
        );
        yield* complete(state);
        compiled.locals.forEach((_, id) => {
          MutableHashMap.remove(state.known, id);
        });
        yield* remember(state);
        compiled.locals.forEach((t, id) => {
          MutableHashMap.set(state.known, id, t);
        });
        return rows.map((r) =>
          B.fromEntries(
            Arr.filterMap(layout, ({ column, at }) => {
              const v = r[at];
              if (Predicate.isNullish(v)) return Result.failVoid;
              const term =
                column.type === 'int' ? new Term.Literal(str(v), INTEGER) : termOf(state, num(v));
              return Result.succeed([column.variable, term] as const);
            }),
          ),
        );
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
            const compiled = Translation.compile(op, ctx, resolveIn(ids));
            if (Result.isFailure(compiled)) {
              return yield* new Store.StoreError({ message: compiled.failure });
            }
            const q = compiled.success;
            if (
              Arr.isReadonlyArrayNonEmpty(q.risks) &&
              Translation.isRisky(q, yield* storeClasses)
            ) {
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
      estimate: (pattern) => countWhere(pattern, Option.some(10_000)),
      count: (pattern) => countWhere(pattern, Option.none()),
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

/** The `resolve` of `Translation.compile` over resolved term ids. */
const resolveIn = (ids: Ids) => (t: Term.GroundTerm) =>
  Option.getOrUndefined(MutableHashMap.get(ids, t.key));

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
