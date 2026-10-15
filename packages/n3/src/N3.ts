/**
 * Notation3 (N3) parsing and serialisation.
 *
 * - `parse` parses an N3 document into the full N3 model (`Model.Document`),
 *   including formulas, variables, collections and literals in any position.
 * - `serializeDocument` pretty-prints the N3 model.
 * - `parser`, `serializer` and `codec` implement the core
 *   `Serialization.Parser` / `Serializer` / `Codec` interfaces over RDF
 *   `Dataset`s, using the mapping documented in the `Mapping` module:
 *   formulas become named graphs identified by blank nodes, and collections
 *   become `rdf:first`/`rdf:rest` lists. Documents outside the RDF-compatible
 *   subset (variables, literal subjects, non-IRI predicates) fail with
 *   `RdfParseError`.
 *
 * Syntax notes (current W3C CG specification and test suite):
 *
 * - Supports `@prefix`/`@base`, SPARQL `PREFIX`/`BASE`, formulas, quick
 *   variables, paths (`!`, `^`), `a`, `has`, `is … of`, `<-`, `=`, `=>`,
 *   `<=`, IRI property lists (`[ id <iri> … ]`), and the `@`-prefixed
 *   keyword forms. The legacy explicit quantifiers `@forAll` (mapped to
 *   variables) and `@forSome` (mapped to fresh blank nodes) are accepted;
 *   `@keywords` is rejected.
 * - `<=` is `log:isImpliedBy`; `=` is `owl:sameAs`.
 * - An empty formula `{}` denotes the literal `true`.
 * - The empty prefix `:` defaults to `<#>` (relative to the base) when not
 *   declared.
 * - Blank node labels are scoped to the whole document.
 * - `"…"^^i18n:{lang}_{dir}` is read as a directional language-tagged
 *   string.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Parser from './internal/parser.ts';
import * as Writer from './internal/writer.ts';
import * as Mapping from './Mapping.ts';
import * as Model from './Model.ts';

/**
 * The N3 format descriptor (`text/n3`, `.n3`).
 *
 * N3 can only represent named graphs that are named by blank nodes used as
 * terms (formulas), so `datasets` is `false`.
 *
 * @since 0.1.0
 * @category formats
 */
export const format: Serialization.Format = Serialization.makeFormat({
  name: 'N3',
  mediaType: 'text/n3',
  mediaTypes: ['text/n3', 'text/rdf+n3', 'application/n3'],
  extensions: ['n3'],
  datasets: false,
});

/**
 * Options for parsing N3.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions extends Serialization.ParseOptions {}

const runParser = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Model.Document, Serialization.RdfParseError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(
        Parser.parse(input, {
          baseIri: options?.baseIri,
          blankNodePrefix: options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix(),
        }),
      );
    } catch (e) {
      if (e instanceof Parser.SyntaxFailure) {
        return Effect.fail(
          new Serialization.RdfParseError({
            format: format.name,
            message: e.message,
            line: e.line,
            column: e.column,
          }),
        );
      }
      throw e;
    }
  });

/**
 * Parses an N3 document into the full N3 model.
 *
 * @example
 * ```ts
 * import { Effect } from 'effect'
 * import { N3 } from '@thomasfosterau/effect-n3'
 *
 * const doc = Effect.runSync(N3.parse('@prefix : <http://example.org/> . { ?x a :Man } => { ?x a :Mortal } .'))
 * doc.formula.statements.length // 1
 * ```
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse: (
  input: string,
  options?: ParseOptions,
) => Effect.Effect<Model.Document, Serialization.RdfParseError> = Effect.fnUntraced(function* (
  input: string,
  options?: ParseOptions,
) {
  return yield* runParser(input, options);
});

/**
 * Parses an N3 document in the RDF-compatible subset into a core dataset
 * (see `Mapping.toDataset`).
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseDataset = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.flatMap(runParser(input, options), (doc) =>
    Effect.suspend(() => {
      const prefix = options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix();
      return Mapping.toDataset(doc, { blankNodePrefix: prefix }).pipe(
        Effect.mapError(
          (e) => new Serialization.RdfParseError({ format: format.name, message: e.message }),
        ),
        Effect.map((dataset): Serialization.ParseResult => ({
          dataset,
          prefixes: doc.prefixes,
          baseIri: doc.baseIri,
        })),
      );
    }),
  );

/**
 * The N3 `Serialization.Parser`, producing core datasets.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parser: Serialization.Parser<ParseOptions> = Serialization.makeParser({
  format,
  parse: parseDataset,
});

/**
 * Options for serialising N3.
 *
 * @since 0.1.0
 * @category models
 */
export interface SerializeOptions extends Serialization.SerializeOptions {
  /** Indentation unit for nested formulas and statements (default four spaces). */
  readonly indent?: string | undefined;
}

/**
 * Serialises an N3 formula or document. Prefixes from the options (or, for
 * a document, the document's own prefixes) are used to abbreviate IRIs, and
 * only the prefixes actually used are declared.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializeDocument = (
  self: Model.Formula | Model.Document,
  options?: SerializeOptions,
): string => {
  const isFormula = Model.isFormula(self);
  return Writer.write(isFormula ? self : self.formula, {
    prefixes: options?.prefixes ?? (isFormula ? undefined : self.prefixes),
    baseIri: options?.baseIri ?? (isFormula ? undefined : self.baseIri),
    indent: options?.indent,
  });
};

/**
 * Serialises RDF quads as N3. Graphs named by blank nodes that are used as
 * terms are written as nested formulas, and well-formed RDF lists as
 * collections; other named graphs cannot be represented and fail with
 * `RdfSerializeError`.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serialize = (
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  Mapping.fromDataset(quads).pipe(
    Effect.map((f) => serializeDocument(f, options)),
    Effect.mapError(
      (e) => new Serialization.RdfSerializeError({ format: format.name, message: e.message }),
    ),
  );

/**
 * The N3 `Serialization.Serializer` for core datasets.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializer: Serialization.Serializer<SerializeOptions> = Serialization.makeSerializer({
  format,
  serialize,
});

/**
 * The N3 `Serialization.Codec` (parser + serializer over core datasets).
 *
 * @since 0.1.0
 * @category codecs
 */
export const codec: Serialization.Codec<ParseOptions, SerializeOptions> = Serialization.makeCodec(
  parser,
  serializer,
);
