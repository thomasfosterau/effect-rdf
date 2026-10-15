/**
 * Validation reports (§3.6): a typed model of the outcome of SHACL
 * validation, convertible to and from the standard RDF validation report
 * vocabulary.
 *
 * @since 0.1.0
 */
import { Dataset, Term, Vocab } from '@thomasfosterau/effect-rdf';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Path from './Path.ts';
import { sh } from './Vocabulary.ts';

const { rdf, xsd } = Vocab;

/**
 * A single validation result (`sh:ValidationResult`).
 *
 * @since 0.1.0
 * @category models
 */
export interface ValidationResult {
  readonly _tag: 'ValidationResult';
  /** `sh:focusNode`: the focus node that was validated. */
  readonly focusNode: Term.GroundTerm;
  /** `sh:resultPath`: the path of the property shape, when relevant. */
  readonly resultPath: Option.Option<Path.Path>;
  /** `sh:value`: the value node that caused the result, when relevant. */
  readonly value: Option.Option<Term.GroundTerm>;
  /** `sh:sourceShape`: the shape the constraint belongs to. */
  readonly sourceShape: Term.NamedNode | Term.BlankNode;
  /** `sh:sourceConstraintComponent`. */
  readonly sourceConstraintComponent: Term.NamedNode | Term.BlankNode;
  /** `sh:sourceConstraint` (for SPARQL-based constraints). */
  readonly sourceConstraint: Option.Option<Term.NamedNode | Term.BlankNode>;
  /** `sh:resultSeverity`. */
  readonly severity: Term.NamedNode;
  /** `sh:resultMessage` values. */
  readonly messages: ReadonlyArray<Term.Literal>;
  /** `sh:detail`: nested results explaining this result. */
  readonly details: ReadonlyArray<ValidationResult>;
}

/**
 * A validation report (`sh:ValidationReport`).
 *
 * @since 0.1.0
 * @category models
 */
