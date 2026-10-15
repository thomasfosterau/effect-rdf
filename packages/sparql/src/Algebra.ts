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
  switch (op._tag) {
    case 'Bgp':
      for (const p of op.patterns) {
        termVariables(p.subject, out);
        termVariables(p.predicate, out);
        termVariables(p.object, out);
      }
      return;
    case 'Path':
      termVariables(op.subject, out);
      termVariables(op.object, out);
      return;
    case 'Join':
    case 'LeftJoin':
    case 'Union':
      collectVariables(op.left, out);
      collectVariables(op.right, out);
      return;
    case 'Minus':
      collectVariables(op.left, out);
      return;
    case 'Filter':
    case 'OrderBy':
    case 'Distinct':
    case 'Reduced':
    case 'Slice':
      collectVariables(op.input, out);
      return;
    case 'Graph':
    case 'Service':
      termVariables(op.name, out);
      collectVariables(op.input, out);
      return;
    case 'Extend':
      collectVariables(op.input, out);
      out.add(op.variable.value);
      return;
    case 'Group':
      for (const k of op.keys) out.add(k.variable.value);
      for (const a of op.aggregates) out.add(a.variable.value);
      return;
    case 'Project':
      for (const v of op.variables) out.add(v.value);
      return;
    case 'Values':
      for (const v of op.variables) out.add(v.value);
      return;
  }
};

/**
 * The variables that are bound in every solution of an operator (as far as
 * can be determined statically).
 *
 * @since 0.1.0
 * @category utils
 */
export const certainVariables = (op: Operation): ReadonlySet<string> => {
  switch (op._tag) {
    case 'Bgp':
    case 'Path':
      return variables(op);
    case 'Join': {
      const out = new Set(certainVariables(op.left));
      for (const v of certainVariables(op.right)) out.add(v);
      return out;
    }
    case 'LeftJoin':
    case 'Minus':
      return certainVariables(op.left);
    case 'Union': {
      const right = certainVariables(op.right);
      return new Set(Array.from(certainVariables(op.left)).filter((v) => right.has(v)));
    }
    case 'Filter':
    case 'OrderBy':
    case 'Distinct':
    case 'Reduced':
    case 'Slice':
    case 'Extend':
      return certainVariables(op.input);
    case 'Graph':
    case 'Service': {
      const out = new Set(certainVariables(op.input));
      if (op.name._tag === 'Variable') out.add(op.name.value);
      return out;
    }
    case 'Group':
      return new Set();
    case 'Project': {
      const inner = certainVariables(op.input);
      return new Set(op.variables.map((v) => v.value).filter((v) => inner.has(v)));
    }
    case 'Values': {
      return new Set(
        op.variables.map((v) => v.value).filter((v) => op.bindings.every((b) => b.map.has(v))),
      );
    }
  }
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
    switch (e._tag) {
      case 'Variable':
      case 'Triple':
        termVariables(e, out);
        return;
      case 'Operation':
      case 'FunctionCall':
        e.args.forEach(go);
        return;
      default:
        return;
    }
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
  switch (expression._tag) {
    case 'Exists':
      return true;
    case 'Operation':
    case 'FunctionCall':
      return expression.args.some(containsExists);
    default:
      return false;
  }
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
  switch (op._tag) {
    case 'Bgp':
    case 'Path':
    case 'Values':
      return op;
    case 'Join':
    case 'Union':
    case 'Minus':
      return { ...op, left: f(op.left), right: f(op.right) };
    case 'LeftJoin':
      return { ...op, left: f(op.left), right: f(op.right) };
    case 'Filter':
    case 'Graph':
    case 'Extend':
    case 'Group':
    case 'OrderBy':
    case 'Project':
    case 'Distinct':
    case 'Reduced':
    case 'Slice':
    case 'Service':
      return { ...op, input: f(op.input) } as Operation;
  }
};

const termText = (t: Term.Term | Ast.TermPattern): string =>
  t._tag === 'Triple'
    ? `<<( ${termText(t.subject)} ${termText(t.predicate)} ${termText(t.object)} )>>`
    : t.toString();

