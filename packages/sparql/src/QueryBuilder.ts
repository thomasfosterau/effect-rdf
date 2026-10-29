/**
 * A strongly-typed, immutable query builder. Builders produce the SPARQL AST
 * (`build()`), print as SPARQL text (`toString()`) and can be executed with
 * the `SparqlEngine`, yielding rows whose type is derived from the selected
 * variables:
 *
 * ```ts
 * import { QueryBuilder as Q } from '@thomasfosterau/effect-sparql'
 * const v = Q.vars('person', 'name', 'email')
 *
 * const query = Q.select('person', 'name', Q.maybe('email'))
 *   .where(Q.triple(v.person, foaf.name, v.name))
 *   .optional(Q.triple(v.person, foaf.mbox, v.email))
 *   .orderBy(v.name)
 *   .limit(10)
 *
 * // Stream<{ readonly person: GroundTerm; readonly name: GroundTerm; readonly email?: GroundTerm }>
 * const rows = Q.execute(query)
 * // Stream<{ name: string; email?: string }>, decoded with TermSchema
 * const people = Q.decode(query, Schema.Struct({ name: TermSchema.string, email: Schema.optional(TermSchema.iri) }))
 * ```
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import { pipeArguments, type Pipeable } from 'effect/Pipeable';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import type { Simplify } from 'effect/Types';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';
import * as Ast from './Ast.ts';
import * as B from './Bindings.ts';
import * as Engine from './Engine.ts';
import * as Generator from './Generator.ts';
import * as Predicate from 'effect/Predicate';

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

/**
 * A JavaScript value usable as a literal.
 *
 * @since 0.1.0
 * @category models
 */
export type JsValue = string | number | bigint | boolean | Date;

/**
 * An expression, or a JS value (converted to a literal).
 *
 * @since 0.1.0
 * @category models
 */
export type ExpressionInput = Ast.Expression | JsValue;

/**
 * An object position input: a term pattern or a JS value (literal).
 *
 * @since 0.1.0
 * @category models
 */
export type ObjectInput = Ast.TermPattern | JsValue;

/**
 * Anything accepted as (part of) a group graph pattern.
 *
 * @since 0.1.0
 * @category models
 */
export type PatternInput =
  | Ast.TriplePattern
  | Ast.PathPattern
  | Ast.Pattern
  | ReadonlyArray<PatternInput>;

const isJsValue = <A>(u: A | JsValue): u is JsValue =>
  Predicate.isString(u) ||
  Predicate.isNumber(u) ||
  Predicate.isBigInt(u) ||
  Predicate.isBoolean(u) ||
  Predicate.isDate(u);

const isTerm = <T extends Term.Term>(u: T | JsValue): u is T => Term.isTerm(u);

/**
 * Converts a JS value to a literal (terms and expressions are returned
 * unchanged).
 *
 * @since 0.1.0
 * @category constructors
 */
export const toExpression = (input: ExpressionInput): Ast.Expression =>
  isJsValue(input) ? Xsd.fromJs(input) : input;

const toObject = (input: ObjectInput): Ast.TermPattern =>
  isTerm(input) ? input : Xsd.fromJs(input);

// -----------------------------------------------------------------------------
// Variables
// -----------------------------------------------------------------------------

/**
 * Creates a variable.
 *
 * @since 0.1.0
 * @category variables
 */
export const variable = <const N extends string>(name: N): Term.Variable<N> => Term.variable(name);

/**
 * Variables by name, as `v` provides them.
 *
 * @since 0.1.0
 * @category variables
 */
export interface Variables {
  readonly [name: string]: Term.Variable<string>;
}

/**
 * A proxy creating variables by property access: `v.name` is `?name`.
 *
 * @since 0.1.0
 * @category variables
 */
export const v: Variables = new Proxy<Variables>(
  {},
  { get: (_, name) => (Predicate.isString(name) ? Term.variable(name) : undefined) },
);

/**
 * Creates several variables at once, typed by name:
 * `const { s, name } = vars('s', 'name')`.
 *
 * @since 0.1.0
 * @category variables
 */
export const vars = <const N extends ReadonlyArray<string>>(
  ...names: N
): { readonly [K in N[number]]: Term.Variable<K> } =>
  // SAFETY: one entry per name in `names`, each the variable of that name.
  Object.fromEntries(names.map((n) => [n, Term.variable(n)])) as {
    readonly [K in N[number]]: Term.Variable<K>;
  };

