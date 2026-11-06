/**
 * ShExR: the RDF representation of ShEx schemas (vocabulary
 * `http://www.w3.org/ns/shex#`). Reads a schema from a core `Dataset` and
 * writes a schema as RDF quads.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as Dataset from '../Dataset.ts';
import * as Term from '../Term.ts';
import { ShExRError } from './ShExError.ts';
import * as ShExJ from './ShExJ.ts';

/**
 * The ShEx vocabulary namespace.
 *
 * @since 0.1.0
 * @category constants
 */
export const SX = 'http://www.w3.org/ns/shex#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const sx = (local: string) => Term.namedNode(SX + local);
const rdfType = Term.namedNode(`${RDF}type`);
const rdfFirst = Term.namedNode(`${RDF}first`);
const rdfRest = Term.namedNode(`${RDF}rest`);
const rdfNil = Term.namedNode(`${RDF}nil`);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

class Fail extends Error {}

const integerFacetNames = [
  'length',
  'minlength',
  'maxlength',
  'totaldigits',
  'fractiondigits',
] as const;
const rangeFacetNames = ['mininclusive', 'minexclusive', 'maxinclusive', 'maxexclusive'] as const;
// In the order the reader has always read them.
const numericFacetNames = [
  'length',
  'minlength',
  'maxlength',
  'mininclusive',
  'minexclusive',
  'maxinclusive',
  'maxexclusive',
  'totaldigits',
  'fractiondigits',
] as const;

const valueSetTypes = MutableHashSet.make(
  'IriStem',
  'IriStemRange',
  'LiteralStem',
  'LiteralStemRange',
  'Language',
  'LanguageStem',
  'LanguageStemRange',
);

const decodeValueSetValue = Schema.decodeUnknownOption(ShExJ.ValueSetValueSchema);

/** A stem or stem-range value as read, before it is checked against its kind. */
interface RawValueSetValue {
  readonly type: string;
  readonly stem: string | ShExJ.Wildcard;
  readonly exclusions?: ReadonlyArray<string | { readonly type: string; readonly stem: string }>;
}

/** The fields a ShExJ object may carry its semantic actions and annotations in. */
interface Meta {
  semActs?: ReadonlyArray<ShExJ.SemAct>;
  annotations?: ReadonlyArray<ShExJ.Annotation>;
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

class Reader {
  readonly teDefined = MutableHashSet.empty<string>();
  readonly teUses = MutableHashMap.empty<string, number>();

  readonly expressionSites = MutableHashSet.empty<string>();

  readonly dataset: Dataset.Dataset;
  constructor(dataset: Dataset.Dataset) {
    this.dataset = dataset;
    Dataset.match(dataset, { predicate: sx('expression') }).forEach((q) => {
      this.countUse(q.object);
      MutableHashSet.add(this.expressionSites, q.object.key);
    });
    Dataset.match(dataset, { predicate: rdfFirst }).forEach((q) => this.countUse(q.object));
  }

  uses(t: Term.Term): number {
    return Option.getOrElse(MutableHashMap.get(this.teUses, t.key), () => 0);
  }

  countUse(t: Term.Term): void {
    MutableHashMap.set(this.teUses, t.key, this.uses(t) + 1);
  }

  fail(message: string): never {
    throw new Fail(message);
  }

  types(n: Term.Term): ReadonlyArray<string> {
    if (!Term.isResource(n)) return [];
    return Dataset.objectsOf(this.dataset, n, rdfType).map((t) =>
      Term.isNamedNode(t) ? t.value : '',
    );
  }

  hasType(n: Term.Term, local: string): boolean {
    return this.types(n).includes(SX + local);
  }

  one(n: Term.Term, p: string): Option.Option<Term.Object> {
    if (!Term.isResource(n)) return Option.none();
    const os = Dataset.objectsOf(this.dataset, n, sx(p));
    if (os.length > 1) this.fail(`${n.key} has several sx:${p} values`);
    return Arr.head(os);
  }

  /** The value of a required property. */
  required(n: Term.Term, p: string, message: string): Term.Object {
    return Option.getOrElse(this.one(n, p), () => this.fail(message));
  }

  all(n: Term.Term, p: string): ReadonlyArray<Term.Object> {
    if (!Term.isResource(n)) return [];
    return Dataset.objectsOf(this.dataset, n, sx(p));
  }