const pathText = (p: Ast.Path): string => {
  switch (p._tag) {
    case 'PathLink':
      return termText(p.iri);
    case 'PathInverse':
      return `(inv ${pathText(p.path)})`;
    case 'PathSequence':
      return `(seq ${p.paths.map(pathText).join(' ')})`;
    case 'PathAlternative':
      return `(alt ${p.paths.map(pathText).join(' ')})`;
    case 'PathZeroOrMore':
      return `(path* ${pathText(p.path)})`;
    case 'PathOneOrMore':
      return `(path+ ${pathText(p.path)})`;
    case 'PathZeroOrOne':
      return `(path? ${pathText(p.path)})`;
    case 'PathNegated':
      return `(notoneof ${[...p.iris.map(termText), ...p.inverse.map((i) => `^${termText(i)}`)].join(' ')})`;
  }
};

/**
 * Formats an expression as an S-expression (for debugging and logging).
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatExpression = (e: Expression): string => {
  switch (e._tag) {
    case 'Operation':
      return `(${e.operator.toLowerCase()} ${e.args.map(formatExpression).join(' ')})`;
    case 'FunctionCall':
      return `(${termText(e.function)} ${e.args.map(formatExpression).join(' ')})`;
    case 'Exists':
      return `(${e.negated ? 'notexists' : 'exists'} ${format(e.input)})`;
    default:
      return termText(e);
  }
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
  switch (op._tag) {
    case 'Bgp':
      return `(bgp${op.patterns.map((p) => ` (triple ${termText(p.subject)} ${termText(p.predicate)} ${termText(p.object)})`).join('')})`;
    case 'Path':
      return `(path ${termText(op.subject)} ${pathText(op.path)} ${termText(op.object)})`;
    case 'Join':
      return `(join${sub(op.left)}${sub(op.right)})`;
    case 'LeftJoin':
      return `(leftjoin${sub(op.left)}${sub(op.right)}${op.expression !== undefined ? `\n${next}${formatExpression(op.expression)}` : ''})`;
    case 'Filter':
      return `(filter ${formatExpression(op.expression)}${sub(op.input)})`;
    case 'Union':
      return `(union${sub(op.left)}${sub(op.right)})`;
    case 'Graph':
      return `(graph ${termText(op.name)}${sub(op.input)})`;
    case 'Extend':
      return `(extend ((${termText(op.variable)} ${formatExpression(op.expression)}))${sub(op.input)})`;
    case 'Minus':
      return `(minus${sub(op.left)}${sub(op.right)})`;
    case 'Group':
      return `(group (${op.keys.map((k) => `(${termText(k.variable)} ${formatExpression(k.expression)})`).join(' ')}) (${op.aggregates
        .map(
          (a) =>
            `(${termText(a.variable)} (${a.aggregate.name.toLowerCase()}${a.aggregate.distinct ? ' distinct' : ''} ${a.aggregate.expression === '*' ? '*' : formatExpression(a.aggregate.expression)}))`,
        )
        .join(' ')})${sub(op.input)})`;
    case 'OrderBy':
      return `(order (${op.conditions.map((c) => (c.descending ? `(desc ${formatExpression(c.expression)})` : formatExpression(c.expression))).join(' ')})${sub(op.input)})`;
    case 'Project':
      return `(project (${op.variables.map(termText).join(' ')})${sub(op.input)})`;
    case 'Distinct':
      return `(distinct${sub(op.input)})`;
    case 'Reduced':
      return `(reduced${sub(op.input)})`;
    case 'Slice':
      return `(slice ${op.offset} ${op.limit ?? '_'}${sub(op.input)})`;
    case 'Values':
      return `(table (vars ${op.variables.map(termText).join(' ')}) ${op.bindings.length} rows)`;
    case 'Service':
      return `(service ${op.silent ? 'silent ' : ''}${termText(op.name)}${sub(op.input)})`;
  }
};

/**
 * Creates an internal variable.
 *
 * @since 0.1.0
 * @category constructors
 */
export const internalVariable = (name: string): Term.Variable => Term.variable(`@${name}`);
