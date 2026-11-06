/**
 * Effect `Schema`s that decode RDF terms (as found in SPARQL solutions) to
 * JavaScript values and encode them back, for typed decoding of query
 * results with `QueryBuilder.decode`:
 *
 * ```ts
 * const Person = Schema.Struct({
 *   name: TermSchema.string,
 *   age: Schema.optional(TermSchema.integer),
 *   homepage: Schema.optional(TermSchema.iri),
 * })
 * // QueryBuilder.decode(query, Person) : Stream<{ name: string; age?: number; … }>
 * ```
 *
 * A re-export of core's `@thomasfosterau/effect-rdf/TermCodec`, which holds
 * the codecs and their documentation; nothing here depends on SPARQL.
 *
 * @since 0.1.0
 */
export * from '../TermCodec.ts';
