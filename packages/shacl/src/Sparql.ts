/**
 * The extension point for SHACL-SPARQL (§5–§6 of the SHACL specification).
 *
 * The core validator does not execute SPARQL itself. When a shapes graph
 * contains SPARQL-based constraints (`sh:sparql`), SPARQL-based constraint
 * components or SPARQL-based targets (`sh:target`), the validator delegates
 * them to the `SparqlConstraintEvaluator` service if one is provided. When no
 * evaluator is available the validator either fails with an
 * `UnsupportedFeatureError` or ignores those constructs, depending on the
 * `sparql` validation option.
 *
 * A SPARQL engine integration implements this service:
 *
 * ```ts
 * import { Effect, Layer } from "effect"
 * import { Sparql } from "@thomasfosterau/effect-shacl"
 *
 * const EvaluatorLive = Layer.succeed(Sparql.SparqlConstraintEvaluator, {
 *   evaluateConstraint: (input) => Effect.succeed([]),
 *   selectTargets: (input) => Effect.succeed([]),
 * })
 * ```
 *
 * @since 0.1.0
 */
import type { Dataset, Term } from '@thomasfosterau/effect-rdf';
import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import type * as Path from './Path.ts';
import type * as Shapes from './Shapes.ts';

/**
 * A failure while evaluating a SPARQL-based constraint or target.
 *
 * @since 0.1.0
 * @category errors
 */
export class SparqlEvaluationError extends Schema.TaggedError<SparqlEvaluationError>()(
  'SparqlEvaluationError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The input to the evaluation of a SPARQL-based constraint for one focus
 * node.
 *
 * @since 0.1.0
 * @category models
 */
export interface ConstraintInput {
  /** The data graph (with the shapes graph merged in when requested). */
  readonly dataGraph: Dataset.Dataset;
  /** The parsed shapes graph; its `dataset` is the `$shapesGraph`. */
  readonly shapesGraph: Shapes.ShapesGraph;
  /** The shape (`$currentShape`) that holds the constraint. */
  readonly shape: Shapes.Shape;
  /** The SPARQL constraint or custom component instance. */
  readonly constraint: Shapes.SparqlConstraint | Shapes.ComponentConstraint;
  /** The focus node (`$this`). */
  readonly focusNode: Term.GroundTerm;
  /** The value nodes of the focus node for this shape. */
  readonly valueNodes: ReadonlyArray<Term.GroundTerm>;
}

/**
 * One solution reported by a SPARQL-based constraint. Omitted fields take the
 * defaults defined by the SHACL-SPARQL specification: the focus node, the
 * shape's path, the shape's severity and messages.
 *
 * @since 0.1.0
 * @category models
 */
export interface Violation {
  readonly focusNode?: Term.GroundTerm | undefined;
  readonly value?: Term.GroundTerm | undefined;
  readonly path?: Path.Path | undefined;
  readonly messages?: ReadonlyArray<Term.Literal> | undefined;
  readonly severity?: Term.NamedNode | undefined;
}

/**
 * The input to the evaluation of a SPARQL-based or custom target.
 *
 * @since 0.1.0
 * @category models
 */
export interface TargetInput {
  readonly dataGraph: Dataset.Dataset;
  readonly shapesGraph: Shapes.ShapesGraph;
  readonly shape: Shapes.Shape;
  /** The value of `sh:target`. */
  readonly target: Term.GroundTerm;
}

/**
 * A service able to evaluate SHACL-SPARQL constraints and targets, provided
 * by a SPARQL engine integration.
 *
 * @since 0.1.0
 * @category services
 */
export class SparqlConstraintEvaluator extends Context.Service<
  SparqlConstraintEvaluator,
  {
    /** Evaluates a SPARQL constraint for one focus node, returning its violations. */
    readonly evaluateConstraint: (
      input: ConstraintInput,
    ) => Effect.Effect<ReadonlyArray<Violation>, SparqlEvaluationError>;
    /** Computes the focus nodes of a SPARQL-based or custom target. */
    readonly selectTargets: (
      input: TargetInput,
    ) => Effect.Effect<ReadonlyArray<Term.GroundTerm>, SparqlEvaluationError>;
  }
>()('@thomasfosterau/effect-shacl/Sparql/SparqlConstraintEvaluator') {}
