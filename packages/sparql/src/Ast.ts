/**
 * The abstract syntax tree of SPARQL 1.1 (and SPARQL 1.2) queries and
 * updates.
 *
 * The AST stays close to the surface syntax (group graph patterns, solution
 * modifiers, update operations) while using the core `Term` model for all
 * IRIs, literals, blank nodes, variables and triple terms. Abbreviated
 * syntax (prefixed names, `a`, blank node property lists, collections,
 * reifiers and annotations) is expanded by the parser, so every IRI in the
 * tree is absolute.
 *
 * All nodes are plain immutable objects discriminated by `_tag`; the
 * constructors in this module are the recommended way to build them.
 *
 * @since 0.1.0
 */
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Predicate from 'effect/Predicate';
import * as Match from 'effect/Match';

// -----------------------------------------------------------------------------
// Terms
// -----------------------------------------------------------------------------

/**
 * A term that may appear in a triple pattern: an IRI, literal, blank node,
 * variable or triple term (whose components may themselves be variables).
 *
 * @since 0.1.0
 * @category models
 */
export type TermPattern =
  | Term.NamedNode
  | Term.BlankNode
  | Term.Literal
  | Term.Variable
  | Term.Triple<any, any, any>;

/**
 * An IRI or a variable.
 *
 * @since 0.1.0
 * @category models
 */
export type VarOrIri = Term.NamedNode | Term.Variable;

// -----------------------------------------------------------------------------
// Property paths
// -----------------------------------------------------------------------------

/**
 * A property path expression (SPARQL 1.1 §9).
 *
 * A path consisting of a single IRI is represented as `PathLink`; triple
 * patterns whose predicate is a plain IRI use `TriplePattern` instead.
 *
 * @since 0.1.0
 * @category models
 */
export type Path =
  | PathLink
  | PathInverse
  | PathSequence
  | PathAlternative
  | PathZeroOrMore
  | PathOneOrMore
  | PathZeroOrOne
  | PathNegated;

/**
 * @since 0.1.0
 * @category models
 */
export interface PathLink {
  readonly _tag: 'PathLink';
  readonly iri: Term.NamedNode;
}

/**
 * `^path`
 *
 * @since 0.1.0
 * @category models
 */
export interface PathInverse {
  readonly _tag: 'PathInverse';
  readonly path: Path;
}

/**
 * `path1 / path2 / …`
 *
 * @since 0.1.0
 * @category models
 */
export interface PathSequence {
  readonly _tag: 'PathSequence';
  readonly paths: ReadonlyArray<Path>;
}

/**
 * `path1 | path2 | …`
 *
 * @since 0.1.0
 * @category models
 */
export interface PathAlternative {
  readonly _tag: 'PathAlternative';
  readonly paths: ReadonlyArray<Path>;
}

/**
 * `path*`
 *
 * @since 0.1.0
 * @category models
 */
export interface PathZeroOrMore {
  readonly _tag: 'PathZeroOrMore';
  readonly path: Path;
}

/**
 * `path+`
 *
 * @since 0.1.0
 * @category models
 */
export interface PathOneOrMore {
  readonly _tag: 'PathOneOrMore';
  readonly path: Path;
}

/**
 * `path?`
 *
 * @since 0.1.0
 * @category models
 */
export interface PathZeroOrOne {
  readonly _tag: 'PathZeroOrOne';
  readonly path: Path;
}

/**
 * A negated property set `!(iri1 | ^iri2 | …)`. `iris` are the forward
 * IRIs and `inverse` the IRIs written with `^`.
 *
 * @since 0.1.0
 * @category models
 */
export interface PathNegated {
  readonly _tag: 'PathNegated';
  readonly iris: ReadonlyArray<Term.NamedNode>;
  readonly inverse: ReadonlyArray<Term.NamedNode>;
}

/**
 * @since 0.1.0
 * @category guards
 */
export const isPath = (u: unknown): u is Path =>
  Predicate.hasProperty(u, '_tag') && Predicate.isString(u._tag) && u._tag.startsWith('Path');

