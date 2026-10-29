/**
 * ShEx validation: checks node/shape associations of a shape map against an
 * RDF dataset per the ShEx 2.1 semantics (with the ShEx 2.2 `EXTENDS`,
 * `ABSTRACT` and `RESTRICTS` extensions).
 *
 * Recursive references are evaluated coinductively (the maximal typing) and
 * memoised; schemas are checked for the structural requirements, which
 * guarantee a stratification so that negation is well-defined. Imports are
 * loaded through the `SchemaLoader` service and semantic actions are
 * dispatched to the `SemAct.SemActHandler` service.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import { Engine } from './internal/engine.ts';
import * as SemAct from './SemAct.ts';
import { ShExImportError, type ShExStructureError, ShExValidationError } from './ShExError.ts';
import type * as ShExJ from './ShExJ.ts';
import * as ShapeMap from './ShapeMap.ts';
import * as Structure from './Structure.ts';

// -----------------------------------------------------------------------------
// Services
// -----------------------------------------------------------------------------

/**
 * Loads imported schemas by IRI.
 *
 * @since 0.1.0
 * @category models
 */
export interface Loader {
  readonly load: (iri: string) => Effect.Effect<ShExJ.Schema, ShExImportError>;
}

/**
 * The service used to resolve `IMPORT`s. The default loader fails for every
 * import.
 *
 * @since 0.1.0
 * @category services
 */
export const SchemaLoader: Context.Reference<Loader> = Context.Reference<Loader>(
  '@thomasfosterau/effect-shex/SchemaLoader',
  {
    defaultValue: () => ({
      load: (iri) =>
        Effect.fail(new ShExImportError({ iri, message: 'no SchemaLoader is configured' })),
    }),
  },
);

/**
 * A layer providing a `SchemaLoader`.
 *
 * @since 0.1.0
 * @category layers
 */
export const loaderLayer = (loader: Loader): Layer.Layer<never> =>
  Layer.succeed(SchemaLoader, loader);

/**
 * A loader serving schemas from a map of IRIs (useful for tests and bundled
 * schemas).
 *
 * @since 0.1.0
 * @category constructors
 */
export const loaderFromRecord = (schemas: Readonly<Record<string, ShExJ.Schema>>): Loader => ({
  load: (iri) => {
    const s = schemas[iri];
    return s === undefined
      ? Effect.fail(new ShExImportError({ iri, message: 'unknown schema' }))
      : Effect.succeed(s);
  },
});

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /**
   * Definitions for shapes declared `EXTERNAL`, given as a schema whose
   * declarations share the external labels.
   */
  readonly externalShapes?: ShExJ.Schema | undefined;
  /**
   * Code for semantic actions written without code (`%<name>%`), matched by
   * action name.
   */
  readonly externalSemActs?: ReadonlyArray<ShExJ.SemAct> | undefined;
  /** The IRI of the schema itself, so that circular imports of it are ignored. */
  readonly schemaIri?: string | undefined;
}

/**
 * The validation result of one node/shape association.
 *
 * @since 0.1.0
 * @category models
 */
export interface ShapeResult {
  readonly node: Term.GroundTerm;
  readonly shape: ShapeMap.ShapeSelector;
  readonly status: 'conformant' | 'nonconformant';
  /** Why the node does not conform. */
  readonly reason?: string;
}

/**
 * A validation report: one result per association of the (fixed) shape map.
 *
 * @since 0.1.0
 * @category models
 */
export interface ValidationReport {
  readonly results: ReadonlyArray<ShapeResult>;
  /** Whether every association conforms. */
  readonly conformant: boolean;
}

/**
 * A validator for one (import-resolved, structurally checked) schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface Validator {
  /** The schema with the declarations of its imports merged in. */
  readonly schema: ShExJ.Schema;
  readonly index: Structure.SchemaIndex;
  /** Validates a fixed or query shape map against a dataset. */
  readonly validate: (
    dataset: Dataset.Dataset,
    shapeMap: ShapeMap.QueryShapeMap,
  ) => Effect.Effect<ValidationReport, ShExValidationError>;
}

// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------

/**
 * Loads the imports of a schema (transitively, each IRI once) and merges
 * their declarations into it. The importing schema's `start` and `startActs`
 * are kept.
 *
 * @since 0.1.0
 * @category imports
 */
