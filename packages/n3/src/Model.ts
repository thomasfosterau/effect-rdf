/**
 * The Notation3 data model.
 *
 * N3 extends RDF with quoted graphs (formulas), first-class lists
 * (collections), universally quantified variables and literals or other
 * non-IRI terms in any position of a statement. Core RDF `Quad`s only allow
 * ground terms, so this module defines an N3-specific model on top of the
 * core term classes:
 *
 * - `N3Term` = core `NamedNode` | `BlankNode` | `Literal` | `Variable`, plus
 *   the N3-only `Collection` (an N3 list) and `Formula` (a graph term).
 * - `Statement` — a triple of arbitrary `N3Term`s.
 * - `Formula` — an unordered set of statements. Formulas are values: two
 *   formulas with the same statements are equal (`Equal.equals`), which
 *   matches the N3 semantics of graph terms.
 * - `Document` — a parsed N3 document: its top-level formula together with
 *   the prefixes and base IRI it declared.
 *
 * Quick variables (`?x`) are represented by core `Term.Variable`s. Blank
 * nodes keep their core representation; a blank node is implicitly
 * existentially quantified in the innermost formula that contains all of its
 * occurrences.
 *
 * Like core terms, `Collection`, `Formula` and `Statement` implement `Equal`
 * and `Hash` through a canonical `key`.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Equal from 'effect/Equal';
import * as Hash from 'effect/Hash';
import { NodeInspectSymbol } from 'effect/Inspectable';
import { pipeArguments, type Pipeable } from 'effect/Pipeable';
import * as Order from 'effect/Order';
import { hasProperty } from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Term from '@thomasfosterau/effect-rdf/Term';

/**
 * @since 0.1.0
 * @category symbols
 */
export const TypeId: unique symbol = Symbol.for('@thomasfosterau/effect-n3/Model');

/**
 * @since 0.1.0
 * @category symbols
 */
export type TypeId = typeof TypeId;

abstract class N3Base implements Equal.Equal, Pipeable {
  readonly [TypeId]: TypeId = TypeId;
  abstract readonly _tag: string;
  #key: string | undefined;
  #hash: number | undefined;

