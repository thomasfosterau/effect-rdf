/**
 * Errors raised while evaluating queries and updates.
 *
 * @since 0.1.0
 */
import * as Schema from 'effect/Schema';

/**
 * A failure while evaluating a query (other than expression errors, which
 * SPARQL handles internally), e.g. a failing `SERVICE` call.
 *
 * @since 0.1.0
 * @category errors
 */
export class EvaluationError extends Schema.TaggedError<EvaluationError>()('EvaluationError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A failure of an update operation, e.g. `CREATE GRAPH` on an existing graph
 * or `DROP GRAPH` on a missing one (without `SILENT`).
 *
 * @since 0.1.0
 * @category errors
 */
export class UpdateError extends Schema.TaggedError<UpdateError>()('UpdateError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
