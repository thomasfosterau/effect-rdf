/**
 * The ShExJ abstract syntax of ShEx schemas (ShEx 2.1, plus the ShEx 2.2
 * `EXTENDS` / `ABSTRACT` / `RESTRICTS` additions), as plain immutable
 * TypeScript values together with Effect `Schema`s that decode and encode
 * ShExJ JSON documents.
 *
 * Shape and triple expression labels are IRI strings or blank node labels
 * written `_:label`. A reference to a shape or triple expression is simply
 * its label (a string).
 *
 * @since 0.1.0
 */
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { ShExJError } from './ShExError.ts';

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * An IRI (absolute, after parsing) or a blank node label (`_:label`).
 *
 * @since 0.1.0
 * @category models
 */
export type Label = string;

/**
 * A ShEx schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface Schema {
  readonly type: 'Schema';
  readonly '@context'?: string;
  readonly imports?: ReadonlyArray<string>;
  readonly startActs?: ReadonlyArray<SemAct>;
  readonly start?: ShapeExprOrRef;
  readonly shapes?: ReadonlyArray<ShapeDecl>;
}

/**
 * A labelled shape expression declaration.
 *
 * @since 0.1.0
 * @category models
 */
export interface ShapeDecl {
  readonly type: 'ShapeDecl';
  readonly id: Label;
  readonly abstract?: boolean;
  readonly restricts?: ReadonlyArray<ShapeExprOrRef>;
  readonly shapeExpr: ShapeExprOrRef;
}

/**
 * @since 0.1.0
 * @category models
 */
export type ShapeExpr = ShapeOr | ShapeAnd | ShapeNot | NodeConstraint | Shape | ShapeExternal;

/**
 * A shape expression or a reference (label) to a declared shape expression.
 *
 * @since 0.1.0
 * @category models
 */
export type ShapeExprOrRef = ShapeExpr | Label;

/**
 * @since 0.1.0
 * @category models
 */
