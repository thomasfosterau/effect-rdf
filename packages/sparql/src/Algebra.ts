/**
 * The SPARQL algebra (SPARQL 1.1 §18): the operator tree that queries are
 * translated to and that the engine (or a storage backend) evaluates.
 *
 * Operators are plain immutable objects discriminated by `_tag`. Blank nodes
 * of query patterns are replaced by internal variables (whose names start
 * with `@` and therefore cannot clash with user variables); aggregates are
 * computed by `Group` nodes and referenced through internal variables.
 *
 * Storage backends that evaluate (parts of) the algebra natively — such as a
 * SQL backend translating SPARQL to SQL — pattern-match on these types; see
 * `Store.QueryCapability`.
 *
 * @since 0.1.0
 */
import * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Ast from './Ast.ts';
import type { Bindings } from './Bindings.ts';
import * as Arr from 'effect/Array';
import * as Match from 'effect/Match';

// -----------------------------------------------------------------------------
// Expressions
// -----------------------------------------------------------------------------

/**
 * An algebra expression: like `Ast.Expression`, but `EXISTS` patterns are
 * translated to algebra and aggregates have been replaced by variables.
 *
 * @since 0.1.0
 * @category models
 */
export type Expression =
  | Term.Variable
  | Term.NamedNode
  | Term.Literal
  | Term.BlankNode
  | Term.Triple<any, any, any>
  | OperationExpression
  | FunctionCallExpression
  | ExistsExpression;

/**
 * @since 0.1.0
 * @category models
 */
