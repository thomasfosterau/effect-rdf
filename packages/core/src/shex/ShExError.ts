/**
 * Errors raised by the ShEx package.
 *
 * Syntax errors in ShExC and ShapeMap documents are reported with the core
 * `Serialization.RdfParseError` (with `format`, `line` and `column`); the
 * errors defined here cover the other failure modes.
 *
 * @since 0.1.0
 */
import * as Schema from 'effect/Schema';

/**
 * A ShExJ document that is not valid JSON or does not match the ShExJ
 * abstract syntax.
 *
 * @since 0.1.0
 * @category errors
 */
export class ShExJError extends Schema.TaggedError<ShExJError, { readonly brand: unique symbol }>()(
  'ShExJError',
  {
    message: Schema.String,
  },
) {}

/**
 * A schema that is syntactically valid but violates one of the ShEx
 * structural requirements (missing references, negation or extension cycles,
 * invalid inclusions, …).
 *
 * @since 0.1.0
 * @category errors
 */
export class ShExStructureError extends Schema.TaggedError<
  ShExStructureError,
  { readonly brand: unique symbol }
>()('ShExStructureError', {
  message: Schema.String,
}) {}

/**
 * A failure to load an imported schema.
 *
 * @since 0.1.0
 * @category errors
 */
export class ShExImportError extends Schema.TaggedError<
  ShExImportError,
  { readonly brand: unique symbol }
>()('ShExImportError', {
  iri: Schema.String,
  message: Schema.String,
}) {}

/**
 * An RDF graph that is not a valid ShExR representation of a schema.
 *
 * @since 0.1.0
 * @category errors
 */
export class ShExRError extends Schema.TaggedError<ShExRError, { readonly brand: unique symbol }>()(
  'ShExRError',
  {
    message: Schema.String,
  },
) {}

/**
 * A validation request that cannot be evaluated, e.g. a shape map that names
 * a shape label the schema does not declare.
 *
 * @since 0.1.0
 * @category errors
 */
export class ShExValidationError extends Schema.TaggedError<
  ShExValidationError,
  { readonly brand: unique symbol }
>()('ShExValidationError', {
  message: Schema.String,
}) {}
