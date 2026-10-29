/**
 * Differential tests: random queries over random datasets are evaluated by
 * the engine over the in-memory store and over the SQL store (SQLite), and
 * must give the same solutions (as multisets).
 */
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Stream from 'effect/Stream';
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import * as Engine from '@thomasfosterau/effect-sparql/Engine';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import * as SqlStore from '../src/SqlStore.ts';

// -----------------------------------------------------------------------------
// Random generation
// -----------------------------------------------------------------------------

/** A small seeded PRNG (mulberry32). */
const prng = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <A>(xs: ReadonlyArray<A>): A => xs[int(xs.length)]!;
  const chance = (p: number) => next() < p;
  return { int, pick, chance };
};

type Random = ReturnType<typeof prng>;

const EX = 'http://example.org/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const iri = (s: string) => Term.namedNode(`${EX}${s}`);
const typed = (v: string, dt: string) => new Term.Literal(v, Term.namedNode(`${XSD}${dt}`));

const resources = ['r0', 'r1', 'r2', 'r3', 'r4'].map(iri);
const predicates = ['p0', 'p1', 'p2', 'p3'].map(iri);
const graphs = ['g0', 'g1'].map(iri);
const blanks = [Term.blankNode('b0'), Term.blankNode('b1')];

/** Literals SQL compares exactly. */
const safeLiterals: ReadonlyArray<Term.Literal> = [
  typed('1', 'integer'),
  typed('2', 'integer'),
  typed('-3', 'integer'),
  typed('01', 'integer'),
  typed('1.0', 'decimal'),
  typed('2.50', 'decimal'),
  typed('1e0', 'double'),
  typed('2.5E1', 'double'),
  typed('7', 'int'),
  Term.literal('a'),
  Term.literal('b'),
  Term.literal('abc'),
  Term.literal('Ab'),
  Term.literal(''),
  Term.literal('a', 'en'),
  Term.literal('b', 'fr'),
  Term.literal('ab', 'en-GB'),
  Term.literal('a', { language: 'ar', direction: 'rtl' }),
  typed('true', 'boolean'),
  typed('false', 'boolean'),
  typed('1', 'boolean'),
  typed('x', 'anyURI'),
  new Term.Literal('x', iri('dt')),
  typed('abc', 'integer'),
  typed('maybe', 'boolean'),
];

/** Literals that make (some) comparisons fall back to the engine. */
const riskyLiterals: ReadonlyArray<Term.Literal> = [
  typed('1.5', 'float'),
  typed('123456789012345678901234567890', 'integer'),
  typed('0.1234567890123456789', 'decimal'),
  typed('NaN', 'double'),
  typed('INF', 'double'),
  typed('2020-01-01', 'date'),
  typed('2020-01-01T00:00:00Z', 'dateTime'),
  typed('P1D', 'dayTimeDuration'),
];

const tripleTerm = Term.triple(resources[0]!, predicates[0]!, resources[1]!);

const makeData = (r: Random, risky: boolean): Array<Term.Quad> => {
  const literals = risky ? [...safeLiterals, ...riskyLiterals] : safeLiterals;
  const out: Array<Term.Quad> = [];
  const n = 25 + r.int(30);
  for (let i = 0; i < n; i++) {
    const s = r.chance(0.1) ? r.pick(blanks) : r.chance(0.05) ? tripleTerm : r.pick(resources);
    const p = r.pick(predicates);
    const o = r.chance(0.4)
      ? r.pick(resources)
      : r.chance(0.05)
        ? r.pick(blanks)
        : r.chance(0.03)
          ? tripleTerm
          : r.pick(literals);
    const g = r.chance(0.6) ? Term.defaultGraph : r.pick(graphs);
    out.push(Term.quad(s, p, o, g));
  }
  return out;
};

const VARS = ['?a', '?b', '?c', '?d'];

const literalText = (l: Term.Literal): string => l.toString();

class QueryGen {
  fresh = 0;
  readonly r: Random;
  readonly risky: boolean;
  constructor(r: Random, risky: boolean) {
    this.r = r;
    this.risky = risky;
  }

  constant(): string {
    const r = this.r;
    const pool = this.risky ? [...safeLiterals, ...riskyLiterals] : safeLiterals;
    return r.chance(0.4) ? r.pick(resources).toString() : literalText(r.pick(pool));
  }

  operand(): string {
    return this.r.chance(0.6) ? this.r.pick(VARS) : this.constant();
  }

