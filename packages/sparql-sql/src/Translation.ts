/**
 * SPARQL algebra to SQL translation.
 *
 * `compile` translates an algebra tree into a single SQL `SELECT` over the
 * store's tables (term dictionary + quads of term ids), or reports that the
 * tree is not (exactly) translatable — the store then lets the generic engine
 * evaluate that node and offers its children again.
 *
 * Solutions are rows whose columns hold term ids (`NULL` = unbound). Terms
 * that are not in the dictionary but are needed by the query (constants of
 * `VALUES`, `BIND`, …) get negative, query-local ids. Integer results of
 * `COUNT` are carried as plain integers. The final `SELECT` joins the
 * dictionary to decode the ids.
 *
 * Translated: BGPs (self-joins of the quads table, triple term patterns
 * through the dictionary), `Join`, `LeftJoin` (with the filter in the `ON`
 * clause), `Union` (`UNION ALL` with `NULL` padding), `Minus` and
 * `[NOT] EXISTS` (correlated `NOT EXISTS` / `EXISTS`), `Filter`, `Graph`
 * (constant and variable), `Extend` with term-valued expressions, `Values`,
 * `Project`, `Distinct`, `Reduced`, `Slice` and `Group` with `COUNT` /
 * `SAMPLE`. Expressions: `&&`, `||`, `!`, `=`, `!=`, `<`, `>`, `<=`, `>=`,
 * `IN`, `NOT IN`, `BOUND`, `sameTerm`, `isIRI`, `isBlank`, `isLiteral`,
 * `isNumeric`, `isTriple`, `hasLang`, `hasLangDir`, `STR`, `LANG`,
 * `DATATYPE`, `STRLEN`, `STRSTARTS`, `STRENDS`, `CONTAINS`, `LANGMATCHES`,
 * `IF`, `COALESCE` and `EXISTS`, with SPARQL's error semantics (an error is
 * SQL `NULL`; SPARQL's `&&`/`||`/`!` coincide with SQL's three-valued logic).
 *
 * Comparisons are evaluated per row by the comparison class of the terms
 * (stored in the dictionary). Combinations of classes that SQL cannot compare
 * exactly (e.g. dates, arbitrary-precision decimals, float/double promotion)
 * are reported as `risks`: before running the query the store checks which
 * classes exist and falls back to the engine if a risk can occur.
 *
 * @since 0.1.0
 */
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as Result from 'effect/Result';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Algebra from '@thomasfosterau/effect-sparql/Algebra';
import type * as Ast from '@thomasfosterau/effect-sparql/Ast';
import * as Expression from '@thomasfosterau/effect-sparql/Expression';
import type * as Store from '@thomasfosterau/effect-sparql/Store';
import type * as Dialect from './Dialect.ts';
import * as Enc from './internal/encoding.ts';
import * as Predicate from 'effect/Predicate';

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * What the translation needs to know besides the algebra.
 *
 * @since 0.1.0
 * @category models
 */
export interface TranslationContext {
  readonly dialect: Dialect.Dialect;
  readonly tables: Dialect.Tables;
  readonly dataset: Store.DatasetSpec;
  readonly activeGraph: Store.ActiveGraph;
}

/**
 * An output column of a compiled query: `id` columns hold term ids (decoded
 * from the dictionary columns that follow them), `int` columns integers
 * (decoded as `xsd:integer`).
 *
 * @since 0.1.0
 * @category models
 */
export interface OutputColumn {
  readonly variable: string;
  readonly type: 'id' | 'int';
}

/**
 * A combination of comparison classes that the SQL cannot compare exactly.
 * The query is only exact if the combination cannot occur: a class marked
 * static is certainly present (it is the class of a constant operand);
 * otherwise it occurs if some term of the store (or a query-local constant)
 * has it.
 *
 * @since 0.1.0
 * @category models
 */
export interface Risk {
  readonly a: number;
  readonly aStatic: boolean;
  readonly b: number;
  readonly bStatic: boolean;
}

/**
 * A compiled query.
 *
 * @since 0.1.0
 * @category models
 */
export interface CompiledQuery {
  /** The SQL text (with dialect placeholders). */
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  /**
   * The output columns. Each `id` column is followed in the result rows by
   * the dictionary columns `kind, value, datatype, lang, dir`.
   */
  readonly columns: ReadonlyArray<OutputColumn>;
  /** Query-local terms (by negative id). */
  readonly locals: ReadonlyMap<number, Term.GroundTerm>;
  /** The comparison classes of the query-local terms. */
  readonly localClasses: ReadonlySet<number>;
  readonly risks: ReadonlyArray<Risk>;
}

/**
 * Whether the risks of a compiled query can occur, given the comparison
 * classes present in the store.
 *
 * @since 0.1.0
 * @category utils
 */
export const isRisky = (compiled: CompiledQuery, storeClasses: ReadonlySet<number>): boolean => {
  const present = (c: number) => storeClasses.has(c) || compiled.localClasses.has(c);
  return compiled.risks.some((r) => (r.aStatic || present(r.a)) && (r.bStatic || present(r.b)));
};