export interface ShapeOr {
  readonly type: 'ShapeOr';
  readonly shapeExprs: ReadonlyArray<ShapeExprOrRef>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface ShapeAnd {
  readonly type: 'ShapeAnd';
  readonly shapeExprs: ReadonlyArray<ShapeExprOrRef>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface ShapeNot {
  readonly type: 'ShapeNot';
  readonly shapeExpr: ShapeExprOrRef;
}

/**
 * A shape defined outside the schema (supplied by the validator).
 *
 * @since 0.1.0
 * @category models
 */
export interface ShapeExternal {
  readonly type: 'ShapeExternal';
}

/**
 * @since 0.1.0
 * @category models
 */
export type NodeKind = 'iri' | 'bnode' | 'nonliteral' | 'literal';

/**
 * XML Schema string and numeric facets.
 *
 * @since 0.1.0
 * @category models
 */
export interface Facets {
  readonly length?: number;
  readonly minlength?: number;
  readonly maxlength?: number;
  readonly pattern?: string;
  readonly flags?: string;
  readonly mininclusive?: number;
  readonly minexclusive?: number;
  readonly maxinclusive?: number;
  readonly maxexclusive?: number;
  readonly totaldigits?: number;
  readonly fractiondigits?: number;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface NodeConstraint extends Facets {
  readonly type: 'NodeConstraint';
  readonly nodeKind?: NodeKind;
  readonly datatype?: string;
  readonly values?: ReadonlyArray<ValueSetValue>;
  readonly semActs?: ReadonlyArray<SemAct>;
  readonly annotations?: ReadonlyArray<Annotation>;
}

/**
 * A literal in a value set or annotation. `type` is the datatype IRI (absent
 * for `xsd:string` and language-tagged strings).
 *
 * @since 0.1.0
 * @category models
 */
export interface ObjectLiteral {
  readonly value: string;
  readonly language?: string;
  readonly type?: string;
}

/**
 * An IRI (string) or a literal.
 *
 * @since 0.1.0
 * @category models
 */
export type ObjectValue = string | ObjectLiteral;

/**
 * @since 0.1.0
 * @category models
 */
export interface Wildcard {
  readonly type: 'Wildcard';
}

/**
 * @since 0.1.0
 * @category models
 */
export interface IriStem {
  readonly type: 'IriStem';
  readonly stem: string;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface IriStemRange {
  readonly type: 'IriStemRange';
  readonly stem: string | Wildcard;
  readonly exclusions: ReadonlyArray<string | IriStem>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface LiteralStem {
  readonly type: 'LiteralStem';
  readonly stem: string;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface LiteralStemRange {
  readonly type: 'LiteralStemRange';
  readonly stem: string | Wildcard;
  readonly exclusions: ReadonlyArray<string | LiteralStem>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Language {
  readonly type: 'Language';
  readonly languageTag: string;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface LanguageStem {
  readonly type: 'LanguageStem';
  readonly stem: string;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface LanguageStemRange {
  readonly type: 'LanguageStemRange';
  readonly stem: string | Wildcard;
  readonly exclusions: ReadonlyArray<string | LanguageStem>;
}

/**
 * @since 0.1.0
 * @category models
 */
export type ValueSetValue =
  | ObjectValue
  | IriStem
  | IriStemRange
  | LiteralStem
  | LiteralStemRange
  | Language
  | LanguageStem
  | LanguageStemRange;

/**
 * @since 0.1.0
 * @category models
 */
export interface Shape {
  readonly type: 'Shape';
  readonly closed?: boolean;
  readonly extends?: ReadonlyArray<ShapeExprOrRef>;
  readonly extra?: ReadonlyArray<string>;
  readonly expression?: TripleExprOrRef;
  readonly semActs?: ReadonlyArray<SemAct>;
  readonly annotations?: ReadonlyArray<Annotation>;
}

/**
 * @since 0.1.0
 * @category models
 */
export type TripleExpr = EachOf | OneOf | TripleConstraint;

/**
 * A triple expression or a reference (inclusion, `&label`) to a labelled
 * triple expression.
 *
 * @since 0.1.0
 * @category models
 */
export type TripleExprOrRef = TripleExpr | Label;

/**
 * Cardinality: `max` of `-1` means unbounded. Both default to 1.
 *
 * @since 0.1.0
 * @category models
 */
export interface Cardinality {
  readonly min?: number;
  readonly max?: number;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface EachOf extends Cardinality {
  readonly type: 'EachOf';
  readonly id?: Label;
  readonly expressions: ReadonlyArray<TripleExprOrRef>;
  readonly semActs?: ReadonlyArray<SemAct>;
  readonly annotations?: ReadonlyArray<Annotation>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface OneOf extends Cardinality {
  readonly type: 'OneOf';
  readonly id?: Label;
  readonly expressions: ReadonlyArray<TripleExprOrRef>;
  readonly semActs?: ReadonlyArray<SemAct>;
  readonly annotations?: ReadonlyArray<Annotation>;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface TripleConstraint extends Cardinality {
  readonly type: 'TripleConstraint';
  readonly id?: Label;
  readonly inverse?: boolean;
  readonly predicate: string;
  readonly valueExpr?: ShapeExprOrRef;
  readonly semActs?: ReadonlyArray<SemAct>;
  readonly annotations?: ReadonlyArray<Annotation>;
}

/**
 * A semantic action.
 *
 * @since 0.1.0
 * @category models
 */
export interface SemAct {
  readonly type: 'SemAct';
  readonly name: string;
  readonly code?: string;
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Annotation {
  readonly type: 'Annotation';
  readonly predicate: string;
  readonly object: ObjectValue;
}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const opt = Schema.optionalKey;
const Int = Schema.Int;
const atLeast2 = <S extends Schema.Top>(s: S) => Schema.Array(s).check(Schema.isMinLength(2));
const atLeast1 = <S extends Schema.Top>(s: S) => Schema.Array(s).check(Schema.isMinLength(1));

/**
 * @since 0.1.0
 * @category schemas
 */
export const SemActSchema: Schema.Codec<SemAct> = Schema.Struct({
  type: Schema.Literal('SemAct'),
  name: Schema.String,
  code: opt(Schema.String),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ObjectLiteralSchema: Schema.Codec<ObjectLiteral> = Schema.Struct({
  value: Schema.String,
  language: opt(Schema.String),
  type: opt(Schema.String),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ObjectValueSchema: Schema.Codec<ObjectValue> = Schema.Union([
  Schema.String,
  ObjectLiteralSchema,
]);

/**
 * @since 0.1.0
 * @category schemas
 */
export const AnnotationSchema: Schema.Codec<Annotation> = Schema.Struct({
  type: Schema.Literal('Annotation'),
  predicate: Schema.String,
  object: ObjectValueSchema,
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const WildcardSchema: Schema.Codec<Wildcard> = Schema.Struct({
  type: Schema.Literal('Wildcard'),
});

const stem = <T extends string>(type: T) =>
  Schema.Struct({ type: Schema.Literal(type), stem: Schema.String });

/**
 * @since 0.1.0
 * @category schemas
 */
export const IriStemSchema: Schema.Codec<IriStem> = stem('IriStem');

/**
 * @since 0.1.0
 * @category schemas
 */
export const LiteralStemSchema: Schema.Codec<LiteralStem> = stem('LiteralStem');

/**
 * @since 0.1.0
 * @category schemas
 */
export const LanguageStemSchema: Schema.Codec<LanguageStem> = stem('LanguageStem');

/**
 * @since 0.1.0
 * @category schemas
 */
export const IriStemRangeSchema: Schema.Codec<IriStemRange> = Schema.Struct({
  type: Schema.Literal('IriStemRange'),
  stem: Schema.Union([Schema.String, WildcardSchema]),
  exclusions: Schema.Array(Schema.Union([Schema.String, IriStemSchema])),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const LiteralStemRangeSchema: Schema.Codec<LiteralStemRange> = Schema.Struct({
  type: Schema.Literal('LiteralStemRange'),
  stem: Schema.Union([Schema.String, WildcardSchema]),
  exclusions: Schema.Array(Schema.Union([Schema.String, LiteralStemSchema])),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const LanguageSchema: Schema.Codec<Language> = Schema.Struct({
  type: Schema.Literal('Language'),
  languageTag: Schema.String,
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const LanguageStemRangeSchema: Schema.Codec<LanguageStemRange> = Schema.Struct({
  type: Schema.Literal('LanguageStemRange'),
  stem: Schema.Union([Schema.String, WildcardSchema]),
  exclusions: Schema.Array(Schema.Union([Schema.String, LanguageStemSchema])),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ValueSetValueSchema: Schema.Codec<ValueSetValue> = Schema.Union([
  Schema.String,
  IriStemSchema,
  IriStemRangeSchema,
  LiteralStemSchema,
  LiteralStemRangeSchema,
  LanguageSchema,
  LanguageStemSchema,
  LanguageStemRangeSchema,
  ObjectLiteralSchema,
]);

const shapeExprOrRef: Schema.Codec<ShapeExprOrRef> = Schema.suspend(
  (): Schema.Codec<ShapeExprOrRef> => ShapeExprOrRefSchema,
);
const tripleExprOrRef: Schema.Codec<TripleExprOrRef> = Schema.suspend(
  (): Schema.Codec<TripleExprOrRef> => TripleExprOrRefSchema,
);

/**
 * @since 0.1.0
 * @category schemas
 */
export const NodeConstraintSchema: Schema.Codec<NodeConstraint> = Schema.Struct({
  type: Schema.Literal('NodeConstraint'),
  nodeKind: opt(Schema.Literals(['iri', 'bnode', 'nonliteral', 'literal'])),
  datatype: opt(Schema.String),
  length: opt(Int),
  minlength: opt(Int),
  maxlength: opt(Int),
  pattern: opt(Schema.String),
  flags: opt(Schema.String),
  mininclusive: opt(Schema.Number),
  minexclusive: opt(Schema.Number),
  maxinclusive: opt(Schema.Number),
  maxexclusive: opt(Schema.Number),
  totaldigits: opt(Int),
  fractiondigits: opt(Int),
  values: opt(Schema.Array(ValueSetValueSchema)),
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeExternalSchema: Schema.Codec<ShapeExternal> = Schema.Struct({
  type: Schema.Literal('ShapeExternal'),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeOrSchema: Schema.Codec<ShapeOr> = Schema.Struct({
  type: Schema.Literal('ShapeOr'),
  shapeExprs: atLeast2(shapeExprOrRef),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeAndSchema: Schema.Codec<ShapeAnd> = Schema.Struct({
  type: Schema.Literal('ShapeAnd'),
  shapeExprs: atLeast2(shapeExprOrRef),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeNotSchema: Schema.Codec<ShapeNot> = Schema.Struct({
  type: Schema.Literal('ShapeNot'),
  shapeExpr: shapeExprOrRef,
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeSchema: Schema.Codec<Shape> = Schema.Struct({
  type: Schema.Literal('Shape'),
  closed: opt(Schema.Boolean),
  extends: opt(atLeast1(shapeExprOrRef)),
  extra: opt(atLeast1(Schema.String)),
  expression: opt(tripleExprOrRef),
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeExprSchema: Schema.Codec<ShapeExpr> = Schema.Union([
  ShapeOrSchema,
  ShapeAndSchema,
  ShapeNotSchema,
  NodeConstraintSchema,
  ShapeSchema,
  ShapeExternalSchema,
]);

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeExprOrRefSchema: Schema.Codec<ShapeExprOrRef> = Schema.Union([
  Schema.String,
  ShapeExprSchema,
]);

const cardinalityFields = {
  min: opt(Int),
  max: opt(Int),
};

/**
 * @since 0.1.0
 * @category schemas
 */
export const TripleConstraintSchema: Schema.Codec<TripleConstraint> = Schema.Struct({
  type: Schema.Literal('TripleConstraint'),
  id: opt(Schema.String),
  inverse: opt(Schema.Boolean),
  predicate: Schema.String,
  valueExpr: opt(shapeExprOrRef),
  ...cardinalityFields,
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const EachOfSchema: Schema.Codec<EachOf> = Schema.Struct({
  type: Schema.Literal('EachOf'),
  id: opt(Schema.String),
  expressions: atLeast1(tripleExprOrRef),
  ...cardinalityFields,
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const OneOfSchema: Schema.Codec<OneOf> = Schema.Struct({
  type: Schema.Literal('OneOf'),
  id: opt(Schema.String),
  expressions: atLeast1(tripleExprOrRef),
  ...cardinalityFields,
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const TripleExprSchema: Schema.Codec<TripleExpr> = Schema.Union([
  EachOfSchema,
  OneOfSchema,
  TripleConstraintSchema,
]);

/**
 * @since 0.1.0
 * @category schemas
 */
export const TripleExprOrRefSchema: Schema.Codec<TripleExprOrRef> = Schema.Union([
  Schema.String,
  TripleExprSchema,
]);

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeDeclSchema: Schema.Codec<ShapeDecl> = Schema.Struct({
  type: Schema.Literal('ShapeDecl'),
  id: Schema.String,
  abstract: opt(Schema.Boolean),
  restricts: opt(atLeast1(ShapeExprOrRefSchema)),
  shapeExpr: ShapeExprOrRefSchema,
});

/**
 * The schema of a complete ShExJ document.
 *
 * @since 0.1.0
 * @category schemas
 */
export const SchemaSchema: Schema.Codec<Schema> = Schema.Struct({
  type: Schema.Literal('Schema'),
  '@context': opt(Schema.String),
  imports: opt(atLeast1(Schema.String)),
  startActs: opt(atLeast1(SemActSchema)),
  start: opt(ShapeExprOrRefSchema),
  shapes: opt(atLeast1(ShapeDeclSchema)),
});

/**
 * The ShEx JSON-LD context IRI.
 *
 * @since 0.1.0
 * @category constants
 */
export const context = 'http://www.w3.org/ns/shex.jsonld';

// -----------------------------------------------------------------------------
// Decoding / encoding
// -----------------------------------------------------------------------------

/**
 * Decodes and validates an already-parsed JSON value as a ShExJ schema.
 *
 * @since 0.1.0
 * @category decoding
 */
export const decode = (input: unknown): Effect.Effect<Schema, ShExJError> =>
  Schema.decodeUnknownEffect(SchemaSchema)(input).pipe(
    Effect.mapError((e) => new ShExJError({ message: e.message })),
  );

/**
 * Parses and validates a ShExJ JSON document.
 *
 * @since 0.1.0
 * @category decoding
 */
export const parse = (input: string): Effect.Effect<Schema, ShExJError> =>
  Effect.try({
    try: () => JSON.parse(input) as unknown,
    catch: (e) => new ShExJError({ message: `invalid JSON: ${String(e)}` }),
  }).pipe(Effect.flatMap(decode));

/**
 * Encodes a schema as a ShExJ JSON value (adding the JSON-LD `@context`).
 *
 * @since 0.1.0
 * @category encoding
 */
export const toJson = (schema: Schema): unknown => {
  const { '@context': _, ...rest } = schema;
  return { '@context': context, ...rest };
};

/**
 * Serialises a schema as a ShExJ JSON document.
 *
 * @since 0.1.0
 * @category encoding
 */
export const stringify = (schema: Schema, space: number | string = 2): string =>
  JSON.stringify(toJson(schema), null, space);

// -----------------------------------------------------------------------------
// IRI mapping
// -----------------------------------------------------------------------------

/**
 * Applies `f` to every IRI in a schema (labels, predicates, datatypes, value
 * set IRIs and stems, imports, semantic action names and annotations). Blank
 * node labels are left untouched.
 *
 * @since 0.1.0
 * @category combinators
 */
export const mapIris = (schema: Schema, f: (iri: string) => string): Schema => {
  const label = (l: string) => (isBlankLabel(l) ? l : f(l));
  const objectValue = (v: ObjectValue): ObjectValue =>
    typeof v === 'string' ? f(v) : v.type === undefined ? v : { ...v, type: f(v.type) };
  const semActs = (acts: ReadonlyArray<SemAct> | undefined) =>
    acts?.map((a) => ({ ...a, name: f(a.name) }));
  const annotations = (as: ReadonlyArray<Annotation> | undefined) =>
    as?.map((a) => ({ ...a, predicate: f(a.predicate), object: objectValue(a.object) }));
  const withMeta = <T extends { semActs?: unknown; annotations?: unknown }>(
    t: T,
    acts: ReadonlyArray<SemAct> | undefined,
    annots: ReadonlyArray<Annotation> | undefined,
  ): T => {
    const out: any = { ...t };
    if (acts !== undefined) out.semActs = semActs(acts);
    if (annots !== undefined) out.annotations = annotations(annots);
    return out;
  };
  const value = (v: ValueSetValue): ValueSetValue => {
    if (typeof v === 'string') return f(v);
    if (isObjectLiteral(v)) return objectValue(v);
    switch (v.type) {
      case 'IriStem':
        return { ...v, stem: f(v.stem) };
      case 'IriStemRange':
        return {
          ...v,
          stem: typeof v.stem === 'string' ? f(v.stem) : v.stem,
          exclusions: v.exclusions.map((e) =>
            typeof e === 'string' ? f(e) : { ...e, stem: f(e.stem) },
          ),
        };
      default:
        return v;
    }
  };
  const shapeExpr = (e: ShapeExprOrRef): ShapeExprOrRef => {
    if (typeof e === 'string') return label(e);
    switch (e.type) {
      case 'ShapeOr':
      case 'ShapeAnd':
        return { ...e, shapeExprs: e.shapeExprs.map(shapeExpr) };
      case 'ShapeNot':
        return { ...e, shapeExpr: shapeExpr(e.shapeExpr) };
      case 'ShapeExternal':
        return e;
      case 'NodeConstraint': {
        const out: any = withMeta(e, e.semActs, e.annotations);
        if (e.datatype !== undefined) out.datatype = f(e.datatype);
        if (e.values !== undefined) out.values = e.values.map(value);
        return out;
      }
      case 'Shape': {
        const out: any = withMeta(e, e.semActs, e.annotations);
        if (e.extends !== undefined) out.extends = e.extends.map(shapeExpr);
        if (e.extra !== undefined) out.extra = e.extra.map(f);
        if (e.expression !== undefined) out.expression = tripleExpr(e.expression);
        return out;
      }
    }
  };
  const tripleExpr = (t: TripleExprOrRef): TripleExprOrRef => {
    if (typeof t === 'string') return label(t);
    const out: any = withMeta(t, t.semActs, t.annotations);
    if (t.id !== undefined) out.id = label(t.id);
    if (t.type === 'TripleConstraint') {
      out.predicate = f(t.predicate);
      if (t.valueExpr !== undefined) out.valueExpr = shapeExpr(t.valueExpr);
    } else {
      out.expressions = t.expressions.map(tripleExpr);
    }
    return out;
  };
  const out: any = { ...schema };
  if (schema.imports !== undefined) out.imports = schema.imports.map(f);
  if (schema.startActs !== undefined) out.startActs = semActs(schema.startActs);
  if (schema.start !== undefined) out.start = shapeExpr(schema.start);
  if (schema.shapes !== undefined)
    out.shapes = schema.shapes.map((d) => {
      const decl: any = { ...d, id: label(d.id), shapeExpr: shapeExpr(d.shapeExpr) };
      if (d.restricts !== undefined) decl.restricts = d.restricts.map(shapeExpr);
      return decl;
    });
  return out;
};

/**
 * Resolves every relative IRI of a schema (e.g. one read from a ShExJ file)
 * against a base IRI.
 *
 * @since 0.1.0
 * @category combinators
 */
export const resolveIris = (schema: Schema, base: string): Schema =>
  mapIris(schema, (iri) => (Iri.isAbsolute(iri) ? iri : Iri.resolve(iri, base)));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Whether a label is a blank node label (`_:x`).
 *
 * @since 0.1.0
 * @category guards
 */
export const isBlankLabel = (label: Label): boolean => label.startsWith('_:');

/**
 * Whether a value set value is an `ObjectLiteral`.
 *
 * @since 0.1.0
 * @category guards
 */
export const isObjectLiteral = (v: unknown): v is ObjectLiteral =>
  typeof v === 'object' && v !== null && 'value' in v;

/**
 * Normalised cardinality, with `max` of `-1` (unbounded) mapped to
 * `Infinity`.
 *
 * @since 0.1.0
 * @category utils
 */
export const cardinality = (c: Cardinality): { readonly min: number; readonly max: number } => {
  const min = c.min ?? 1;
  const max = c.max === undefined ? 1 : c.max === -1 ? Infinity : c.max;
  return { min, max };
};