  list(n: Option.Option<Term.Object>): ReadonlyArray<Term.Object> {
    return Option.match(n, {
      onNone: () => [],
      onSome: (head) =>
        Option.getOrElse(Dataset.list(this.dataset, head), () =>
          this.fail(`${head.key} is not a well-formed RDF list`),
        ),
    });
  }

  label(n: Term.Term): string {
    if (Term.isNamedNode(n)) return n.value;
    if (Term.isBlankNode(n)) return `_:${n.value}`;
    return this.fail(`${n.key} cannot be a label`);
  }

  iri(n: Option.Option<Term.Term>, what: string): string {
    const t = Option.getOrUndefined(n);
    if (!Term.isNamedNode(t)) return this.fail(`expected an IRI for ${what}`);
    return t.value;
  }

  str(n: Option.Option<Term.Term>, what: string): string {
    const t = Option.getOrUndefined(n);
    if (!Term.isLiteral(t)) return this.fail(`expected a literal for ${what}`);
    return t.value;
  }

  num(n: Option.Option<Term.Term>, what: string): number {
    const v = Number(this.str(n, what));
    if (Number.isNaN(v)) this.fail(`expected a number for ${what}`);
    return v;
  }

  bool(n: Option.Option<Term.Term>): boolean {
    return Option.exists(n, (t) => Term.isLiteral(t) && (t.value === 'true' || t.value === '1'));
  }

  objectValue(n: Term.Term): ShExJ.ObjectValue {
    if (Term.isNamedNode(n)) return n.value;
    if (Term.isLiteral(n)) {
      if (n.language !== '') return { value: n.value, language: n.language };
      if (n.datatype.value === `${XSD}string`) return { value: n.value };
      return { value: n.value, type: n.datatype.value };
    }
    return this.fail(`${n.key} is not an IRI or literal`);
  }

  annotations(n: Term.Term): Option.Option<ReadonlyArray<ShExJ.Annotation>> {
    return Option.map(this.one(n, 'annotation'), (l) =>
      this.list(Option.some(l)).map((a) => ({
        type: 'Annotation',
        predicate: this.iri(this.one(a, 'predicate'), 'sx:predicate'),
        object: this.objectValue(this.required(a, 'object', 'annotation without sx:object')),
      })),
    );
  }

  meta(n: Term.Term, out: Meta): void {
    const acts = this.semActsOf(n, 'semActs');
    const annots = this.annotations(n);
    if (Option.isSome(acts)) out.semActs = acts.value;
    if (Option.isSome(annots)) out.annotations = annots.value;
  }

  /** A shape expression or a reference to a declaration. */
  shapeDeclOrExpr(n: Term.Term): ShExJ.ShapeExprOrRef {
    const types = this.types(n);
    if (types.includes(`${SX}ShapeDecl`) || Arr.isReadonlyArrayEmpty(types)) return this.label(n);
    return this.shapeExpr(n);
  }

  shapeExpr(n: Term.Term): ShExJ.ShapeExpr {
    const types = this.types(n);
    if (types.includes(`${SX}ShapeOr`) || types.includes(`${SX}ShapeAnd`)) {
      const type = types.includes(`${SX}ShapeOr`) ? 'ShapeOr' : 'ShapeAnd';
      return {
        type,
        shapeExprs: this.list(this.one(n, 'shapeExprs')).map((x) => this.shapeDeclOrExpr(x)),
      };
    }
    if (types.includes(`${SX}ShapeNot`))
      return {
        type: 'ShapeNot',
        shapeExpr: this.shapeDeclOrExpr(
          this.required(n, 'shapeExpr', 'ShapeNot without sx:shapeExpr'),
        ),
      };
    if (types.includes(`${SX}ShapeExternal`)) return { type: 'ShapeExternal' };
    if (types.includes(`${SX}NodeConstraint`)) return this.nodeConstraint(n);
    if (types.includes(`${SX}Shape`)) return this.shape(n);
    return this.fail(`${n.key} is not a shape expression`);
  }