// -----------------------------------------------------------------------------
// Triple and quad patterns
// -----------------------------------------------------------------------------

/**
 * A triple pattern whose predicate is an IRI or a variable.
 *
 * @since 0.1.0
 * @category models
 */
export interface TriplePattern {
  readonly _tag: 'TriplePattern';
  readonly subject: TermPattern;
  readonly predicate: VarOrIri;
  readonly object: TermPattern;
}

/**
 * A triple pattern whose predicate is a (non-trivial) property path.
 *
 * @since 0.1.0
 * @category models
 */
export interface PathPattern {
  readonly _tag: 'PathPattern';
  readonly subject: TermPattern;
  readonly path: Path;
  readonly object: TermPattern;
}

/**
 * A triple pattern within a graph: used by update templates (`INSERT`,
 * `DELETE`, `DELETE WHERE`). `graph` is the default graph for triples
 * outside of a `GRAPH` block.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuadPattern {
  readonly _tag: 'QuadPattern';
  readonly subject: TermPattern;
  readonly predicate: VarOrIri;
  readonly object: TermPattern;
  readonly graph: Term.NamedNode | Term.Variable | Term.DefaultGraph;
}

// -----------------------------------------------------------------------------
// Expressions
// -----------------------------------------------------------------------------

/**
 * The built-in operators and functions of SPARQL 1.1 and 1.2, in their
 * canonical (upper case) spelling. Unary plus and minus are `UPLUS` and
 * `UMINUS`; `IN` and `NOT IN` take the tested expression as their first
 * argument.
 *
 * @since 0.1.0
 * @category models
 */
export type Operator =
  | '||'
  | '&&'
  | '!'
  | '='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | 'UPLUS'
  | 'UMINUS'
  | 'IN'
  | 'NOT IN'
  | BuiltInName;

/**
 * Names of the built-in function calls (`BuiltInCall` in the grammar,
 * excluding aggregates and `EXISTS`).
 *
 * @since 0.1.0
 * @category models
 */
export type BuiltInName =
  | 'STR'
  | 'LANG'
  | 'LANGMATCHES'
  | 'LANGDIR'
  | 'DATATYPE'
  | 'BOUND'
  | 'IRI'
  | 'URI'
  | 'BNODE'
  | 'RAND'
  | 'ABS'
  | 'CEIL'
  | 'FLOOR'
  | 'ROUND'
  | 'CONCAT'
  | 'SUBSTR'
  | 'STRLEN'
  | 'REPLACE'
  | 'UCASE'
  | 'LCASE'
  | 'ENCODE_FOR_URI'
  | 'CONTAINS'
  | 'STRSTARTS'
  | 'STRENDS'
  | 'STRBEFORE'
  | 'STRAFTER'
  | 'YEAR'
  | 'MONTH'
  | 'DAY'
  | 'HOURS'
  | 'MINUTES'
  | 'SECONDS'
  | 'TIMEZONE'
  | 'TZ'
  | 'NOW'
  | 'UUID'
  | 'STRUUID'
  | 'MD5'
  | 'SHA1'
  | 'SHA256'
  | 'SHA384'
  | 'SHA512'
  | 'COALESCE'
  | 'IF'
  | 'STRLANG'
  | 'STRLANGDIR'
  | 'STRDT'
  | 'SAMETERM'
  | 'ISIRI'
  | 'ISURI'
  | 'ISBLANK'
  | 'ISLITERAL'
  | 'ISNUMERIC'
  | 'HASLANG'
  | 'HASLANGDIR'
  | 'REGEX'
  | 'ISTRIPLE'
  | 'TRIPLE'
  | 'SUBJECT'
  | 'PREDICATE'
  | 'OBJECT';

/**
 * Arity of each built-in function: `[min, max]` (`max` = `Infinity` for
 * variadic functions).
 *
 * @since 0.1.0
 * @category models
 */
