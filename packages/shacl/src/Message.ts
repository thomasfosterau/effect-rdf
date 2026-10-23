/**
 * Message templates: `sh:message` values (and `sh:labelTemplate`s) may refer
 * to variables with `{?name}` or `{$name}`, which are replaced with a string
 * representation of the variable's value when a validation result is
 * produced (SHACL §5.3.2 and §6.2.2).
 *
 * The validator substitutes:
 *
 * - for SPARQL-based constraints, the variables of the result solution
 *   (`this`, `value`, `path`, any other projected variable) and, for
 *   SPARQL-based constraint components, the parameter values;
 * - for core constraints, `this`, `value`, `path` and the parameters of the
 *   constraint component by their local names (`{$minCount}`,
 *   `{$datatype}`, `{$pattern}`, …).
 *
 * ```ts
 * import { Term } from "@thomasfosterau/effect-rdf"
 * import { Message } from "@thomasfosterau/effect-shacl"
 *
 * Message.substitute(Term.literal("Expected at least {$minCount} values"), (name) =>
 *   name === "minCount" ? Term.literal("2") : undefined,
 * ) // "Expected at least 2 values"
 * ```
 *
 * @since 0.1.0
 */
import { Term } from '@thomasfosterau/effect-rdf';
import * as Predicate from 'effect/Predicate';

const placeholder = /\{[?$]([\p{L}\p{N}_\p{M}]+)\}/gu;

/**
 * A human-readable string for a term inside a message: the lexical form of
 * literals, the IRI of named nodes, `_:label` for blank nodes and the
 * N-Triples-like form of triple terms.
 *
 * @since 0.1.0
 * @category formatting
 */
export const display = (term: Term.Term): string => {
  switch (term._tag) {
    case 'Literal':
    case 'NamedNode':
      return term.value;
    case 'BlankNode':
      return `_:${term.value}`;
    default:
      return term.toString();
  }
};

/**
 * The variable names referenced by a template, in order of appearance.
 *
 * @since 0.1.0
 * @category queries
 */
export const variables = (template: string): ReadonlyArray<string> =>
  Array.from(template.matchAll(placeholder), (m) => m[1]!);

/**
 * Replaces the `{?name}` / `{$name}` placeholders of a template string.
 * Placeholders whose variable `lookup` does not know are left unchanged.
 *
 * @since 0.1.0
 * @category substitution
 */
export const format = (template: string, lookup: (name: string) => Term.Term | undefined): string =>
  template.replace(placeholder, (match, name: string) => {
    const value = lookup(name);
    return value === undefined ? match : display(value);
  });

/**
 * Substitutes the placeholders of a message literal, keeping its language
 * tag (or datatype).
 *
 * @since 0.1.0
 * @category substitution
 */
export const substitute = (
  message: Term.Literal,
  lookup: (name: string) => Term.Term | undefined,
): Term.Literal => {
  const value = format(message.value, lookup);
  return value === message.value
    ? message
    : new Term.Literal(value, message.datatype, message.language, message.direction);
};

/**
 * The local name of an IRI: the longest NCName at its end (SHACL §6.2.1).
 * SPARQL-based constraint components derive their parameter names (and
 * thus the pre-bound variable names) this way. Returns an empty string when
 * the IRI does not end with an NCName.
 *
 * @since 0.1.0
 * @category utils
 */
export const localName = (iri: Term.NamedNode | string): string => {
  const value = Predicate.isString(iri) ? iri : iri.value;
  const match = /[\p{L}\p{N}\p{M}_.-]*$/u.exec(value);
  // An NCName cannot start with a digit, `-` or `.`.
  return (match?.[0] ?? '').replace(/^[\p{N}\p{M}.-]+/u, '');
};