export interface OperationExpression {
  readonly _tag: 'Operation';
  readonly operator: Ast.Operator;
  readonly args: ReadonlyArray<Expression>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface FunctionCallExpression {
  readonly _tag: 'FunctionCall';
  readonly function: Term.NamedNode;
  readonly args: ReadonlyArray<Expression>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface ExistsExpression {
  readonly _tag: 'Exists';
  readonly negated: boolean;
  readonly input: Operation;
}

/**
 * An aggregate computed by a `Group` operator.
 *
 * @since 0.1.0
 * @category models
 */
export interface Aggregate {
  readonly name: Ast.AggregateName;
  readonly distinct: boolean;
  readonly expression: Expression | '*';
  readonly separator?: string | undefined;
}

// -----------------------------------------------------------------------------
// Operators
// -----------------------------------------------------------------------------

/**
 * An algebra operator.
 *
 * @since 0.1.0
 * @category models
 */
export type Operation =
  | Bgp
  | Path
  | Join
  | LeftJoin
  | Filter
  | Union
  | Graph
  | Extend
  | Minus
  | Group
  | OrderBy
  | Project
  | Distinct
  | Reduced
  | Slice
  | Values
  | Service;

/**
 * A basic graph pattern. The empty BGP is the join identity (one empty
 * solution).
 *
 * @since 0.1.0
 * @category models
 */
export interface Bgp {
  readonly _tag: 'Bgp';
  readonly patterns: ReadonlyArray<Ast.TriplePattern>;
}

/**
 * A property path pattern that could not be expanded to triple patterns.
 *
 * @since 0.1.0
 * @category models
 */
export interface Path {
  readonly _tag: 'Path';
  readonly subject: Ast.TermPattern;
  readonly path: Ast.Path;
  readonly object: Ast.TermPattern;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Join {
  readonly _tag: 'Join';
  readonly left: Operation;
  readonly right: Operation;
}

/**
 * `OPTIONAL`, with the filter of the optional group as `expression`.
 *
 * @since 0.1.0
 * @category models
 */
export interface LeftJoin {
  readonly _tag: 'LeftJoin';
  readonly left: Operation;
  readonly right: Operation;
  readonly expression?: Expression | undefined;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Filter {
  readonly _tag: 'Filter';
  readonly expression: Expression;
  readonly input: Operation;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Union {
  readonly _tag: 'Union';
  readonly left: Operation;
  readonly right: Operation;
}

/**
 * Evaluates `input` against a named graph (`GRAPH`).
 *
 * @since 0.1.0
 * @category models
 */
export interface Graph {
  readonly _tag: 'Graph';
  readonly name: Term.NamedNode | Term.Variable;
  readonly input: Operation;
}

/**
 * Binds `variable` to the value of `expression` (`BIND` and select
 * expressions).
 *
 * @since 0.1.0
 * @category models
 */
export interface Extend {
  readonly _tag: 'Extend';
  readonly input: Operation;
  readonly variable: Term.Variable;
  readonly expression: Expression;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Minus {
  readonly _tag: 'Minus';
  readonly left: Operation;
  readonly right: Operation;
}

/**
 * A group key: the grouping expression and the variable it is bound to.
 *
 * @since 0.1.0
 * @category models
 */
export interface GroupKey {
  readonly expression: Expression;
  readonly variable: Term.Variable;
}

/**
 * Grouping and aggregation (`Group` + `AggregateJoin`). Each output solution
 * binds the key variables and the aggregate variables of one group. With no
 * keys, all solutions form one group (which exists even if there are no
 * solutions).
 *
 * @since 0.1.0
 * @category models
 */
export interface Group {
  readonly _tag: 'Group';
  readonly input: Operation;
  readonly keys: ReadonlyArray<GroupKey>;
  readonly aggregates: ReadonlyArray<{
    readonly variable: Term.Variable;
    readonly aggregate: Aggregate;
  }>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface OrderCondition {
  readonly expression: Expression;
  readonly descending: boolean;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface OrderBy {
  readonly _tag: 'OrderBy';
  readonly input: Operation;
  readonly conditions: ReadonlyArray<OrderCondition>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Project {
  readonly _tag: 'Project';
  readonly input: Operation;
  readonly variables: ReadonlyArray<Term.Variable>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Distinct {
  readonly _tag: 'Distinct';
  readonly input: Operation;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Reduced {
  readonly _tag: 'Reduced';
  readonly input: Operation;
}

/**
 * `OFFSET` / `LIMIT`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Slice {
  readonly _tag: 'Slice';
  readonly input: Operation;
  readonly offset: number;
  readonly limit?: number | undefined;
}

/**
 * Inline data (`VALUES`).
 *
 * @since 0.1.0
 * @category models
 */
export interface Values {
  readonly _tag: 'Values';
  readonly variables: ReadonlyArray<Term.Variable>;
  readonly bindings: ReadonlyArray<Bindings>;
}

/**
 * A federated `SERVICE` pattern. `pattern` keeps the original syntax so that
 * the pattern can be sent to the remote endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly _tag: 'Service';
  readonly name: Term.NamedNode | Term.Variable;
  readonly silent: boolean;
  readonly input: Operation;
  readonly pattern: Ast.GroupPattern;
  readonly prefixes: Readonly<Record<string, string>>;
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

/**
 * A translated query: the algebra of the WHERE clause plus solution
 * modifiers, the query form and the dataset clause.
 *
 * @since 0.1.0
 * @category models
 */
export type Query =
  | {
      readonly _tag: 'Select';
      readonly input: Operation;
      readonly variables: ReadonlyArray<Term.Variable>;
      readonly dataset?: Ast.DatasetClause | undefined;
    }
  | {
      readonly _tag: 'Construct';
      readonly input: Operation;
      readonly template: ReadonlyArray<Ast.TriplePattern>;
      readonly dataset?: Ast.DatasetClause | undefined;
    }
  | {
      readonly _tag: 'Ask';
      readonly input: Operation;
      readonly dataset?: Ast.DatasetClause | undefined;
    }
  | {
      readonly _tag: 'Describe';
      readonly input: Operation;
      readonly terms: ReadonlyArray<Term.NamedNode | Term.Variable>;
      readonly dataset?: Ast.DatasetClause | undefined;
    };

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

/**
 * The empty BGP: the join identity.
 *
 * @since 0.1.0
 * @category constructors
 */
export const unit: Bgp = { _tag: 'Bgp', patterns: [] };

/**
 * @since 0.1.0
 * @category constructors
 */
export const bgp = (patterns: ReadonlyArray<Ast.TriplePattern>): Bgp => ({ _tag: 'Bgp', patterns });

/**
 * @since 0.1.0
 * @category constructors
 */
export const join = (left: Operation, right: Operation): Join => ({ _tag: 'Join', left, right });

/**
 * @since 0.1.0
 * @category constructors
 */
export const leftJoin = (left: Operation, right: Operation, expression?: Expression): LeftJoin =>
  expression === undefined
    ? { _tag: 'LeftJoin', left, right }
    : { _tag: 'LeftJoin', left, right, expression };

/**
 * @since 0.1.0
 * @category constructors
 */
export const filter = (expression: Expression, input: Operation): Filter => ({
  _tag: 'Filter',
  expression,
  input,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const union = (left: Operation, right: Operation): Union => ({ _tag: 'Union', left, right });

/**
 * @since 0.1.0
 * @category constructors
 */
export const minus = (left: Operation, right: Operation): Minus => ({ _tag: 'Minus', left, right });

/**
 * @since 0.1.0
 * @category constructors
 */
export const extend = (
  input: Operation,
  variable: Term.Variable,
  expression: Expression,
): Extend => ({
  _tag: 'Extend',
  input,
  variable,
  expression,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const project = (input: Operation, variables: ReadonlyArray<Term.Variable>): Project => ({
  _tag: 'Project',
  input,
  variables,
});

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Whether a variable name is internal (introduced by translation for blank
 * nodes, property path sequences, group keys and aggregates).
 *
 * @since 0.1.0
 * @category utils
 */
export const isInternalVariable = (name: string): boolean => name.startsWith('@');

const termVariables = (t: Term.Term | Ast.TermPattern, out: Set<string>): void => {
  if (t._tag === 'Variable') out.add(t.value);
  else if (t._tag === 'Triple') {
    termVariables(t.subject, out);
    termVariables(t.predicate, out);
    termVariables(t.object, out);
  }
};

/**
 * The variables that may be bound by solutions of an operator ("in-scope"
 * variables, including internal ones).
 *
 * @since 0.1.0
 * @category utils
 */
export const variables = (op: Operation): ReadonlySet<string> => {
  const out = new Set<string>();
  collectVariables(op, out);
  return out;
};

const collectVariables = (op: Operation, out: Set<string>): void => {
  Match.value(op).pipe(
    Match.tag('Bgp', (o) => {
      for (const p of o.patterns) {
        termVariables(p.subject, out);
        termVariables(p.predicate, out);
        termVariables(p.object, out);
      }
    }),
    Match.tag('Path', (o) => {
      termVariables(o.subject, out);
      termVariables(o.object, out);
    }),
    Match.tag('Join', 'LeftJoin', 'Union', (o) => {
      collectVariables(o.left, out);
      collectVariables(o.right, out);
    }),
    Match.tag('Minus', (o) => collectVariables(o.left, out)),
    Match.tag('Filter', 'OrderBy', 'Distinct', 'Reduced', 'Slice', (o) =>
      collectVariables(o.input, out),
    ),
    Match.tag('Graph', 'Service', (o) => {
      termVariables(o.name, out);
      collectVariables(o.input, out);
    }),
    Match.tag('Extend', (o) => {
      collectVariables(o.input, out);
      out.add(o.variable.value);
    }),
    Match.tag('Group', (o) => {
      for (const k of o.keys) out.add(k.variable.value);
      for (const a of o.aggregates) out.add(a.variable.value);
    }),
    Match.tag('Project', 'Values', (o) => {
      for (const v of o.variables) out.add(v.value);
    }),
    Match.exhaustive,
  );
};

/**
 * The variables that are bound in every solution of an operator (as far as
 * can be determined statically).
 *
 * @since 0.1.0
 * @category utils
 */
export const certainVariables = (op: Operation): ReadonlySet<string> => {
  return Match.value(op).pipe(
    Match.tag('Bgp', 'Path', (o): ReadonlySet<string> => variables(o)),
    Match.tag('Join', (o) => {
      const out = new Set(certainVariables(o.left));
      for (const v of certainVariables(o.right)) out.add(v);
      return out;
    }),
    Match.tag('LeftJoin', 'Minus', (o) => certainVariables(o.left)),
    Match.tag('Union', (o) => {
      const right = certainVariables(o.right);
      return new Set(Array.from(certainVariables(o.left)).filter((v) => right.has(v)));
    }),
    Match.tag('Filter', 'OrderBy', 'Distinct', 'Reduced', 'Slice', 'Extend', (o) =>
      certainVariables(o.input),
    ),
    Match.tag('Graph', 'Service', (o) => {
      const out = new Set(certainVariables(o.input));
      if (o.name._tag === 'Variable') out.add(o.name.value);
      return out;
    }),
    Match.tag('Group', () => new Set<string>()),
    Match.tag('Project', (o) => {
      const inner = certainVariables(o.input);
      return new Set(o.variables.map((v) => v.value).filter((v) => inner.has(v)));
    }),
    Match.tag(
      'Values',
      (o) =>
        new Set(
          o.variables.map((v) => v.value).filter((v) => o.bindings.every((b) => b.map.has(v))),
        ),
    ),
    Match.exhaustive,
  );
};

/**
 * The variables mentioned by an expression (not looking into `EXISTS`).
 *
 * @since 0.1.0
 * @category utils
 */
export const expressionVariables = (expression: Expression): ReadonlySet<string> => {
  const out = new Set<string>();
  const go = (e: Expression): void => {
    Match.value(e).pipe(
      Match.tag('Variable', 'Triple', (t) => termVariables(t, out)),
      Match.tag('Operation', 'FunctionCall', (call) => call.args.forEach(go)),
      Match.orElse(() => undefined),
    );
  };
  go(expression);
  return out;
};

/**
 * Whether an expression contains `EXISTS` / `NOT EXISTS`.
 *
 * @since 0.1.0
 * @category utils
 */
export const containsExists = (expression: Expression): boolean => {
  return Match.value(expression).pipe(
    Match.tag('Exists', () => true),
    Match.tag('Operation', 'FunctionCall', (call) => call.args.some(containsExists)),
    Match.orElse(() => false),
  );
};

/**
 * Rewrites an operator tree bottom-up: `f` is applied to every node after
 * its children have been rewritten.
 *
 * @since 0.1.0
 * @category utils
 */
export const transform = (op: Operation, f: (op: Operation) => Operation): Operation => {
  const go = (o: Operation): Operation => f(mapChildren(o, go));
  return go(op);
};

/**
 * Applies `f` to the direct children of an operator.
 *
 * @since 0.1.0
 * @category utils
 */
export const mapChildren = (op: Operation, f: (op: Operation) => Operation): Operation => {
  return Match.value(op).pipe(
    Match.tag('Bgp', 'Path', 'Values', (o): Operation => o),
    Match.tag('Join', 'Union', 'Minus', (o) => ({ ...o, left: f(o.left), right: f(o.right) })),
    Match.tag('LeftJoin', (o) => ({ ...o, left: f(o.left), right: f(o.right) })),
    Match.tag(
      'Filter',
      'Graph',
      'Extend',
      'Group',
      'OrderBy',
      'Project',
      'Distinct',
      'Reduced',
      'Slice',
      'Service',
      // SAFETY: every operator listed here has an `input`, and replacing it keeps the
      // operator's own tag.
      (o) => ({ ...o, input: f(o.input) }),
    ),
    Match.exhaustive,
  );
};

const termText = (t: Term.Term | Ast.TermPattern): string =>
  t._tag === 'Triple'
    ? `<<( ${termText(t.subject)} ${termText(t.predicate)} ${termText(t.object)} )>>`
    : t.toString();

const pathText = (p: Ast.Path): string => {
  return Match.value(p).pipe(
    Match.tag('PathLink', (l) => termText(l.iri)),
    Match.tag('PathInverse', (i) => `(inv ${pathText(i.path)})`),
    Match.tag('PathSequence', (s) => `(seq ${s.paths.map(pathText).join(' ')})`),
    Match.tag('PathAlternative', (a) => `(alt ${a.paths.map(pathText).join(' ')})`),
    Match.tag('PathZeroOrMore', (z) => `(path* ${pathText(z.path)})`),
    Match.tag('PathOneOrMore', (o) => `(path+ ${pathText(o.path)})`),
    Match.tag('PathZeroOrOne', (z) => `(path? ${pathText(z.path)})`),
    Match.tag(
      'PathNegated',
      (n) =>
        `(notoneof ${[...n.iris.map(termText), ...n.inverse.map((i) => `^${termText(i)}`)].join(' ')})`,
    ),
    Match.exhaustive,
  );
};

/**
 * Formats an expression as an S-expression (for debugging and logging).
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatExpression = (e: Expression): string => {
  return Match.value(e).pipe(
    Match.tag(
      'Operation',
      (o) => `(${o.operator.toLowerCase()} ${o.args.map(formatExpression).join(' ')})`,
    ),
    Match.tag(
      'FunctionCall',
      (c) => `(${termText(c.function)} ${c.args.map(formatExpression).join(' ')})`,
    ),
    Match.tag('Exists', (x) => `(${x.negated ? 'notexists' : 'exists'} ${format(x.input)})`),
    Match.orElse((t) => termText(t)),
  );
};

/**
 * Formats an operator tree as an S-expression in the style of the SPARQL
 * Algebra notation (for debugging and logging).
 *
 * @since 0.1.0
 * @category formatting
 */
export const format = (op: Operation, indent = ''): string => {
  const next = `${indent}  `;
  const sub = (o: Operation) => `\n${next}${format(o, next)}`;
  return Match.value(op).pipe(
    Match.tag(
      'Bgp',
      (o) =>
        `(bgp${o.patterns.map((p) => ` (triple ${termText(p.subject)} ${termText(p.predicate)} ${termText(p.object)})`).join('')})`,
    ),
    Match.tag(
      'Path',
      (o) => `(path ${termText(o.subject)} ${pathText(o.path)} ${termText(o.object)})`,
    ),
    Match.tag('Join', (o) => `(join${sub(o.left)}${sub(o.right)})`),
    Match.tag(
      'LeftJoin',
      (o) =>
        `(leftjoin${sub(o.left)}${sub(o.right)}${o.expression !== undefined ? `\n${next}${formatExpression(o.expression)}` : ''})`,
    ),
    Match.tag('Filter', (o) => `(filter ${formatExpression(o.expression)}${sub(o.input)})`),
    Match.tag('Union', (o) => `(union${sub(o.left)}${sub(o.right)})`),
    Match.tag('Graph', (o) => `(graph ${termText(o.name)}${sub(o.input)})`),
    Match.tag(
      'Extend',
      (o) =>
        `(extend ((${termText(o.variable)} ${formatExpression(o.expression)}))${sub(o.input)})`,
    ),
    Match.tag('Minus', (o) => `(minus${sub(o.left)}${sub(o.right)})`),
    Match.tag(
      'Group',
      (o) =>
        `(group (${o.keys.map((k) => `(${termText(k.variable)} ${formatExpression(k.expression)})`).join(' ')}) (${o.aggregates
          .map(
            (a) =>
              `(${termText(a.variable)} (${a.aggregate.name.toLowerCase()}${a.aggregate.distinct ? ' distinct' : ''} ${a.aggregate.expression === '*' ? '*' : formatExpression(a.aggregate.expression)}))`,
          )
          .join(' ')})${sub(o.input)})`,
    ),
    Match.tag(
      'OrderBy',
      (o) =>
        `(order (${o.conditions.map((c) => (c.descending ? `(desc ${formatExpression(c.expression)})` : formatExpression(c.expression))).join(' ')})${sub(o.input)})`,
    ),
    Match.tag(
      'Project',
      (o) => `(project (${o.variables.map(termText).join(' ')})${sub(o.input)})`,
    ),
    Match.tag('Distinct', (o) => `(distinct${sub(o.input)})`),
    Match.tag('Reduced', (o) => `(reduced${sub(o.input)})`),
    Match.tag('Slice', (o) => `(slice ${o.offset} ${o.limit ?? '_'}${sub(o.input)})`),
    Match.tag(
      'Values',
      (o) => `(table (vars ${o.variables.map(termText).join(' ')}) ${o.bindings.length} rows)`,
    ),
    Match.tag(
      'Service',
      (o) => `(service ${o.silent ? 'silent ' : ''}${termText(o.name)}${sub(o.input)})`,
    ),
    Match.exhaustive,
  );
};

/**
 * Creates an internal variable.
 *
 * @since 0.1.0
 * @category constructors
 */
export const internalVariable = (name: string): Term.Variable => Term.variable(`@${name}`);

// -----------------------------------------------------------------------------
// Pre-binding
// -----------------------------------------------------------------------------

/**
 * Applies `f` to every graph pattern nested in an expression (the patterns
 * of `EXISTS` / `NOT EXISTS`).
 *
 * @since 0.1.0
 * @category utils
 */
export const mapExpressionPatterns = (
  expression: Expression,
  f: (op: Operation) => Operation,
): Expression => {
  return Match.value(expression).pipe(
    Match.tag('Exists', (x): Expression => ({ ...x, input: f(x.input) })),
    Match.tag('Operation', (o) => ({
      ...o,
      args: o.args.map((a) => mapExpressionPatterns(a, f)),
    })),
    Match.tag('FunctionCall', (c) => ({
      ...c,
      args: c.args.map((a) => mapExpressionPatterns(a, f)),
    })),
    Match.orElse((e) => e),
  );
};

/**
 * Pre-binds variables in an algebra expression, following the "values
 * insertion" definition of SHACL-SPARQL (Appendix "Pre-binding of
 * Variables", aligned with the SPARQL `EXISTS` errata): every basic graph
 * pattern, property path and `GRAPH ?var` pattern `Y` — including those
 * nested in `EXISTS` — is replaced by `Join(Table(μ), Y)`, where `Table(μ)`
 * is a one-row `VALUES` table holding the pre-bound solution `μ`.
 *
 * The pre-bound values are also substituted into the replaced patterns,
 * which does not change the result (the join restores the bindings) but lets
 * the optimizer and the store use them as constants.
 *
 * Unlike a trailing `VALUES` clause, pre-bound values are visible to every
 * `FILTER` and `BIND`, including those of groups that never match the
 * variable: `SELECT $this WHERE { FILTER ($this = ex:a) }` has one solution
 * when `this` is pre-bound to `ex:a`. Queries using `MINUS`, `VALUES` or
 * `SERVICE`, rebinding a pre-bound variable with `AS`, or with sub-queries
 * that do not project the pre-bound variables, have no well-defined meaning
 * under pre-binding.
 *
 * @since 0.1.0
 * @category utils
 */
export const prebind = (op: Operation, bindings: Bindings): Operation => {
  if (bindings.map.size === 0) return op;
  const table: Values = {
    _tag: 'Values',
    variables: Array.from(bindings.map.keys(), (v) => Term.variable(v)),
    bindings: [bindings],
  };
  const term = (t: Ast.TermPattern): Ast.TermPattern => {
    if (t._tag === 'Variable') {
      const v = bindings.map.get(t.value);
      // SAFETY: a bound value is a ground term, which is also a term pattern.
      return v === undefined ? t : (v as Ast.TermPattern);
    }
    if (t._tag === 'Triple') {
      const s = term(t.subject);
      const p = term(t.predicate);
      const o = term(t.object);
      // SAFETY: substituting ground terms into a triple pattern keeps each position's kind.
      return s === t.subject && p === t.predicate && o === t.object
        ? t
        : Term.triple(s as Term.Subject, p as Term.Predicate, o as Term.Object);
    }
    return t;
  };
  const predicate = (p: Ast.VarOrIri): Ast.VarOrIri => {
    if (p._tag !== 'Variable') return p;
    const v = bindings.map.get(p.value);
    return v !== undefined && v._tag === 'NamedNode' ? v : p;
  };
  const expr = (e: Expression): Expression => mapExpressionPatterns(e, go);
  const go = (o: Operation): Operation => {
    return Match.value(o).pipe(
      Match.tag('Bgp', (b): Operation =>
        Arr.isReadonlyArrayEmpty(b.patterns)
          ? table
          : join(
              table,
              bgp(
                b.patterns.map((p): Ast.TriplePattern => ({
                  _tag: 'TriplePattern',
                  subject: term(p.subject),
                  predicate: predicate(p.predicate),
                  object: term(p.object),
                })),
              ),
            ),
      ),
      Match.tag('Path', (p) =>
        join(table, { ...p, subject: term(p.subject), object: term(p.object) }),
      ),
      Match.tag('Graph', (g) => {
        const input = go(g.input);
        const value = g.name._tag === 'Variable' ? bindings.map.get(g.name.value) : undefined;
        if (value === undefined) return { ...g, input };
        return join(
          table,
          value._tag === 'NamedNode' ? { ...g, name: value, input } : { ...g, input },
        );
      }),
      Match.tag('Filter', (x) => ({ ...x, expression: expr(x.expression), input: go(x.input) })),
      Match.tag('LeftJoin', (l) =>
        l.expression === undefined
          ? { ...l, left: go(l.left), right: go(l.right) }
          : { ...l, left: go(l.left), right: go(l.right), expression: expr(l.expression) },
      ),
      Match.tag('Extend', (x) => ({ ...x, expression: expr(x.expression), input: go(x.input) })),
      Match.tag('OrderBy', (x) => ({
        ...x,
        input: go(x.input),
        conditions: x.conditions.map((c) => ({ ...c, expression: expr(c.expression) })),
      })),
      Match.tag('Group', (x) => ({
        ...x,
        input: go(x.input),
        keys: x.keys.map((k) => ({ ...k, expression: expr(k.expression) })),
        aggregates: x.aggregates.map((a) => ({
          ...a,
          aggregate:
            a.aggregate.expression === '*'
              ? a.aggregate
              : { ...a.aggregate, expression: expr(a.aggregate.expression) },
        })),
      })),
      Match.orElse((x) => mapChildren(x, go)),
    );
  };
  return go(op);
};
