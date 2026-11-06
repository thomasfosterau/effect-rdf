/**
 * Class refinements of the core terms, for the walks that test every term
 * they visit (`Term.isVariable` and its siblings check the `TypeId` through
 * a `dual` call first; a class check is one instruction).
 *
 * @internal
 */
import * as Term from '../../Term.ts';

/** @internal */
export const isNamedNode = (u: unknown): u is Term.NamedNode => u instanceof Term.NamedNode;

/** @internal */
export const isBlankNode = (u: unknown): u is Term.BlankNode => u instanceof Term.BlankNode;

/** @internal */
export const isLiteral = (u: unknown): u is Term.Literal => u instanceof Term.Literal;

/** @internal */
export const isVariable = (u: unknown): u is Term.Variable => u instanceof Term.Variable;

/** @internal */
export const isTriple = (u: unknown): u is Term.Triple => u instanceof Term.Triple;