  nodeConstraint(n: Term.Term): ShExJ.NodeConstraint {
    const nc: Mutable<ShExJ.NodeConstraint> = { type: 'NodeConstraint' };
    const kind = this.one(n, 'nodeKind');
    if (Option.isSome(kind)) {
      const k = this.iri(kind, 'sx:nodeKind').slice(SX.length);
      if (k !== 'iri' && k !== 'bnode' && k !== 'literal' && k !== 'nonliteral')
        this.fail(`unknown node kind ${kind.value.key}`);
      nc.nodeKind = k;
    }
    const dt = this.one(n, 'datatype');
    if (Option.isSome(dt)) nc.datatype = this.iri(dt, 'sx:datatype');
    numericFacetNames.forEach((f) => {
      const v = this.one(n, f);
      if (Option.isSome(v)) nc[f] = this.num(v, `sx:${f}`);
    });
    const pattern = this.one(n, 'pattern');
    if (Option.isSome(pattern)) nc.pattern = this.str(pattern, 'sx:pattern');
    const flags = this.one(n, 'flags');
    if (Option.isSome(flags)) nc.flags = this.str(flags, 'sx:flags');
    const values = this.one(n, 'values');
    if (Option.isSome(values)) nc.values = this.list(values).map((v) => this.valueSetValue(v));
    this.meta(n, nc);
    return nc;
  }

  stem(n: Term.Term): string | ShExJ.Wildcard {
    if (this.hasType(n, 'Wildcard')) return { type: 'Wildcard' };
    return Term.isNamedNode(n) ? n.value : this.str(Option.some(n), 'sx:stem');
  }

  valueSetValue(n: Term.Term): ShExJ.ValueSetValue {
    if (Term.isLiteral(n)) return this.objectValue(n);
    const found = Arr.findFirst(
      this.types(n).map((x) => x.slice(SX.length)),
      (x) => MutableHashSet.has(valueSetTypes, x),
    );
    if (Option.isNone(found) || Term.isNamedNode(n)) return this.objectValue(n);
    const t = found.value;
    const stem = () => this.stem(this.required(n, 'stem', `${t} without sx:stem`));
    const exclusions = () =>
      this.list(this.one(n, 'exclusion')).map((e) =>
        Term.isLiteral(e) || Term.isNamedNode(e)
          ? e.value
          : {
              type: (this.types(e)[0] ?? `${SX}IriStem`).slice(SX.length),
              stem: this.str(this.one(e, 'stem'), 'sx:stem'),
            },
      );
    // The stem kinds carry a string stem, the stem-range kinds a stem and their exclusions.
    const decoded = (value: RawValueSetValue): ShExJ.ValueSetValue =>
      Option.getOrElse(decodeValueSetValue(value), () =>
        this.fail(`${n.key} is not a well-formed ${t}`),
      );
    return Match.value(t).pipe(
      Match.withReturnType<ShExJ.ValueSetValue>(),
      Match.when(Match.is('IriStem', 'LiteralStem', 'LanguageStem'), (kind) =>
        decoded({ type: kind, stem: stem() }),
      ),
      Match.when(Match.is('IriStemRange', 'LiteralStemRange', 'LanguageStemRange'), (kind) =>
        decoded({ type: kind, stem: stem(), exclusions: exclusions() }),
      ),
      Match.when('Language', () => ({
        type: 'Language',
        languageTag: this.str(this.one(n, 'languageTag'), 'sx:languageTag'),
      })),
      Match.orElse((kind) => this.fail(`unknown value set value type ${kind}`)),
    );
  }

  shape(n: Term.Term): ShExJ.Shape {
    const shape: Mutable<ShExJ.Shape> = { type: 'Shape' };
    const ext = this.one(n, 'extends');
    if (Option.isSome(ext)) shape.extends = this.list(ext).map((x) => this.shapeDeclOrExpr(x));
    const closed = this.one(n, 'closed');
    if (Option.isSome(closed)) shape.closed = this.bool(closed);
    const extra = this.all(n, 'extra');
    if (Arr.isReadonlyArrayNonEmpty(extra))
      shape.extra = Arr.sort(
        extra.map((e) => this.iri(Option.some(e), 'sx:extra')),
        Order.String,
      );
    const expr = this.one(n, 'expression');
    if (Option.isSome(expr)) shape.expression = this.tripleExpr(expr.value, true);
    this.meta(n, shape);
    return shape;
  }