export interface ValidationReport {
  readonly _tag: 'ValidationReport';
  /** `sh:conforms`: true when there are no validation results. */
  readonly conforms: boolean;
  /** `sh:result` values. */
  readonly results: ReadonlyArray<ValidationResult>;
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const makeResult = (fields: {
  readonly focusNode: Term.GroundTerm;
  readonly sourceShape: Term.NamedNode | Term.BlankNode;
  readonly sourceConstraintComponent: Term.NamedNode | Term.BlankNode;
  readonly severity?: Term.NamedNode | undefined;
  readonly resultPath?: Option.Option<Path.Path> | undefined;
  readonly value?: Option.Option<Term.GroundTerm> | undefined;
  readonly sourceConstraint?: Option.Option<Term.NamedNode | Term.BlankNode> | undefined;
  readonly messages?: ReadonlyArray<Term.Literal> | undefined;
  readonly details?: ReadonlyArray<ValidationResult> | undefined;
}): ValidationResult => ({
  _tag: 'ValidationResult',
  focusNode: fields.focusNode,
  resultPath: fields.resultPath ?? Option.none(),
  value: fields.value ?? Option.none(),
  sourceShape: fields.sourceShape,
  sourceConstraintComponent: fields.sourceConstraintComponent,
  sourceConstraint: fields.sourceConstraint ?? Option.none(),
  severity: fields.severity ?? sh.Violation,
  messages: fields.messages ?? [],
  details: fields.details ?? [],
});

/**
 * Builds a report from results; `conforms` is true iff there are none.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (results: ReadonlyArray<ValidationResult>): ValidationReport => ({
  _tag: 'ValidationReport',
  conforms: results.length === 0,
  results,
});

/**
 * @since 0.1.0
 * @category guards
 */
export const isValidationReport = (u: unknown): u is ValidationReport =>
  typeof u === 'object' && u !== null && (u as { _tag?: unknown })._tag === 'ValidationReport';

/**
 * @since 0.1.0
 * @category schemas
 */
export const ValidationReportSchema: Schema.declare<ValidationReport> = Schema.declare(
  isValidationReport,
  { identifier: 'ValidationReport' },
);

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

/**
 * The results with a given severity.
 *
 * @since 0.1.0
 * @category queries
 */
export const withSeverity = (
  self: ValidationReport,
  severity: Term.NamedNode,
): ReadonlyArray<ValidationResult> =>
  self.results.filter((r) => r.severity.value === severity.value);

/**
 * The `sh:Violation` results.
 *
 * @since 0.1.0
 * @category queries
 */
export const violations = (self: ValidationReport): ReadonlyArray<ValidationResult> =>
  withSeverity(self, sh.Violation);

/**
 * Whether the report has no results of severity `sh:Violation` (it may still
 * contain warnings and informational results).
 *
 * @since 0.1.0
 * @category queries
 */
export const hasNoViolations = (self: ValidationReport): boolean => violations(self).length === 0;

/**
 * A human-readable, multi-line summary of a report.
 *
 * @since 0.1.0
 * @category formatting
 */
export const format = (self: ValidationReport): string => {
  if (self.conforms) return 'Conforms';
  const lines = [`Does not conform (${self.results.length} result(s))`];
  const go = (r: ValidationResult, indent: string) => {
    const severity = sh.localName(r.severity) ?? r.severity.key;
    const component = Term.isNamedNode(r.sourceConstraintComponent)
      ? (sh.localName(r.sourceConstraintComponent) ?? r.sourceConstraintComponent.key)
      : r.sourceConstraintComponent.key;
    const parts = [`${indent}- [${severity}] ${component} on ${r.focusNode.key}`];
    if (Option.isSome(r.resultPath)) parts.push(`path ${Path.toSparql(r.resultPath.value)}`);
    if (Option.isSome(r.value)) parts.push(`value ${r.value.value.key}`);
    parts.push(`(shape ${r.sourceShape.key})`);
    const message = r.messages[0];
    lines.push(parts.join(' ') + (message === undefined ? '' : `: ${message.value}`));
    for (const d of r.details) go(d, `${indent}  `);
  };
  for (const r of self.results) go(r, '');
  return lines.join('\n');
};

// -----------------------------------------------------------------------------
// RDF conversion
// -----------------------------------------------------------------------------

/**
 * Options for `toDataset`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ToDatasetOptions {
  /** The graph to write the report into (default graph by default). */
  readonly graph?: Term.Graph | undefined;
  /** Include `sh:detail` results (default `true`). */
  readonly details?: boolean | undefined;
  /** Include `sh:resultMessage` values (default `true`). */
  readonly messages?: boolean | undefined;
}

/**
 * Converts a report to the standard RDF validation report graph, using fresh
 * blank nodes for the report, its results and any non-IRI result paths.
 * Returns the report node together with the dataset.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toRdf = (
  self: ValidationReport,
  options: ToDatasetOptions = {},
): { readonly node: Term.BlankNode; readonly dataset: Dataset.Dataset } => {
  const graph = options.graph ?? Term.defaultGraph;
  const includeDetails = options.details !== false;
  const includeMessages = options.messages !== false;
  const quads: Array<Term.Quad> = [];
  const add = (s: Term.Subject, p: Term.NamedNode, o: Term.Object) =>
    quads.push(Term.quad(s, p, o, graph));
  const writeResult = (r: ValidationResult): Term.BlankNode => {
    const node = Term.blankNode();
    add(node, rdf.type, sh.ValidationResult);
    add(node, sh.focusNode, r.focusNode);
    if (Option.isSome(r.resultPath)) {
      const encoded = Path.toRdf(r.resultPath.value, graph);
      quads.push(...encoded.quads);
      add(node, sh.resultPath, encoded.node);
    }
    if (Option.isSome(r.value)) add(node, sh.value, r.value.value);
    add(node, sh.sourceShape, r.sourceShape);
    add(node, sh.sourceConstraintComponent, r.sourceConstraintComponent);
    if (Option.isSome(r.sourceConstraint)) add(node, sh.sourceConstraint, r.sourceConstraint.value);
    add(node, sh.resultSeverity, r.severity);
    if (includeMessages) for (const m of r.messages) add(node, sh.resultMessage, m);
    if (includeDetails) for (const d of r.details) add(node, sh.detail, writeResult(d));
    return node;
  };
  const report = Term.blankNode();
  add(report, rdf.type, sh.ValidationReport);
  add(report, sh.conforms, Term.literal(String(self.conforms), xsd.boolean));
  for (const r of self.results) add(report, sh.result, writeResult(r));
  return { node: report, dataset: Dataset.fromIterable(quads) };
};

/**
 * Converts a report to the standard RDF validation report graph.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toDataset = (
  self: ValidationReport,
  options: ToDatasetOptions = {},
): Dataset.Dataset => toRdf(self, options).dataset;

/**
 * Why an RDF validation report could not be read.
 *
 * @since 0.1.0
 * @category errors
 */