  /** A canonical, N3-like serialisation used for equality and hashing. */
  get key(): string {
    return (this.#key ??= this.computeKey());
  }

  protected abstract computeKey(): string;

  /** RDF/JS-style alias of `_tag`. */
  get termType(): this['_tag'] {
    return this._tag;
  }

  equals(that: unknown): boolean {
    return hasProperty(that, TypeId) && (that as N3Base).key === this.key;
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return this.equals(that);
  }

  [Hash.symbol](): number {
    return (this.#hash ??= Hash.string(this.key));
  }

  pipe() {
    return pipeArguments(this, arguments);
  }

  toString(): string {
    return this.key;
  }

  toJSON(): unknown {
    return { _tag: this._tag, value: this.key };
  }

  [NodeInspectSymbol](): string {
    return `${this._tag}(${this.key})`;
  }
}

/**
 * An N3 list (collection): an ordered, first-class sequence of terms,
 * written `( a b c )`. The empty collection corresponds to `rdf:nil`.
 *
 * @since 0.1.0
 * @category models
 */
export class Collection extends N3Base {
  readonly _tag = 'Collection' as const;
  readonly items: ReadonlyArray<N3Term>;
  constructor(items: ReadonlyArray<N3Term>) {
    super();
    this.items = items;
  }
  protected computeKey(): string {
    return this.items.length === 0 ? '()' : `( ${this.items.map((t) => t.key).join(' ')} )`;
  }
}

/**
 * An N3 statement: a triple whose subject, predicate and object may be any
 * `N3Term`.
 *
 * @since 0.1.0
 * @category models
 */
export class Statement<
  out S extends N3Term = N3Term,
  out P extends N3Term = N3Term,
  out O extends N3Term = N3Term,
> extends N3Base {
  readonly _tag = 'Statement' as const;
  readonly subject: S;
  readonly predicate: P;
  readonly object: O;
  constructor(subject: S, predicate: P, object: O) {
    super();
    this.subject = subject;
    this.predicate = predicate;
    this.object = object;
  }
  protected computeKey(): string {
    return `${this.subject.key} ${this.predicate.key} ${this.object.key}`;
  }
}

/**
 * An N3 formula (graph term): an unordered set of statements, written
 * `{ ... }`. Duplicate statements are removed on construction, and equality
 * is set equality of the statements (blank node labels are compared
 * literally; use `Isomorphism.isomorphic` for a blank-node-aware comparison).
 *
 * @since 0.1.0
 * @category models
 */
export class Formula extends N3Base {
  readonly _tag = 'Formula' as const;
  readonly statements: ReadonlyArray<Statement>;
  constructor(statements: Iterable<Statement>) {
    super();
    const seen = new Set<string>();
    const unique: Array<Statement> = [];
    for (const s of statements) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      unique.push(s);
    }
    this.statements = unique;
  }
  /** The number of statements in the formula. */
  get size(): number {
    return this.statements.length;
  }
  protected computeKey(): string {
    if (this.statements.length === 0) return '{}';
    const keys = Arr.sort(
      this.statements.map((s) => s.key),
      Order.String,
    );
    return `{ ${keys.join(' . ')} }`;
  }
  [Symbol.iterator](): Iterator<Statement> {
    return this.statements[Symbol.iterator]();
  }
}

/**
 * Any term that may appear in an N3 statement.
 *
 * @since 0.1.0
 * @category models
 */
export type N3Term =
  | Term.NamedNode
  | Term.BlankNode
  | Term.Literal
  | Term.Variable
  | Collection
  | Formula;

/**
 * A parsed N3 document.
 *
 * @since 0.1.0
 * @category models
 */
export interface Document {
  /** The top-level formula: every statement asserted by the document. */
  readonly formula: Formula;
  /** The prefixes declared by the document (in declaration order). */
  readonly prefixes: PrefixMap.PrefixMap;
  /** The final in-scope base IRI of the document, if any. */
  readonly baseIri: string | undefined;
}

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category constructors
 */
export const statement = <S extends N3Term, P extends N3Term, O extends N3Term>(
  subject: S,
  predicate: P,
  object: O,
): Statement<S, P, O> => new Statement(subject, predicate, object);

/**
 * @since 0.1.0
 * @category constructors
 */
export const formula = (statements: Iterable<Statement> = []): Formula => new Formula(statements);

/**
 * The empty formula `{}`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const emptyFormula: Formula = new Formula([]);

/**
 * @since 0.1.0
 * @category constructors
 */
export const collection = (items: Iterable<N3Term> = []): Collection =>
  new Collection(Array.from(items));

/**
 * Creates a document from a formula.
 *
 * @since 0.1.0
 * @category constructors
 */
export const document = (
  formula: Formula,
  options?: { readonly prefixes?: PrefixMap.PrefixMap; readonly baseIri?: string | undefined },
): Document => ({
  formula,
  prefixes: options?.prefixes ?? PrefixMap.empty,
  baseIri: options?.baseIri,
});

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category guards
 */
export const isFormula = (u: unknown): u is Formula => u instanceof Formula;

/**
 * @since 0.1.0
 * @category guards
 */
export const isCollection = (u: unknown): u is Collection => u instanceof Collection;

/**
 * @since 0.1.0
 * @category guards
 */
export const isStatement = (u: unknown): u is Statement => u instanceof Statement;

/**
 * Whether a value is an `N3Term` (a core IRI, blank node, literal or
 * variable, or an N3 collection or formula).
 *
 * @since 0.1.0
 * @category guards
 */
export const isN3Term = (u: unknown): u is N3Term =>
  isFormula(u) ||
  isCollection(u) ||
  Term.isNamedNode(u) ||
  Term.isBlankNode(u) ||
  Term.isLiteral(u) ||
  Term.isVariable(u);

// -----------------------------------------------------------------------------
// Inspection
// -----------------------------------------------------------------------------

/**
 * Whether a term, statement or formula is free of variables (recursively).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isGround = (self: N3Term | Statement): boolean => {
  switch (self._tag) {
    case 'Variable':
      return false;
    case 'Collection':
      return self.items.every(isGround);
    case 'Formula':
      return self.statements.every(isGround);
    case 'Statement':
      return isGround(self.subject) && isGround(self.predicate) && isGround(self.object);
    default:
      return true;
  }
};

const collect = (
  self: N3Term | Statement,
  test: (t: N3Term) => boolean,
  out: Map<string, N3Term>,
): void => {
  switch (self._tag) {
    case 'Collection':
      for (const i of self.items) collect(i, test, out);
      return;
    case 'Formula':
      for (const s of self.statements) collect(s, test, out);
      return;
    case 'Statement':
      collect(self.subject, test, out);
      collect(self.predicate, test, out);
      collect(self.object, test, out);
      return;
    default:
      if (test(self)) out.set(self.key, self);
  }
};

/**
 * All distinct variables occurring in a term, statement or formula
 * (including inside nested formulas and collections), in order of first
 * occurrence.
 *
 * @since 0.1.0
 * @category getters
 */
export const variables = (self: N3Term | Statement): ReadonlyArray<Term.Variable> => {
  const out = new Map<string, N3Term>();
  collect(self, Term.isVariable, out);
  return Array.from(out.values()) as Array<Term.Variable>;
};

/**
 * All distinct blank nodes occurring in a term, statement or formula
 * (including inside nested formulas and collections).
 *
 * @since 0.1.0
 * @category getters
 */
export const blankNodes = (self: N3Term | Statement): ReadonlyArray<Term.BlankNode> => {
  const out = new Map<string, N3Term>();
  collect(self, Term.isBlankNode, out);
  return Array.from(out.values()) as Array<Term.BlankNode>;
};

// -----------------------------------------------------------------------------
// Combinators
// -----------------------------------------------------------------------------

/**
 * Applies `f` to every atomic term (IRI, blank node, literal, variable),
 * recursing into collections, statements and nested formulas.
 *
 * @since 0.1.0
 * @category combinators
 */
export function mapTerms<T extends N3Term | Statement>(
  self: T,
  f: (term: Term.NamedNode | Term.BlankNode | Term.Literal | Term.Variable) => N3Term,
): T extends Statement ? Statement : T extends Formula ? Formula : N3Term;
export function mapTerms(
  self: N3Term | Statement,
  f: (term: Term.NamedNode | Term.BlankNode | Term.Literal | Term.Variable) => N3Term,
): N3Term | Statement {
  const go = (t: N3Term | Statement): N3Term | Statement => {
    switch (t._tag) {
      case 'Collection':
        return new Collection(t.items.map((i) => go(i) as N3Term));
      case 'Formula':
        return new Formula(t.statements.map((s) => go(s) as Statement));
      case 'Statement':
        return new Statement(
          go(t.subject) as N3Term,
          go(t.predicate) as N3Term,
          go(t.object) as N3Term,
        );
      default:
        return f(t);
    }
  };
  return go(self);
}

/**
 * Replaces variables by the terms bound to them (by variable name); unbound
 * variables are kept.
 *
 * @since 0.1.0
 * @category combinators
 */
export function substitute<T extends N3Term | Statement>(
  self: T,
  bindings: ReadonlyMap<string, N3Term>,
): T extends Statement ? Statement : T extends Formula ? Formula : N3Term;
export function substitute(
  self: N3Term | Statement,
  bindings: ReadonlyMap<string, N3Term>,
): N3Term | Statement {
  return mapTerms(self, (t) => (t._tag === 'Variable' ? (bindings.get(t.value) ?? t) : t));
}

/**
 * Adds statements to a formula.
 *
 * @since 0.1.0
 * @category combinators
 */
export const addStatements = (self: Formula, statements: Iterable<Statement>): Formula =>
  new Formula([...self.statements, ...statements]);

/**
 * Whether a formula contains a statement.
 *
 * @since 0.1.0
 * @category predicates
 */
export const hasStatement = (self: Formula, statement: Statement): boolean =>
  self.statements.some((s) => s.key === statement.key);

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category schemas
 */
export const FormulaSchema: Schema.declare<Formula> = Schema.declare(isFormula, {
  identifier: 'Formula',
});

/**
 * The value a `FormulaSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type FormulaSchema = typeof FormulaSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const CollectionSchema: Schema.declare<Collection> = Schema.declare(isCollection, {
  identifier: 'Collection',
});

/**
 * The value a `CollectionSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type CollectionSchema = typeof CollectionSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const StatementSchema: Schema.declare<Statement> = Schema.declare(isStatement, {
  identifier: 'Statement',
});

/**
 * The value a `StatementSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type StatementSchema = typeof StatementSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const N3TermSchema: Schema.declare<N3Term> = Schema.declare(isN3Term, {
  identifier: 'N3Term',
});

/**
 * The value a `N3TermSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type N3TermSchema = typeof N3TermSchema.Type;
