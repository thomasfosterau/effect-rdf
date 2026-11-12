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
import * as MutableHashMap from 'effect/MutableHashMap';
import { pipeArguments, type Pipeable } from 'effect/Pipeable';
import * as Order from 'effect/Order';
import { hasProperty } from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as PrefixMap from '../PrefixMap.ts';
import * as Term from '../Term.ts';
import * as Guards from './internal/guards.ts';
import { loop } from './internal/loop.ts';

/**
 * @since 0.1.0
 * @category symbols
 */
export const TypeId: unique symbol = Symbol.for('@thomasfosterau/effect-rdf/n3/Model');

/**
 * @since 0.1.0
 * @category symbols
 */
export type TypeId = typeof TypeId;

abstract class N3Base implements Equal.Equal, Pipeable {
  readonly [TypeId]: TypeId = TypeId;
  abstract readonly _tag: string;
  /** The key once computed (no key is empty: the shortest are `()` and `{}`). */
  #key = '';
  /** The hash once computed (0 until then; a hash of 0 is merely computed again). */
  #hash = 0;

  /** A canonical, N3-like serialisation used for equality and hashing. */
  get key(): string {
    if (this.#key === '') this.#key = this.computeKey();
    return this.#key;
  }

  protected abstract computeKey(): string;

  /**
   * Statements, collections and formulas override this to combine their
   * parts' hashes, so that a formula deduplicating its statements builds no
   * key; whatever the override, equal keys give equal hashes.
   */
  protected computeHash(): number {
    return Hash.string(this.key);
  }

  /** RDF/JS-style alias of `_tag`. */
  get termType(): this['_tag'] {
    return this._tag;
  }

  equals(that: unknown): boolean {
    return isN3Base(that) && that.key === this.key;
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return this.equals(that);
  }

  [Hash.symbol](): number {
    if (this.#hash === 0) this.#hash = this.computeHash();
    return this.#hash;
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

/** Whether a value is an N3 collection, statement or formula (it carries the `TypeId`). */
const isN3Base = (u: unknown): u is N3Base => hasProperty(u, TypeId);

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
  protected override computeHash(): number {
    return this.items.reduce((h, item) => Hash.combine(h, item[Hash.symbol]()), Hash.string('()'));
  }
  protected computeKey(): string {
    return Arr.isReadonlyArrayEmpty(this.items)
      ? '()'
      : `( ${this.items.map((t) => t.key).join(' ')} )`;
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
  protected override computeHash(): number {
    return Hash.combine(
      Hash.combine(this.subject[Hash.symbol](), this.predicate[Hash.symbol]()),
      this.object[Hash.symbol](),
    );
  }
  protected computeKey(): string {
    return `${this.subject.key} ${this.predicate.key} ${this.object.key}`;
  }
}

/**
 * Whether two terms are equal (have the same key), compared by their parts
 * where that avoids building keys: identical or differently hashed terms are
 * decided at once, and statements, collections and formulas are compared
 * part by part. Only leaf terms (IRIs, literals, blank nodes, variables) are
 * compared by key.
 */
const sameTerm = (a: N3Term, b: N3Term): boolean => {
  if (a === b) return true;
  if (a[Hash.symbol]() !== b[Hash.symbol]()) return false;
  if (a instanceof Formula) return b instanceof Formula && sameFormula(a, b);
  if (a instanceof Collection) {
    return (
      b instanceof Collection &&
      a.items.length === b.items.length &&
      a.items.every((item, i) => sameTerm(item, b.items[i] ?? item))
    );
  }
  if (b instanceof Formula || b instanceof Collection) return false;
  return a.key === b.key;
};

/** Whether two statements are equal: their terms are (`sameTerm`). */
const sameStatement = (a: Statement, b: Statement): boolean =>
  sameTerm(a.subject, b.subject) &&
  sameTerm(a.predicate, b.predicate) &&
  sameTerm(a.object, b.object);

/** Whether two formulas have the same statements (searched for small ones, by key otherwise). */
const sameFormula = (a: Formula, b: Formula): boolean => {
  const as = a.statements;
  const bs = b.statements;
  if (as.length !== bs.length) return false;
  if (as.length > 8) return a.key === b.key;
  return as.every((s) => bs.some((t) => sameStatement(s, t)));
};

/** A placeholder for the probe's statement before the first is placed. */
const emptyStatement: Statement = new Statement(
  Term.namedNode(''),
  Term.namedNode(''),
  Term.namedNode(''),
);

/**
 * The statements without duplicates, keeping the first of each: by their
 * structural hashes, comparing keys only when two hashes are equal, so that
 * no key is built for statements that differ.
 */
const deduplicate = (all: ReadonlyArray<Statement>): ReadonlyArray<Statement> => {
  const n = all.length;
  if (n < 2) return all;
  // Open addressing over a power-of-two table at most half full: each slot holds a statement's
  // hash and its position + 1 (0 when empty), probed linearly
  const mask = 2 ** Math.ceil(Math.log2(n * 2)) - 1;
  const hashes = new Int32Array(mask + 1);
  const slots = new Int32Array(mask + 1);
  const unique: Array<Statement> = [];
  // The probe of the statement being placed: one closure for the whole table
  let current: Statement = emptyStatement;
  let hash = 0;
  let i = 0;
  let duplicate = false;
  const probe = (): boolean => {
    const slot = slots[i] ?? 0;
    if (slot === 0) return false;
    if (hashes[i] === hash && sameStatement(current, all[slot - 1] ?? current)) {
      duplicate = true;
      return false;
    }
    i = (i + 1) & mask;
    return true;
  };
  all.forEach((s, k) => {
    current = s;
    hash = s[Hash.symbol]() | 0;
    i = hash & mask;
    duplicate = false;
    loop(probe);
    if (duplicate) return;
    hashes[i] = hash;
    slots[i] = k + 1;
    unique.push(s);
  });
  return unique.length === n ? all : unique;
};

/**
 * An N3 formula (graph term): an unordered set of statements, written
 * `{ ... }`. Duplicate statements are removed (when the statements are first
 * read), and equality is set equality of the statements (blank node labels are compared
 * literally; use `Isomorphism.isomorphic` for a blank-node-aware comparison).
 *
 * @since 0.1.0
 * @category models
 */
export class Formula extends N3Base {
  readonly _tag = 'Formula' as const;
  /** The statements as given (copied), then without duplicates once first read. */
  #statements: ReadonlyArray<Statement>;
  #deduplicated = false;
  constructor(statements: Iterable<Statement>) {
    super();
    this.#statements = Array.from(statements);
  }
  /**
   * The statements, without duplicates, in the order first given. They are
   * deduplicated the first time they are read, not when the formula is
   * made, so a formula that is never read (a parse whose result is only
   * checked for errors, a formula a rule discards) costs nothing to dedupe.
   */
  get statements(): ReadonlyArray<Statement> {
    if (!this.#deduplicated) {
      this.#statements = deduplicate(this.#statements);
      this.#deduplicated = true;
    }
    return this.#statements;
  }
  /** The sum of the statements' hashes: the same for the same set, whatever the order. */
  protected override computeHash(): number {
    return Hash.optimize(this.statements.reduce((h, st) => (h + st[Hash.symbol]()) | 0, 0x7b7d));
  }
  /** The number of statements in the formula. */
  get size(): number {
    // Fewer than two statements cannot hold a duplicate
    return this.#statements.length < 2 ? this.#statements.length : this.statements.length;
  }
  protected computeKey(): string {
    if (Arr.isReadonlyArrayEmpty(this.statements)) return '{}';
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
  root: Formula,
  options?: { readonly prefixes?: PrefixMap.PrefixMap; readonly baseIri?: string | undefined },
): Document => ({
  formula: root,
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
export const isGround = (self: N3Term | Statement): boolean => groundness(self);

// Plain refinements rather than `Match`: `isGround` runs for every term it visits.
const groundness = (self: N3Term | Statement): boolean =>
  self instanceof Statement
    ? groundness(self.subject) && groundness(self.predicate) && groundness(self.object)
    : self instanceof Formula
      ? self.statements.every(groundness)
      : self instanceof Collection
        ? self.items.every(groundness)
        : !Guards.isVariable(self);

/** Adds the atoms of `self` that pass `test` to `out`, by key, in order of first occurrence. */
const collect = <A extends N3Term>(
  self: N3Term | Statement,
  test: (t: N3Term) => t is A,
  out: MutableHashMap.MutableHashMap<string, A>,
): void => {
  if (self instanceof Statement) {
    collect(self.subject, test, out);
    collect(self.predicate, test, out);
    collect(self.object, test, out);
  } else if (self instanceof Formula) {
    self.statements.forEach((s) => collect(s, test, out));
  } else if (self instanceof Collection) {
    self.items.forEach((i) => collect(i, test, out));
  } else if (test(self)) {
    MutableHashMap.set(out, self.key, self);
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
  const out = MutableHashMap.empty<string, Term.Variable>();
  collect(self, Guards.isVariable, out);
  return Arr.fromIterable(MutableHashMap.values(out));
};

/**
 * All distinct blank nodes occurring in a term, statement or formula
 * (including inside nested formulas and collections).
 *
 * @since 0.1.0
 * @category getters
 */
export const blankNodes = (self: N3Term | Statement): ReadonlyArray<Term.BlankNode> => {
  const out = MutableHashMap.empty<string, Term.BlankNode>();
  collect(self, Guards.isBlankNode, out);
  return Arr.fromIterable(MutableHashMap.values(out));
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
  return self instanceof Statement ? mapStatement(self, f) : mapTerm(self, f);
}

type Atom = Term.NamedNode | Term.BlankNode | Term.Literal | Term.Variable;

// Plain refinements rather than `Match`: `mapTerms` runs for every term it visits.
const mapTerm = (t: N3Term, f: (term: Atom) => N3Term): N3Term =>
  t instanceof Formula
    ? new Formula(t.statements.map((s) => mapStatement(s, f)))
    : t instanceof Collection
      ? new Collection(t.items.map((i) => mapTerm(i, f)))
      : f(t);

const mapStatement = (s: Statement, f: (term: Atom) => N3Term): Statement =>
  new Statement(mapTerm(s.subject, f), mapTerm(s.predicate, f), mapTerm(s.object, f));

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
  return mapTerms(self, (t) => (Guards.isVariable(t) ? (bindings.get(t.value) ?? t) : t));
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
export const hasStatement = (self: Formula, candidate: Statement): boolean =>
  self.statements.some((s) => s.key === candidate.key);

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/**
 * Schema of a formula; its JSON codec is
 * `{ "type": "formula", "statements": [{ subject, predicate, object }, …] }`
 * over JSON N3 terms.
 *
 * @since 0.1.0
 * @category schemas
 */
export const FormulaSchema: Schema.declare<Formula> = Schema.declare(isFormula, {
  identifier: 'Formula',
  toCodecJson: () =>
    Schema.link<Formula>()(
      Schema.Struct({
        type: Schema.tag('formula'),
        statements: Schema.Array(Schema.suspend(() => StatementSchema)),
      }),
      SchemaTransformation.transform({
        decode: (j) => new Formula(j.statements),
        encode: (f) => ({ type: 'formula' as const, statements: f.statements }),
      }),
    ),
});

/**
 * The value a `FormulaSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type FormulaSchema = typeof FormulaSchema.Type;

/**
 * Schema of a collection; its JSON codec is
 * `{ "type": "collection", "items": [ … ] }` over JSON N3 terms.
 *
 * @since 0.1.0
 * @category schemas
 */
export const CollectionSchema: Schema.declare<Collection> = Schema.declare(isCollection, {
  identifier: 'Collection',
  toCodecJson: () =>
    Schema.link<Collection>()(
      Schema.Struct({
        type: Schema.tag('collection'),
        items: Schema.Array(Schema.suspend(() => N3TermSchema)),
      }),
      SchemaTransformation.transform({
        decode: (j) => new Collection(j.items),
        encode: (c) => ({ type: 'collection' as const, items: c.items }),
      }),
    ),
});

/**
 * The value a `CollectionSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type CollectionSchema = typeof CollectionSchema.Type;

/**
 * Schema of a statement; its JSON codec is `{ subject, predicate, object }`
 * over JSON N3 terms.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StatementSchema: Schema.declare<Statement> = Schema.declare(isStatement, {
  identifier: 'Statement',
  toCodecJson: () =>
    Schema.link<Statement>()(
      Schema.Struct({
        subject: Schema.suspend(() => N3TermSchema),
        predicate: Schema.suspend(() => N3TermSchema),
        object: Schema.suspend(() => N3TermSchema),
      }),
      SchemaTransformation.transform({
        decode: (j) => new Statement(j.subject, j.predicate, j.object),
        encode: (st) => ({ subject: st.subject, predicate: st.predicate, object: st.object }),
      }),
    ),
});

/**
 * The value a `StatementSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type StatementSchema = typeof StatementSchema.Type;

/**
 * Schema of any N3 term; its JSON codec is core's `TermJson` term (IRIs,
 * blank nodes, literals, variables) or a JSON collection or formula.
 *
 * @since 0.1.0
 * @category schemas
 */
export const N3TermSchema: Schema.declare<N3Term> = Schema.declare(isN3Term, {
  identifier: 'N3Term',
  toCodecJson: () =>
    Schema.link<N3Term>()(
      Schema.Union([
        Term.NamedNodeSchema,
        Term.BlankNodeSchema,
        Term.LiteralSchema,
        Term.VariableSchema,
        CollectionSchema,
        FormulaSchema,
      ]),
      SchemaTransformation.passthrough(),
    ),
});

/**
 * The value a `N3TermSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type N3TermSchema = typeof N3TermSchema.Type;
