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
import * as Result from 'effect/Result';
import * as S from 'effect/Schema';
import { ShExJError } from './ShExError.ts';
import * as Json from './internal/json.ts';

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

const opt = S.optionalKey;
const Int = S.Int;
const atLeast2 = <S extends S.Top>(s: S) => S.Array(s).check(S.isMinLength(2));
const atLeast1 = <S extends S.Top>(s: S) => S.Array(s).check(S.isMinLength(1));

/**
 * @since 0.1.0
 * @category schemas
 */
export const SemActSchema: S.Codec<SemAct> = S.Struct({
  type: S.Literal('SemAct'),
  name: S.String,
  code: opt(S.String),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ObjectLiteralSchema: S.Codec<ObjectLiteral> = S.Struct({
  value: S.String,
  language: opt(S.String),
  type: opt(S.String),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ObjectValueSchema: S.Codec<ObjectValue> = S.Union([S.String, ObjectLiteralSchema]);

/**
 * @since 0.1.0
 * @category schemas
 */
export const AnnotationSchema: S.Codec<Annotation> = S.Struct({
  type: S.Literal('Annotation'),
  predicate: S.String,
  object: ObjectValueSchema,
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const WildcardSchema: S.Codec<Wildcard> = S.Struct({
  type: S.Literal('Wildcard'),
});

const stem = <T extends string>(type: T) => S.Struct({ type: S.Literal(type), stem: S.String });

/**
 * @since 0.1.0
 * @category schemas
 */
export const IriStemSchema: S.Codec<IriStem> = stem('IriStem');

/**
 * @since 0.1.0
 * @category schemas
 */
export const LiteralStemSchema: S.Codec<LiteralStem> = stem('LiteralStem');

/**
 * @since 0.1.0
 * @category schemas
 */
export const LanguageStemSchema: S.Codec<LanguageStem> = stem('LanguageStem');

/**
 * @since 0.1.0
 * @category schemas
 */
export const IriStemRangeSchema: S.Codec<IriStemRange> = S.Struct({
  type: S.Literal('IriStemRange'),
  stem: S.Union([S.String, WildcardSchema]),
  exclusions: S.Array(S.Union([S.String, IriStemSchema])),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const LiteralStemRangeSchema: S.Codec<LiteralStemRange> = S.Struct({
  type: S.Literal('LiteralStemRange'),
  stem: S.Union([S.String, WildcardSchema]),
  exclusions: S.Array(S.Union([S.String, LiteralStemSchema])),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const LanguageSchema: S.Codec<Language> = S.Struct({
  type: S.Literal('Language'),
  languageTag: S.String,
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const LanguageStemRangeSchema: S.Codec<LanguageStemRange> = S.Struct({
  type: S.Literal('LanguageStemRange'),
  stem: S.Union([S.String, WildcardSchema]),
  exclusions: S.Array(S.Union([S.String, LanguageStemSchema])),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ValueSetValueSchema: S.Codec<ValueSetValue> = S.Union([
  S.String,
  IriStemSchema,
  IriStemRangeSchema,
  LiteralStemSchema,
  LiteralStemRangeSchema,
  LanguageSchema,
  LanguageStemSchema,
  LanguageStemRangeSchema,
  ObjectLiteralSchema,
]);

const shapeExprOrRef: S.Codec<ShapeExprOrRef> = S.suspend(
  (): S.Codec<ShapeExprOrRef> => ShapeExprOrRefSchema,
);
const tripleExprOrRef: S.Codec<TripleExprOrRef> = S.suspend(
  (): S.Codec<TripleExprOrRef> => TripleExprOrRefSchema,
);

/**
 * @since 0.1.0
 * @category schemas
 */
export const NodeConstraintSchema: S.Codec<NodeConstraint> = S.Struct({
  type: S.Literal('NodeConstraint'),
  nodeKind: opt(S.Literals(['iri', 'bnode', 'nonliteral', 'literal'])),
  datatype: opt(S.String),
  length: opt(Int),
  minlength: opt(Int),
  maxlength: opt(Int),
  pattern: opt(S.String),
  flags: opt(S.String),
  mininclusive: opt(S.Number),
  minexclusive: opt(S.Number),
  maxinclusive: opt(S.Number),
  maxexclusive: opt(S.Number),
  totaldigits: opt(Int),
  fractiondigits: opt(Int),
  values: opt(S.Array(ValueSetValueSchema)),
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeExternalSchema: S.Codec<ShapeExternal> = S.Struct({
  type: S.Literal('ShapeExternal'),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeOrSchema: S.Codec<ShapeOr> = S.Struct({
  type: S.Literal('ShapeOr'),
  shapeExprs: atLeast2(shapeExprOrRef),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeAndSchema: S.Codec<ShapeAnd> = S.Struct({
  type: S.Literal('ShapeAnd'),
  shapeExprs: atLeast2(shapeExprOrRef),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeNotSchema: S.Codec<ShapeNot> = S.Struct({
  type: S.Literal('ShapeNot'),
  shapeExpr: shapeExprOrRef,
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeSchema: S.Codec<Shape> = S.Struct({
  type: S.Literal('Shape'),
  closed: opt(S.Boolean),
  extends: opt(atLeast1(shapeExprOrRef)),
  extra: opt(atLeast1(S.String)),
  expression: opt(tripleExprOrRef),
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeExprSchema: S.Codec<ShapeExpr> = S.Union([
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
export const ShapeExprOrRefSchema: S.Codec<ShapeExprOrRef> = S.Union([S.String, ShapeExprSchema]);

const cardinalityFields = {
  min: opt(Int),
  max: opt(Int),
};

/**
 * @since 0.1.0
 * @category schemas
 */
export const TripleConstraintSchema: S.Codec<TripleConstraint> = S.Struct({
  type: S.Literal('TripleConstraint'),
  id: opt(S.String),
  inverse: opt(S.Boolean),
  predicate: S.String,
  valueExpr: opt(shapeExprOrRef),
  ...cardinalityFields,
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const EachOfSchema: S.Codec<EachOf> = S.Struct({
  type: S.Literal('EachOf'),
  id: opt(S.String),
  expressions: atLeast1(tripleExprOrRef),
  ...cardinalityFields,
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const OneOfSchema: S.Codec<OneOf> = S.Struct({
  type: S.Literal('OneOf'),
  id: opt(S.String),
  expressions: atLeast1(tripleExprOrRef),
  ...cardinalityFields,
  semActs: opt(atLeast1(SemActSchema)),
  annotations: opt(atLeast1(AnnotationSchema)),
});

/**
 * @since 0.1.0
 * @category schemas
 */
export const TripleExprSchema: S.Codec<TripleExpr> = S.Union([
  EachOfSchema,
  OneOfSchema,
  TripleConstraintSchema,
]);

/**
 * @since 0.1.0
 * @category schemas
 */
export const TripleExprOrRefSchema: S.Codec<TripleExprOrRef> = S.Union([
  S.String,
  TripleExprSchema,
]);

/**
 * @since 0.1.0
 * @category schemas
 */
export const ShapeDeclSchema: S.Codec<ShapeDecl> = S.Struct({
  type: S.Literal('ShapeDecl'),
  id: S.String,
  abstract: opt(S.Boolean),
  restricts: opt(atLeast1(ShapeExprOrRefSchema)),
  shapeExpr: ShapeExprOrRefSchema,
});

/**
 * The schema of a complete ShExJ document.
 *
 * @since 0.1.0
 * @category schemas
 */
export const SchemaSchema: S.Codec<Schema> = S.Struct({
  type: S.Literal('Schema'),
  '@context': opt(S.String),
  imports: opt(atLeast1(S.String)),
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
  S.decodeUnknownEffect(SchemaSchema)(input).pipe(
    Effect.mapError((e) => new ShExJError({ message: e.message })),
  );

/**
 * Parses and validates a ShExJ JSON document.
 *
 * @since 0.1.0
 * @category decoding
 */
export const parse = (input: string): Effect.Effect<Schema, ShExJError> =>
  Result.match(Json.parse(input), {
    onFailure: (e) => Effect.fail(new ShExJError({ message: `invalid JSON: ${e}` })),
    onSuccess: decode,
  });

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
  S.encodeSync(S.fromJsonString(S.Unknown, { space }))(toJson(schema));

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
    let out: T = { ...t };
    if (acts !== undefined) out = { ...out, semActs: semActs(acts) };
    if (annots !== undefined) out = { ...out, annotations: annotations(annots) };
    return out;
  };
  const value = (v: ValueSetValue): ValueSetValue => {
    if (typeof v === 'string') return f(v);
    if ('value' in v) return objectValue(v);
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
 * Inclusive repetition bounds of a triple expression; `max` may be
 * `Infinity`.
 *
 * @since 0.1.0
 * @category utils
 */
export interface Bounds {
  readonly min: number;
  readonly max: number;
}

/**
 * Normalised cardinality, with `max` of `-1` (unbounded) mapped to
 * `Infinity`.
 *
 * @since 0.1.0
 * @category utils
 */
export const cardinality = (c: Cardinality): Bounds => {
  const min = c.min ?? 1;
  const max = c.max === undefined ? 1 : c.max === -1 ? Infinity : c.max;
  return { min, max };
};
