/**
 * Validation reports (§3.6): a typed model of the outcome of SHACL
 * validation, convertible to and from the standard RDF validation report
 * vocabulary.
 *
 * @since 0.1.0
 */
import { Dataset, Term, Vocab } from '@thomasfosterau/effect-rdf';
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import * as Path from './Path.ts';
import { sh } from './Vocabulary.ts';
import * as Predicate from 'effect/Predicate';

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
  conforms: Arr.isReadonlyArrayEmpty(results),
  results,
});

/**
 * @since 0.1.0
 * @category guards
 */
export const isValidationReport = (u: unknown): u is ValidationReport =>
  Predicate.isTagged(u, 'ValidationReport');

// The structural shape of the report model, which `ValidationReportSchema` links to as its JSON
// codec: `Schema.toCodecJson` derives the terms' JSON through their own declarations.
const PathStruct: Schema.Codec<Path.Path> = Schema.Union([
  Schema.Struct({ _tag: Schema.tag('PredicatePath'), predicate: Term.NamedNodeSchema }),
  Schema.Struct({
    _tag: Schema.tag('SequencePath'),
    paths: Schema.Array(Schema.suspend((): Schema.Codec<Path.Path> => PathStruct)),
  }),
  Schema.Struct({
    _tag: Schema.tag('AlternativePath'),
    paths: Schema.Array(Schema.suspend((): Schema.Codec<Path.Path> => PathStruct)),
  }),
  ...(['InversePath', 'ZeroOrMorePath', 'OneOrMorePath', 'ZeroOrOnePath'] as const).map((tag) =>
    Schema.Struct({
      _tag: Schema.tag(tag),
      path: Schema.suspend((): Schema.Codec<Path.Path> => PathStruct),
    }),
  ),
]).annotate({ identifier: 'Path' });

const ResourceSchema = Schema.Union([Term.NamedNodeSchema, Term.BlankNodeSchema]);

const ValidationResultStruct: Schema.Codec<ValidationResult> = Schema.Struct({
  _tag: Schema.tag('ValidationResult'),
  focusNode: Term.GroundTermSchema,
  resultPath: Schema.Option(PathStruct),
  value: Schema.Option(Term.GroundTermSchema),
  sourceShape: ResourceSchema,
  sourceConstraintComponent: ResourceSchema,
  sourceConstraint: Schema.Option(ResourceSchema),
  severity: Term.NamedNodeSchema,
  messages: Schema.Array(Term.LiteralSchema),
  details: Schema.Array(
    Schema.suspend((): Schema.Codec<ValidationResult> => ValidationResultStruct),
  ),
}).annotate({ identifier: 'ValidationResult' });

// `conforms` is derived from the results (`make`), so the JSON carries only the results.
const ValidationReportJson = Schema.Struct({ results: Schema.Array(ValidationResultStruct) });

/**
 * Schema of a validation report; its JSON codec is `{ results }`, mirroring
 * the result model with terms as `TermJson` terms and `Option`s in Effect's
 * JSON form (`conforms` is recomputed from the results on decode).
 *
 * @since 0.1.0
 * @category schemas
 */
export const ValidationReportSchema: Schema.declare<ValidationReport> = Schema.declare(
  isValidationReport,
  {
    identifier: 'ValidationReport',
    toCodecJson: () =>
      Schema.link<ValidationReport>()(
        ValidationReportJson,
        SchemaTransformation.transform({
          decode: ({ results }) => make(results),
          encode: ({ results }) => ({ results }),
        }),
      ),
  },
);

/**
 * The type `ValidationReportSchema` decodes to: a `ValidationReport`.
 *
 * @since 0.1.0
 * @category schemas
 */
export type ValidationReportSchema = typeof ValidationReportSchema.Type;

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
export const hasNoViolations = (self: ValidationReport): boolean =>
  Arr.isReadonlyArrayEmpty(violations(self));

/**
 * A human-readable, multi-line summary of a report.
 *
 * @since 0.1.0
 * @category formatting
 */
export const format = (self: ValidationReport): string => {
  if (self.conforms) return 'Conforms';
  const lines = [`Does not conform (${self.results.length} result(s))`];
  const go = (indent: string) => (r: ValidationResult) => {
    lines.push(`${indent}- ${formatResult(r)}`);
    Arr.forEach(r.details, go(`${indent}  `));
  };
  Arr.forEach(self.results, go(''));
  return lines.join('\n');
};