export const builtInArity: Readonly<Record<BuiltInName, readonly [number, number]>> = {
  STR: [1, 1],
  LANG: [1, 1],
  LANGMATCHES: [2, 2],
  LANGDIR: [1, 1],
  DATATYPE: [1, 1],
  BOUND: [1, 1],
  IRI: [1, 1],
  URI: [1, 1],
  BNODE: [0, 1],
  RAND: [0, 0],
  ABS: [1, 1],
  CEIL: [1, 1],
  FLOOR: [1, 1],
  ROUND: [1, 1],
  CONCAT: [0, Infinity],
  SUBSTR: [2, 3],
  STRLEN: [1, 1],
  REPLACE: [3, 4],
  UCASE: [1, 1],
  LCASE: [1, 1],
  ENCODE_FOR_URI: [1, 1],
  CONTAINS: [2, 2],
  STRSTARTS: [2, 2],
  STRENDS: [2, 2],
  STRBEFORE: [2, 2],
  STRAFTER: [2, 2],
  YEAR: [1, 1],
  MONTH: [1, 1],
  DAY: [1, 1],
  HOURS: [1, 1],
  MINUTES: [1, 1],
  SECONDS: [1, 1],
  TIMEZONE: [1, 1],
  TZ: [1, 1],
  NOW: [0, 0],
  UUID: [0, 0],
  STRUUID: [0, 0],
  MD5: [1, 1],
  SHA1: [1, 1],
  SHA256: [1, 1],
  SHA384: [1, 1],
  SHA512: [1, 1],
  COALESCE: [0, Infinity],
  IF: [3, 3],
  STRLANG: [2, 2],
  STRLANGDIR: [3, 3],
  STRDT: [2, 2],
  SAMETERM: [2, 2],
  ISIRI: [1, 1],
  ISURI: [1, 1],
  ISBLANK: [1, 1],
  ISLITERAL: [1, 1],
  ISNUMERIC: [1, 1],
  HASLANG: [1, 1],
  HASLANGDIR: [1, 1],
  REGEX: [2, 3],
  ISTRIPLE: [1, 1],
  TRIPLE: [3, 3],
  SUBJECT: [1, 1],
  PREDICATE: [1, 1],
  OBJECT: [1, 1],
};

/**
 * Whether a (case-insensitive) name is a built-in function.
 *
 * @since 0.1.0
 * @category guards
 */
export const isBuiltInName = (name: string): name is BuiltInName =>
  Object.prototype.hasOwnProperty.call(builtInArity, name.toUpperCase());

/**
 * A SPARQL expression. Variables and constant terms are expressions as-is.
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
  | AggregateExpression
  | ExistsExpression;

/**
 * An operator or built-in function application.
 *
 * @since 0.1.0
 * @category models
 */
export interface OperationExpression {
  readonly _tag: 'Operation';
  readonly operator: Operator;
  readonly args: ReadonlyArray<Expression>;
}

/**
 * A call to an extension function (or a cast such as `xsd:integer(?x)`)
 * identified by IRI.
 *
 * @since 0.1.0
 * @category models
 */
export interface FunctionCallExpression {
  readonly _tag: 'FunctionCall';
  readonly function: Term.NamedNode;
  readonly args: ReadonlyArray<Expression>;
  /** `DISTINCT` was given (only meaningful for custom aggregates). */
  readonly distinct: boolean;
}

/**
 * @since 0.1.0
 * @category models
 */
export type AggregateName = 'COUNT' | 'SUM' | 'MIN' | 'MAX' | 'AVG' | 'SAMPLE' | 'GROUP_CONCAT';

/**
 * An aggregate. `expression` is `'*'` for `COUNT(*)`.
 *
 * @since 0.1.0
 * @category models
 */
export interface AggregateExpression {
  readonly _tag: 'Aggregate';
  readonly name: AggregateName;
  readonly distinct: boolean;
  readonly expression: Expression | '*';
  /** The `SEPARATOR` of `GROUP_CONCAT` (defaults to a single space). */
  readonly separator?: string | undefined;
}

/**
 * `EXISTS { … }` / `NOT EXISTS { … }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ExistsExpression {
  readonly _tag: 'Exists';
  readonly negated: boolean;
  readonly pattern: GroupPattern;
}

// -----------------------------------------------------------------------------
// Graph patterns
// -----------------------------------------------------------------------------

/**
 * An element of a group graph pattern.
 *
 * @since 0.1.0
 * @category models
 */