/**
 * The `as` constructor: an alias that is required unless marked optional.
 *
 * @since 0.1.0
 * @category projection
 */
export interface AsAlias {
  <const N extends string>(expression: ExpressionInput, name: N): Alias<N, false>;
  <const N extends string>(
    expression: ExpressionInput,
    name: N,
    options: { readonly optional: true },
  ): Alias<N, true>;
}

/**
 * Marks a selected variable as possibly unbound (e.g. bound in an
 * `OPTIONAL`): its row field becomes optional.
 *
 * @since 0.1.0
 * @category projection
 */
export interface MaybeVariable<N extends string> {
  readonly _tag: 'Maybe';
  readonly name: N;
}

/**
 * @since 0.1.0
 * @category projection
 */
export const maybe = <const N extends string>(name: N): MaybeVariable<N> => ({
  _tag: 'Maybe',
  name,
});

/**
 * A projected expression `(expr AS ?name)`.
 *
 * @since 0.1.0
 * @category projection
 */
export interface Alias<N extends string, Optional extends boolean = false> {
  readonly _tag: 'Alias';
  readonly name: N;
  readonly expression: Ast.Expression;
  readonly optional: Optional;
}

/**
 * Projects an expression as a variable. Pass `{ optional: true }` when the
 * expression may fail (leaving the variable unbound).
 *
 * @since 0.1.0
 * @category projection
 */
export const as: AsAlias = (
  expression: ExpressionInput,
  name: string,
  options?: { readonly optional: true },
): any => ({
  _tag: 'Alias',
  name,
  expression: toExpression(expression),
  optional: options?.optional ?? false,
});

/**
 * An item of a `SELECT` list.
 *
 * @since 0.1.0
 * @category projection
 */
export type SelectItem = string | Term.Variable | MaybeVariable<string> | Alias<string, boolean>;

type RequiredOf<I> = I extends string
  ? I
  : I extends Term.Variable<infer N>
    ? N
    : I extends Alias<infer N, false>
      ? N
      : never;

type OptionalOf<I> =
  I extends MaybeVariable<infer N> ? N : I extends Alias<infer N, true> ? N : never;

/**
 * The row type of a `SELECT` query with required variables `R` and
 * possibly-unbound variables `O`.
 *
 * @since 0.1.0
 * @category models
 */
export type Row<R extends string, O extends string> = Simplify<
  { readonly [K in R]: Term.GroundTerm } & { readonly [K in O]?: Term.GroundTerm | undefined }
>;

// -----------------------------------------------------------------------------
// Patterns
// -----------------------------------------------------------------------------

/**
 * A triple pattern. The predicate may be a property path; the object may be
 * a JS value.
 *
 * @since 0.1.0
 * @category patterns
 */
export const triple = (
  subject: Ast.TermPattern,
  predicate: Ast.VarOrIri | Ast.Path,
  object: ObjectInput,
): Ast.TriplePattern | Ast.PathPattern =>
  Ast.isPath(predicate)
    ? Ast.pathPattern(subject, predicate, toObject(object))
    : Ast.triplePattern(subject, predicate, toObject(object));

/**
 * Property path constructors.
 *
 * @since 0.1.0
 * @category patterns
 */
export const path = {
  link: (iri: Term.NamedNode): Ast.Path => Ast.link(iri),
  inverse: (p: Ast.Path | Term.NamedNode): Ast.Path => Ast.inverse(toPath(p)),
  sequence: (...ps: ReadonlyArray<Ast.Path | Term.NamedNode>): Ast.Path =>
    Ast.sequence(...ps.map(toPath)),
  alternative: (...ps: ReadonlyArray<Ast.Path | Term.NamedNode>): Ast.Path =>
    Ast.alternative(...ps.map(toPath)),
  zeroOrMore: (p: Ast.Path | Term.NamedNode): Ast.Path => Ast.zeroOrMore(toPath(p)),
  oneOrMore: (p: Ast.Path | Term.NamedNode): Ast.Path => Ast.oneOrMore(toPath(p)),
  zeroOrOne: (p: Ast.Path | Term.NamedNode): Ast.Path => Ast.zeroOrOne(toPath(p)),
  negated: (
    iris: ReadonlyArray<Term.NamedNode>,
    inverse: ReadonlyArray<Term.NamedNode> = [],
  ): Ast.Path => Ast.negated(iris, inverse),
} as const;