class Unsupported {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

const unsupported = (reason: string): never => {
  throw new Unsupported(reason);
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const collectTerm = (t: Ast.TermPattern | Term.Term, out: Map<string, Term.GroundTerm>): void => {
  return Match.value(t).pipe(
    Match.tag('NamedNode', 'Literal', (t) => {
      out.set(t.key, t);
      return;
    }),
    Match.tag('Triple', (t) => {
      if (Term.isGround(t)) {
        // SAFETY: `Term.isGround` holds, so the triple pattern has no variables.
        out.set(t.key, t as Term.Triple);
      } else {
        collectTerm(t.subject, out);
        collectTerm(t.predicate, out);
        collectTerm(t.object, out);
      }
      return;
    }),
    Match.orElse(() => undefined),
  );
};

const collectExpression = (e: Algebra.Expression, out: Map<string, Term.GroundTerm>): void => {
  Match.value(e).pipe(
    Match.tag('Operation', 'FunctionCall', (call) =>
      call.args.forEach((a) => collectExpression(a, out)),
    ),
    Match.tag('Exists', (x) => collectOperation(x.input, out)),
    Match.orElse((t) => collectTerm(t, out)),
  );
};

const collectOperation = (op: Algebra.Operation, out: Map<string, Term.GroundTerm>): void => {
  return Match.value(op).pipe(
    Match.tag('Bgp', (op) => {
      for (const p of op.patterns) {
        collectTerm(p.subject, out);
        collectTerm(p.predicate, out);
        collectTerm(p.object, out);
      }
      return;
    }),
    Match.tag('Path', () => undefined),
    Match.tag('Join', 'Union', 'Minus', (op) => {
      collectOperation(op.left, out);
      collectOperation(op.right, out);
      return;
    }),
    Match.tag('LeftJoin', (op) => {
      collectOperation(op.left, out);
      collectOperation(op.right, out);
      if (op.expression !== undefined) collectExpression(op.expression, out);
      return;
    }),
    Match.tag('Filter', (op) => {
      collectExpression(op.expression, out);
      collectOperation(op.input, out);
      return;
    }),
    Match.tag('Extend', (op) => {
      collectExpression(op.expression, out);
      collectOperation(op.input, out);
      return;
    }),
    Match.tag('Graph', (op) => {
      collectTerm(op.name, out);
      collectOperation(op.input, out);
      return;
    }),
    Match.tag('Values', (op) => {
      for (const b of op.bindings) for (const [, t] of b) collectTerm(t, out);
      return;
    }),
    Match.tag('Group', 'OrderBy', 'Project', 'Distinct', 'Reduced', 'Slice', 'Service', (op) => {
      collectOperation(op.input, out);
      return;
    }),
    Match.exhaustive,
  );
};

/**
 * The constant terms of an algebra tree (and of the dataset) whose
 * dictionary ids the translation needs.
 *
 * @since 0.1.0
 * @category utils
 */
export const constants = (
  op: Algebra.Operation,
  context: Pick<TranslationContext, 'dataset' | 'activeGraph'>,
): ReadonlyArray<Term.GroundTerm> => {
  const out = new Map<string, Term.GroundTerm>();
  collectOperation(op, out);
  const { defaultGraph, namedGraphs } = context.dataset;
  if (Array.isArray(defaultGraph)) {
    // SAFETY: `Array.isArray` holds, and the array form of the dataset's default graph lists graph
    // terms.
    for (const g of defaultGraph as ReadonlyArray<Term.Graph>) {
      if (g._tag !== 'DefaultGraph') out.set(g.key, g);
    }
  }
  if (namedGraphs !== 'all') for (const g of namedGraphs) out.set(g.key, g);
  if (context.activeGraph._tag === 'NamedGraph') {
    out.set(context.activeGraph.graph.key, context.activeGraph.graph);
  }
  out.set(TRUE.key, TRUE);
  out.set(FALSE.key, FALSE);
  return Array.from(out.values());
};

// -----------------------------------------------------------------------------
// Blocks
// -----------------------------------------------------------------------------

interface Col {
  readonly sql: string;
  readonly nullable: boolean;
  readonly type: 'id' | 'int';
}

interface Item {
  readonly source: string;
  readonly alias: string;
  /** The `ON` condition of a `LEFT JOIN`; inner joins have none. */
  readonly left?: string | undefined;
}

/** A `SELECT` under construction: FROM items, WHERE conditions and variables. */
interface Block {
  readonly items: ReadonlyArray<Item>;
  readonly where: ReadonlyArray<string>;
  readonly cols: ReadonlyMap<string, Col>;
}

const EMPTY: Block = { items: [], where: [], cols: new Map() };

type GraphCtx =
  | { readonly kind: 'default' }
  | { readonly kind: 'const'; readonly id: number }
  | { readonly kind: 'var'; readonly hidden: string };

const isHidden = (name: string): boolean => name.startsWith('#');

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const TRUE = new Term.Literal('true', Term.namedNode(`${XSD}boolean`));
const FALSE = new Term.Literal('false', Term.namedNode(`${XSD}boolean`));

// -----------------------------------------------------------------------------
// Expression operands
// -----------------------------------------------------------------------------

type Static = string | number | boolean | null;

/** A field of an operand: statically known or a SQL expression. */
type F = { readonly s: Static } | { readonly q: string };

type C = boolean | string;

/** The join condition of two columns of one variable, and their merged column. */
interface JoinCompat {
  readonly cond: string;
  readonly merged: Col;
}

/** Numeric-promotion branches of a comparison, and the class pairs they handle. */
interface Promotions {
  readonly branches: Array<readonly [C, string]>;
  readonly handled: Set<string>;
}

interface Operand {
  readonly tag: 'term' | 'const' | 'int' | 'str' | 'bool' | 'iri' | 'null';
  /** Possible comparison classes (`undefined` = any). */
  readonly classes: ReadonlyArray<number> | undefined;
  readonly isNull: F;
  readonly cls: F;
  readonly kind: F;
  readonly value: F;
  readonly datatype: F;
  readonly lang: F;
  readonly dir: F;
  readonly num: F;
  /** The term id, for term-valued operands. */
  readonly id?: F | undefined;
  /** The constant term. */
  readonly term?: Term.GroundTerm | undefined;
  /** The SQL boolean of `bool` operands. */
  readonly bool?: string | undefined;
}

const S = (s: Static): F => ({ s });
const Q = (q: string): F => ({ q });
const isStatic = (f: F): f is { readonly s: Static } => 's' in f;

const RISK_ORDER: ReadonlyArray<readonly [number, number]> = [
  [1, 3],
  [2, 3],
  [8, 1],
  [8, 2],
  [8, 3],
  [8, 8],
  [11, 1],
  [11, 2],
  [11, 3],
  [11, 8],
  [11, 11],
  [7, 7],
];
const RISK_EQUAL: ReadonlyArray<readonly [number, number]> = [...RISK_ORDER, [10, 10]];

const and = (...cs: ReadonlyArray<C>): C => {
  const parts: Array<string> = [];
  for (const c of cs) {
    if (c === false) return false;
    if (c !== true) parts.push(c);
  }
  return Arr.isReadonlyArrayEmpty(parts)
    ? true
    : parts.length === 1
      ? parts[0]!
      : `(${parts.join(' AND ')})`;
};

const or = (...cs: ReadonlyArray<C>): C => {
  const parts: Array<string> = [];
  for (const c of cs) {
    if (c === true) return true;
    if (c !== false) parts.push(c);
  }
  return Arr.isReadonlyArrayEmpty(parts)
    ? false
    : parts.length === 1
      ? parts[0]!
      : `(${parts.join(' OR ')})`;
};

const condSql = (c: C): string => (c === true ? 'TRUE' : c === false ? 'FALSE' : c);

const caseOf = (branches: ReadonlyArray<readonly [C, string]>, otherwise: string): string => {
  const live: Array<readonly [string, string]> = [];
  for (const [c, v] of branches) {
    if (c === false) continue;
    if (c === true) {
      if (Arr.isReadonlyArrayEmpty(live)) return v;
      return `(CASE ${live.map(([w, r]) => `WHEN ${w} THEN ${r}`).join(' ')} ELSE ${v} END)`;
    }
    live.push([c, v]);
  }
  if (Arr.isReadonlyArrayEmpty(live)) return otherwise;
  return `(CASE ${live.map(([w, r]) => `WHEN ${w} THEN ${r}`).join(' ')} ELSE ${otherwise} END)`;
};

// -----------------------------------------------------------------------------
// Compiler
// -----------------------------------------------------------------------------

interface Env {
  readonly cols: ReadonlyMap<string, Col>;
  readonly graph: GraphCtx;
}

class Compiler {
  readonly dialect: Dialect.Dialect;
  readonly T: string;
  readonly Q: string;
  readonly G: string;
  counter = 0;
  readonly colNames = new Map<string, string>();
  readonly params: Array<unknown> = [];
  readonly paramIndex = new Map<string, number>();
  readonly risks: Array<Risk> = [];
  readonly localClasses = new Set<number>();

  readonly context: TranslationContext;
  readonly resolve: (term: Term.GroundTerm) => number | undefined;
  /** Query-local terms, by key (stable across the two compilation passes). */
  readonly locals: Map<string, { readonly id: number; readonly term: Term.GroundTerm }>;
  /** Whether the query-local terms are complete (second pass). */
  readonly localsKnown: boolean;

  constructor(
    context: TranslationContext,
    resolve: (term: Term.GroundTerm) => number | undefined,
    locals: Map<string, { readonly id: number; readonly term: Term.GroundTerm }>,
    localsKnown: boolean,
  ) {
    this.context = context;
    this.resolve = resolve;
    this.locals = locals;
    this.localsKnown = localsKnown;
    this.dialect = context.dialect;
    this.T = context.tables.terms;
    this.Q = context.tables.quads;
    this.G = context.tables.graphs;
  }

  alias(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  col(name: string): string {
    let c = this.colNames.get(name);
    if (c === undefined) this.colNames.set(name, (c = `c${this.colNames.size}`));
    return c;
  }

  param(value: string): string {
    let i = this.paramIndex.get(value);
    if (i === undefined) {
      this.params.push(value);
      i = this.params.length;
      this.paramIndex.set(value, i);
    }
    return this.dialect.castText(`\ue000${i}\ue000`);
  }

  lit(v: Static): string {
    if (v === null) return 'NULL';
    if (Predicate.isBoolean(v)) return v ? 'TRUE' : 'FALSE';
    if (Predicate.isNumber(v)) {
      if (!Number.isFinite(v)) return 'NULL';
      return Number.isInteger(v) && Math.abs(v) < 1e15
        ? String(v)
        : this.dialect.castDouble(String(v));
    }
    return this.param(v);
  }

  f(field: F): string {
    return isStatic(field) ? this.lit(field.s) : field.q;
  }

  /** The id of a constant term (a query-local negative id if it is not in the dictionary). */
  idOf(term: Term.GroundTerm | Term.DefaultGraph): number {
    if (term._tag === 'DefaultGraph') return 0;
    const id = this.resolve(term);
    if (id !== undefined) return id;
    let local = this.locals.get(term.key);
    if (local === undefined) {
      local = { id: -(this.locals.size + 1), term };
      this.locals.set(term.key, local);
    }
    this.localClasses.add(Enc.classify(term).cls);
    return local.id;
  }

  // --- rendering --------------------------------------------------------------

  from(items: ReadonlyArray<Item>): string {
    if (Arr.isReadonlyArrayEmpty(items)) return '';
    let out = ` FROM ${items[0]!.source} ${items[0]!.alias}`;
    for (const it of items.slice(1)) {
      out +=
        it.left !== undefined
          ? ` LEFT JOIN ${it.source} ${it.alias} ON ${it.left}`
          : ` JOIN ${it.source} ${it.alias} ON TRUE`;
    }
    return out;
  }

  whereClause(where: ReadonlyArray<string>): string {
    return Arr.isReadonlyArrayEmpty(where) ? '' : ` WHERE ${where.join(' AND ')}`;
  }

  nullCol(type: 'id' | 'int'): string {
    return type === 'id' ? this.dialect.nullId : this.dialect.castId('NULL');
  }

  render(
    block: Block,
    names: ReadonlyArray<string> = Array.from(block.cols.keys()),
    options: {
      readonly distinct?: boolean;
      readonly types?: ReadonlyMap<string, 'id' | 'int'>;
    } = {},
  ): string {
    const select = names.map((n) => {
      const c = block.cols.get(n);
      return `${c !== undefined ? c.sql : this.nullCol(options.types?.get(n) ?? 'id')} AS ${this.col(n)}`;
    });
    return `SELECT ${options.distinct === true ? 'DISTINCT ' : ''}${Arr.isReadonlyArrayEmpty(select) ? '1 AS one' : select.join(', ')}${this.from(block.items)}${this.whereClause(block.where)}`;
  }

  /** Wraps SQL as a subquery item. */
  wrapSql(sql: string, cols: ReadonlyMap<string, Omit<Col, 'sql'>>): Block {
    const alias = this.alias('s');
    const out = new Map<string, Col>();
    for (const [n, c] of cols) out.set(n, { ...c, sql: `${alias}.${this.col(n)}` });
    return { items: [{ source: `(${sql})`, alias }], where: [], cols: out };
  }

  wrap(block: Block, options: { readonly distinct?: boolean } = {}): Block {
    return this.wrapSql(this.render(block, undefined, options), block.cols);
  }

  // --- joins ------------------------------------------------------------------

  compat(a: Col, b: Col): JoinCompat {
    if (a.type !== b.type) return unsupported('Joining integer and term columns');
    if (!a.nullable && !b.nullable) return { cond: `${a.sql} = ${b.sql}`, merged: a };
    if (!a.nullable) return { cond: `(${b.sql} IS NULL OR ${b.sql} = ${a.sql})`, merged: a };
    if (!b.nullable) return { cond: `(${a.sql} IS NULL OR ${a.sql} = ${b.sql})`, merged: b };
    return {
      cond: `(${a.sql} IS NULL OR ${b.sql} IS NULL OR ${a.sql} = ${b.sql})`,
      merged: { sql: `COALESCE(${a.sql}, ${b.sql})`, nullable: true, type: a.type },
    };
  }

  join(a: Block, b: Block): Block {
    if (Arr.isReadonlyArrayEmpty(b.items) && Arr.isReadonlyArrayEmpty(b.where) && b.cols.size === 0)
      return a;
    if (Arr.isReadonlyArrayEmpty(a.items) && Arr.isReadonlyArrayEmpty(a.where) && a.cols.size === 0)
      return b;
    const cols = new Map(a.cols);
    const where = [...a.where, ...b.where];
    for (const [n, cb] of b.cols) {
      const ca = cols.get(n);
      if (ca === undefined) cols.set(n, cb);
      else {
        const { cond, merged } = this.compat(ca, cb);
        where.push(cond);
        cols.set(n, merged);
      }
    }
    return { items: [...a.items, ...b.items], where, cols };
  }

  /** Ensures a block has a FROM item (so that a LEFT JOIN can be appended). */
  anchored(block: Block): Block {
    if (Arr.isReadonlyArrayNonEmpty(block.items)) return block;
    return { ...block, items: [{ source: '(SELECT 1 AS one)', alias: this.alias('u') }] };
  }

  // --- operators --------------------------------------------------------------

  op(op: Algebra.Operation, g: GraphCtx, unit: Block): Block {
    return Match.value(op).pipe(
      Match.tag('Bgp', (op) =>
        Arr.isReadonlyArrayEmpty(op.patterns) ? unit : this.bgp(op.patterns, g),
      ),
      Match.tag('Join', (op) => this.join(this.op(op.left, g, unit), this.op(op.right, g, unit))),
      Match.tag('LeftJoin', (op) => this.leftJoin(op, g, unit)),
      Match.tag('Filter', (op) => {
        const input = this.op(op.input, g, unit);
        const cond = this.ebv(this.operand(op.expression, { cols: input.cols, graph: g }));
        if (cond === 'TRUE') return input;
        return { ...input, where: [...input.where, cond] };
      }),
      Match.tag('Union', (op) => this.union(this.op(op.left, g, unit), this.op(op.right, g, unit))),
      Match.tag('Graph', (op) => this.graph(op, g, unit)),
      Match.tag('Extend', (op) => {
        const input = this.op(op.input, g, unit);
        if (input.cols.has(op.variable.value)) return unsupported('BIND to a bound variable');
        const col = this.termValued(this.operand(op.expression, { cols: input.cols, graph: g }));
        const cols = new Map(input.cols);
        cols.set(op.variable.value, col);
        return { ...input, cols };
      }),
      Match.tag('Minus', (op) => this.minus(this.op(op.left, g, unit), this.op(op.right, g, unit))),
      Match.tag('Group', (op) => this.group(op, g, unit)),
      Match.tag('Project', (op) => {
        const input = this.op(op.input, g, unit);
        const keep = new Set(op.variables.map((v) => v.value));
        const cols = new Map<string, Col>();
        for (const [n, c] of input.cols) if (keep.has(n) || isHidden(n)) cols.set(n, c);
        return { ...input, cols };
      }),
      Match.tag('Distinct', (op) => this.wrap(this.op(op.input, g, unit), { distinct: true })),
      Match.tag('Reduced', (op) => this.op(op.input, g, unit)),
      Match.tag('Slice', (op) => {
        if (g.kind === 'var') return unsupported('Slice inside GRAPH ?var');
        const input = this.op(op.input, g, unit);
        return this.wrapSql(
          `${this.render(input)}${this.dialect.limitOffset(op.limit, op.offset)}`,
          input.cols,
        );
      }),
      Match.tag('Values', (op) => {
        // Like the engine, inline data does not see the context solution.
        return this.values(op);
      }),
      Match.tag('OrderBy', () => unsupported('ORDER BY is evaluated by the engine')),
      Match.tag('Path', () => unsupported('Property paths are evaluated by the engine')),
      Match.tag('Service', () => unsupported('SERVICE is evaluated by the engine')),
      Match.exhaustive,
    );
  }

  // --- BGP --------------------------------------------------------------------

  bgp(patterns: ReadonlyArray<Ast.TriplePattern>, g: GraphCtx): Block {
    const items: Array<Item> = [];
    const where: Array<string> = [];
    const cols = new Map<string, Col>();
    const bind = (name: string, sql: string) => {
      const c = cols.get(name);
      if (c === undefined) cols.set(name, { sql, nullable: false, type: 'id' });
      else where.push(`${c.sql} = ${sql}`);
    };
    const position = (t: Ast.TermPattern, sql: string, constants: Array<string>): void => {
      return Match.value(t).pipe(
        Match.tag('Variable', (t) => {
          bind(t.value, sql);
          return;
        }),
        Match.tag('BlankNode', () => unsupported('Blank node in a pattern')),
        Match.tag('NamedNode', 'Literal', (t) => {
          constants.push(`${sql} = ${this.idOf(t)}`);
          return;
        }),
        Match.tag('Triple', (t) => {
          if (Term.isGround(t)) {
            // SAFETY: `Term.isGround` holds, so the triple pattern has no variables.
            constants.push(`${sql} = ${this.idOf(t as Term.Triple)}`);
            return;
          }
          const ta = this.alias('t');
          items.push({ source: this.T, alias: ta });
          where.push(`${ta}.id = ${sql}`, `${ta}.kind = ${Enc.Kind.Triple}`);
          position(t.subject, `${ta}.sub`, where);
          position(t.predicate, `${ta}.pre`, where);
          position(t.object, `${ta}.obj`, where);
          return;
        }),
        Match.exhaustive,
      );
    };
    const { defaultGraph } = this.context.dataset;
    for (const p of patterns) {
      const a = this.alias('q');
      const merged =
        g.kind === 'default' &&
        (defaultGraph === 'union' || (Array.isArray(defaultGraph) && defaultGraph.length > 1));
      if (merged) {
        // The default graph is a merge of several graphs: match each triple once.
        const inner: Array<string> = [];
        if (defaultGraph !== 'union') {
          // SAFETY: not `union`, `default` or `all` was handled before, so the default graph is the
          // list of graph terms.
          inner.push(
            `g IN (${(defaultGraph as ReadonlyArray<Term.Graph>).map((x) => this.idOf(x)).join(', ')})`,
          );
        }
        const deferred: Array<() => void> = [];
        const positionIn = (t: Ast.TermPattern, column: string) => {
          if (t._tag === 'Variable' || (t._tag === 'Triple' && !Term.isGround(t))) {
            deferred.push(() => position(t, `${a}.${column}`, where));
          } else position(t, column, inner);
        };
        positionIn(p.subject, 's');
        positionIn(p.predicate, 'p');
        positionIn(p.object, 'o');
        items.push({
          source: `(SELECT DISTINCT s, p, o FROM ${this.Q}${Arr.isReadonlyArrayNonEmpty(inner) ? ` WHERE ${inner.join(' AND ')}` : ''})`,
          alias: a,
        });
        deferred.forEach((f) => f());
        continue;
      }
      items.push({ source: this.Q, alias: a });
      Match.value(g).pipe(
        Match.when({ kind: 'default' }, () => {
          if (defaultGraph === 'default') where.push(`${a}.g = 0`);
          else if (Array.isArray(defaultGraph) && defaultGraph.length === 1) {
            // SAFETY: `Array.isArray` holds, so the default graph is a list of graph terms.
            where.push(`${a}.g = ${this.idOf((defaultGraph as ReadonlyArray<Term.Graph>)[0]!)}`);
          } else where.push('1 = 0');
        }),
        Match.when({ kind: 'const' }, (g) => {
          where.push(`${a}.g = ${g.id}`);
        }),
        Match.when({ kind: 'var' }, (g) => {
          bind(g.hidden, `${a}.g`);
          where.push(this.namedGraphCond(`${a}.g`));
        }),
        Match.exhaustive,
      );
      position(p.subject, `${a}.s`, where);
      position(p.predicate, `${a}.p`, where);
      position(p.object, `${a}.o`, where);
    }
    return { items, where, cols };
  }

  /** The condition that the graph id column `g` of a quad is a named graph of the dataset. */
  namedGraphCond(g: string): string {
    const named = this.context.dataset.namedGraphs;
    if (named === 'all') return `${g} <> 0`;
    if (Arr.isReadonlyArrayEmpty(named)) return '1 = 0';
    return `${g} IN (${named.map((n) => this.idOf(n)).join(', ')})`;
  }

  /** A subquery listing the named graphs of the dataset (column `g`). */
  namedGraphsSource(): string {
    const named = this.context.dataset.namedGraphs;
    if (named === 'all') {
      return `(SELECT id AS g FROM ${this.G} UNION SELECT DISTINCT g FROM ${this.Q} WHERE g <> 0)`;
    }
    if (Arr.isReadonlyArrayEmpty(named)) return `(SELECT ${this.dialect.nullId} AS g WHERE 1 = 0)`;
    const alias = this.alias('n');
    return `(SELECT column1 AS g FROM (VALUES ${named.map((n) => `(${this.idOf(n)})`).join(', ')}) AS ${alias})`;
  }

  // --- other operators ---------------------------------------------------------

  values(op: Algebra.Values): Block {
    const vars = op.variables.map((v) => v.value);
    if (Arr.isReadonlyArrayEmpty(op.bindings)) {
      const cols = new Map<string, Col>();
      for (const v of vars) cols.set(v, { sql: this.dialect.nullId, nullable: true, type: 'id' });
      return { items: [], where: ['1 = 0'], cols };
    }
    const rows = op.bindings.map((b) =>
      Arr.isReadonlyArrayEmpty(vars)
        ? '(1)'
        : `(${vars
            .map((v) => {
              const t = b.map.get(v);
              return t === undefined ? this.dialect.nullId : String(this.idOf(t));
            })
            .join(', ')})`,
    );
    const a = this.alias('v');
    const select = Arr.isReadonlyArrayEmpty(vars)
      ? 'column1 AS one'
      : vars.map((v, i) => `column${i + 1} AS ${this.col(v)}`);
    const cols = new Map<string, Col>();
    for (const v of vars) {
      cols.set(v, {
        sql: `${a}.${this.col(v)}`,
        nullable: !op.bindings.every((b) => b.map.has(v)),
        type: 'id',
      });
    }
    return {
      items: [
        {
          source: `(SELECT ${Predicate.isString(select) ? select : select.join(', ')} FROM (VALUES ${rows.join(', ')}) AS ${a}_rows)`,
          alias: a,
        },
      ],
      where: [],
      cols,
    };
  }

  leftJoin(op: Algebra.LeftJoin, g: GraphCtx, unit: Block): Block {
    const left = this.op(op.left, g, unit);
    const right = this.op(op.right, g, unit);
    for (const [n, c] of right.cols) {
      if (isHidden(n) && (left.cols.get(n)?.nullable ?? true) && !c.nullable) {
        return unsupported('OPTIONAL graph-dependent pattern under GRAPH ?var');
      }
    }
    if (
      op.expression === undefined &&
      Arr.isReadonlyArrayEmpty(right.items) &&
      Arr.isReadonlyArrayEmpty(right.where) &&
      right.cols.size === 0
    ) {
      return left;
    }
    const a = this.anchored(left);
    const r = this.wrap(right);
    const conds: Array<string> = [];
    const merged = new Map(a.cols);
    const out = new Map(a.cols);
    for (const [n, cr] of r.cols) {
      const ca = a.cols.get(n);
      if (ca === undefined) {
        merged.set(n, cr);
        out.set(n, { ...cr, nullable: true });
      } else {
        const { cond, merged: m } = this.compat(ca, cr);
        conds.push(cond);
        merged.set(n, m);
        out.set(
          n,
          ca.nullable
            ? { sql: `COALESCE(${ca.sql}, ${cr.sql})`, nullable: true, type: ca.type }
            : ca,
        );
      }
    }
    if (op.expression !== undefined) {
      const e = this.ebv(this.operand(op.expression, { cols: merged, graph: g }));
      if (e !== 'TRUE') conds.push(e);
    }
    const on = Arr.isReadonlyArrayEmpty(conds) ? 'TRUE' : conds.join(' AND ');
    return {
      items: [...a.items, { source: r.items[0]!.source, alias: r.items[0]!.alias, left: on }],
      where: a.where,
      cols: out,
    };
  }

  union(a: Block, b: Block): Block {
    const names = Array.from(new Set([...a.cols.keys(), ...b.cols.keys()]));
    const cols = new Map<string, Omit<Col, 'sql'>>();
    const types = new Map<string, 'id' | 'int'>();
    for (const n of names) {
      const ca = a.cols.get(n);
      const cb = b.cols.get(n);
      if (ca !== undefined && cb !== undefined && ca.type !== cb.type) {
        return unsupported('UNION of integer and term columns');
      }
      if (isHidden(n) && (ca === undefined || cb === undefined || ca.nullable || cb.nullable)) {
        return unsupported('UNION of graph-dependent and independent patterns under GRAPH ?var');
      }
      const type = (ca ?? cb)!.type;
      types.set(n, type);
      cols.set(n, {
        nullable: ca === undefined || cb === undefined || ca.nullable || cb.nullable,
        type,
      });
    }
    const sql = `${this.render(a, names, { types })} UNION ALL ${this.render(b, names, { types })}`;
    return this.wrapSql(sql, cols);
  }

  minus(a: Block, b: Block): Block {
    const shared = Array.from(b.cols.keys()).filter((n) => a.cols.has(n));
    for (const n of b.cols.keys()) {
      if (isHidden(n) && !a.cols.has(n)) {
        return unsupported('MINUS of a graph-dependent pattern under GRAPH ?var');
      }
    }
    const overlap = shared.filter((n) => !isHidden(n));
    if (Arr.isReadonlyArrayEmpty(overlap)) return a;
    const m = this.wrap(b);
    const conds: Array<string> = [];
    const overlapConds: Array<C> = [];
    for (const n of shared) {
      const ca = a.cols.get(n)!;
      const cb = m.cols.get(n)!;
      conds.push(this.compat(ca, cb).cond);
      if (!isHidden(n)) {
        overlapConds.push(
          and(
            ca.nullable ? `${ca.sql} IS NOT NULL` : true,
            cb.nullable ? `${cb.sql} IS NOT NULL` : true,
          ),
        );
      }
    }
    const overlapCond = or(...overlapConds);
    if (overlapCond === false) return a;
    if (overlapCond !== true) conds.push(overlapCond);
    const item = m.items[0]!;
    return {
      ...a,
      where: [
        ...a.where,
        `NOT EXISTS (SELECT 1 FROM ${item.source} ${item.alias} WHERE ${conds.join(' AND ')})`,
      ],
    };
  }

  graph(op: Algebra.Graph, g: GraphCtx, unit: Block): Block {
    if (op.name._tag === 'NamedNode') {
      const id = this.idOf(op.name);
      const input = this.op(op.input, { kind: 'const', id }, unit);
      const named = this.context.dataset.namedGraphs;
      let cond: string;
      if (named === 'all') {
        cond = `(EXISTS (SELECT 1 FROM ${this.G} WHERE id = ${id}) OR EXISTS (SELECT 1 FROM ${this.Q} WHERE g = ${id}))`;
      } else cond = named.some((n) => n.key === op.name.key) ? 'TRUE' : '1 = 0';
      return cond === 'TRUE' ? input : { ...input, where: [...input.where, cond] };
    }
    const hidden = `#${this.alias('g')}`;
    let input = this.op(op.input, { kind: 'var', hidden }, unit);
    let gcol = input.cols.get(hidden);
    if (gcol !== undefined && gcol.nullable) {
      return unsupported('Graph-independent solutions under GRAPH ?var');
    }
    if (gcol === undefined) {
      const alias = this.alias('n');
      input = {
        ...input,
        items: [...input.items, { source: this.namedGraphsSource(), alias }],
      };
      gcol = { sql: `${alias}.g`, nullable: false, type: 'id' };
    }
    const cols = new Map(input.cols);
    cols.delete(hidden);
    const where = [...input.where];
    const existing = cols.get(op.name.value);
    if (existing === undefined) cols.set(op.name.value, gcol);
    else {
      const { cond } = this.compat(existing, gcol);
      where.push(cond);
      cols.set(op.name.value, gcol);
    }
    void g;
    return { items: input.items, where, cols };
  }

  group(op: Algebra.Group, g: GraphCtx, unit: Block): Block {
    if (g.kind === 'var') return unsupported('GROUP inside GRAPH ?var');
    const input = this.op(op.input, g, unit);
    const needed = new Set<string>();
    const keyVars: Array<{ readonly source: string; readonly target: string }> = [];
    for (const k of op.keys) {
      if (k.expression._tag !== 'Variable') return unsupported('Non-variable group key');
      if (!input.cols.has(k.expression.value)) return unsupported('Group key is never bound');
      needed.add(k.expression.value);
      keyVars.push({ source: k.expression.value, target: k.variable.value });
    }
    const aggs: Array<{
      readonly target: string;
      readonly sql: (s: string) => string;
      readonly col: Omit<Col, 'sql'>;
    }> = [];
    for (const { variable, aggregate } of op.aggregates) {
      const e = aggregate.expression;
      if (aggregate.name === 'COUNT') {
        if (e === '*') {
          if (aggregate.distinct) return unsupported('COUNT(DISTINCT *)');
          aggs.push({
            target: variable.value,
            sql: () => 'COUNT(*)',
            col: { nullable: false, type: 'int' },
          });
          continue;
        }
        if (e._tag !== 'Variable') return unsupported('COUNT of an expression');
        const name = e.value;
        if (!input.cols.has(name)) {
          aggs.push({
            target: variable.value,
            sql: () => '0',
            col: { nullable: false, type: 'int' },
          });
          continue;
        }
        needed.add(name);
        aggs.push({
          target: variable.value,
          sql: (s) => `COUNT(${aggregate.distinct ? 'DISTINCT ' : ''}${s}.${this.col(name)})`,
          col: { nullable: false, type: 'int' },
        });
        continue;
      }
      if (aggregate.name === 'SAMPLE' && e !== '*' && e._tag === 'Variable') {
        const name = e.value;
        const c = input.cols.get(name);
        if (c === undefined) {
          aggs.push({
            target: variable.value,
            sql: () => this.dialect.nullId,
            col: { nullable: true, type: 'id' },
          });
          continue;
        }
        needed.add(name);
        aggs.push({
          target: variable.value,
          sql: (s) => `MIN(${s}.${this.col(name)})`,
          col: { nullable: true, type: c.type },
        });
        continue;
      }
      return unsupported(`Aggregate ${aggregate.name}`);
    }
    const s = this.alias('a');
    const select: Array<string> = [];
    const cols = new Map<string, Omit<Col, 'sql'>>();
    for (const k of keyVars) {
      const c = input.cols.get(k.source)!;
      select.push(`${s}.${this.col(k.source)} AS ${this.col(k.target)}`);
      cols.set(k.target, { nullable: c.nullable, type: c.type });
    }
    for (const a of aggs) {
      select.push(`${a.sql(s)} AS ${this.col(a.target)}`);
      cols.set(a.target, a.col);
    }
    const inner = this.render(input, Array.from(needed));
    const groupBy = Arr.isReadonlyArrayEmpty(keyVars)
      ? ''
      : ` GROUP BY ${Array.from(new Set(keyVars.map((k) => `${s}.${this.col(k.source)}`))).join(', ')}`;
    const sql = `SELECT ${Arr.isReadonlyArrayEmpty(select) ? '1 AS one' : select.join(', ')} FROM (${inner}) ${s}${groupBy}`;
    return this.wrapSql(sql, cols);
  }

  // --- expressions ------------------------------------------------------------

  /** A dictionary attribute of a term id expression. */
  attr(id: string, field: 'kind' | 'value' | 'datatype' | 'lang' | 'dir' | 'cls' | 'num'): string {
    const lookup = `(SELECT ${field} FROM ${this.T} WHERE id = ${id})`;
    if (this.locals.size === 0) return lookup;
    if (!this.localsKnown) return lookup;
    const branches = Array.from(this.locals.values()).map(({ id: localId, term }) => {
      const v = this.lit(Enc.encode(term, [0, 0, 0])[field]);
      // Typed values, so that the branches agree with the dictionary column.
      const typed =
        field === 'num'
          ? this.dialect.castDouble(v)
          : field === 'kind' || field === 'cls'
            ? this.dialect.castInt(v)
            : this.dialect.castText(v);
      return `WHEN ${localId} THEN ${typed}`;
    });
    return `(CASE WHEN ${id} < 0 THEN (CASE ${id} ${branches.join(' ')} END) ELSE ${lookup} END)`;
  }

  termOperand(id: string, nullable: boolean): Operand {
    return {
      tag: 'term',
      classes: undefined,
      isNull: nullable ? Q(`${id} IS NULL`) : S(false),
      cls: Q(this.attr(id, 'cls')),
      kind: Q(this.attr(id, 'kind')),
      value: Q(this.attr(id, 'value')),
      datatype: Q(this.attr(id, 'datatype')),
      lang: Q(this.attr(id, 'lang')),
      dir: Q(this.attr(id, 'dir')),
      num: Q(this.attr(id, 'num')),
      id: Q(id),
    };
  }

  constOperand(term: Term.GroundTerm): Operand {
    const { cls, num } = Enc.classify(term);
    const base = {
      tag: 'const' as const,
      classes: [cls],
      isNull: S(false),
      cls: S(cls),
      num: S(num),
      id: S(this.idOf(term)),
      term,
    };
    return Match.value(term).pipe(
      Match.tag('NamedNode', 'BlankNode', (term) => ({
        ...base,
        kind: S(term._tag === 'NamedNode' ? Enc.Kind.NamedNode : Enc.Kind.BlankNode),
        value: S(term.value),
        datatype: S(''),
        lang: S(''),
        dir: S(''),
      })),
      Match.tag('Literal', (term) => ({
        ...base,
        kind: S(Enc.Kind.Literal),
        value: S(term.value),
        datatype: S(term.datatype.value),
        lang: S(term.language),
        dir: S(term.direction ?? ''),
      })),
      Match.tag('Triple', () => ({
        ...base,
        kind: S(Enc.Kind.Triple),
        value: S(null),
        datatype: S(''),
        lang: S(''),
        dir: S(''),
      })),
      Match.exhaustive,
    );
  }

  intOperand(sql: string, nullable: boolean): Operand {
    return {
      tag: 'int',
      classes: [Enc.Cls.SafeNumber],
      isNull: nullable ? Q(`${sql} IS NULL`) : S(false),
      cls: S(Enc.Cls.SafeNumber),
      kind: S(Enc.Kind.Literal),
      value: Q(this.dialect.castText(sql)),
      datatype: S(`${XSD}integer`),
      lang: S(''),
      dir: S(''),
      num: Q(sql),
    };
  }

  strOperand(sql: string): Operand {
    return {
      tag: 'str',
      classes: [Enc.Cls.String],
      isNull: Q(`${sql} IS NULL`),
      cls: S(Enc.Cls.String),
      kind: S(Enc.Kind.Literal),
      value: Q(sql),
      datatype: S(Term.XSD_STRING),
      lang: S(''),
      dir: S(''),
      num: S(null),
    };
  }

  boolOperand(sql: string): Operand {
    if (sql === 'TRUE' || sql === 'FALSE') return this.constOperand(sql === 'TRUE' ? TRUE : FALSE);
    return {
      tag: 'bool',
      classes: [Enc.Cls.Boolean],
      isNull: Q(`${sql} IS NULL`),
      cls: S(Enc.Cls.Boolean),
      kind: S(Enc.Kind.Literal),
      value: Q(`(CASE WHEN ${sql} THEN 'true' WHEN NOT ${sql} THEN 'false' END)`),
      datatype: S(`${XSD}boolean`),
      lang: S(''),
      dir: S(''),
      num: Q(`(CASE WHEN ${sql} THEN 1 WHEN NOT ${sql} THEN 0 END)`),
      bool: sql,
    };
  }

  iriOperand(sql: string): Operand {
    return {
      tag: 'iri',
      classes: [Enc.Cls.Resource],
      isNull: Q(`${sql} IS NULL`),
      cls: S(Enc.Cls.Resource),
      kind: S(Enc.Kind.NamedNode),
      value: Q(sql),
      datatype: S(''),
      lang: S(''),
      dir: S(''),
      num: S(null),
    };
  }

  readonly NULL: Operand = {
    tag: 'null',
    classes: [],
    isNull: S(true),
    cls: S(null),
    kind: S(null),
    value: S(null),
    datatype: S(null),
    lang: S(null),
    dir: S(null),
    num: S(null),
  };

  /** A term-valued expression as a column (for `BIND`). */
  termValued(o: Operand): Col {
    return Match.value(o).pipe(
      Match.withReturnType<Col>(),
      Match.when({ tag: 'term' }, (o) => ({
        sql: this.f(o.id!),
        nullable: !isStatic(o.isNull) || o.isNull.s !== false,
        type: 'id',
      })),
      Match.when({ tag: 'const' }, (o) => ({
        sql: String(this.idOf(o.term!)),
        nullable: false,
        type: 'id',
      })),
      Match.when({ tag: 'int' }, (o) => ({
        sql: this.f(o.num),
        nullable: !isStatic(o.isNull) || o.isNull.s !== false,
        type: 'int',
      })),
      Match.when({ tag: 'bool' }, (o) => ({
        sql: `(CASE WHEN ${o.bool!} THEN ${this.idOf(TRUE)} WHEN NOT ${o.bool!} THEN ${this.idOf(FALSE)} END)`,
        nullable: true,
        type: 'id',
      })),
      Match.when({ tag: 'null' }, () => ({ sql: this.dialect.nullId, nullable: true, type: 'id' })),
      Match.orElse(() => unsupported('Expression value is not a stored term')),
    );
  }

  /** Compiles an expression to an operand. */
  operand(e: Algebra.Expression, env: Env): Operand {
    return Match.value(e).pipe(
      Match.tag('Variable', (e) => {
        const c = env.cols.get(e.value);
        if (c === undefined) return this.NULL;
        return c.type === 'int'
          ? this.intOperand(c.sql, c.nullable)
          : this.termOperand(c.sql, c.nullable);
      }),
      Match.tag('NamedNode', 'Literal', (e) => this.constOperand(e)),
      Match.tag('BlankNode', () => unsupported('Blank node in an expression')),
      Match.tag('Triple', (e) => {
        if (!Term.isGround(e)) return unsupported('Triple term pattern in an expression');
        // SAFETY: `Term.isGround` holds, so the triple term has no variables.
        return this.constOperand(e as Term.Triple);
      }),
      Match.tag('FunctionCall', (e) => unsupported(`Function <${e.function.value}>`)),
      Match.tag('Exists', (e) => this.boolOperand(this.exists(e, env))),
      Match.tag('Operation', (e) => this.operation(e, env)),
      Match.exhaustive,
    );
  }

  operation(e: Algebra.OperationExpression, env: Env): Operand {
    const args = e.args;
    const arg = (i: number) => this.operand(args[i]!, env);
    const bool = (sql: string) => this.boolOperand(sql);
    return Match.value(e)
      .pipe(
        Match.when({ operator: '&&' }, () => bool(`(${this.ebv(arg(0))} AND ${this.ebv(arg(1))})`)),
        Match.when({ operator: '||' }, () => bool(`(${this.ebv(arg(0))} OR ${this.ebv(arg(1))})`)),
        Match.when({ operator: '!' }, () => bool(`(NOT ${this.ebv(arg(0))})`)),
        Match.when({ operator: '=' }, () => bool(this.equals(arg(0), arg(1)))),
        Match.when({ operator: '!=' }, () => bool(`(NOT ${this.equals(arg(0), arg(1))})`)),
        Match.when({ operator: Match.is('<', '>', '<=', '>=') }, (e) =>
          bool(this.compare(arg(0), arg(1), e.operator)),
        ),
        Match.when({ operator: Match.is('IN', 'NOT IN') }, (e) => {
          const value = arg(0);
          const tests = args.slice(1).map((_, i) => this.equals(value, arg(i + 1)));
          const any = Arr.isReadonlyArrayEmpty(tests) ? 'FALSE' : `(${tests.join(' OR ')})`;
          return bool(e.operator === 'IN' ? any : `(NOT ${any})`);
        }),
        Match.when({ operator: 'BOUND' }, () => {
          const v = args[0]!;
          if (v._tag !== 'Variable') return unsupported('BOUND of a non-variable');
          const c = env.cols.get(v.value);
          return bool(c === undefined ? 'FALSE' : c.nullable ? `(${c.sql} IS NOT NULL)` : 'TRUE');
        }),
        Match.when({ operator: 'SAMETERM' }, () => {
          const a = arg(0);
          const b = arg(1);
          if (a.tag === 'null' || b.tag === 'null') return bool('NULL');
          if (a.id === undefined || b.id === undefined)
            return unsupported('sameTerm of computed values');
          return bool(`(${this.f(a.id)} = ${this.f(b.id)})`);
        }),
        Match.when({ operator: Match.is('ISIRI', 'ISURI') }, () =>
          bool(this.kindTest(arg(0), Enc.Kind.NamedNode)),
        ),
        Match.when({ operator: 'ISBLANK' }, () => bool(this.kindTest(arg(0), Enc.Kind.BlankNode))),
        Match.when({ operator: 'ISLITERAL' }, () => bool(this.kindTest(arg(0), Enc.Kind.Literal))),
        Match.when({ operator: 'ISTRIPLE' }, () => bool(this.kindTest(arg(0), Enc.Kind.Triple))),
        Match.when({ operator: 'ISNUMERIC' }, () => {
          const a = arg(0);
          return bool(this.guard(a, condSql(this.clsIn(a, [1, 2, 3, 8, 11]))));
        }),
        Match.when({ operator: 'HASLANG' }, () => {
          const a = arg(0);
          return bool(this.guard(a, condSql(this.clsIn(a, [Enc.Cls.LangString]))));
        }),
        Match.when({ operator: 'HASLANGDIR' }, () => {
          const a = arg(0);
          return bool(
            this.guard(a, condSql(and(this.clsIn(a, [Enc.Cls.LangString]), this.ne(a.dir, S(''))))),
          );
        }),
        Match.when({ operator: 'STR' }, () => {
          const a = arg(0);
          if (a.tag === 'const') {
            const t = a.term!;
            if (t._tag === 'NamedNode' || t._tag === 'Literal')
              return this.constOperand(Term.literal(t.value));
            return this.NULL;
          }
          if (a.tag === 'str' || a.tag === 'null') return a;
          return this.strOperand(
            caseOf(
              [
                [this.isNullC(a), 'NULL'],
                [
                  or(this.eqC(a.kind, Enc.Kind.NamedNode), this.eqC(a.kind, Enc.Kind.Literal)),
                  this.f(a.value),
                ],
              ],
              'NULL',
            ),
          );
        }),
        Match.when({ operator: 'LANG' }, () => {
          const a = arg(0);
          if (a.tag === 'const') {
            const t = a.term!;
            return t._tag === 'Literal' ? this.constOperand(Term.literal(t.language)) : this.NULL;
          }
          if (a.tag === 'null') return a;
          return this.strOperand(
            caseOf(
              [
                [this.isNullC(a), 'NULL'],
                [this.eqC(a.kind, Enc.Kind.Literal), this.f(a.lang)],
              ],
              'NULL',
            ),
          );
        }),
      )
      .pipe(
        Match.when({ operator: 'DATATYPE' }, () => {
          const a = arg(0);
          if (a.tag === 'const') {
            const t = a.term!;
            return t._tag === 'Literal' ? this.constOperand(t.datatype) : this.NULL;
          }
          if (a.tag === 'null') return a;
          return this.iriOperand(
            caseOf(
              [
                [this.isNullC(a), 'NULL'],
                [this.eqC(a.kind, Enc.Kind.Literal), this.f(a.datatype)],
              ],
              'NULL',
            ),
          );
        }),
        Match.when({ operator: 'STRLEN' }, () => {
          const a = arg(0);
          if (a.tag === 'null') return a;
          return this.intOperand(
            caseOf(
              [
                [
                  this.clsIn(a, [Enc.Cls.String, Enc.Cls.LangString]),
                  this.dialect.length(this.f(a.value)),
                ],
              ],
              'NULL',
            ),
            true,
          );
        }),
        Match.when({ operator: Match.is('STRSTARTS', 'STRENDS', 'CONTAINS') }, (e) => {
          const a = arg(0);
          const b = arg(1);
          const fn =
            e.operator === 'STRSTARTS'
              ? this.dialect.startsWith
              : e.operator === 'STRENDS'
                ? this.dialect.endsWith
                : this.dialect.contains;
          const strings = [Enc.Cls.String, Enc.Cls.LangString];
          const ok = and(
            this.clsIn(a, strings),
            this.clsIn(b, strings),
            or(
              this.clsIn(b, [Enc.Cls.String]),
              and(this.eqFF(a.lang, b.lang), this.eqFF(a.dir, b.dir)),
            ),
          );
          return bool(caseOf([[ok, fn(this.f(a.value), this.f(b.value))]], 'NULL'));
        }),
        Match.when({ operator: 'LANGMATCHES' }, () => {
          const a = arg(0);
          const b = arg(1);
          if (b.tag !== 'const') return unsupported('LANGMATCHES with a non-constant range');
          const range = b.term!;
          if (range._tag !== 'Literal' || Enc.classify(range).cls !== Enc.Cls.String)
            return bool('NULL');
          // eslint-disable-next-line no-control-regex
          if (!/^[\x00-\x7f]*$/.test(range.value)) return unsupported('Non-ASCII language range');
          const r = range.value.toLowerCase();
          const tag = `lower(${this.f(a.value)})`;
          const test =
            r === '*'
              ? `(${this.f(a.value)} <> '')`
              : `(${tag} = ${this.lit(r)} OR ${this.dialect.startsWith(tag, this.lit(`${r}-`))})`;
          return bool(caseOf([[this.clsIn(a, [Enc.Cls.String]), test]], 'NULL'));
        }),
        Match.when({ operator: 'IF' }, () => {
          const c = this.ebv(arg(0));
          const a = arg(1);
          const b = arg(2);
          const ca = this.termValued(a);
          const cb = this.termValued(b);
          if (ca.type !== cb.type) return unsupported('IF of integer and term values');
          const sql = `(CASE WHEN ${c} THEN ${ca.sql} WHEN NOT ${c} THEN ${cb.sql} END)`;
          return ca.type === 'int' ? this.intOperand(sql, true) : this.termOperand(sql, true);
        }),
        Match.when({ operator: 'COALESCE' }, () => {
          const parts = args.map((_, i) => arg(i)).filter((o) => o.tag !== 'null');
          if (Arr.isReadonlyArrayEmpty(parts)) return this.NULL;
          const cols = parts.map((o) => this.termValued(o));
          const type = cols[0]!.type;
          if (cols.some((c) => c.type !== type))
            return unsupported('COALESCE of integer and term values');
          const sql =
            cols.length === 1 ? cols[0]!.sql : `COALESCE(${cols.map((c) => c.sql).join(', ')})`;
          const nullable = cols.every((c) => c.nullable);
          return type === 'int' ? this.intOperand(sql, nullable) : this.termOperand(sql, nullable);
        }),
        Match.orElse((e) => unsupported(`Operator ${e.operator}`)),
      );
  }

  // --- conditions -------------------------------------------------------------

  isNullC(o: Operand): C {
    return isStatic(o.isNull) ? o.isNull.s === true : o.isNull.q;
  }

  eqC(f: F, v: Static): C {
    if (isStatic(f)) return f.s === null ? false : f.s === v;
    return `${f.q} = ${this.lit(v)}`;
  }

  clsIn(o: Operand, classes: ReadonlyArray<number>): C {
    const f = o.cls;
    if (isStatic(f)) return Predicate.isNumber(f.s) && classes.includes(f.s);
    return classes.length === 1 ? `${f.q} = ${classes[0]}` : `${f.q} IN (${classes.join(', ')})`;
  }

  eqFF(a: F, b: F): C {
    if (isStatic(a) && isStatic(b)) return a.s === b.s;
    return `${this.f(a)} = ${this.f(b)}`;
  }

  ne(a: F, b: F): C {
    if (isStatic(a) && isStatic(b)) return a.s !== b.s;
    return `${this.f(a)} <> ${this.f(b)}`;
  }

  /** `NULL` if the operand is unbound, otherwise the test. */
  guard(o: Operand, test: string): string {
    return caseOf([[this.isNullC(o), 'NULL']], test);
  }

  kindTest(o: Operand, kind: number): string {
    return this.guard(o, condSql(this.eqC(o.kind, kind)));
  }

  /** Records the class combinations of a comparison that SQL cannot evaluate exactly. */
  risk(
    pairs: ReadonlyArray<readonly [number, number]>,
    a: Operand,
    b: Operand,
    handled: ReadonlySet<string> = new Set(),
  ): void {
    const possible = (o: Operand, c: number) => o.classes === undefined || o.classes.includes(c);
    for (const [x, y] of pairs) {
      for (const [p, q] of x === y ? [[x, y] as const] : [[x, y] as const, [y, x] as const]) {
        if (!possible(a, p) || !possible(b, q) || handled.has(`${p},${q}`)) continue;
        const r: Risk = {
          a: p,
          aStatic: a.classes !== undefined,
          b: q,
          bStatic: b.classes !== undefined,
        };
        if (r.aStatic && r.bStatic) unsupported('Comparison that SQL cannot evaluate exactly');
        this.risks.push(r);
      }
    }
  }

  /**
   * Exact comparisons of a float-or-double term with a numeric constant,
   * following SPARQL's type promotion (integers and decimals are promoted to
   * float, floats to double). Returns the branches and the class pairs they
   * handle.
   */
  promoted(a: Operand, b: Operand, op: string): Promotions {
    const branches: Array<readonly [C, string]> = [];
    const handled = new Set<string>();
    const one = (t: Operand, c: Operand, flip: boolean) => {
      if (c.tag !== 'const' || t.tag === 'const' || !isStatic(c.num) || !isStatic(c.cls)) return;
      const v = c.num.s;
      const cc = c.cls.s;
      if (!Predicate.isNumber(v)) return;
      const add = (cls: number, value: number) => {
        if (!Number.isFinite(value)) return;
        const cmp = flip
          ? `${this.lit(value)} ${op} ${this.f(t.num)}`
          : `${this.f(t.num)} ${op} ${this.lit(value)}`;
        branches.push([this.clsIn(t, [cls]), cmp]);
        handled.add(flip ? `${cc},${cls}` : `${cls},${cc}`);
      };
      if (cc === Enc.Cls.SafeNumber) add(Enc.Cls.Float, Math.fround(v));
      else if (cc === Enc.Cls.Double) add(Enc.Cls.Float, v);
      else if (cc === Enc.Cls.Float) add(Enc.Cls.Double, v);
    };
    one(a, b, false);
    one(b, a, true);
    return { branches, handled };
  }

  /** SPARQL `=` (value equality, with errors as `NULL`). */
  equals(a: Operand, b: Operand): string {
    if (a.tag === 'null' || b.tag === 'null') return 'NULL';
    if (a.tag === 'const' && b.tag === 'const') {
      const r = Expression.equals(a.term!, b.term!);
      return Result.isSuccess(r) ? (r.success ? 'TRUE' : 'FALSE') : 'NULL';
    }
    const promoted = this.promoted(a, b, '=');
    this.risk(RISK_EQUAL, a, b, promoted.handled);
    const bothIds = a.id !== undefined && b.id !== undefined;
    const num = `${this.f(a.num)} = ${this.f(b.num)}`;
    return caseOf(
      [
        [or(this.isNullC(a), this.isNullC(b)), 'NULL'],
        [bothIds ? this.eqFF(a.id!, b.id!) : false, 'TRUE'],
        ...promoted.branches,
        [and(this.clsIn(a, [1, 2]), this.clsIn(b, [1, 2])), num],
        [and(this.clsIn(a, [3]), this.clsIn(b, [3])), num],
        [and(this.clsIn(a, [6]), this.clsIn(b, [6])), num],
        [and(this.clsIn(a, [4]), this.clsIn(b, [4])), `${this.f(a.value)} = ${this.f(b.value)}`],
        [
          and(this.clsIn(a, [0]), this.clsIn(b, [0])),
          bothIds ? 'FALSE' : condSql(and(this.eqFF(a.kind, b.kind), this.eqFF(a.value, b.value))),
        ],
        [or(this.clsIn(a, [0, 10]), this.clsIn(b, [0, 10])), 'FALSE'],
        [or(this.clsIn(a, [5]), this.clsIn(b, [5])), 'FALSE'],
        [
          and(
            this.clsIn(a, Enc.WELL_FORMED_KNOWN),
            this.clsIn(b, Enc.WELL_FORMED_KNOWN),
            this.ne(a.datatype, b.datatype),
          ),
          'FALSE',
        ],
      ],
      'NULL',
    );
  }

  /** SPARQL `<`, `>`, `<=`, `>=`. */
  compare(a: Operand, b: Operand, op: '<' | '>' | '<=' | '>='): string {
    if (a.tag === 'null' || b.tag === 'null') return 'NULL';
    const promoted = this.promoted(a, b, op);
    this.risk(RISK_ORDER, a, b, promoted.handled);
    const num = `${this.f(a.num)} ${op} ${this.f(b.num)}`;
    const str = `${this.dialect.binary(this.f(a.value))} ${op} ${this.dialect.binary(this.f(b.value))}`;
    return caseOf(
      [
        [or(this.isNullC(a), this.isNullC(b)), 'NULL'],
        ...promoted.branches,
        [and(this.clsIn(a, [1, 2]), this.clsIn(b, [1, 2])), num],
        [and(this.clsIn(a, [3]), this.clsIn(b, [3])), num],
        [and(this.clsIn(a, [4]), this.clsIn(b, [4])), str],
        [
          and(
            this.clsIn(a, [5]),
            this.clsIn(b, [5]),
            this.eqFF(a.lang, b.lang),
            this.eqFF(a.dir, b.dir),
          ),
          str,
        ],
        [and(this.clsIn(a, [6]), this.clsIn(b, [6])), num],
      ],
      'NULL',
    );
  }

  /** The effective boolean value (SQL boolean, `NULL` = error). */
  ebv(o: Operand): string {
    return Match.value(o).pipe(
      Match.when({ tag: 'bool' }, (o) => o.bool!),
      Match.when({ tag: Match.is('null', 'iri') }, () => 'NULL'),
      Match.when({ tag: 'const' }, (o) => {
        const r = Expression.effectiveBooleanValue(o.term!);
        return Result.isSuccess(r) ? (r.success ? 'TRUE' : 'FALSE') : 'NULL';
      }),
      Match.when({ tag: 'int' }, (o) => `(${this.f(o.num)} <> 0)`),
      Match.when({ tag: 'str' }, (o) => `(${this.f(o.value)} <> '')`),
      Match.when({ tag: 'term' }, (o) => {
        const num = `${this.f(o.num)} <> 0`;
        const value = this.f(o.value);
        return caseOf(
          [
            [this.clsIn(o, [6, 1, 2, 3]), num],
            [this.clsIn(o, [4]), `${value} <> ''`],
            [this.clsIn(o, [8]), this.dialect.hasNonZeroDigit(value)],
            [this.clsIn(o, [11]), `${value} <> 'NaN'`],
            [this.clsIn(o, [12]), 'FALSE'],
          ],
          'NULL',
        );
      }),
      Match.exhaustive,
    );
  }

  /** `EXISTS` / `NOT EXISTS` as a correlated subquery. */
  exists(e: Algebra.ExistsExpression, env: Env): string {
    const context: Block = { items: [], where: [], cols: env.cols };
    const inner = this.op(e.input, env.graph, context);
    const where = [...inner.where];
    if (env.graph.kind === 'var') {
      const hidden = env.graph.hidden;
      const ic = inner.cols.get(hidden);
      const oc = env.cols.get(hidden);
      if (ic !== undefined) {
        if (oc === undefined || oc.nullable)
          return unsupported('EXISTS in a graph-independent pattern');
        if (ic.sql !== oc.sql) where.push(`${ic.sql} = ${oc.sql}`);
      }
    }
    const sql = `EXISTS (SELECT 1${this.from(inner.items)}${this.whereClause(where)})`;
    return e.negated ? `(NOT ${sql})` : sql;
  }
}

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

const compileOnce = (
  op: Algebra.Operation,
  context: TranslationContext,
  resolve: (term: Term.GroundTerm) => number | undefined,
  locals: Map<string, { readonly id: number; readonly term: Term.GroundTerm }>,
  localsKnown: boolean,
): CompiledQuery => {
  const c = new Compiler(context, resolve, locals, localsKnown);
  const g: GraphCtx =
    context.activeGraph._tag === 'NamedGraph'
      ? { kind: 'const', id: c.idOf(context.activeGraph.graph) }
      : { kind: 'default' };
  const block = c.op(op, g, EMPTY);
  const names = Array.from(block.cols.keys()).filter((n) => !isHidden(n));
  const inner = c.render(block, names);
  const select: Array<string> = [];
  const joins: Array<string> = [];
  const columns: Array<OutputColumn> = [];
  names.forEach((n, i) => {
    const col = block.cols.get(n)!;
    const name = `r.${c.col(n)}`;
    columns.push({ variable: n, type: col.type });
    if (col.type === 'int') {
      select.push(name);
      return;
    }
    const t = `d${i}`;
    select.push(name, `${t}.kind`, `${t}.value`, `${t}.datatype`, `${t}.lang`, `${t}.dir`);
    joins.push(` LEFT JOIN ${c.T} ${t} ON ${t}.id = ${name}`);
  });
  const marked = `SELECT ${Arr.isReadonlyArrayEmpty(select) ? '1 AS one' : select.join(', ')} FROM (${inner}) r${joins.join('')}`;
  // Number the parameters in order of use (fragments of discarded branches
  // may have allocated parameters that are not used).
  const params: Array<unknown> = [];
  const numbering = new Map<string, number>();
  const sql = marked.replace(/\ue000(\d+)\ue000/g, (_, i: string) => {
    if (context.dialect.anonymousParameters) {
      params.push(c.params[Number(i) - 1]);
      return context.dialect.placeholder(params.length);
    }
    let n = numbering.get(i);
    if (n === undefined) {
      params.push(c.params[Number(i) - 1]);
      numbering.set(i, (n = params.length));
    }
    return context.dialect.placeholder(n);
  });
  const byId = new Map<number, Term.GroundTerm>();
  for (const { id, term } of locals.values()) byId.set(id, term);
  return {
    sql,
    params,
    columns,
    locals: byId,
    localClasses: c.localClasses,
    risks: c.risks,
  };
};

/**
 * Translates an algebra tree to SQL. `resolve` gives the dictionary ids of
 * constant terms (see `constants`); terms it does not know get query-local
 * ids. Fails with a reason if the tree is not translatable.
 *
 * @since 0.1.0
 * @category compilation
 */
export const compile = (
  op: Algebra.Operation,
  context: TranslationContext,
  resolve: (term: Term.GroundTerm) => number | undefined,
): Result.Result<CompiledQuery, string> => {
  return Result.try({
    try: () => {
      const locals = new Map<string, { readonly id: number; readonly term: Term.GroundTerm }>();
      const first = compileOnce(op, context, resolve, locals, false);
      if (locals.size === 0) return first;
      // Second pass: dictionary attributes of query-local terms are inlined.
      return compileOnce(op, context, resolve, locals, true);
    },
    // An `Unsupported` is the expected failure; anything else is a defect and
    // keeps propagating.
    catch: (err) => {
      if (err instanceof Unsupported) return err.reason;
      throw err;
    },
  });
};

/**
 * Whether an algebra tree is translatable to SQL (independent of the data).
 *
 * @since 0.1.0
 * @category compilation
 */
export const supports = (op: Algebra.Operation, context: TranslationContext): boolean =>
  Result.isSuccess(compile(op, context, () => undefined));