  /**
   * Reads a triple expression. A labelled expression used in several places
   * is defined (with its `id`) at the first shape's `sx:expression` that
   * uses it, or else at its first use, and referenced elsewhere.
   */
  tripleExpr(n: Term.Term, viaExpression = false): ShExJ.TripleExprOrRef {
    const types = this.types(n);
    const labelled = Term.isNamedNode(n) || this.uses(n) > 1;
    if (labelled) {
      const label = this.label(n);
      if (MutableHashSet.has(this.teDefined, label) || Arr.isReadonlyArrayEmpty(types))
        return label;
      if (!viaExpression && MutableHashSet.has(this.expressionSites, n.key)) return label;
      MutableHashSet.add(this.teDefined, label);
    }
    let te: Mutable<ShExJ.TripleExpr>;
    if (types.includes(`${SX}TripleConstraint`)) {
      const tc: Mutable<ShExJ.TripleConstraint> = {
        type: 'TripleConstraint',
        predicate: this.iri(this.one(n, 'predicate'), 'sx:predicate'),
      };
      const inverse = this.one(n, 'inverse');
      if (Option.isSome(inverse)) tc.inverse = this.bool(inverse);
      const ve = this.one(n, 'valueExpr');
      if (Option.isSome(ve)) tc.valueExpr = this.shapeDeclOrExpr(ve.value);
      te = tc;
    } else if (types.includes(`${SX}EachOf`) || types.includes(`${SX}OneOf`)) {
      te = {
        type: types.includes(`${SX}EachOf`) ? 'EachOf' : 'OneOf',
        expressions: this.list(this.one(n, 'expressions')).map((x) => this.tripleExpr(x)),
      };
    } else return this.fail(`${n.key} is not a triple expression`);
    const min = this.one(n, 'min');
    if (Option.isSome(min)) te.min = this.num(min, 'sx:min');
    const max = this.one(n, 'max');
    if (Option.isSome(max)) te.max = this.num(max, 'sx:max');
    this.meta(n, te);
    // A labelled triple expression is the expression with its `id`.
    return labelled ? { id: this.label(n), ...te } : te;
  }

  schema(): ShExJ.Schema {
    const roots = Dataset.match(this.dataset, { predicate: rdfType, object: sx('Schema') });
    const root = Option.getOrElse(
      Option.filter(Arr.head(roots), () => roots.length === 1),
      () => this.fail(`expected exactly one sx:Schema, found ${roots.length}`),
    ).subject;
    const schema: Mutable<ShExJ.Schema> = { type: 'Schema' };
    const imports = this.one(root, 'imports');
    if (Option.isSome(imports))
      schema.imports = this.list(imports).map((i) => this.iri(Option.some(i), 'sx:imports'));
    const startActs = this.semActsOf(root, 'startActs');
    if (Option.isSome(startActs)) schema.startActs = startActs.value;
    const start = this.one(root, 'start');
    if (Option.isSome(start)) schema.start = this.shapeDeclOrExpr(start.value);
    const shapes = this.one(root, 'shapes');
    if (Option.isSome(shapes)) {
      schema.shapes = this.list(shapes).map((d) => {
        const decl: Mutable<ShExJ.ShapeDecl> = {
          type: 'ShapeDecl',
          id: this.label(d),
          shapeExpr: { type: 'Shape' },
        };
        const abstract = this.one(d, 'abstract');
        if (Option.isSome(abstract) && this.bool(abstract)) decl.abstract = true;
        const restricts = this.one(d, 'restricts');
        if (Option.isSome(restricts))
          decl.restricts = this.list(restricts).map((x) => this.shapeDeclOrExpr(x));
        decl.shapeExpr = this.shapeDeclOrExpr(
          this.required(d, 'shapeExpr', `${d.key} has no sx:shapeExpr`),
        );
        return decl;
      });
    }
    return schema;
  }