const toPath = (p: Ast.Path | Term.NamedNode): Ast.Path => (Ast.isPath(p) ? p : Ast.link(p));

const flatten = (inputs: ReadonlyArray<PatternInput>): Array<Ast.Pattern> => {
  const out: Array<Ast.Pattern> = [];
  const go = (input: PatternInput): void => {
    if (Array.isArray(input)) {
      (input as ReadonlyArray<PatternInput>).forEach(go);
      return;
    }
    const p = input as Ast.TriplePattern | Ast.PathPattern | Ast.Pattern;
    if (p._tag === 'TriplePattern' || p._tag === 'PathPattern') {
      const last = out[out.length - 1];
      if (last !== undefined && last._tag === 'Bgp') {
        out[out.length - 1] = Ast.bgp([...last.triples, p]);
      } else out.push(Ast.bgp([p]));
    } else out.push(p);
  };
  inputs.forEach(go);
  return out;
};

/**
 * A group graph pattern `{ … }`.
 *
 * @since 0.1.0
 * @category patterns
 */
export const group = (...patterns: ReadonlyArray<PatternInput>): Ast.GroupPattern =>
  Ast.group(flatten(patterns));

/**
 * `OPTIONAL { … }`
 *
 * @since 0.1.0
 * @category patterns
 */
export const optional = (...patterns: ReadonlyArray<PatternInput>): Ast.OptionalPattern =>
  Ast.optional(group(...patterns));

/**
 * `MINUS { … }`
 *
 * @since 0.1.0
 * @category patterns
 */
export const minus = (...patterns: ReadonlyArray<PatternInput>): Ast.MinusPattern =>
  Ast.minus(group(...patterns));

/**
 * `{ … } UNION { … }`; each argument is one alternative.
 *
 * @since 0.1.0
 * @category patterns
 */
export const union = (...alternatives: ReadonlyArray<PatternInput>): Ast.UnionPattern =>
  Ast.union(alternatives.map((a) => group(a)));

/**
 * `GRAPH name { … }`
 *
 * @since 0.1.0
 * @category patterns
 */
export const graph = (
  name: Ast.VarOrIri,
  ...patterns: ReadonlyArray<PatternInput>
): Ast.GraphPattern => Ast.graph(name, group(...patterns));

/**
 * `FILTER(expr)`
 *
 * @since 0.1.0
 * @category patterns
 */
export const filter = (expression: ExpressionInput): Ast.FilterPattern =>
  Ast.filter(toExpression(expression));

/**
 * `BIND(expr AS ?name)`
 *
 * @since 0.1.0
 * @category patterns
 */
export const bind = (expression: ExpressionInput, name: string | Term.Variable): Ast.BindPattern =>
  Ast.bind(toExpression(expression), Predicate.isString(name) ? Term.variable(name) : name);

/**
 * Inline data from records: `values([{ x: ex.a, y: 1 }, { x: ex.b }])`.
 * Missing or `undefined` values are `UNDEF`.
 *
 * @since 0.1.0
 * @category patterns
 */
export const values = (
  rows: ReadonlyArray<Readonly<Record<string, Term.GroundTerm | JsValue | undefined>>>,
): Ast.ValuesPattern => {
  const names = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return Ast.values(
    names.map((n) => Term.variable(n)),
    rows.map((r) =>
      names.map((n) => {
        const x = r[n];
        return x === undefined ? undefined : isTerm(x) ? x : Xsd.fromJs(x);
      }),
    ),
  );
};

// -----------------------------------------------------------------------------
// Expressions
// -----------------------------------------------------------------------------

const op =
  (operator: Ast.Operator) =>
  (...args: ReadonlyArray<ExpressionInput>): Ast.Expression =>
    Ast.operation(operator, ...args.map(toExpression));

const binary =
  (operator: Ast.Operator) =>
  (a: ExpressionInput, b: ExpressionInput): Ast.Expression =>
    Ast.operation(operator, toExpression(a), toExpression(b));

const unary =
  (operator: Ast.Operator) =>
  (a: ExpressionInput): Ast.Expression =>
    Ast.operation(operator, toExpression(a));