export class ReportSyntaxError extends Schema.TaggedError<ReportSyntaxError>()(
  'ReportSyntaxError',
  { message: Schema.String },
) {}

/**
 * Reads a validation report from RDF. The report node defaults to the (only)
 * instance of `sh:ValidationReport` in the dataset.
 *
 * @since 0.1.0
 * @category conversions
 */
export const fromDataset = (
  dataset: Dataset.Dataset,
  reportNode?: Term.NamedNode | Term.BlankNode,
): Result.Result<ValidationReport, ReportSyntaxError> => {
  const err = (message: string) => Result.fail(new ReportSyntaxError({ message }));
  let node: Term.Term | undefined = reportNode;
  if (node === undefined) {
    const reports = Dataset.subjectsOf(dataset, rdf.type, sh.ValidationReport);
    if (reports.length !== 1)
      return err(`expected exactly one sh:ValidationReport, found ${reports.length}`);
    node = reports[0]!;
  }
  if (node._tag !== 'NamedNode' && node._tag !== 'BlankNode') return err('invalid report node');
  const one = (s: Term.Subject, p: Term.NamedNode) => Dataset.objectsOf(dataset, s, p)[0];
  const conformsNode = one(node, sh.conforms);
  if (conformsNode === undefined || conformsNode._tag !== 'Literal')
    return err('the report has no sh:conforms literal');
  const readResult = (r: Term.GroundTerm, depth: number): ValidationResult | string => {
    if (r._tag === 'Literal' || depth > 64) return `invalid result node ${r.key}`;
    const focusNode = one(r, sh.focusNode);
    const sourceShape = one(r, sh.sourceShape);
    const component = one(r, sh.sourceConstraintComponent);
    const severity = one(r, sh.resultSeverity);
    if (focusNode === undefined) return `result ${r.key} has no sh:focusNode`;
    if (sourceShape === undefined || !Term.isResource(sourceShape))
      return `result ${r.key} has no valid sh:sourceShape`;
    if (component === undefined || !Term.isResource(component))
      return `result ${r.key} has no valid sh:sourceConstraintComponent`;
    if (severity === undefined || severity._tag !== 'NamedNode')
      return `result ${r.key} has no valid sh:resultSeverity`;
    const pathNode = one(r, sh.resultPath);
    let resultPath = Option.none<Path.Path>();
    if (pathNode !== undefined) {
      const p = Path.fromRdf(dataset, pathNode);
      if (Result.isFailure(p)) return `result ${r.key} has an invalid sh:resultPath`;
      resultPath = Option.some(p.success);
    }
    const sourceConstraint = one(r, sh.sourceConstraint);
    const details: Array<ValidationResult> = [];
    for (const d of Dataset.objectsOf(dataset, r, sh.detail)) {
      const detail = readResult(d, depth + 1);
      if (typeof detail === 'string') return detail;
      details.push(detail);
    }
    return makeResult({
      focusNode,
      sourceShape,
      sourceConstraintComponent: component,
      severity,
      resultPath,
      value: Option.fromNullishOr(one(r, sh.value)),
      sourceConstraint:
        sourceConstraint !== undefined && Term.isResource(sourceConstraint)
          ? Option.some(sourceConstraint)
          : Option.none(),
      messages: Dataset.objectsOf(dataset, r, sh.resultMessage).filter(Term.isLiteral),
      details,
    });
  };
  const results: Array<ValidationResult> = [];
  for (const r of Dataset.objectsOf(dataset, node, sh.result)) {
    const result = readResult(r, 0);
    if (typeof result === 'string') return err(result);
    results.push(result);
  }
  return Result.succeed({
    _tag: 'ValidationReport',
    conforms: conformsNode.value === 'true' || conformsNode.value === '1',
    results,
  });
};