  expr(depth: number): string {
    const r = this.r;
    const v = () => r.pick(VARS);
    const choice = r.int(depth > 0 ? 24 : 18);
    switch (choice) {
      case 0:
      case 1:
        return `${this.operand()} = ${this.operand()}`;
      case 2:
        return `${this.operand()} != ${this.operand()}`;
      case 3:
      case 4:
        return `${this.operand()} ${r.pick(['<', '>', '<=', '>='])} ${this.operand()}`;
      case 5:
        return `BOUND(${v()})`;
      case 6:
        return `${r.pick(['isIRI', 'isBlank', 'isLiteral', 'isNumeric', 'isTRIPLE', 'hasLANG'])}(${v()})`;
      case 7:
        return `sameTerm(${v()}, ${this.operand()})`;
      case 8:
        return `${r.pick(['STRSTARTS', 'STRENDS', 'CONTAINS'])}(${r.chance(0.5) ? `STR(${v()})` : v()}, ${r.pick(['"a"', '"b"', '""', '"a"@en'])})`;
      case 9:
        return `LANG(${v()}) = ${r.pick(['"en"', '""', '"fr"'])}`;
      case 10:
        return `LANGMATCHES(LANG(${v()}), ${r.pick(['"en"', '"*"', '"EN"'])})`;
      case 11:
        return `DATATYPE(${v()}) = <${XSD}${r.pick(['integer', 'string', 'boolean', 'decimal'])}>`;
      case 12:
        return `STRLEN(STR(${v()})) ${r.pick(['>', '=', '<'])} ${r.int(4)}`;
      case 13:
        return `${v()} ${r.pick(['IN', 'NOT IN'])} (${this.constant()}, ${this.operand()})`;
      case 14:
        return v();
      case 15:
        return `STR(${v()}) = ${r.pick(['"a"', '"1"', `"${EX}r1"`])}`;
      case 16:
        // Not translatable: evaluated by the engine.
        return `REGEX(STR(${v()}), "^a")`;
      case 17:
        return `${v()} + 1 > 2`;
      case 18:
        return `!(${this.expr(depth - 1)})`;
      case 19:
      case 20:
        return `(${this.expr(depth - 1)}) && (${this.expr(depth - 1)})`;
      case 21:
        return `(${this.expr(depth - 1)}) || (${this.expr(depth - 1)})`;
      case 22:
        return `${r.chance(0.5) ? 'EXISTS' : 'NOT EXISTS'} { ${this.triple()} }`;
      default:
        return `IF(${this.expr(depth - 1)}, ${this.operand()}, ${this.operand()}) = ${this.operand()}`;
    }
  }

  triple(): string {
    const r = this.r;
    const s = r.chance(0.75)
      ? r.pick(VARS)
      : r.chance(0.9)
        ? r.pick(resources).toString()
        : `<<( ${resources[0]!.toString()} ${predicates[0]!.toString()} ?d )>>`;
    const p = r.chance(0.7) ? r.pick(predicates).toString() : r.pick(VARS);
    const o = r.chance(0.7) ? r.pick(VARS) : this.constant();
    return `${s} ${p} ${o} .`;
  }

  group(depth: number): string {
    const r = this.r;
    const parts: Array<string> = [this.triple()];
    const n = r.int(depth > 0 ? 4 : 2);
    for (let i = 0; i < n; i++) {
      const choice = r.int(depth > 0 ? 12 : 3);
      switch (choice) {
        case 0:
        case 1:
          parts.push(this.triple());
          break;
        case 2:
          parts.push(`FILTER(${this.expr(2)})`);
          break;
        case 3:
          parts.push(
            `OPTIONAL { ${this.group(depth - 1)}${r.chance(0.4) ? ` FILTER(${this.expr(1)})` : ''} }`,
          );
          break;
        case 4:
          parts.push(`{ ${this.group(depth - 1)} } UNION { ${this.group(depth - 1)} }`);
          break;
        case 5:
          parts.push(`MINUS { ${this.group(depth - 1)} }`);
          break;
        case 6: {
          const e = r.chance(0.5)
            ? this.operand()
            : r.chance(0.5)
              ? this.expr(1)
              : `COALESCE(${r.pick(VARS)}, ${this.operand()})`;
          parts.push(`BIND(${e} AS ?x${this.fresh++})`);
          break;
        }
        case 7:
          parts.push(
            `VALUES ${r.pick(VARS)} { ${Array.from({ length: 1 + r.int(3) }, () => (r.chance(0.2) ? 'UNDEF' : this.constant())).join(' ')} }`,
          );
          break;
        case 8:
          parts.push(
            `GRAPH ${r.chance(0.5) ? '?g' : r.pick(graphs).toString()} { ${this.group(depth - 1)} }`,
          );
          break;
        case 9:
          parts.push(
            `{ SELECT DISTINCT ${r.pick(VARS)} ${r.pick(VARS)} WHERE { ${this.group(depth - 1)} } }`,
          );
          break;
        case 10: {
          const k = r.pick(VARS);
          parts.push(
            `{ SELECT ${k} (COUNT(${r.chance(0.5) ? '*' : `DISTINCT ${r.pick(VARS)}`}) AS ?n${this.fresh++}) WHERE { ${this.group(depth - 1)} } GROUP BY ${k} }`,
          );
          break;
        }
        default:
          parts.push(`FILTER(${this.expr(2)})`);
      }
    }
    return parts.join(' ');
  }