/** @since 0.1.0 @category expressions */
export const eq = binary('=');
/** @since 0.1.0 @category expressions */
export const ne = binary('!=');
/** @since 0.1.0 @category expressions */
export const lt = binary('<');
/** @since 0.1.0 @category expressions */
export const le = binary('<=');
/** @since 0.1.0 @category expressions */
export const gt = binary('>');
/** @since 0.1.0 @category expressions */
export const ge = binary('>=');
/** @since 0.1.0 @category expressions */
export const add = binary('+');
/** @since 0.1.0 @category expressions */
export const subtract = binary('-');
/** @since 0.1.0 @category expressions */
export const multiply = binary('*');
/** @since 0.1.0 @category expressions */
export const divide = binary('/');
/** @since 0.1.0 @category expressions */
export const negate = unary('UMINUS');
/** @since 0.1.0 @category expressions */
export const not = unary('!');

/**
 * Logical conjunction of any number of conditions.
 *
 * @since 0.1.0
 * @category expressions
 */
export const and = (...args: ReadonlyArray<ExpressionInput>): Ast.Expression =>
  args.map(toExpression).reduce((a, b) => Ast.operation('&&', a, b));

/**
 * Logical disjunction of any number of conditions.
 *
 * @since 0.1.0
 * @category expressions
 */
export const or = (...args: ReadonlyArray<ExpressionInput>): Ast.Expression =>
  args.map(toExpression).reduce((a, b) => Ast.operation('||', a, b));

/**
 * `expr IN (…)`
 *
 * @since 0.1.0
 * @category expressions
 */
export const isIn = (
  expression: ExpressionInput,
  list: ReadonlyArray<ExpressionInput>,
): Ast.Expression => Ast.operation('IN', toExpression(expression), ...list.map(toExpression));

/**
 * `expr NOT IN (…)`
 *
 * @since 0.1.0
 * @category expressions
 */
export const notIn = (
  expression: ExpressionInput,
  list: ReadonlyArray<ExpressionInput>,
): Ast.Expression => Ast.operation('NOT IN', toExpression(expression), ...list.map(toExpression));

/**
 * Calls any built-in function by name, e.g. `fn('STRLEN', v.name)`.
 *
 * @since 0.1.0
 * @category expressions
 */
export const fn = (
  name: Ast.BuiltInName,
  ...args: ReadonlyArray<ExpressionInput>
): Ast.Expression => Ast.operation(name, ...args.map(toExpression));

/**
 * Calls an extension function (or XSD cast) by IRI.
 *
 * @since 0.1.0
 * @category expressions
 */
export const call = (
  iri: Term.NamedNode,
  ...args: ReadonlyArray<ExpressionInput>
): Ast.Expression => Ast.functionCall(iri, args.map(toExpression));

/** @since 0.1.0 @category expressions */
export const bound = (variable: Term.Variable): Ast.Expression => Ast.operation('BOUND', variable);
/** @since 0.1.0 @category expressions */
export const str = op('STR');
/** @since 0.1.0 @category expressions */
export const lang = op('LANG');
/** @since 0.1.0 @category expressions */
export const langMatches = op('LANGMATCHES');
/** @since 0.1.0 @category expressions */
export const datatype = op('DATATYPE');
/** @since 0.1.0 @category expressions */
export const iri = op('IRI');
/** @since 0.1.0 @category expressions */
export const regex = op('REGEX');
/** @since 0.1.0 @category expressions */
export const contains = op('CONTAINS');
/** @since 0.1.0 @category expressions */
export const strStarts = op('STRSTARTS');
/** @since 0.1.0 @category expressions */
export const strEnds = op('STRENDS');
/** @since 0.1.0 @category expressions */
export const strlen = op('STRLEN');
/** @since 0.1.0 @category expressions */
export const ucase = op('UCASE');
/** @since 0.1.0 @category expressions */
export const lcase = op('LCASE');
/** @since 0.1.0 @category expressions */
export const concat = op('CONCAT');
/** @since 0.1.0 @category expressions */
export const substr = op('SUBSTR');
/** @since 0.1.0 @category expressions */
export const replace = op('REPLACE');
/** @since 0.1.0 @category expressions */
export const coalesce = op('COALESCE');
/** @since 0.1.0 @category expressions */
export const ifThenElse = op('IF');
/** @since 0.1.0 @category expressions */
export const isIri = op('ISIRI');
/** @since 0.1.0 @category expressions */
export const isBlank = op('ISBLANK');
/** @since 0.1.0 @category expressions */
export const isLiteral = op('ISLITERAL');
/** @since 0.1.0 @category expressions */
export const isNumeric = op('ISNUMERIC');
/** @since 0.1.0 @category expressions */
export const sameTerm = op('SAMETERM');

