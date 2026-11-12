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
import * as Arr from 'effect/Array';
import * as Equal from 'effect/Equal';
import * as Match from 'effect/Match';
import * as HashMap from 'effect/HashMap';
import * as HashSet from 'effect/HashSet';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Term from '../../Term.ts';
import type * as Algebra from '../Algebra.ts';
import type * as Ast from '../Ast.ts';
import * as Expression from '../Expression.ts';
import type * as Store from '../Store.ts';
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
  readonly locals: HashMap.HashMap<number, Term.GroundTerm>;
  /** The comparison classes of the query-local terms. */
  readonly localClasses: HashSet.HashSet<number>;
  readonly risks: ReadonlyArray<Risk>;
}

/**
 * Whether the risks of a compiled query can occur, given the comparison
 * classes present in the store.
 *
 * @since 0.1.0
 * @category utils
 */
export const isRisky = (
  compiled: CompiledQuery,
  storeClasses: HashSet.HashSet<number>,
): boolean => {
  const present = (c: number) =>
    HashSet.has(storeClasses, c) || HashSet.has(compiled.localClasses, c);
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

/** Terms by key. */
type TermsByKey = MutableHashMap.MutableHashMap<string, Term.GroundTerm>;

/** Whether a term (pattern) is a triple term with no variables. */
const isGroundTriple = (t: Ast.TermPattern | Term.Term): t is Term.Triple =>
  Term.isTriple(t) && Term.isGround(t);

const collectTerm = (term: Ast.TermPattern | Term.Term, out: TermsByKey): void => {
  return Match.value(term).pipe(
    Match.tag('NamedNode', 'Literal', (t) => {
      MutableHashMap.set(out, t.key, t);
      return;
    }),
    Match.tag('Triple', (t) => {
      if (isGroundTriple(t)) {
        MutableHashMap.set(out, t.key, t);
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

const collectExpression = (e: Algebra.Expression, out: TermsByKey): void => {
  Match.value(e).pipe(
    Match.tag('Operation', 'FunctionCall', (call) =>
      call.args.forEach((a) => collectExpression(a, out)),
    ),
    Match.tag('Exists', (x) => collectOperation(x.input, out)),
    Match.orElse((t) => collectTerm(t, out)),
  );
};

const collectOperation = (operation: Algebra.Operation, out: TermsByKey): void => {
  return Match.value(operation).pipe(
    Match.tag('Bgp', (op) =>
      op.patterns.forEach((p) => {
        collectTerm(p.subject, out);
        collectTerm(p.predicate, out);
        collectTerm(p.object, out);
      }),
    ),
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
    Match.tag('Values', (op) =>
      op.bindings.forEach((b) => Arr.forEach(b, ([, t]) => collectTerm(t, out))),
    ),
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
  const out: TermsByKey = MutableHashMap.empty();
  collectOperation(op, out);
  const { defaultGraph, namedGraphs } = context.dataset;
  if (!Predicate.isString(defaultGraph)) {
    defaultGraph.forEach((g) => {
      if (!Term.isDefaultGraph(g)) MutableHashMap.set(out, g.key, g);
    });
  }
  if (!Predicate.isString(namedGraphs)) {
    namedGraphs.forEach((g) => MutableHashMap.set(out, g.key, g));
  }
  if (Predicate.isTagged(context.activeGraph, 'NamedGraph')) {
    MutableHashMap.set(out, context.activeGraph.graph.key, context.activeGraph.graph);
  }
  MutableHashMap.set(out, TRUE.key, TRUE);
  MutableHashMap.set(out, FALSE.key, FALSE);
  return Arr.fromIterable(MutableHashMap.values(out));
};

// -----------------------------------------------------------------------------
// Blocks
// -----------------------------------------------------------------------------

interface Col {
  readonly sql: string;
  readonly nullable: boolean;
  readonly type: 'id' | 'int';
}

/** The columns of a block, by variable (in order of binding). */
type Cols = MutableHashMap.MutableHashMap<string, Col>;

/** Column types without their SQL, by variable. */
type ColTypes = MutableHashMap.MutableHashMap<string, Omit<Col, 'sql'>>;

interface Item {
  readonly source: string;
  readonly alias: string;
  /** The `ON` condition of a `LEFT JOIN`; inner joins have none. */
  readonly left: Option.Option<string>;
}

/** A FROM item joined unconditionally. */
const inner = (source: string, alias: string): Item => ({ source, alias, left: Option.none() });

/** A `SELECT` under construction: FROM items, WHERE conditions and variables. */
interface Block {
  readonly items: ReadonlyArray<Item>;
  readonly where: ReadonlyArray<string>;
  readonly cols: Cols;
}

/** A block selecting from one subquery. */
interface Wrapped extends Block {
  readonly items: readonly [Item];
}

const EMPTY: Block = { items: [], where: [], cols: MutableHashMap.empty() };

/** Whether a block is the unit (no items, conditions or columns). */
const isUnit = (block: Block): boolean =>
  Arr.isReadonlyArrayEmpty(block.items) &&
  Arr.isReadonlyArrayEmpty(block.where) &&
  MutableHashMap.isEmpty(block.cols);

type GraphCtx =
  | { readonly kind: 'default' }
  | { readonly kind: 'const'; readonly id: number }
  | { readonly kind: 'var'; readonly hidden: string };

const isHidden = (name: string): boolean => name.startsWith('#');

/** The distinct values of `items`, in order of first occurrence. */
const distinct = <A extends string | number>(items: Iterable<A>): Array<A> =>
  Arr.fromIterable(MutableHashSet.fromIterable(items));

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const TRUE = new Term.Literal('true', Term.namedNode(`${XSD}boolean`));
const FALSE = new Term.Literal('false', Term.namedNode(`${XSD}boolean`));

// -----------------------------------------------------------------------------
// Expression operands
// -----------------------------------------------------------------------------

type Scalar = string | number | boolean;

/** A statically known value: none is SQL `NULL`. */
type Static = Option.Option<Scalar>;

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
  readonly handled: MutableHashSet.MutableHashSet<string>;
}

interface Fields {
  /** Possible comparison classes (none = any). */
  readonly classes: Option.Option<ReadonlyArray<number>>;
  readonly isNull: F;
  readonly cls: F;
  readonly kind: F;
  readonly value: F;
  readonly datatype: F;
  readonly lang: F;
  readonly dir: F;
  readonly num: F;
}

type Operand =
  /** A term-valued expression (`id` is its term id). */
  | (Fields & { readonly tag: 'term'; readonly id: F })
  /** A constant term. */
  | (Fields & { readonly tag: 'const'; readonly id: F; readonly term: Term.GroundTerm })
  /** A boolean (`bool` is its SQL boolean). */
  | (Fields & { readonly tag: 'bool'; readonly bool: string })
  | (Fields & { readonly tag: 'int' })
  | (Fields & { readonly tag: 'str' })
  | (Fields & { readonly tag: 'iri' })
  | (Fields & { readonly tag: 'null' });

/** The term id of a term-valued operand. */
const operandId = (o: Operand): Option.Option<F> =>
  o.tag === 'term' || o.tag === 'const' ? Option.some(o.id) : Option.none();

const S = (s: Scalar): F => ({ s: Option.some(s) });
const SO = (s: Static): F => ({ s });
const SNULL: F = { s: Option.none() };
const Q = (q: string): F => ({ q });
const isStatic = (f: F): f is { readonly s: Static } => 's' in f;

/** The statically known number of a field. */
const staticNumber = (f: F): Option.Option<number> =>
  isStatic(f) ? Option.filter(f.s, Predicate.isNumber) : Option.none();

/** Whether a field is statically the value `v`. */
const isStaticValue = (f: F, v: Scalar): boolean =>
  isStatic(f) && Option.exists(f.s, (s) => s === v);

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

/** The SQL conditions of `cs` (dropping the statically known ones). */
const conditions = (cs: ReadonlyArray<C>): Array<string> => cs.filter(Predicate.isString);

const and = (...cs: ReadonlyArray<C>): C => {
  if (cs.includes(false)) return false;
  const parts = conditions(cs);
  return Arr.match(parts, {
    onEmpty: () => true,
    onNonEmpty: ([first, ...rest]) =>
      Arr.isReadonlyArrayEmpty(rest) ? first : `(${parts.join(' AND ')})`,
  });
};

const or = (...cs: ReadonlyArray<C>): C => {
  if (cs.includes(true)) return true;
  const parts = conditions(cs);
  return Arr.match(parts, {
    onEmpty: () => false,
    onNonEmpty: ([first, ...rest]) =>
      Arr.isReadonlyArrayEmpty(rest) ? first : `(${parts.join(' OR ')})`,
  });
};

const condSql = (c: C): string => (c === true ? 'TRUE' : c === false ? 'FALSE' : c);

const isLive = (branch: readonly [C, string]): branch is readonly [string, string] =>
  Predicate.isString(branch[0]);

/**
 * A `CASE` of the branches up to the first that always holds (whose value is
 * then the `ELSE`), dropping the branches that never hold.
 */
const caseOf = (branches: ReadonlyArray<readonly [C, string]>, otherwise: string): string => {
  const fallback = Option.match(
    Arr.findFirst(branches, ([c]) => c === true),
    { onNone: () => otherwise, onSome: ([, v]) => v },
  );
  const live = Arr.takeWhile(branches, ([c]) => c !== true).filter(isLive);
  if (Arr.isReadonlyArrayEmpty(live)) return fallback;
  return `(CASE ${live.map(([w, r]) => `WHEN ${w} THEN ${r}`).join(' ')} ELSE ${fallback} END)`;
};

// -----------------------------------------------------------------------------
// Compiler
// -----------------------------------------------------------------------------

interface Env {
  readonly cols: Cols;
  readonly graph: GraphCtx;
}

/** A query-local term and its (negative) id. */
interface Local {
  readonly id: number;
  readonly term: Term.GroundTerm;
}

/** Query-local terms by key. */
type Locals = MutableHashMap.MutableHashMap<string, Local>;

/** An aggregate of a `GROUP`: the SQL of its value over the grouped subquery `s`. */
interface Aggregate {
  readonly target: string;
  readonly sql: (s: string) => string;
  readonly col: Omit<Col, 'sql'>;
}

/** A group key variable (`source`, bound to `col`) and the variable it is projected as. */
interface GroupKey {
  readonly source: string;
  readonly target: string;
  readonly col: Col;
}

/** The input of a `GRAPH ?var` and the column of its graph ids. */
interface GraphInput {
  readonly input: Block;
  readonly gcol: Col;
}

/** A variable of both sides of a `MINUS`, with its column on each side. */
interface Shared {
  readonly name: string;
  readonly left: Col;
  readonly right: Col;
}

class Compiler {
  readonly dialect: Dialect.Dialect;
  readonly T: string;
  readonly Q: string;
  readonly G: string;
  counter = 0;
  readonly colNames = MutableHashMap.empty<string, string>();
  readonly params: Array<unknown> = [];
  readonly paramIndex = MutableHashMap.empty<string, number>();
  readonly risks: Array<Risk> = [];
  readonly localClasses = MutableHashSet.empty<number>();

  readonly context: TranslationContext;
  readonly resolve: (term: Term.GroundTerm) => Option.Option<number>;
  /** Query-local terms, by key (stable across the two compilation passes). */
  readonly locals: Locals;
  /** Whether the query-local terms are complete (second pass). */
  readonly localsKnown: boolean;

  constructor(
    context: TranslationContext,
    resolve: (term: Term.GroundTerm) => Option.Option<number>,
    locals: Locals,
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
    return Option.getOrElse(MutableHashMap.get(this.colNames, name), () => {
      const c = `c${MutableHashMap.size(this.colNames)}`;
      MutableHashMap.set(this.colNames, name, c);
      return c;
    });
  }

  param(value: string): string {
    const i = Option.getOrElse(MutableHashMap.get(this.paramIndex, value), () => {
      this.params.push(value);
      const n = this.params.length;
      MutableHashMap.set(this.paramIndex, value, n);
      return n;
    });
    return this.dialect.castText(`\ue000${i}\ue000`);
  }

  lit(v: Scalar): string {
    if (Predicate.isBoolean(v)) return v ? 'TRUE' : 'FALSE';
    if (Predicate.isNumber(v)) {
      if (!Number.isFinite(v)) return 'NULL';
      return Number.isInteger(v) && Math.abs(v) < 1e15
        ? String(v)
        : this.dialect.castDouble(String(v));
    }
    return this.param(v);
  }

  /** A statically known value as SQL (none is `NULL`). */
  litOf(v: Static): string {
    return Option.match(v, { onNone: () => 'NULL', onSome: (s) => this.lit(s) });
  }

  f(field: F): string {
    return isStatic(field) ? this.litOf(field.s) : field.q;
  }

  /** The id of a constant term (a query-local negative id if it is not in the dictionary). */
  idOf(term: Term.GroundTerm | Term.DefaultGraph): number {
    if (Term.isDefaultGraph(term)) return 0;
    return Option.getOrElse(this.resolve(term), () => this.localId(term));
  }

  /** The query-local id of a term that is not in the dictionary. */
  localId(term: Term.GroundTerm): number {
    const local = Option.getOrElse(MutableHashMap.get(this.locals, term.key), () => {
      const created: Local = { id: -(MutableHashMap.size(this.locals) + 1), term };
      MutableHashMap.set(this.locals, term.key, created);
      return created;
    });
    MutableHashSet.add(this.localClasses, Enc.classify(term).cls);
    return local.id;
  }

  // --- rendering --------------------------------------------------------------

  from(items: ReadonlyArray<Item>): string {
    if (!Arr.isReadonlyArrayNonEmpty(items)) return '';
    const [first, ...rest] = items;
    const joins = rest.map((it) =>
      Option.match(it.left, {
        onNone: () => ` JOIN ${it.source} ${it.alias} ON TRUE`,
        onSome: (on) => ` LEFT JOIN ${it.source} ${it.alias} ON ${on}`,
      }),
    );
    return ` FROM ${first.source} ${first.alias}${joins.join('')}`;
  }

  whereClause(where: ReadonlyArray<string>): string {
    return Arr.isReadonlyArrayEmpty(where) ? '' : ` WHERE ${where.join(' AND ')}`;
  }

  nullCol(type: 'id' | 'int'): string {
    return type === 'id' ? this.dialect.nullId : this.dialect.castId('NULL');
  }

  render(
    block: Block,
    names: ReadonlyArray<string> = Arr.fromIterable(MutableHashMap.keys(block.cols)),
    options: {
      readonly distinct?: boolean;
      readonly types?: MutableHashMap.MutableHashMap<string, 'id' | 'int'>;
    } = {},
  ): string {
    const { types } = options;
    const select = names.map((n) => {
      const sql = Option.match(MutableHashMap.get(block.cols, n), {
        onNone: () =>
          this.nullCol(
            types === undefined
              ? 'id'
              : Option.getOrElse(MutableHashMap.get(types, n), () => 'id' as const),
          ),
        onSome: (c) => c.sql,
      });
      return `${sql} AS ${this.col(n)}`;
    });
    return `SELECT ${options.distinct === true ? 'DISTINCT ' : ''}${Arr.isReadonlyArrayEmpty(select) ? '1 AS one' : select.join(', ')}${this.from(block.items)}${this.whereClause(block.where)}`;
  }

  /** Wraps SQL as a subquery item. */
  wrapSql(sql: string, cols: ColTypes): Wrapped {
    const alias = this.alias('s');
    const out: Cols = MutableHashMap.empty();
    MutableHashMap.forEach(cols, (c, n) => {
      MutableHashMap.set(out, n, { ...c, sql: `${alias}.${this.col(n)}` });
    });
    return { items: [inner(`(${sql})`, alias)], where: [], cols: out };
  }

  wrap(block: Block, options: { readonly distinct?: boolean } = {}): Wrapped {
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
    if (isUnit(b)) return a;
    if (isUnit(a)) return b;
    const cols = MutableHashMap.fromIterable(a.cols);
    const where = [...a.where, ...b.where];
    MutableHashMap.forEach(b.cols, (cb, n) =>
      Option.match(MutableHashMap.get(cols, n), {
        onNone: () => {
          MutableHashMap.set(cols, n, cb);
        },
        onSome: (ca) => {
          const { cond, merged } = this.compat(ca, cb);
          where.push(cond);
          MutableHashMap.set(cols, n, merged);
        },
      }),
    );
    return { items: [...a.items, ...b.items], where, cols };
  }

  /** Ensures a block has a FROM item (so that a LEFT JOIN can be appended). */
  anchored(block: Block): Block {
    if (Arr.isReadonlyArrayNonEmpty(block.items)) return block;
    return { ...block, items: [inner('(SELECT 1 AS one)', this.alias('u'))] };
  }

  // --- operators --------------------------------------------------------------

  op(operation: Algebra.Operation, g: GraphCtx, unit: Block): Block {
    return Match.value(operation).pipe(
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
        if (MutableHashMap.has(input.cols, op.variable.value)) {
          return unsupported('BIND to a bound variable');
        }
        const col = this.termValued(this.operand(op.expression, { cols: input.cols, graph: g }));
        const cols = MutableHashMap.fromIterable(input.cols);
        MutableHashMap.set(cols, op.variable.value, col);
        return { ...input, cols };
      }),
      Match.tag('Minus', (op) => this.minus(this.op(op.left, g, unit), this.op(op.right, g, unit))),
      Match.tag('Group', (op) => this.group(op, g, unit)),
      Match.tag('Project', (op) => {
        const input = this.op(op.input, g, unit);
        const keep = MutableHashSet.fromIterable(op.variables.map((v) => v.value));
        const cols: Cols = MutableHashMap.empty();
        MutableHashMap.forEach(input.cols, (c, n) => {
          if (MutableHashSet.has(keep, n) || isHidden(n)) MutableHashMap.set(cols, n, c);
        });
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

  bgp(patterns: ReadonlyArray<Ast.TriplePattern>, ctx: GraphCtx): Block {
    const items: Array<Item> = [];
    const where: Array<string> = [];
    const cols: Cols = MutableHashMap.empty();
    const bind = (name: string, sql: string) =>
      Option.match(MutableHashMap.get(cols, name), {
        onNone: () => {
          MutableHashMap.set(cols, name, { sql, nullable: false, type: 'id' });
        },
        onSome: (c) => {
          where.push(`${c.sql} = ${sql}`);
        },
      });
    const position = (t: Ast.TermPattern, sql: string, bound: Array<string>): void => {
      return Match.value(t).pipe(
        Match.tag('Variable', (pattern) => {
          bind(pattern.value, sql);
          return;
        }),
        Match.tag('BlankNode', () => unsupported('Blank node in a pattern')),
        Match.tag('NamedNode', 'Literal', (pattern) => {
          bound.push(`${sql} = ${this.idOf(pattern)}`);
          return;
        }),
        Match.tag('Triple', (pattern) => {
          if (isGroundTriple(pattern)) {
            bound.push(`${sql} = ${this.idOf(pattern)}`);
            return;
          }
          const ta = this.alias('t');
          items.push(inner(this.T, ta));
          where.push(`${ta}.id = ${sql}`, `${ta}.kind = ${Enc.Kind.Triple}`);
          position(pattern.subject, `${ta}.sub`, where);
          position(pattern.predicate, `${ta}.pre`, where);
          position(pattern.object, `${ta}.obj`, where);
          return;
        }),
        Match.exhaustive,
      );
    };
    const { defaultGraph } = this.context.dataset;
    patterns.forEach((p) => {
      const a = this.alias('q');
      const merged =
        ctx.kind === 'default' &&
        (defaultGraph === 'union' || (Array.isArray(defaultGraph) && defaultGraph.length > 1));
      if (merged) {
        // The default graph is a merge of several graphs: match each triple once.
        const conds: Array<string> = [];
        if (!Predicate.isString(defaultGraph)) {
          conds.push(`g IN (${defaultGraph.map((x) => this.idOf(x)).join(', ')})`);
        }
        const deferred: Array<() => void> = [];
        const positionIn = (t: Ast.TermPattern, column: string) => {
          if (Term.isVariable(t) || (Term.isTriple(t) && !Term.isGround(t))) {
            deferred.push(() => position(t, `${a}.${column}`, where));
          } else position(t, column, conds);
        };
        positionIn(p.subject, 's');
        positionIn(p.predicate, 'p');
        positionIn(p.object, 'o');
        items.push(
          inner(
            `(SELECT DISTINCT s, p, o FROM ${this.Q}${Arr.isReadonlyArrayNonEmpty(conds) ? ` WHERE ${conds.join(' AND ')}` : ''})`,
            a,
          ),
        );
        deferred.forEach((f) => f());
        return;
      }
      items.push(inner(this.Q, a));
      Match.value(ctx).pipe(
        Match.when({ kind: 'default' }, () => {
          if (defaultGraph === 'default') where.push(`${a}.g = 0`);
          else if (!Predicate.isString(defaultGraph) && Predicate.isTupleOf(defaultGraph, 1)) {
            where.push(`${a}.g = ${this.idOf(defaultGraph[0])}`);
          } else where.push('1 = 0');
        }),
        Match.when({ kind: 'const' }, (graph) => {
          where.push(`${a}.g = ${graph.id}`);
        }),
        Match.when({ kind: 'var' }, (graph) => {
          bind(graph.hidden, `${a}.g`);
          where.push(this.namedGraphCond(`${a}.g`));
        }),
        Match.exhaustive,
      );
      position(p.subject, `${a}.s`, where);
      position(p.predicate, `${a}.p`, where);
      position(p.object, `${a}.o`, where);
    });
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
      const cols = MutableHashMap.fromIterable(
        vars.map((v): readonly [string, Col] => [
          v,
          { sql: this.dialect.nullId, nullable: true, type: 'id' },
        ]),
      );
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
    const cols = MutableHashMap.fromIterable(
      vars.map((v): readonly [string, Col] => [
        v,
        {
          sql: `${a}.${this.col(v)}`,
          nullable: !op.bindings.every((b) => b.map.has(v)),
          type: 'id',
        },
      ]),
    );
    return {
      items: [
        inner(
          `(SELECT ${Predicate.isString(select) ? select : select.join(', ')} FROM (VALUES ${rows.join(', ')}) AS ${a}_rows)`,
          a,
        ),
      ],
      where: [],
      cols,
    };
  }

  leftJoin(op: Algebra.LeftJoin, g: GraphCtx, unit: Block): Block {
    const left = this.op(op.left, g, unit);
    const right = this.op(op.right, g, unit);
    MutableHashMap.forEach(right.cols, (c, n) => {
      const leftNullable = Option.match(MutableHashMap.get(left.cols, n), {
        onNone: () => true,
        onSome: (l) => l.nullable,
      });
      if (isHidden(n) && leftNullable && !c.nullable) {
        unsupported('OPTIONAL graph-dependent pattern under GRAPH ?var');
      }
    });
    if (op.expression === undefined && isUnit(right)) return left;
    const a = this.anchored(left);
    const r = this.wrap(right);
    const conds: Array<string> = [];
    const merged = MutableHashMap.fromIterable(a.cols);
    const out = MutableHashMap.fromIterable(a.cols);
    MutableHashMap.forEach(r.cols, (cr, n) =>
      Option.match(MutableHashMap.get(a.cols, n), {
        onNone: () => {
          MutableHashMap.set(merged, n, cr);
          MutableHashMap.set(out, n, { ...cr, nullable: true });
        },
        onSome: (ca) => {
          const { cond, merged: m } = this.compat(ca, cr);
          conds.push(cond);
          MutableHashMap.set(merged, n, m);
          MutableHashMap.set(
            out,
            n,
            ca.nullable
              ? { sql: `COALESCE(${ca.sql}, ${cr.sql})`, nullable: true, type: ca.type }
              : ca,
          );
        },
      }),
    );
    if (op.expression !== undefined) {
      const e = this.ebv(this.operand(op.expression, { cols: merged, graph: g }));
      if (e !== 'TRUE') conds.push(e);
    }
    const on = Arr.isReadonlyArrayEmpty(conds) ? 'TRUE' : conds.join(' AND ');
    const [item] = r.items;
    return {
      items: [...a.items, { source: item.source, alias: item.alias, left: Option.some(on) }],
      where: a.where,
      cols: out,
    };
  }

  union(a: Block, b: Block): Block {
    const names = distinct([...MutableHashMap.keys(a.cols), ...MutableHashMap.keys(b.cols)]);
    const cols: ColTypes = MutableHashMap.empty();
    const types = MutableHashMap.empty<string, 'id' | 'int'>();
    names.forEach((n) => {
      const ca = MutableHashMap.get(a.cols, n);
      const cb = MutableHashMap.get(b.cols, n);
      if (Option.isSome(ca) && Option.isSome(cb) && ca.value.type !== cb.value.type) {
        unsupported('UNION of integer and term columns');
      }
      const nullable =
        Option.isNone(ca) || Option.isNone(cb) || ca.value.nullable || cb.value.nullable;
      if (isHidden(n) && nullable) {
        unsupported('UNION of graph-dependent and independent patterns under GRAPH ?var');
      }
      // `n` is a column of `a` or of `b`.
      const type = Option.isSome(ca) ? ca.value.type : Option.isSome(cb) ? cb.value.type : 'id';
      MutableHashMap.set(types, n, type);
      MutableHashMap.set(cols, n, { nullable, type });
    });
    const sql = `${this.render(a, names, { types })} UNION ALL ${this.render(b, names, { types })}`;
    return this.wrapSql(sql, cols);
  }

  minus(a: Block, b: Block): Block {
    const bNames = Arr.fromIterable(MutableHashMap.keys(b.cols));
    const shared = bNames.filter((n) => MutableHashMap.has(a.cols, n));
    if (bNames.some((n) => isHidden(n) && !MutableHashMap.has(a.cols, n))) {
      return unsupported('MINUS of a graph-dependent pattern under GRAPH ?var');
    }
    const overlap = shared.filter((n) => !isHidden(n));
    if (Arr.isReadonlyArrayEmpty(overlap)) return a;
    const m = this.wrap(b);
    const pairs = Arr.filterMap(shared, (name): Result.Result<Shared, void> => {
      const left = MutableHashMap.get(a.cols, name);
      const right = MutableHashMap.get(m.cols, name);
      return Option.isSome(left) && Option.isSome(right)
        ? Result.succeed({ name, left: left.value, right: right.value })
        : Result.failVoid;
    });
    const conds = pairs.map(({ left, right }) => this.compat(left, right).cond);
    const overlapCond = or(
      ...pairs
        .filter(({ name }) => !isHidden(name))
        .map(({ left, right }) =>
          and(
            left.nullable ? `${left.sql} IS NOT NULL` : true,
            right.nullable ? `${right.sql} IS NOT NULL` : true,
          ),
        ),
    );
    if (overlapCond === false) return a;
    if (overlapCond !== true) conds.push(overlapCond);
    const [item] = m.items;
    return {
      ...a,
      where: [
        ...a.where,
        `NOT EXISTS (SELECT 1 FROM ${item.source} ${item.alias} WHERE ${conds.join(' AND ')})`,
      ],
    };
  }

  graph(op: Algebra.Graph, g: GraphCtx, unit: Block): Block {
    const name = op.name;
    if (Term.isNamedNode(name)) {
      const id = this.idOf(name);
      const input = this.op(op.input, { kind: 'const', id }, unit);
      const named = this.context.dataset.namedGraphs;
      const cond =
        named === 'all'
          ? `(EXISTS (SELECT 1 FROM ${this.G} WHERE id = ${id}) OR EXISTS (SELECT 1 FROM ${this.Q} WHERE g = ${id}))`
          : named.some((n) => n.key === name.key)
            ? 'TRUE'
            : '1 = 0';
      return cond === 'TRUE' ? input : { ...input, where: [...input.where, cond] };
    }
    const hidden = `#${this.alias('g')}`;
    const body = this.op(op.input, { kind: 'var', hidden }, unit);
    const bound = MutableHashMap.get(body.cols, hidden);
    if (Option.isSome(bound) && bound.value.nullable) {
      return unsupported('Graph-independent solutions under GRAPH ?var');
    }
    const { input, gcol } = Option.match(bound, {
      onSome: (c): GraphInput => ({ input: body, gcol: c }),
      onNone: (): GraphInput => {
        const alias = this.alias('n');
        return {
          input: { ...body, items: [...body.items, inner(this.namedGraphsSource(), alias)] },
          gcol: { sql: `${alias}.g`, nullable: false, type: 'id' },
        };
      },
    });
    const cols = MutableHashMap.fromIterable(input.cols);
    MutableHashMap.remove(cols, hidden);
    const where = [...input.where];
    Option.match(MutableHashMap.get(cols, name.value), {
      onNone: () => undefined,
      onSome: (existing) => {
        where.push(this.compat(existing, gcol).cond);
      },
    });
    MutableHashMap.set(cols, name.value, gcol);
    void g;
    return { items: input.items, where, cols };
  }

  group(op: Algebra.Group, g: GraphCtx, unit: Block): Block {
    if (g.kind === 'var') return unsupported('GROUP inside GRAPH ?var');
    const input = this.op(op.input, g, unit);
    const needed = MutableHashSet.empty<string>();
    const keyVars = op.keys.map((k): GroupKey => {
      const e = k.expression;
      if (!Term.isVariable(e)) return unsupported('Non-variable group key');
      const col = Option.getOrElse(MutableHashMap.get(input.cols, e.value), () =>
        unsupported('Group key is never bound'),
      );
      MutableHashSet.add(needed, e.value);
      return { source: e.value, target: k.variable.value, col };
    });
    const aggs = op.aggregates.map(({ variable, aggregate }): Aggregate => {
      const e = aggregate.expression;
      if (aggregate.name === 'COUNT') {
        if (e === '*') {
          if (aggregate.distinct) return unsupported('COUNT(DISTINCT *)');
          return {
            target: variable.value,
            sql: () => 'COUNT(*)',
            col: { nullable: false, type: 'int' },
          };
        }
        if (!Term.isVariable(e)) return unsupported('COUNT of an expression');
        const name = e.value;
        if (!MutableHashMap.has(input.cols, name)) {
          return { target: variable.value, sql: () => '0', col: { nullable: false, type: 'int' } };
        }
        MutableHashSet.add(needed, name);
        return {
          target: variable.value,
          sql: (s) => `COUNT(${aggregate.distinct ? 'DISTINCT ' : ''}${s}.${this.col(name)})`,
          col: { nullable: false, type: 'int' },
        };
      }
      if (aggregate.name === 'SAMPLE' && Term.isVariable(e)) {
        const name = e.value;
        return Option.match(MutableHashMap.get(input.cols, name), {
          onNone: (): Aggregate => ({
            target: variable.value,
            sql: () => this.dialect.nullId,
            col: { nullable: true, type: 'id' },
          }),
          onSome: (c): Aggregate => {
            MutableHashSet.add(needed, name);
            return {
              target: variable.value,
              sql: (s) => `MIN(${s}.${this.col(name)})`,
              col: { nullable: true, type: c.type },
            };
          },
        });
      }
      return unsupported(`Aggregate ${aggregate.name}`);
    });
    const s = this.alias('a');
    const cols: ColTypes = MutableHashMap.empty();
    const select = [
      ...keyVars.map((k) => {
        const sql = `${s}.${this.col(k.source)} AS ${this.col(k.target)}`;
        MutableHashMap.set(cols, k.target, { nullable: k.col.nullable, type: k.col.type });
        return sql;
      }),
      ...aggs.map((agg) => {
        const sql = `${agg.sql(s)} AS ${this.col(agg.target)}`;
        MutableHashMap.set(cols, agg.target, agg.col);
        return sql;
      }),
    ];
    const innerSql = this.render(input, Arr.fromIterable(needed));
    const groupBy = Arr.isReadonlyArrayEmpty(keyVars)
      ? ''
      : ` GROUP BY ${distinct(keyVars.map((k) => `${s}.${this.col(k.source)}`)).join(', ')}`;
    const sql = `SELECT ${Arr.isReadonlyArrayEmpty(select) ? '1 AS one' : select.join(', ')} FROM (${innerSql}) ${s}${groupBy}`;
    return this.wrapSql(sql, cols);
  }

  // --- expressions ------------------------------------------------------------

  /** A dictionary attribute of a term id expression. */
  attr(id: string, field: 'kind' | 'value' | 'datatype' | 'lang' | 'dir' | 'cls' | 'num'): string {
    const lookup = `(SELECT ${field} FROM ${this.T} WHERE id = ${id})`;
    if (MutableHashMap.isEmpty(this.locals)) return lookup;
    if (!this.localsKnown) return lookup;
    const branches = Arr.fromIterable(MutableHashMap.values(this.locals)).map(
      ({ id: localId, term }) => {
        const row = Enc.encode(term, [0, 0, 0]);
        const v = field === 'num' ? this.litOf(row.num) : this.lit(row[field]);
        // Typed values, so that the branches agree with the dictionary column.
        const typed =
          field === 'num'
            ? this.dialect.castDouble(v)
            : field === 'kind' || field === 'cls'
              ? this.dialect.castInt(v)
              : this.dialect.castText(v);
        return `WHEN ${localId} THEN ${typed}`;
      },
    );
    return `(CASE WHEN ${id} < 0 THEN (CASE ${id} ${branches.join(' ')} END) ELSE ${lookup} END)`;
  }

  termOperand(id: string, nullable: boolean): Operand {
    return {
      tag: 'term',
      classes: Option.none(),
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

  constOperand(constant: Term.GroundTerm): Operand {
    const { cls, num } = Enc.classify(constant);
    const base = {
      tag: 'const' as const,
      classes: Option.some([cls]),
      isNull: S(false),
      cls: S(cls),
      num: SO(num),
      id: S(this.idOf(constant)),
      term: constant,
    };
    return Match.value(constant).pipe(
      Match.withReturnType<Operand>(),
      Match.tag('NamedNode', 'BlankNode', (term) => ({
        ...base,
        kind: S(Term.isNamedNode(term) ? Enc.Kind.NamedNode : Enc.Kind.BlankNode),
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
        value: SNULL,
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
      classes: Option.some([Enc.Cls.SafeNumber]),
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
      classes: Option.some([Enc.Cls.String]),
      isNull: Q(`${sql} IS NULL`),
      cls: S(Enc.Cls.String),
      kind: S(Enc.Kind.Literal),
      value: Q(sql),
      datatype: S(Term.XSD_STRING),
      lang: S(''),
      dir: S(''),
      num: SNULL,
    };
  }

  boolOperand(sql: string): Operand {
    if (sql === 'TRUE' || sql === 'FALSE') return this.constOperand(sql === 'TRUE' ? TRUE : FALSE);
    return {
      tag: 'bool',
      classes: Option.some([Enc.Cls.Boolean]),
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
      classes: Option.some([Enc.Cls.Resource]),
      isNull: Q(`${sql} IS NULL`),
      cls: S(Enc.Cls.Resource),
      kind: S(Enc.Kind.NamedNode),
      value: Q(sql),
      datatype: S(''),
      lang: S(''),
      dir: S(''),
      num: SNULL,
    };
  }

  readonly NULL: Operand = {
    tag: 'null',
    classes: Option.some([]),
    isNull: S(true),
    cls: SNULL,
    kind: SNULL,
    value: SNULL,
    datatype: SNULL,
    lang: SNULL,
    dir: SNULL,
    num: SNULL,
  };

  /** A term-valued expression as a column (for `BIND`). */
  termValued(operand: Operand): Col {
    return Match.value(operand).pipe(
      Match.withReturnType<Col>(),
      Match.when({ tag: 'term' }, (o) => ({
        sql: this.f(o.id),
        nullable: !isStaticValue(o.isNull, false),
        type: 'id',
      })),
      Match.when({ tag: 'const' }, (o) => ({
        sql: String(this.idOf(o.term)),
        nullable: false,
        type: 'id',
      })),
      Match.when({ tag: 'int' }, (o) => ({
        sql: this.f(o.num),
        nullable: !isStaticValue(o.isNull, false),
        type: 'int',
      })),
      Match.when({ tag: 'bool' }, (o) => ({
        sql: `(CASE WHEN ${o.bool} THEN ${this.idOf(TRUE)} WHEN NOT ${o.bool} THEN ${this.idOf(FALSE)} END)`,
        nullable: true,
        type: 'id',
      })),
      Match.when({ tag: 'null' }, () => ({ sql: this.dialect.nullId, nullable: true, type: 'id' })),
      Match.orElse(() => unsupported('Expression value is not a stored term')),
    );
  }

  /** Compiles an expression to an operand. */
  operand(expr: Algebra.Expression, env: Env): Operand {
    return Match.value(expr).pipe(
      Match.tag('Variable', (e) =>
        Option.match(MutableHashMap.get(env.cols, e.value), {
          onNone: () => this.NULL,
          onSome: (c) =>
            c.type === 'int'
              ? this.intOperand(c.sql, c.nullable)
              : this.termOperand(c.sql, c.nullable),
        }),
      ),
      Match.tag('NamedNode', 'Literal', (e) => this.constOperand(e)),
      Match.tag('BlankNode', () => unsupported('Blank node in an expression')),
      Match.tag('Triple', (e) =>
        isGroundTriple(e)
          ? this.constOperand(e)
          : unsupported('Triple term pattern in an expression'),
      ),
      Match.tag('FunctionCall', (e) => unsupported(`Function <${e.function.value}>`)),
      Match.tag('Exists', (e) => this.boolOperand(this.exists(e, env))),
      Match.tag('Operation', (e) => this.operation(e, env)),
      Match.exhaustive,
    );
  }

  operation(expr: Algebra.OperationExpression, env: Env): Operand {
    const args = expr.args;
    const arg = (i: number) =>
      Option.match(Arr.get(args, i), {
        onNone: () => unsupported(`Operator ${expr.operator} without argument ${i + 1}`),
        onSome: (a) => this.operand(a, env),
      });
    const bool = (sql: string) => this.boolOperand(sql);
    return Match.value(expr)
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
          const v = args[0];
          if (!Term.isVariable(v)) return unsupported('BOUND of a non-variable');
          return bool(
            Option.match(MutableHashMap.get(env.cols, v.value), {
              onNone: () => 'FALSE',
              onSome: (c) => (c.nullable ? `(${c.sql} IS NOT NULL)` : 'TRUE'),
            }),
          );
        }),
        Match.when({ operator: 'SAMETERM' }, () => {
          const a = arg(0);
          const b = arg(1);
          if (a.tag === 'null' || b.tag === 'null') return bool('NULL');
          const ia = operandId(a);
          const ib = operandId(b);
          if (Option.isNone(ia) || Option.isNone(ib)) {
            return unsupported('sameTerm of computed values');
          }
          return bool(`(${this.f(ia.value)} = ${this.f(ib.value)})`);
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
            const t = a.term;
            if (Term.isNamedNode(t) || Term.isLiteral(t)) {
              return this.constOperand(Term.literal(t.value));
            }
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
            const t = a.term;
            return Term.isLiteral(t) ? this.constOperand(Term.literal(t.language)) : this.NULL;
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
            const t = a.term;
            return Term.isLiteral(t) ? this.constOperand(t.datatype) : this.NULL;
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
          const range = b.term;
          if (!Term.isLiteral(range) || Enc.classify(range).cls !== Enc.Cls.String) {
            return bool('NULL');
          }
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
          if (!Arr.isReadonlyArrayNonEmpty(parts)) return this.NULL;
          const cols = Arr.map(parts, (o) => this.termValued(o));
          const [first, ...rest] = cols;
          const type = first.type;
          if (rest.some((c) => c.type !== type)) {
            return unsupported('COALESCE of integer and term values');
          }
          const sql = Arr.isReadonlyArrayEmpty(rest)
            ? first.sql
            : `COALESCE(${cols.map((c) => c.sql).join(', ')})`;
          const nullable = cols.every((c) => c.nullable);
          return type === 'int' ? this.intOperand(sql, nullable) : this.termOperand(sql, nullable);
        }),
        Match.orElse((e) => unsupported(`Operator ${e.operator}`)),
      );
  }

  // --- conditions -------------------------------------------------------------

  isNullC(o: Operand): C {
    return isStatic(o.isNull) ? Option.exists(o.isNull.s, (s) => s === true) : o.isNull.q;
  }

  eqC(f: F, v: Scalar): C {
    if (isStatic(f)) return Option.exists(f.s, (s) => s === v);
    return `${f.q} = ${this.lit(v)}`;
  }

  clsIn(o: Operand, classes: ReadonlyArray<number>): C {
    const f = o.cls;
    if (isStatic(f)) return Option.exists(f.s, (s) => Predicate.isNumber(s) && classes.includes(s));
    return classes.length === 1 ? `${f.q} = ${classes[0]}` : `${f.q} IN (${classes.join(', ')})`;
  }

  eqFF(a: F, b: F): C {
    if (isStatic(a) && isStatic(b)) return Equal.equals(a.s, b.s);
    return `${this.f(a)} = ${this.f(b)}`;
  }

  ne(a: F, b: F): C {
    if (isStatic(a) && isStatic(b)) return !Equal.equals(a.s, b.s);
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
    handled: MutableHashSet.MutableHashSet<string> = MutableHashSet.empty(),
  ): void {
    const possible = (o: Operand, c: number) =>
      Option.match(o.classes, { onNone: () => true, onSome: (classes) => classes.includes(c) });
    pairs.forEach(([x, y]) => {
      const orders: ReadonlyArray<readonly [number, number]> =
        x === y
          ? [[x, y]]
          : [
              [x, y],
              [y, x],
            ];
      orders.forEach(([p, q]) => {
        if (!possible(a, p) || !possible(b, q) || MutableHashSet.has(handled, `${p},${q}`)) return;
        const r: Risk = {
          a: p,
          aStatic: Option.isSome(a.classes),
          b: q,
          bStatic: Option.isSome(b.classes),
        };
        if (r.aStatic && r.bStatic) unsupported('Comparison that SQL cannot evaluate exactly');
        this.risks.push(r);
      });
    });
  }

  /**
   * Exact comparisons of a float-or-double term with a numeric constant,
   * following SPARQL's type promotion (integers and decimals are promoted to
   * float, floats to double). Returns the branches and the class pairs they
   * handle.
   */
  promoted(a: Operand, b: Operand, op: string): Promotions {
    const branches: Array<readonly [C, string]> = [];
    const handled = MutableHashSet.empty<string>();
    const one = (t: Operand, c: Operand, flip: boolean) => {
      if (c.tag !== 'const' || t.tag === 'const') return;
      const value = staticNumber(c.num);
      const constClass = staticNumber(c.cls);
      if (Option.isNone(value) || Option.isNone(constClass)) return;
      const v = value.value;
      const cc = constClass.value;
      const add = (cls: number, n: number) => {
        if (!Number.isFinite(n)) return;
        const cmp = flip
          ? `${this.lit(n)} ${op} ${this.f(t.num)}`
          : `${this.f(t.num)} ${op} ${this.lit(n)}`;
        branches.push([this.clsIn(t, [cls]), cmp]);
        MutableHashSet.add(handled, flip ? `${cc},${cls}` : `${cls},${cc}`);
      };
      if (cc === Enc.Cls.SafeNumber) add(Enc.Cls.Float, Math.fround(v));
      else if (cc === Enc.Cls.Double) add(Enc.Cls.Float, v);
      else if (cc === Enc.Cls.Float) add(Enc.Cls.Double, v);
    };
    one(a, b, false);
    one(b, a, true);
    return { branches, handled };
  }

  /**
   * The branches comparing two numbers of the same SQL-comparable kind
   * (integers, decimals and doubles together; floats with floats) by `num`.
   */
  numericBranches(a: Operand, b: Operand, num: string): Array<readonly [C, string]> {
    return [
      [and(this.clsIn(a, [1, 2]), this.clsIn(b, [1, 2])), num],
      [and(this.clsIn(a, [3]), this.clsIn(b, [3])), num],
    ];
  }

  /** SPARQL `=` (value equality, with errors as `NULL`). */
  equals(a: Operand, b: Operand): string {
    if (a.tag === 'null' || b.tag === 'null') return 'NULL';
    if (a.tag === 'const' && b.tag === 'const') {
      const r = Expression.equals(a.term, b.term);
      return Result.isSuccess(r) ? (r.success ? 'TRUE' : 'FALSE') : 'NULL';
    }
    const promoted = this.promoted(a, b, '=');
    this.risk(RISK_EQUAL, a, b, promoted.handled);
    const ia = operandId(a);
    const ib = operandId(b);
    const bothIds = Option.isSome(ia) && Option.isSome(ib);
    const sameId: C =
      Option.isSome(ia) && Option.isSome(ib) ? this.eqFF(ia.value, ib.value) : false;
    const num = `${this.f(a.num)} = ${this.f(b.num)}`;
    return caseOf(
      [
        [or(this.isNullC(a), this.isNullC(b)), 'NULL'],
        [sameId, 'TRUE'],
        ...promoted.branches,
        ...this.numericBranches(a, b, num),
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
        ...this.numericBranches(a, b, num),
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
  ebv(operand: Operand): string {
    return Match.value(operand).pipe(
      Match.when({ tag: 'bool' }, (o) => o.bool),
      Match.when({ tag: Match.is('null', 'iri') }, () => 'NULL'),
      Match.when({ tag: 'const' }, (o) => {
        const r = Expression.effectiveBooleanValue(o.term);
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
    const body = this.op(e.input, env.graph, context);
    const where = [...body.where];
    if (env.graph.kind === 'var') {
      const hidden = env.graph.hidden;
      const ic = MutableHashMap.get(body.cols, hidden);
      const oc = MutableHashMap.get(env.cols, hidden);
      if (Option.isSome(ic)) {
        if (Option.isNone(oc) || oc.value.nullable) {
          return unsupported('EXISTS in a graph-independent pattern');
        }
        if (ic.value.sql !== oc.value.sql) where.push(`${ic.value.sql} = ${oc.value.sql}`);
      }
    }
    const sql = `EXISTS (SELECT 1${this.from(body.items)}${this.whereClause(where)})`;
    return e.negated ? `(NOT ${sql})` : sql;
  }
}

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

const compileOnce = (
  op: Algebra.Operation,
  context: TranslationContext,
  resolve: (term: Term.GroundTerm) => Option.Option<number>,
  locals: Locals,
  localsKnown: boolean,
): CompiledQuery => {
  const c = new Compiler(context, resolve, locals, localsKnown);
  const g: GraphCtx = Predicate.isTagged(context.activeGraph, 'NamedGraph')
    ? { kind: 'const', id: c.idOf(context.activeGraph.graph) }
    : { kind: 'default' };
  const block = c.op(op, g, EMPTY);
  const visible = Arr.fromIterable(block.cols).filter(([n]) => !isHidden(n));
  const names = visible.map(([n]) => n);
  const innerSql = c.render(block, names);
  const select: Array<string> = [];
  const joins: Array<string> = [];
  const columns: Array<OutputColumn> = [];
  visible.forEach(([n, col], i) => {
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
  const marked = `SELECT ${Arr.isReadonlyArrayEmpty(select) ? '1 AS one' : select.join(', ')} FROM (${innerSql}) r${joins.join('')}`;
  // Number the parameters in order of use (fragments of discarded branches
  // may have allocated parameters that are not used).
  const params: Array<unknown> = [];
  const numbering = MutableHashMap.empty<string, number>();
  const sql = marked.replace(/\ue000(\d+)\ue000/g, (_, i: string) => {
    if (context.dialect.anonymousParameters) {
      params.push(c.params[Number(i) - 1]);
      return context.dialect.placeholder(params.length);
    }
    const n = Option.getOrElse(MutableHashMap.get(numbering, i), () => {
      params.push(c.params[Number(i) - 1]);
      MutableHashMap.set(numbering, i, params.length);
      return params.length;
    });
    return context.dialect.placeholder(n);
  });
  const byId = HashMap.fromIterable(
    Arr.fromIterable(MutableHashMap.values(locals)).map(({ id, term }) => [id, term] as const),
  );
  return {
    sql,
    params,
    columns,
    locals: byId,
    localClasses: HashSet.fromIterable(c.localClasses),
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
  const resolveId = (term: Term.GroundTerm) => Option.fromNullishOr(resolve(term));
  return Result.try({
    try: () => {
      const locals: Locals = MutableHashMap.empty();
      const first = compileOnce(op, context, resolveId, locals, false);
      if (MutableHashMap.isEmpty(locals)) return first;
      // Second pass: dictionary attributes of query-local terms are inlined.
      return compileOnce(op, context, resolveId, locals, true);
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