  query(): string {
    const r = this.r;
    const where = this.group(2);
    switch (r.int(5)) {
      case 0:
        return `ASK { ${where} }`;
      case 1:
        return `SELECT DISTINCT ${r.pick(VARS)} ${r.pick(VARS)} WHERE { ${where} }`;
      case 2:
        return `SELECT (COUNT(*) AS ?count) WHERE { ${where} }`;
      default:
        return `SELECT * WHERE { ${where} }`;
    }
  }
}

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

const evaluate = (engine: Engine.SparqlEngineShape, query: string) =>
  Effect.gen(function* () {
    const result = yield* engine.query(query);
    switch (result._tag) {
      case 'Ask':
        return [String(result.value)];
      case 'Select':
        return Arr.sort(
          (yield* Stream.runCollect(result.bindings)).map((b) => b.key),
          Order.String,
        );
      case 'Graph':
        return Arr.sort(
          (yield* Stream.runCollect(result.quads)).map((q) => q.key),
          Order.String,
        );
    }
  });

const DATASETS = Number(process.env.DIFF_DATASETS ?? 12);
const QUERIES_PER_DATASET = Number(process.env.DIFF_QUERIES ?? 40);
const SEED = Number(process.env.DIFF_SEED ?? 1000);

describe('Differential: SQL store vs in-memory store', () => {
  it.effect(
    `gives the same results for ${DATASETS * QUERIES_PER_DATASET} random queries`,
    () =>
      Effect.gen(function* () {
        let compared = 0;
        let rootInSql = 0;
        let sqlUsed = 0;
        let nonEmpty = 0;
        yield* Effect.forEach(
          Array.from({ length: DATASETS }, (_, i) => i),
          Effect.fnUntraced(function* (d) {
            const r = prng(SEED + d);
            const risky = d % 3 === 2;
            const quads = makeData(r, risky);
            const memory = yield* Store.makeMemory(Dataset.fromIterable(quads));
            let events: Array<SqlStore.QueryEvent> = [];
            yield* Effect.gen(function* () {
              const store = yield* SqlStore.SqlStore;
              yield* store.insert(quads);
              const sqlEngine = Engine.make(store);
              const memEngine = Engine.make(memory);
              const gen = new QueryGen(r, risky);
              yield* Effect.forEach(
                Array.from({ length: QUERIES_PER_DATASET }, (_, i) => i),
                Effect.fnUntraced(function* () {
                  const query = gen.query();
                  events = [];
                  const expected = yield* Effect.exit(evaluate(memEngine, query));
                  const actual = yield* Effect.exit(evaluate(sqlEngine, query));
                  // Both fail, or both succeed with the same rows.
                  assert(
                    Exit.isSuccess(actual) || Exit.isFailure(expected),
                    Exit.isFailure(actual)
                      ? `SQL evaluation failed for ${query}: ${String(actual.cause)}`
                      : '',
                  );
                  const outcome = (exit: typeof expected) =>
                    Exit.isFailure(exit) ? { query, failed: true } : { query, rows: exit.value };
                  expect(outcome(actual)).toEqual(outcome(expected));
                  if (Exit.isFailure(expected)) return;
                  compared++;
                  if (expected.value.length > 0 && expected.value[0] !== 'false') nonEmpty++;
                  if (events[0]?._tag === 'Executed') rootInSql++;
                  if (events.some((e) => e._tag === 'Executed')) sqlUsed++;
                }),
                { concurrency: 1, discard: true },
              );
            }).pipe(
              Effect.provide(
                SqlStore.layerSqlite({ filename: ':memory:', onQuery: (e) => events.push(e) }),
              ),
            );
          }),
          { concurrency: 1, discard: true },
        );
        yield* Effect.logInfo(
          `Compared ${compared} queries (${nonEmpty} with solutions): ${sqlUsed} used SQL, ${rootInSql} entirely in SQL`,
        );
        // Most generated queries are valid and use SQL.
        expect(compared).toBeGreaterThan(DATASETS * QUERIES_PER_DATASET * 0.8);
        expect(sqlUsed).toBeGreaterThan(compared * 0.8);
        expect(rootInSql).toBeGreaterThan(compared * 0.2);
        expect(nonEmpty).toBeGreaterThan(compared * 0.3);
      }),
    120_000,
  );
});
