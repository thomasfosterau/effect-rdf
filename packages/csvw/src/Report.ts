/**
 * The validation report of CSVW processing: the errors and warnings raised
 * while reading metadata, checking it against the tabular data, parsing
 * cells and checking primary and foreign keys, each with its position.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Schema from 'effect/Schema';

/**
 * How serious an issue is: an `error` makes the input invalid, a `warning`
 * does not.
 *
 * @since 0.1.0
 * @category models
 */
export const Level = Schema.Literals(['error', 'warning']);

/**
 * @since 0.1.0
 * @category models
 */
export type Level = typeof Level.Type;

/**
 * One error or warning, positioned where it applies: the table URL, the
 * source row number and the source column number (all 1-based, absent when
 * the issue concerns the whole table or metadata).
 *
 * @since 0.1.0
 * @category models
 */
export const Issue = Schema.Struct({
  level: Level,
  message: Schema.String,
  table: Schema.optional(Schema.String),
  row: Schema.optional(Schema.Int),
  column: Schema.optional(Schema.Int),
});

/**
 * @since 0.1.0
 * @category models
 */
export type Issue = typeof Issue.Type;

/**
 * A validation report: every issue raised, in the order raised.
 *
 * @since 0.1.0
 * @category models
 */
export const Report = Schema.Struct({ issues: Schema.Array(Issue) });

/**
 * @since 0.1.0
 * @category models
 */
export type Report = typeof Report.Type;

/**
 * The empty report.
 *
 * @since 0.1.0
 * @category constructors
 */
export const empty: Report = { issues: [] };

/**
 * A report of the given issues.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (issues: ReadonlyArray<Issue>): Report => ({ issues });

/**
 * An error issue.
 *
 * @since 0.1.0
 * @category constructors
 */
export const error = (message: string, position: Omit<Issue, 'level' | 'message'> = {}): Issue => ({
  level: 'error',
  message,
  ...position,
});

/**
 * A warning issue.
 *
 * @since 0.1.0
 * @category constructors
 */
export const warning = (
  message: string,
  position: Omit<Issue, 'level' | 'message'> = {},
): Issue => ({ level: 'warning', message, ...position });

/**
 * The errors of a report.
 *
 * @since 0.1.0
 * @category getters
 */
export const errors = (self: Report): ReadonlyArray<Issue> =>
  Arr.filter(self.issues, (i) => i.level === 'error');

/**
 * The warnings of a report.
 *
 * @since 0.1.0
 * @category getters
 */
export const warnings = (self: Report): ReadonlyArray<Issue> =>
  Arr.filter(self.issues, (i) => i.level === 'warning');

/**
 * Whether a report has no errors (warnings are allowed).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isValid = (self: Report): boolean => !Arr.isReadonlyArrayNonEmpty(errors(self));

/**
 * Two reports in one.
 *
 * @since 0.1.0
 * @category combinators
 */
export const combine = (self: Report, that: Report): Report => ({
  issues: Arr.appendAll(self.issues, that.issues),
});