/**
 * Formats one validation result on one line (without its details):
 * severity, constraint component, focus node, path, value, shape and the
 * first message.
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatResult = (r: ValidationResult): string => {
  const severity = sh.localName(r.severity) ?? r.severity.key;
  const component = Term.isNamedNode(r.sourceConstraintComponent)
    ? (sh.localName(r.sourceConstraintComponent) ?? r.sourceConstraintComponent.key)
    : r.sourceConstraintComponent.key;
  const parts = [`[${severity}] ${component} on ${r.focusNode.key}`];
  if (Option.isSome(r.resultPath)) parts.push(`path ${Path.toSparql(r.resultPath.value)}`);
  if (Option.isSome(r.value)) parts.push(`value ${r.value.value.key}`);
  parts.push(`(shape ${r.sourceShape.key})`);
  const message = r.messages[0];
  return parts.join(' ') + (message === undefined ? '' : `: ${message.value}`);
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
 * A validation report encoded as RDF: the report's node and the graph
 * describing it.
 *
 * @since 0.1.0
 * @category conversions
 */
export interface ReportRdf {
  readonly node: Term.BlankNode;
  readonly dataset: Dataset.Dataset;
}

/**
 * Converts a report to the standard RDF validation report graph, using fresh
 * blank nodes for the report, its results and any non-IRI result paths.
 * Returns the report node together with the dataset.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toRdf = (self: ValidationReport, options: ToDatasetOptions = {}): ReportRdf => {
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
    if (includeMessages) Arr.forEach(r.messages, (m) => add(node, sh.resultMessage, m));
    if (includeDetails) Arr.forEach(r.details, (d) => add(node, sh.detail, writeResult(d)));
    return node;
  };
  const report = Term.blankNode();
  add(report, rdf.type, sh.ValidationReport);
  add(report, sh.conforms, Term.literal(String(self.conforms), xsd.boolean));
  Arr.forEach(self.results, (r) => add(report, sh.result, writeResult(r)));
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
  const node = Option.match(Option.fromUndefinedOr(reportNode), {
    onSome: (n): Result.Result<Term.Resource, string> => Result.succeed(n),
    onNone: () => {
      const reports = Dataset.subjectsOf(dataset, rdf.type, sh.ValidationReport);
      return Result.fromOption(
        Option.filter(Arr.head(reports), () => reports.length === 1),
        () => `expected exactly one sh:ValidationReport, found ${reports.length}`,
      ).pipe(
        Result.flatMap((n) =>
          Term.isResource(n) ? Result.succeed(n) : Result.fail('invalid report node'),
        ),
      );
    },
  });
  if (Result.isFailure(node)) return err(node.failure);
  const one = (s: Term.Subject, p: Term.NamedNode) => Arr.head(Dataset.objectsOf(dataset, s, p));
  const conformsNode = Option.filter(one(node.success, sh.conforms), Term.isLiteral);
  if (Option.isNone(conformsNode)) return err('the report has no sh:conforms literal');
  const readResults = (
    nodes: ReadonlyArray<Term.GroundTerm>,
    depth: number,
  ): Result.Result<ReadonlyArray<ValidationResult>, string> =>
    Result.all(Arr.map(nodes, (r) => readResult(r, depth)));
  const readResult = (
    r: Term.GroundTerm,
    depth: number,
  ): Result.Result<ValidationResult, string> => {
    if (Term.isLiteral(r) || depth > 64) return Result.fail(`invalid result node ${r.key}`);
    const required = <A extends Term.GroundTerm>(
      p: Term.NamedNode,
      refinement: (t: Term.GroundTerm) => t is A,
      message: string,
    ): Result.Result<A, string> =>
      Result.fromOption(Option.filter(one(r, p), refinement), () => `result ${r.key} ${message}`);
    const pathNode = one(r, sh.resultPath);
    return Result.gen(function* () {
      const focusNode = yield* required(sh.focusNode, Term.isGroundTerm, 'has no sh:focusNode');
      const sourceShape = yield* required(
        sh.sourceShape,
        Term.isResource,
        'has no valid sh:sourceShape',
      );
      const component = yield* required(
        sh.sourceConstraintComponent,
        Term.isResource,
        'has no valid sh:sourceConstraintComponent',
      );
      const severity = yield* required(
        sh.resultSeverity,
        Term.isNamedNode,
        'has no valid sh:resultSeverity',
      );
      const resultPath = Option.isNone(pathNode)
        ? Option.none<Path.Path>()
        : Option.some(
            yield* Result.mapError(
              Path.fromRdf(dataset, pathNode.value),
              () => `result ${r.key} has an invalid sh:resultPath`,
            ),
          );
      const details = yield* readResults(Dataset.objectsOf(dataset, r, sh.detail), depth + 1);
      return makeResult({
        focusNode,
        sourceShape,
        sourceConstraintComponent: component,
        severity,
        resultPath,
        value: one(r, sh.value),
        sourceConstraint: Option.filter(one(r, sh.sourceConstraint), Term.isResource),
        messages: Dataset.objectsOf(dataset, r, sh.resultMessage).filter(Term.isLiteral),
        details,
      });
    });
  };
  const results = readResults(Dataset.objectsOf(dataset, node.success, sh.result), 0);
  if (Result.isFailure(results)) return err(results.failure);
  return Result.succeed({
    _tag: 'ValidationReport',
    conforms: conformsNode.value.value === 'true' || conformsNode.value.value === '1',
    results: results.success,
  });
};