/**
 * `EXISTS { … }`
 *
 * @since 0.1.0
 * @category expressions
 */
export const exists = (...patterns: ReadonlyArray<PatternInput>): Ast.Expression =>
  Ast.exists(group(...patterns));

/**
 * `NOT EXISTS { … }`
 *
 * @since 0.1.0
 * @category expressions
 */
export const notExists = (...patterns: ReadonlyArray<PatternInput>): Ast.Expression =>
  Ast.exists(group(...patterns), true);

const aggregate =
  (name: Ast.AggregateName) =>
  (expression: ExpressionInput, options?: { readonly distinct?: boolean }): Ast.Expression =>
    Ast.aggregate(name, toExpression(expression), options);

/**
 * `COUNT(*)` (no argument) or `COUNT(expr)`.
 *
 * @since 0.1.0
 * @category aggregates
 */
export const count = (
  expression?: ExpressionInput,
  options?: { readonly distinct?: boolean },
): Ast.Expression =>
  Ast.aggregate('COUNT', expression === undefined ? '*' : toExpression(expression), options);
/** @since 0.1.0 @category aggregates */
export const sum = aggregate('SUM');
/** @since 0.1.0 @category aggregates */
export const avg = aggregate('AVG');
/** @since 0.1.0 @category aggregates */
export const min = aggregate('MIN');
/** @since 0.1.0 @category aggregates */
export const max = aggregate('MAX');
/** @since 0.1.0 @category aggregates */
export const sample = aggregate('SAMPLE');

/**
 * `GROUP_CONCAT(expr; SEPARATOR = sep)`
 *
 * @since 0.1.0
 * @category aggregates
 */
export const groupConcat = (
  expression: ExpressionInput,
  options?: { readonly distinct?: boolean; readonly separator?: string },
): Ast.Expression => Ast.aggregate('GROUP_CONCAT', toExpression(expression), options);

/**
 * A descending `ORDER BY` condition.
 *
 * @since 0.1.0
 * @category modifiers
 */
export const desc = (expression: ExpressionInput): Ast.OrderCondition => ({
  expression: toExpression(expression),
  descending: true,
});

/**
 * An ascending `ORDER BY` condition.
 *
 * @since 0.1.0
 * @category modifiers
 */
export const asc = (expression: ExpressionInput): Ast.OrderCondition => ({
  expression: toExpression(expression),
  descending: false,
});

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

type Kind = Ast.Query['_tag'];

type QueryOf<K extends Kind> = Extract<Ast.Query, { readonly _tag: K }>;

/**
 * An immutable query builder. `K` is the query form; `R` and `O` are the
 * required and optional variables of `SELECT` rows.
 *
 * @since 0.1.0
 * @category models
 */
export class Builder<
  K extends Kind,
  R extends string = never,
  O extends string = never,