export const resolveImports = Effect.fnUntraced(function* (
  schema: ShExJ.Schema,
  schemaIri?: string,
) {
  if (schema.imports === undefined || Arr.isReadonlyArrayEmpty(schema.imports)) return schema;
  const loader = yield* SchemaLoader;
  const seen = new Set<string>(schemaIri === undefined ? [] : [schemaIri]);
  const shapes: Array<ShExJ.ShapeDecl> = [...(schema.shapes ?? [])];
  const labels = new Set(shapes.map((s) => s.id));
  const queue = [...schema.imports];
  while (Arr.isReadonlyArrayNonEmpty(queue)) {
    const iri = queue.shift()!;
    if (seen.has(iri)) continue;
    seen.add(iri);
    const imported = yield* loader.load(iri);
    for (const d of imported.shapes ?? []) {
      if (labels.has(d.id)) continue;
      labels.add(d.id);
      shapes.push(d);
    }
    queue.push(...(imported.imports ?? []));
  }
  const { imports: _, ...rest } = schema;
  // SAFETY: dropping the optional `imports` (and re-adding `shapes` only when non-empty) leaves a
  // valid `ShExJ.Schema`; the spread just loses the nominal type.
  return (Arr.isReadonlyArrayNonEmpty(shapes) ? { ...rest, shapes } : rest) as ShExJ.Schema;
});

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

const isQueryMap = (map: ShapeMap.QueryShapeMap): boolean =>
  map.some((a) => a.node._tag === 'TriplePattern');

/**
 * Prepares a validator: loads imports through `SchemaLoader`, checks the
 * structural requirements and indexes the schema. Semantic actions are
 * dispatched to the `SemAct.SemActHandler` in scope when the validator is
 * made.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = Effect.fnUntraced(function* (schema: ShExJ.Schema, options: Options = {}) {
  const resolved = yield* resolveImports(schema, options.schemaIri);
  yield* Structure.check(resolved);
  const index = Structure.makeIndex(resolved);
  const baseHandler = yield* SemAct.SemActHandler;
  const handler =
    options.externalSemActs === undefined
      ? baseHandler
      : SemAct.withExternalCode(baseHandler, options.externalSemActs);
  const externs = new Map<string, ShExJ.ShapeDecl>();
  for (const d of options.externalShapes?.shapes ?? []) externs.set(d.id, d);

  const validate = (
    dataset: Dataset.Dataset,
    shapeMap: ShapeMap.QueryShapeMap,
  ): Effect.Effect<ValidationReport, ShExValidationError> =>
    Effect.suspend(() => {
      // SAFETY: `isQueryMap` is false, and a shape map is either a query map or a fixed map.
      const fixed = isQueryMap(shapeMap)
        ? ShapeMap.resolve(shapeMap, dataset)
        : (shapeMap as ShapeMap.FixedShapeMap);
      for (const a of fixed) {
        if (ShapeMap.isStart(a.shape)) {
          if (resolved.start === undefined)
            return Effect.fail(
              new ShExValidationError({
                message: 'the shape map uses START but the schema has no start',
              }),
            );
        } else if (!index.shapes.has(a.shape)) {
          return Effect.fail(
            new ShExValidationError({ message: `the schema does not declare shape ${a.shape}` }),
          );
        }
      }
      const engine = new Engine(index, dataset, handler, externs);
      const startFailure = engine.runSemActs(resolved.startActs, {
        site: 'start',
        node: undefined,
      });
      const results: Array<ShapeResult> = fixed.map((a) => {
        const reason =
          startFailure ??
          (ShapeMap.isStart(a.shape)
            ? engine.validateStart(a.node, new Set())
            : engine.validateLabel(a.node, a.shape, new Set()));
        return reason === undefined
          ? { node: a.node, shape: a.shape, status: 'conformant' }
          : { node: a.node, shape: a.shape, status: 'nonconformant', reason };
      });
      return Effect.succeed({
        results,
        conformant: results.every((r) => r.status === 'conformant'),
      });
    });

  // SAFETY: `satisfies Validator` checks the literal; the assertion only widens it to the
  // interface.
  return { schema: resolved, index, validate } satisfies Validator as Validator;
});

/**
 * Validates a shape map against a dataset with a schema.
 *
 * @since 0.1.0
 * @category validation
 */
export const validate = (
  dataset: Dataset.Dataset,
  schema: ShExJ.Schema,
  shapeMap: ShapeMap.QueryShapeMap,
  options: Options = {},
): Effect.Effect<ValidationReport, ShExValidationError | ShExImportError | ShExStructureError> =>
  Effect.flatMap(make(schema, options), (v) => v.validate(dataset, shapeMap));

/**
 * Validates a single node against a shape label (or `START`).
 *
 * @since 0.1.0
 * @category validation
 */
export const validateNode = (
  dataset: Dataset.Dataset,
  schema: ShExJ.Schema,
  node: Term.GroundTerm,
  shape: ShapeMap.ShapeSelector,
  options: Options = {},
): Effect.Effect<ShapeResult, ShExValidationError | ShExImportError | ShExStructureError> =>
  Effect.map(validate(dataset, schema, [{ node, shape }], options), (r) => r.results[0]!);