  semActsOf(n: Term.Term, p: string): Option.Option<ReadonlyArray<ShExJ.SemAct>> {
    return Option.map(this.one(n, p), (l) =>
      this.list(Option.some(l)).map((a) => {
        const act: Mutable<ShExJ.SemAct> = {
          type: 'SemAct',
          name: this.iri(this.one(a, 'name'), 'sx:name'),
        };
        const code = this.one(a, 'code');
        if (Option.isSome(code)) act.code = this.str(code, 'sx:code');
        return act;
      }),
    );
  }
}

/**
 * Reads the ShExR schema contained in a dataset (which must have exactly one
 * node of type `sx:Schema`).
 *
 * @since 0.1.0
 * @category reading
 */
export const fromDataset = (dataset: Dataset.Dataset): Effect.Effect<ShExJ.Schema, ShExRError> =>
  Effect.try({
    try: () => new Reader(dataset).schema(),
    catch: (e) =>
      new ShExRError({
        message:
          Predicate.hasProperty(e, 'message') && Predicate.isString(e.message)
            ? e.message
            : String(e),
      }),
  });

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

const labelTerm = (label: string): Term.NamedNode | Term.BlankNode =>
  label.startsWith('_:') ? Term.blankNode(label.slice(2)) : Term.namedNode(label);

const integerLiteral = (v: number) => Term.literal(String(v), Term.namedNode(`${XSD}integer`));

const numericLiteral = (v: number) =>
  Number.isInteger(v)
    ? integerLiteral(v)
    : Term.literal(String(v), Term.namedNode(`${XSD}decimal`));

const booleanLiteral = (v: boolean) => Term.literal(String(v), Term.namedNode(`${XSD}boolean`));

const objectValueTerm = (v: ShExJ.ObjectValue): Term.Object =>
  Predicate.isString(v)
    ? Term.namedNode(v)
    : v.language !== undefined
      ? Term.literal(v.value, v.language)
      : v.type !== undefined
        ? Term.literal(v.value, Term.namedNode(v.type))
        : Term.literal(v.value);

/**
 * Writes a schema as ShExR quads (in the default graph). Blank nodes are
 * generated for anonymous expressions.
 *
 * @since 0.1.0
 * @category writing
 */
export const toQuads = (schema: ShExJ.Schema): ReadonlyArray<Term.Quad> => {
  const quads: Array<Term.Quad> = [];
  const add = (s: Term.Subject, p: Term.NamedNode, o: Term.Object) =>
    quads.push(Term.quad(s, p, o));
  const list = (items: ReadonlyArray<Term.Object>): Term.Object => {
    const cells = items.map(() => Term.blankNode());
    Arr.zip(cells, items).forEach(([cell, item], i) => {
      add(cell, rdfFirst, item);
      add(cell, rdfRest, cells[i + 1] ?? rdfNil);
    });
    return Option.getOrElse(Arr.head(cells), (): Term.Object => rdfNil);
  };
  const meta = (
    s: Term.Subject,
    x: { semActs?: ReadonlyArray<ShExJ.SemAct>; annotations?: ReadonlyArray<ShExJ.Annotation> },
  ) => {
    if (x.semActs !== undefined) add(s, sx('semActs'), semActs(x.semActs));
    if (x.annotations !== undefined)
      add(
        s,
        sx('annotation'),
        list(
          x.annotations.map((a) => {
            const b = Term.blankNode();
            add(b, rdfType, sx('Annotation'));
            add(b, sx('predicate'), Term.namedNode(a.predicate));
            add(b, sx('object'), objectValueTerm(a.object));
            return b;
          }),
        ),
      );
  };
  const semActs = (acts: ReadonlyArray<ShExJ.SemAct>) =>
    list(
      acts.map((a) => {
        const b = Term.blankNode();
        add(b, rdfType, sx('SemAct'));
        add(b, sx('name'), Term.namedNode(a.name));
        if (a.code !== undefined) add(b, sx('code'), Term.literal(a.code));
        return b;
      }),
    );
  const stem = (s: string | ShExJ.Wildcard, iri: boolean): Term.Object => {
    if (!Predicate.isString(s)) {
      const b = Term.blankNode();
      add(b, rdfType, sx('Wildcard'));
      return b;
    }
    return iri ? Term.literal(s, Term.namedNode(`${XSD}anyURI`)) : Term.literal(s);
  };
  const valueSetValue = (v: ShExJ.ValueSetValue): Term.Object => {
    if (Predicate.isString(v) || !('type' in v) || 'value' in v)
      // SAFETY: a value without `type`, or with a `value`, is an object value in ShExJ.
      return objectValueTerm(v);
    const b = Term.blankNode();
    add(b, rdfType, sx(v.type));
    Match.value(v).pipe(
      Match.discriminator('type')('Language', (member) =>
        add(b, sx('languageTag'), Term.literal(member.languageTag)),
      ),
      Match.discriminator('type')('IriStem', 'LiteralStem', 'LanguageStem', (member) =>
        add(b, sx('stem'), stem(member.stem, false)),
      ),
      Match.orElse((member) => {
        add(b, sx('stem'), stem(member.stem, false));
        const stemType = member.type.replace('Range', '');
        add(
          b,
          sx('exclusion'),
          list(
            Arr.map(member.exclusions, (e) => {
              if (Predicate.isString(e))
                return member.type === 'IriStemRange' ? Term.namedNode(e) : Term.literal(e);
              const x = Term.blankNode();
              add(x, rdfType, sx(stemType));
              add(x, sx('stem'), Term.literal(e.stem));
              return x;
            }),
          ),
        );
      }),
    );
    return b;
  };
  const shapeExpr = (e: ShExJ.ShapeExprOrRef, subject?: Term.Subject): Term.Object => {
    if (Predicate.isString(e)) return labelTerm(e);
    const s = subject ?? Term.blankNode();
    add(s, rdfType, sx(e.type));
    Match.value(e).pipe(
      Match.discriminator('type')('ShapeAnd', 'ShapeOr', (expr) =>
        add(s, sx('shapeExprs'), list(expr.shapeExprs.map((x) => shapeExpr(x)))),
      ),
      Match.discriminator('type')('ShapeNot', (expr) =>
        add(s, sx('shapeExpr'), shapeExpr(expr.shapeExpr)),
      ),
      Match.discriminator('type')('ShapeExternal', () => undefined),
      Match.discriminator('type')('NodeConstraint', (expr) => {
        if (expr.nodeKind !== undefined) add(s, sx('nodeKind'), sx(expr.nodeKind));
        if (expr.datatype !== undefined) add(s, sx('datatype'), Term.namedNode(expr.datatype));
        integerFacetNames.forEach((f) => {
          const v = expr[f];
          if (v !== undefined) add(s, sx(f), integerLiteral(v));
        });
        rangeFacetNames.forEach((f) => {
          const v = expr[f];
          if (v !== undefined) add(s, sx(f), numericLiteral(v));
        });
        if (expr.pattern !== undefined) add(s, sx('pattern'), Term.literal(expr.pattern));
        if (expr.flags !== undefined) add(s, sx('flags'), Term.literal(expr.flags));
        if (expr.values !== undefined) add(s, sx('values'), list(expr.values.map(valueSetValue)));
        meta(s, expr);
      }),
      Match.discriminator('type')('Shape', (expr) => {
        if (expr.extends !== undefined)
          add(s, sx('extends'), list(expr.extends.map((x) => shapeExpr(x))));
        if (expr.closed !== undefined) add(s, sx('closed'), booleanLiteral(expr.closed));
        expr.extra?.forEach((p) => add(s, sx('extra'), Term.namedNode(p)));
        if (expr.expression !== undefined) add(s, sx('expression'), tripleExpr(expr.expression));
        meta(s, expr);
      }),
      Match.exhaustive,
    );
    return s;
  };
  const tripleExpr = (t: ShExJ.TripleExprOrRef): Term.Object => {
    if (Predicate.isString(t)) return labelTerm(t);
    const s = t.id !== undefined ? labelTerm(t.id) : Term.blankNode();
    add(s, rdfType, sx(t.type));
    if (t.type === 'TripleConstraint') {
      if (t.inverse !== undefined) add(s, sx('inverse'), booleanLiteral(t.inverse));
      add(s, sx('predicate'), Term.namedNode(t.predicate));
      if (t.valueExpr !== undefined) add(s, sx('valueExpr'), shapeExpr(t.valueExpr));
    } else {
      add(s, sx('expressions'), list(t.expressions.map(tripleExpr)));
    }
    if (t.min !== undefined) add(s, sx('min'), integerLiteral(t.min));
    if (t.max !== undefined) add(s, sx('max'), integerLiteral(t.max));
    meta(s, t);
    return s;
  };
  const root = Term.blankNode();
  add(root, rdfType, sx('Schema'));
  if (schema.imports !== undefined)
    add(root, sx('imports'), list(schema.imports.map((i) => Term.namedNode(i))));
  if (schema.startActs !== undefined) add(root, sx('startActs'), semActs(schema.startActs));
  if (schema.start !== undefined) add(root, sx('start'), shapeExpr(schema.start));
  if (schema.shapes !== undefined) {
    const decls = schema.shapes.map((d) => {
      const s = labelTerm(d.id);
      add(s, rdfType, sx('ShapeDecl'));
      if (d.abstract !== undefined) add(s, sx('abstract'), booleanLiteral(d.abstract));
      if (d.restricts !== undefined)
        add(s, sx('restricts'), list(d.restricts.map((x) => shapeExpr(x))));
      add(s, sx('shapeExpr'), shapeExpr(d.shapeExpr));
      return s;
    });
    add(root, sx('shapes'), list(decls));
  }
  return quads;
};

/**
 * Writes a schema as a ShExR dataset.
 *
 * @since 0.1.0
 * @category writing
 */
export const toDataset = (schema: ShExJ.Schema): Dataset.Dataset =>
  Dataset.fromIterable(toQuads(schema));