> implements Pipeable {
  /** @internal */
  readonly query: QueryOf<K>;
  constructor(query: QueryOf<K>) {
    this.query = query;
  }

  private with(
    patch: Partial<Ast.QueryBase> & Partial<Pick<Ast.SelectQuery, 'distinct' | 'reduced'>>,
  ): Builder<K, R, O> {
    return new Builder({ ...this.query, ...patch } as QueryOf<K>);
  }

  private append(patterns: ReadonlyArray<Ast.Pattern>): Builder<K, R, O> {
    return this.with({ where: group(this.query.where.patterns, patterns) });
  }

  /** Adds patterns to the `WHERE` clause. */
  where(...patterns: ReadonlyArray<PatternInput>): Builder<K, R, O> {
    return this.append(flatten(patterns));
  }

  /** Adds an `OPTIONAL { … }` block. */
  optional(...patterns: ReadonlyArray<PatternInput>): Builder<K, R, O> {
    return this.append([optional(...patterns)]);
  }

  /** Adds a `MINUS { … }` block. */
  minus(...patterns: ReadonlyArray<PatternInput>): Builder<K, R, O> {
    return this.append([minus(...patterns)]);
  }

  /** Adds a `UNION` of alternatives. */
  union(...alternatives: ReadonlyArray<PatternInput>): Builder<K, R, O> {
    return this.append([union(...alternatives)]);
  }

  /** Adds a `FILTER`. */
  filter(expression: ExpressionInput): Builder<K, R, O> {
    return this.append([filter(expression)]);
  }

  /** Adds a `BIND`. */
  bind(expression: ExpressionInput, name: string | Term.Variable): Builder<K, R, O> {
    return this.append([bind(expression, name)]);
  }

  /** Adds a `GRAPH` block. */
  graph(name: Ast.VarOrIri, ...patterns: ReadonlyArray<PatternInput>): Builder<K, R, O> {
    return this.append([graph(name, ...patterns)]);
  }

  /** Adds inline data. */
  values(rows: Parameters<typeof values>[0]): Builder<K, R, O> {
    return this.append([values(rows)]);
  }

  /** Adds `GROUP BY` conditions (expressions or `as(expr, name)`). */
  groupBy(
    ...conditions: ReadonlyArray<ExpressionInput | Alias<string, boolean>>
  ): Builder<K, R, O> {
    return this.with({
      groupBy: [
        ...this.query.groupBy,
        ...conditions.map((c): Ast.GroupCondition =>
          !isJsValue(c) && c._tag === 'Alias'
            ? { expression: c.expression, variable: Term.variable(c.name) }
            : { expression: toExpression(c as ExpressionInput) },
        ),
      ],
    });
  }

  /** Adds `HAVING` conditions. */
  having(...conditions: ReadonlyArray<ExpressionInput>): Builder<K, R, O> {
    return this.with({ having: [...this.query.having, ...conditions.map(toExpression)] });
  }

  /** Adds `ORDER BY` conditions (ascending unless wrapped with `desc`). */
  orderBy(...conditions: ReadonlyArray<ExpressionInput | Ast.OrderCondition>): Builder<K, R, O> {
    return this.with({
      orderBy: [
        ...this.query.orderBy,
        ...conditions.map((c) =>
          !isJsValue(c) && 'descending' in c ? c : asc(c as ExpressionInput),
        ),
      ],
    });
  }

  /** Sets `LIMIT`. */
  limit(limit: number): Builder<K, R, O> {
    return this.with({ limit });
  }

  /** Sets `OFFSET`. */
  offset(offset: number): Builder<K, R, O> {
    return this.with({ offset });
  }

  /** Makes a `SELECT` query `DISTINCT`. */
  distinct(): Builder<K, R, O> {
    return this.with({ distinct: true, reduced: false });
  }

  /** Makes a `SELECT` query `REDUCED`. */
  reduced(): Builder<K, R, O> {
    return this.with({ reduced: true, distinct: false });
  }

  /** Adds `FROM` graphs. */
  from(...graphs: ReadonlyArray<Term.NamedNode>): Builder<K, R, O> {
    const d = this.query.dataset ?? { default: [], named: [] };
    return this.with({ dataset: { default: [...d.default, ...graphs], named: d.named } });
  }

  /** Adds `FROM NAMED` graphs. */
  fromNamed(...graphs: ReadonlyArray<Term.NamedNode>): Builder<K, R, O> {
    const d = this.query.dataset ?? { default: [], named: [] };
    return this.with({ dataset: { default: d.default, named: [...d.named, ...graphs] } });
  }

  /** Declares prefixes (used when printing). */
  prefixes(prefixes: Readonly<Record<string, string>>): Builder<K, R, O> {
    return this.with({
      prologue: {
        ...this.query.prologue,
        prefixes: { ...this.query.prologue.prefixes, ...prefixes },
      },
    });
  }

  /** The query AST. */
  build(): QueryOf<K> {
    return this.query;
  }

  /** The query as SPARQL text. */
  toString(): string {
    return Generator.print(this.query);
  }

  pipe() {
    return pipeArguments(this, arguments);
  }
}

const empty = Ast.group([]);

const projectionItem = (item: SelectItem): Term.Variable | Ast.Projection => {
  if (Predicate.isString(item)) return Term.variable(item);
  switch (item._tag) {
    case 'Variable':
      return item;
    case 'Maybe':
      return Term.variable(item.name);
    case 'Alias':
      return Ast.projection(item.expression, Term.variable(item.name));
  }
};