export type Pattern =
  | BgpPattern
  | GroupPattern
  | OptionalPattern
  | UnionPattern
  | MinusPattern
  | GraphPattern
  | ServicePattern
  | FilterPattern
  | BindPattern
  | ValuesPattern
  | SubSelectPattern;

/**
 * A block of triple patterns (`TriplesBlock`).
 *
 * @since 0.1.0
 * @category models
 */
export interface BgpPattern {
  readonly _tag: 'Bgp';
  readonly triples: ReadonlyArray<TriplePattern | PathPattern>;
}

/**
 * A group graph pattern `{ … }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface GroupPattern {
  readonly _tag: 'Group';
  readonly patterns: ReadonlyArray<Pattern>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface OptionalPattern {
  readonly _tag: 'Optional';
  readonly pattern: GroupPattern;
}

/**
 * `{ … } UNION { … } UNION …`
 *
 * @since 0.1.0
 * @category models
 */
export interface UnionPattern {
  readonly _tag: 'Union';
  readonly patterns: ReadonlyArray<GroupPattern>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface MinusPattern {
  readonly _tag: 'Minus';
  readonly pattern: GroupPattern;
}

/**
 * `GRAPH ?g { … }`
 *
 * @since 0.1.0
 * @category models
 */
export interface GraphPattern {
  readonly _tag: 'Graph';
  readonly name: VarOrIri;
  readonly pattern: GroupPattern;
}

/**
 * `SERVICE [SILENT] <endpoint> { … }`
 *
 * @since 0.1.0
 * @category models
 */
export interface ServicePattern {
  readonly _tag: 'Service';
  readonly name: VarOrIri;
  readonly silent: boolean;
  readonly pattern: GroupPattern;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface FilterPattern {
  readonly _tag: 'Filter';
  readonly expression: Expression;
}

/**
 * `BIND (expr AS ?var)`
 *
 * @since 0.1.0
 * @category models
 */
export interface BindPattern {
  readonly _tag: 'Bind';
  readonly expression: Expression;
  readonly variable: Term.Variable;
}

/**
 * Inline data. Each row has one entry per variable; `undefined` is `UNDEF`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ValuesPattern {
  readonly _tag: 'Values';
  readonly variables: ReadonlyArray<Term.Variable>;
  readonly rows: ReadonlyArray<ReadonlyArray<Term.GroundTerm | undefined>>;
}

/**
 * A nested `SELECT` query.
 *
 * @since 0.1.0
 * @category models
 */
export interface SubSelectPattern {
  readonly _tag: 'SubSelect';
  readonly query: SelectQuery;
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

/**
 * The prologue of a query or update: the declared base IRI, prefixes and
 * version. Declarations are kept for pretty printing only; the parser has
 * already expanded all IRIs.
 *
 * @since 0.1.0
 * @category models
 */
export interface Prologue {
  readonly base?: string | undefined;
  readonly prefixes: Readonly<Record<string, string>>;
  readonly version?: string | undefined;
}

/**
 * `FROM` and `FROM NAMED` (or `USING` / `USING NAMED`) clauses.
 *
 * @since 0.1.0
 * @category models
 */
export interface DatasetClause {
  readonly default: ReadonlyArray<Term.NamedNode>;
  readonly named: ReadonlyArray<Term.NamedNode>;
}

/**
 * A `GROUP BY` condition, optionally bound to a variable with `AS`.
 *
 * @since 0.1.0
 * @category models
 */
export interface GroupCondition {
  readonly expression: Expression;
  readonly variable?: Term.Variable | undefined;
}

/**
 * An `ORDER BY` condition.
 *
 * @since 0.1.0
 * @category models
 */
export interface OrderCondition {
  readonly expression: Expression;
  readonly descending: boolean;
}

/**
 * A projected `(expression AS ?variable)`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Projection {
  readonly _tag: 'Projection';
  readonly expression: Expression;
  readonly variable: Term.Variable;
}

/**
 * Fields shared by all query forms.
 *
 * @since 0.1.0
 * @category models
 */
export interface QueryBase {
  readonly prologue: Prologue;
  readonly dataset?: DatasetClause | undefined;
  readonly where: GroupPattern;
  readonly groupBy: ReadonlyArray<GroupCondition>;
  readonly having: ReadonlyArray<Expression>;
  readonly orderBy: ReadonlyArray<OrderCondition>;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** A trailing `VALUES` clause. */
  readonly values?: ValuesPattern | undefined;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface SelectQuery extends QueryBase {
  readonly _tag: 'Select';
  readonly distinct: boolean;
  readonly reduced: boolean;
  readonly projection: '*' | ReadonlyArray<Term.Variable | Projection>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface ConstructQuery extends QueryBase {
  readonly _tag: 'Construct';
  readonly template: ReadonlyArray<TriplePattern>;
  /** Whether the short form `CONSTRUCT WHERE { … }` was used. */
  readonly short?: boolean | undefined;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface AskQuery extends QueryBase {
  readonly _tag: 'Ask';
}

/**
 * @since 0.1.0
 * @category models
 */
export interface DescribeQuery extends QueryBase {
  readonly _tag: 'Describe';
  readonly terms: '*' | ReadonlyArray<VarOrIri>;
}

/**
 * Any query.
 *
 * @since 0.1.0
 * @category models
 */
export type Query = SelectQuery | ConstructQuery | AskQuery | DescribeQuery;

// -----------------------------------------------------------------------------
// Updates
// -----------------------------------------------------------------------------

/**
 * The target of `CLEAR` / `DROP`.
 *
 * @since 0.1.0
 * @category models
 */
export type GraphTarget =
  | Term.NamedNode
  | { readonly _tag: 'Default' }
  | { readonly _tag: 'Named' }
  | { readonly _tag: 'All' };

/**
 * A graph or the default graph (`ADD`, `MOVE`, `COPY`).
 *
 * @since 0.1.0
 * @category models
 */
export type GraphOrDefault = Term.NamedNode | Term.DefaultGraph;

/**
 * @since 0.1.0
 * @category models
 */
export interface InsertDataOperation {
  readonly _tag: 'InsertData';
  readonly quads: ReadonlyArray<Term.Quad>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface DeleteDataOperation {
  readonly _tag: 'DeleteData';
  readonly quads: ReadonlyArray<Term.Quad>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface DeleteWhereOperation {
  readonly _tag: 'DeleteWhere';
  readonly patterns: ReadonlyArray<QuadPattern>;
}

/**
 * `[WITH <g>] DELETE { … } INSERT { … } [USING …] WHERE { … }`
 *
 * @since 0.1.0
 * @category models
 */
export interface ModifyOperation {
  readonly _tag: 'Modify';
  readonly with?: Term.NamedNode | undefined;
  readonly delete: ReadonlyArray<QuadPattern>;
  readonly insert: ReadonlyArray<QuadPattern>;
  readonly using?: DatasetClause | undefined;
  readonly where: GroupPattern;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface LoadOperation {
  readonly _tag: 'Load';
  readonly silent: boolean;
  readonly source: Term.NamedNode;
  readonly destination?: Term.NamedNode | undefined;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface ClearOperation {
  readonly _tag: 'Clear';
  readonly silent: boolean;
  readonly target: GraphTarget;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface DropOperation {
  readonly _tag: 'Drop';
  readonly silent: boolean;
  readonly target: GraphTarget;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface CreateOperation {
  readonly _tag: 'Create';
  readonly silent: boolean;
  readonly graph: Term.NamedNode;
}

/**
 * `ADD`, `MOVE` and `COPY`.
 *
 * @since 0.1.0
 * @category models
 */
export interface TransferOperation {
  readonly _tag: 'Add' | 'Move' | 'Copy';
  readonly silent: boolean;
  readonly source: GraphOrDefault;
  readonly destination: GraphOrDefault;
}

/**
 * A single update operation.
 *
 * @since 0.1.0
 * @category models
 */
export type UpdateOperation =
  | InsertDataOperation
  | DeleteDataOperation
  | DeleteWhereOperation
  | ModifyOperation
  | LoadOperation
  | ClearOperation
  | DropOperation
  | CreateOperation
  | TransferOperation;

/**
 * An update request: a sequence of operations.
 *
 * @since 0.1.0
 * @category models
 */
export interface Update {
  readonly _tag: 'Update';
  readonly prologue: Prologue;
  readonly operations: ReadonlyArray<UpdateOperation>;
}

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category guards
 */
export const isQuery = (u: unknown): u is Query =>
  Predicate.hasProperty(u, '_tag') &&
  (u._tag === 'Select' || u._tag === 'Construct' || u._tag === 'Ask' || u._tag === 'Describe');

/**
 * @since 0.1.0
 * @category guards
 */
export const isUpdate = (u: unknown): u is Update => Predicate.isTagged(u, 'Update');

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category constructors
 */
export const emptyPrologue: Prologue = { prefixes: {} };

/**
 * @since 0.1.0
 * @category constructors
 */
export const triplePattern = (
  subject: TermPattern,
  predicate: VarOrIri,
  object: TermPattern,
): TriplePattern => ({ _tag: 'TriplePattern', subject, predicate, object });

/**
 * @since 0.1.0
 * @category constructors
 */
export const pathPattern = (
  subject: TermPattern,
  path: Path,
  object: TermPattern,
): PathPattern => ({
  _tag: 'PathPattern',
  subject,
  path,
  object,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const quadPattern = (
  subject: TermPattern,
  predicate: VarOrIri,
  object: TermPattern,
  graph: Term.NamedNode | Term.Variable | Term.DefaultGraph = Term.defaultGraph,
): QuadPattern => ({ _tag: 'QuadPattern', subject, predicate, object, graph });

/**
 * @since 0.1.0
 * @category constructors
 */
export const link = (iri: Term.NamedNode): PathLink => ({ _tag: 'PathLink', iri });

/**
 * @since 0.1.0
 * @category constructors
 */
export const inverse = (path: Path): PathInverse => ({ _tag: 'PathInverse', path });

/**
 * @since 0.1.0
 * @category constructors
 */
export const sequence = (...paths: ReadonlyArray<Path>): PathSequence => ({
  _tag: 'PathSequence',
  paths,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const alternative = (...paths: ReadonlyArray<Path>): PathAlternative => ({
  _tag: 'PathAlternative',
  paths,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const zeroOrMore = (path: Path): PathZeroOrMore => ({ _tag: 'PathZeroOrMore', path });

/**
 * @since 0.1.0
 * @category constructors
 */
export const oneOrMore = (path: Path): PathOneOrMore => ({ _tag: 'PathOneOrMore', path });

/**
 * @since 0.1.0
 * @category constructors
 */
export const zeroOrOne = (path: Path): PathZeroOrOne => ({ _tag: 'PathZeroOrOne', path });

/**
 * @since 0.1.0
 * @category constructors
 */
export const negated = (
  iris: ReadonlyArray<Term.NamedNode>,
  inverse: ReadonlyArray<Term.NamedNode> = [],
): PathNegated => ({ _tag: 'PathNegated', iris, inverse });

/**
 * @since 0.1.0
 * @category constructors
 */
export const operation = (
  operator: Operator,
  ...args: ReadonlyArray<Expression>
): OperationExpression => ({ _tag: 'Operation', operator, args });

/**
 * @since 0.1.0
 * @category constructors
 */
export const functionCall = (
  fn: Term.NamedNode,
  args: ReadonlyArray<Expression>,
  distinct = false,
): FunctionCallExpression => ({ _tag: 'FunctionCall', function: fn, args, distinct });

/**
 * @since 0.1.0
 * @category constructors
 */
export const aggregate = (
  name: AggregateName,
  expression: Expression | '*',
  options?: { readonly distinct?: boolean; readonly separator?: string },
): AggregateExpression => {
  const aggregate: AggregateExpression = {
    _tag: 'Aggregate',
    name,
    expression,
    distinct: options?.distinct ?? false,
  };
  return options?.separator === undefined
    ? aggregate
    : { ...aggregate, separator: options.separator };
};

/**
 * @since 0.1.0
 * @category constructors
 */
export const exists = (pattern: GroupPattern, negated = false): ExistsExpression => ({
  _tag: 'Exists',
  negated,
  pattern,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const bgp = (triples: ReadonlyArray<TriplePattern | PathPattern>): BgpPattern => ({
  _tag: 'Bgp',
  triples,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const group = (patterns: ReadonlyArray<Pattern>): GroupPattern => ({
  _tag: 'Group',
  patterns,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const optional = (pattern: GroupPattern): OptionalPattern => ({ _tag: 'Optional', pattern });

/**
 * @since 0.1.0
 * @category constructors
 */
export const union = (patterns: ReadonlyArray<GroupPattern>): UnionPattern => ({
  _tag: 'Union',
  patterns,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const minus = (pattern: GroupPattern): MinusPattern => ({ _tag: 'Minus', pattern });

/**
 * @since 0.1.0
 * @category constructors
 */
export const graph = (name: VarOrIri, pattern: GroupPattern): GraphPattern => ({
  _tag: 'Graph',
  name,
  pattern,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const service = (name: VarOrIri, pattern: GroupPattern, silent = false): ServicePattern => ({
  _tag: 'Service',
  name,
  pattern,
  silent,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const filter = (expression: Expression): FilterPattern => ({ _tag: 'Filter', expression });

/**
 * @since 0.1.0
 * @category constructors
 */
export const bind = (expression: Expression, variable: Term.Variable): BindPattern => ({
  _tag: 'Bind',
  expression,
  variable,
});

/**
 * @since 0.1.0
 * @category constructors
 */
export const values = (
  variables: ReadonlyArray<Term.Variable>,
  rows: ReadonlyArray<ReadonlyArray<Term.GroundTerm | undefined>>,
): ValuesPattern => ({ _tag: 'Values', variables, rows });

/**
 * @since 0.1.0
 * @category constructors
 */
export const subSelect = (query: SelectQuery): SubSelectPattern => ({ _tag: 'SubSelect', query });

/**
 * A projected `(expression AS ?variable)`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const projection = (expression: Expression, variable: Term.Variable): Projection => ({
  _tag: 'Projection',
  expression,
  variable,
});

const queryDefaults = {
  prologue: emptyPrologue,
  groupBy: [],
  having: [],
  orderBy: [],
} as const;

/**
 * Creates a `SELECT` query; omitted fields take their defaults.
 *
 * @since 0.1.0
 * @category constructors
 */
export const select = (
  fields: Partial<Omit<SelectQuery, '_tag'>> & Pick<SelectQuery, 'where'>,
): SelectQuery => ({
  _tag: 'Select',
  ...queryDefaults,
  distinct: false,
  reduced: false,
  projection: '*',
  ...fields,
});

/**
 * Creates a `CONSTRUCT` query.
 *
 * @since 0.1.0
 * @category constructors
 */
export const construct = (
  fields: Partial<Omit<ConstructQuery, '_tag'>> & Pick<ConstructQuery, 'where' | 'template'>,
): ConstructQuery => ({ _tag: 'Construct', ...queryDefaults, ...fields });

/**
 * Creates an `ASK` query.
 *
 * @since 0.1.0
 * @category constructors
 */
export const ask = (
  fields: Partial<Omit<AskQuery, '_tag'>> & Pick<AskQuery, 'where'>,
): AskQuery => ({ _tag: 'Ask', ...queryDefaults, ...fields });

/**
 * Creates a `DESCRIBE` query.
 *
 * @since 0.1.0
 * @category constructors
 */
export const describe = (
  fields: Partial<Omit<DescribeQuery, '_tag'>> & Pick<DescribeQuery, 'terms'>,
): DescribeQuery => ({ _tag: 'Describe', ...queryDefaults, where: group([]), ...fields });

/**
 * Creates an update request.
 *
 * @since 0.1.0
 * @category constructors
 */
export const update = (
  operations: ReadonlyArray<UpdateOperation>,
  prologue: Prologue = emptyPrologue,
): Update => ({ _tag: 'Update', prologue, operations });

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

const addTermVariables = (term: TermPattern | Term.Term, out: Set<string>): void => {
  if (term._tag === 'Variable') out.add(term.value);
  else if (term._tag === 'Triple') {
    addTermVariables(term.subject, out);
    addTermVariables(term.predicate, out);
    addTermVariables(term.object, out);
  }
};

/**
 * The variables that are in-scope after a graph pattern (SPARQL 1.1 §18.2.1),
 * in order of first appearance. Blank nodes are not included.
 *
 * @since 0.1.0
 * @category utils
 */
export const inScopeVariables = (pattern: Pattern): ReadonlyArray<string> => {
  const out = new Set<string>();
  collectInScope(pattern, out);
  return Array.from(out);
};

const collectInScope = (pattern: Pattern, out: Set<string>): void => {
  Match.value(pattern).pipe(
    Match.tag('Bgp', (b) => {
      for (const t of b.triples) {
        addTermVariables(t.subject, out);
        if (t._tag === 'TriplePattern') addTermVariables(t.predicate, out);
        addTermVariables(t.object, out);
      }
    }),
    Match.tag('Group', 'Union', (g) => {
      for (const p of g.patterns) collectInScope(p, out);
    }),
    Match.tag('Optional', (o) => collectInScope(o.pattern, out)),
    Match.tag('Minus', 'Filter', () => undefined),
    Match.tag('Graph', 'Service', (g) => {
      addTermVariables(g.name, out);
      collectInScope(g.pattern, out);
    }),
    Match.tag('Bind', (b) => {
      out.add(b.variable.value);
    }),
    Match.tag('Values', (v) => {
      for (const x of v.variables) out.add(x.value);
    }),
    Match.tag('SubSelect', (s) => {
      for (const v of projectedVariables(s.query)) out.add(v);
    }),
    Match.exhaustive,
  );
};

/**
 * The variables projected by a `SELECT` query (for `SELECT *`, the
 * in-scope variables of its pattern and trailing `VALUES`).
 *
 * @since 0.1.0
 * @category utils
 */
export const projectedVariables = (query: SelectQuery): ReadonlyArray<string> => {
  if (query.projection === '*') {
    const out = new Set<string>();
    collectInScope(query.where, out);
    if (query.values !== undefined) for (const v of query.values.variables) out.add(v.value);
    return Array.from(out);
  }
  return query.projection.map((p) => (p._tag === 'Variable' ? p.value : p.variable.value));
};

/**
 * All variables mentioned anywhere in an expression (including inside
 * `EXISTS` patterns when `deep` is set).
 *
 * @since 0.1.0
 * @category utils
 */
export const expressionVariables = (
  expression: Expression,
  deep = false,
): ReadonlyArray<string> => {
  const out = new Set<string>();
  const go = (e: Expression): void => {
    Match.value(e).pipe(
      Match.tag('Variable', 'Triple', (t) => addTermVariables(t, out)),
      Match.tag('Operation', 'FunctionCall', (call) => call.args.forEach(go)),
      Match.tag('Aggregate', (a) => {
        if (a.expression !== '*') go(a.expression);
      }),
      Match.tag('Exists', (x) => {
        if (deep) collectInScope(x.pattern, out);
      }),
      Match.orElse(() => undefined),
    );
  };
  go(expression);
  return Array.from(out);
};

/**
 * Whether an expression contains an aggregate (outside of nested `EXISTS`
 * patterns).
 *
 * @since 0.1.0
 * @category utils
 */
export const containsAggregate = (expression: Expression): boolean => {
  return Match.value(expression).pipe(
    Match.tag('Aggregate', () => true),
    Match.tag('Operation', 'FunctionCall', (call) => call.args.some(containsAggregate)),
    Match.orElse(() => false),
  );
};
