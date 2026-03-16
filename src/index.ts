/**
 * effect-rdf — a comprehensive RDF-star toolkit built on Effect.
 *
 * ## Modules
 *
 * | Import path          | Description                                          |
 * | -------------------- | ---------------------------------------------------- |
 * | `effect-rdf`         | This barrel — re-exports all sub-modules             |
 * | `effect-rdf/IRI`     | `IRI` value type and constructors                    |
 * | `effect-rdf/BlankNode` | `BlankNode` value type and constructors            |
 * | `effect-rdf/Literal`  | `Literal` value type and constructors               |
 * | `effect-rdf/Triple`   | `Triple` (RDF-star aware) value type                |
 * | `effect-rdf/Quad`     | `Quad` and `DefaultGraph` value types               |
 * | `effect-rdf/Term`     | Term union types and helpers                        |
 * | `effect-rdf/Dataset`  | Dataset service tag and in-memory layer             |
 * | `effect-rdf/Namespace`| Namespace factory and common vocabularies           |
 * | `effect-rdf/Parser`   | Parser service tag and stub layer                   |
 * | `effect-rdf/Serializer`| Serializer service tag, N-Quads layer & stub       |
 * | `effect-rdf/Errors`   | Tagged error types                                  |
 *
 * @since 0.1.0
 */

// ---------------------------------------------------------------------------
// Sub-module namespace exports
// ---------------------------------------------------------------------------

export * as IRI from "./IRI.js"
export * as BlankNode from "./BlankNode.js"
export * as Literal from "./Literal.js"
export * as Triple from "./Triple.js"
export * as Quad from "./Quad.js"
export * as Term from "./Term.js"
export * as Dataset from "./Dataset.js"
export * as Parser from "./Parser.js"
export * as Serializer from "./Serializer.js"
export * as Namespace from "./Namespace.js"
export * as Errors from "./Errors.js"

// ---------------------------------------------------------------------------
// Convenience namespace aliases
// ---------------------------------------------------------------------------

export {
  namespace,
  rdf, RDF,
  rdfs, RDFS,
  owl, OWL,
  xsd, XSD,
  dcterms, DCTERMS,
  foaf, FOAF,
  skos, SKOS,
  schema, SCHEMA
} from "./Namespace.js"

export { defaultGraph } from "./Quad.js"