/**
 * Starts a `SELECT` query. With no arguments, `SELECT *` (rows are then
 * untyped records).
 *
 * @since 0.1.0
 * @category constructors
 */
export const select = <const Items extends ReadonlyArray<SelectItem>>(
  ...items: Items
): Builder<'Select', RequiredOf<Items[number]>, OptionalOf<Items[number]>> =>
  new Builder(
    Ast.select({
      where: empty,
      projection: Arr.isReadonlyArrayEmpty(items) ? '*' : items.map(projectionItem),
    }),
  );

/**
 * Starts an `ASK` query.
 *
 * @since 0.1.0
 * @category constructors
 */
export const ask = (): Builder<'Ask'> => new Builder(Ast.ask({ where: empty }));

/**
 * Starts a `CONSTRUCT` query with a template.
 *
 * @since 0.1.0
 * @category constructors
 */
export const construct = (
  ...template: ReadonlyArray<Ast.TriplePattern | Ast.PathPattern>
): Builder<'Construct'> =>
  new Builder(
    Ast.construct({
      where: empty,
      template: template.filter((t): t is Ast.TriplePattern => t._tag === 'TriplePattern'),
    }),
  );

/**
 * Starts a `DESCRIBE` query.
 *
 * @since 0.1.0
 * @category constructors
 */
export const describe = (...terms: ReadonlyArray<Ast.VarOrIri>): Builder<'Describe'> =>
  new Builder(Ast.describe({ terms: Arr.isReadonlyArrayEmpty(terms) ? '*' : terms }));

// -----------------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------------

/**
 * Executes a `SELECT` builder, streaming typed rows.
 *
 * @since 0.1.0
 * @category execution
 */
export const execute = <R extends string, O extends string>(
  builder: Builder<'Select', R, O>,
  options?: Engine.RequestOptions,
): Stream.Stream<Row<R, O>, Engine.SparqlError, Engine.SparqlEngine> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      const result = yield* engine.select(builder.build(), options);
      return Stream.map(result.bindings, (b) => B.toRecord(b) as Row<R, O>);
    }),
  );

/**
 * Executes a `SELECT` builder and collects all rows.
 *
 * @since 0.1.0
 * @category execution
 */
export const executeAll = <R extends string, O extends string>(
  builder: Builder<'Select', R, O>,
  options?: Engine.RequestOptions,
): Effect.Effect<ReadonlyArray<Row<R, O>>, Engine.SparqlError, Engine.SparqlEngine> =>
  Stream.runCollect(execute(builder, options));

/**
 * Executes a `SELECT` builder and decodes each row with a schema (whose
 * fields are typically `TermSchema` codecs).
 *
 * @since 0.1.0
 * @category execution
 */
export const decode = <R extends string, O extends string, A, RD>(
  builder: Builder<'Select', R, O>,
  schema: Schema.Decoder<A, RD>,
  options?: Engine.RequestOptions,
): Stream.Stream<A, Engine.SparqlError | Schema.SchemaError, Engine.SparqlEngine | RD> =>
  Stream.mapEffect(execute(builder, options), (row) => Schema.decodeUnknownEffect(schema)(row));

/**
 * Executes an `ASK` builder.
 *
 * @since 0.1.0
 * @category execution
 */
export const executeAsk = (
  builder: Builder<'Ask'>,
  options?: Engine.RequestOptions,
): Effect.Effect<boolean, Engine.SparqlError, Engine.SparqlEngine> =>
  Effect.flatMap(Effect.service(Engine.SparqlEngine), (engine) =>
    engine.ask(builder.build(), options),
  );

/**
 * Executes a `CONSTRUCT` or `DESCRIBE` builder, streaming triples.
 *
 * @since 0.1.0
 * @category execution
 */
export const executeGraph = (
  builder: Builder<'Construct'> | Builder<'Describe'>,
  options?: Engine.RequestOptions,
): Stream.Stream<Term.Quad, Engine.SparqlError, Engine.SparqlEngine> =>
  Stream.unwrap(
    Effect.flatMap(Effect.service(Engine.SparqlEngine), (engine) =>
      engine.construct(builder.build(), options),
    ),
  );
