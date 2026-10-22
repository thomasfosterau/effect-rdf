/**
 * ShExR: the RDF representation of ShEx schemas (vocabulary
 * `http://www.w3.org/ns/shex#`). Reads a schema from a core `Dataset` and
 * writes a schema as RDF quads.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { ShExRError } from './ShExError.ts';
import type * as ShExJ from './ShExJ.ts';

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

const valueSetTypes = new Set([
  'IriStem',
  'IriStemRange',
  'LiteralStem',
  'LiteralStemRange',
  'Language',
  'LanguageStem',
  'LanguageStemRange',
]);

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

class Reader {
  readonly teDefined = new Set<string>();
  readonly teUses = new Map<string, number>();

  readonly expressionSites = new Set<string>();

  readonly dataset: Dataset.Dataset;
  constructor(dataset: Dataset.Dataset) {
    this.dataset = dataset;
    for (const q of Dataset.match(dataset, { predicate: sx('expression') })) {
      this.countUse(q.object);
      this.expressionSites.add(q.object.key);
    }
    for (const q of Dataset.match(dataset, { predicate: rdfFirst })) this.countUse(q.object);
  }

  countUse(t: Term.Term): void {
    this.teUses.set(t.key, (this.teUses.get(t.key) ?? 0) + 1);
  }

  fail(message: string): never {
    throw new Fail(message);
  }

  types(n: Term.Term): ReadonlyArray<string> {
    if (n._tag !== 'NamedNode' && n._tag !== 'BlankNode') return [];
    return Dataset.objectsOf(this.dataset, n, rdfType).map((t) =>
      t._tag === 'NamedNode' ? t.value : '',
    );
  }

  hasType(n: Term.Term, local: string): boolean {
    return this.types(n).includes(SX + local);
  }

  one(n: Term.Term, p: string): Term.Object | undefined {
    if (n._tag !== 'NamedNode' && n._tag !== 'BlankNode') return undefined;
    const os = Dataset.objectsOf(this.dataset, n, sx(p));
    if (os.length > 1) this.fail(`${n.key} has several sx:${p} values`);
    return os[0];
  }

  all(n: Term.Term, p: string): ReadonlyArray<Term.Object> {
    if (n._tag !== 'NamedNode' && n._tag !== 'BlankNode') return [];
    return Dataset.objectsOf(this.dataset, n, sx(p));
  }

  list(n: Term.Term | undefined): ReadonlyArray<Term.Object> {
    if (n === undefined) return [];
    const l = Dataset.list(this.dataset, n as Term.Object);
    if (Option.isNone(l)) return this.fail(`${n.key} is not a well-formed RDF list`);
    return l.value;
  }

  label(n: Term.Term): string {
    if (n._tag === 'NamedNode') return n.value;
    if (n._tag === 'BlankNode') return `_:${n.value}`;
    return this.fail(`${n.key} cannot be a label`);
  }

  iri(n: Term.Term | undefined, what: string): string {
    if (n?._tag !== 'NamedNode') return this.fail(`expected an IRI for ${what}`);
    return n.value;
  }

  str(n: Term.Term | undefined, what: string): string {
    if (n?._tag !== 'Literal') return this.fail(`expected a literal for ${what}`);
    return n.value;
  }

  num(n: Term.Term | undefined, what: string): number {
    const v = Number(this.str(n, what));
    if (Number.isNaN(v)) this.fail(`expected a number for ${what}`);
    return v;
  }

  bool(n: Term.Term | undefined): boolean {
    return n?._tag === 'Literal' && (n.value === 'true' || n.value === '1');
  }

  objectValue(n: Term.Term): ShExJ.ObjectValue {
    if (n._tag === 'NamedNode') return n.value;
    if (n._tag === 'Literal') {
      if (n.language !== '') return { value: n.value, language: n.language };
      if (n.datatype.value === `${XSD}string`) return { value: n.value };
      return { value: n.value, type: n.datatype.value };
    }
    return this.fail(`${n.key} is not an IRI or literal`);
  }

  semActs(n: Term.Term): ReadonlyArray<ShExJ.SemAct> | undefined {
    const l = this.one(n, 'semActs');
    if (l === undefined) return undefined;
    return this.list(l).map((a) => {
      const act: Mutable<ShExJ.SemAct> = {
        type: 'SemAct',
        name: this.iri(this.one(a, 'name'), 'sx:name'),
      };
      const code = this.one(a, 'code');
      if (code !== undefined) act.code = this.str(code, 'sx:code');
      return act;
    });
  }

  annotations(n: Term.Term): ReadonlyArray<ShExJ.Annotation> | undefined {
    const l = this.one(n, 'annotation');
    if (l === undefined) return undefined;
    return this.list(l).map((a) => ({
      type: 'Annotation',
      predicate: this.iri(this.one(a, 'predicate'), 'sx:predicate'),
      object: this.objectValue(this.one(a, 'object') ?? this.fail('annotation without sx:object')),
    }));
  }

  meta<T extends object>(n: Term.Term, out: T): T {
    const acts = this.semActs(n);
    const annots = this.annotations(n);
    const o = out as Mutable<{ semActs?: unknown; annotations?: unknown }>;
    if (acts !== undefined) o.semActs = acts;
    if (annots !== undefined) o.annotations = annots;
    return out;
  }

  /** A shape expression or a reference to a declaration. */
  shapeDeclOrExpr(n: Term.Term): ShExJ.ShapeExprOrRef {
    const types = this.types(n);
    if (types.includes(`${SX}ShapeDecl`) || types.length === 0) return this.label(n);
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
          this.one(n, 'shapeExpr') ?? this.fail('ShapeNot without sx:shapeExpr'),
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
    if (kind !== undefined) {
      const k = this.iri(kind, 'sx:nodeKind').slice(SX.length);
      if (k !== 'iri' && k !== 'bnode' && k !== 'literal' && k !== 'nonliteral')
        this.fail(`unknown node kind ${kind.key}`);
      nc.nodeKind = k;
    }
    const dt = this.one(n, 'datatype');
    if (dt !== undefined) nc.datatype = this.iri(dt, 'sx:datatype');
    for (const f of [
      'length',
      'minlength',
      'maxlength',
      'mininclusive',
      'minexclusive',
      'maxinclusive',
      'maxexclusive',
      'totaldigits',
      'fractiondigits',
    ] as const) {
      const v = this.one(n, f);
      if (v !== undefined) nc[f] = this.num(v, `sx:${f}`);
    }
    const pattern = this.one(n, 'pattern');
    if (pattern !== undefined) nc.pattern = this.str(pattern, 'sx:pattern');
    const flags = this.one(n, 'flags');
    if (flags !== undefined) nc.flags = this.str(flags, 'sx:flags');
    const values = this.one(n, 'values');
    if (values !== undefined) nc.values = this.list(values).map((v) => this.valueSetValue(v));
    return this.meta(n, nc);
  }

  stem(n: Term.Term): string | ShExJ.Wildcard {
    if (this.hasType(n, 'Wildcard')) return { type: 'Wildcard' };
    return n._tag === 'NamedNode' ? n.value : this.str(n, 'sx:stem');
  }

  valueSetValue(n: Term.Term): ShExJ.ValueSetValue {
    if (n._tag === 'Literal') return this.objectValue(n);
    const types = this.types(n);
    const t = types.map((x) => x.slice(SX.length)).find((x) => valueSetTypes.has(x));
    if (t === undefined || n._tag === 'NamedNode') return this.objectValue(n);
    const stem = () => this.stem(this.one(n, 'stem') ?? this.fail(`${t} without sx:stem`));
    const exclusions = () =>
      this.list(this.one(n, 'exclusion')).map((e) =>
        e._tag === 'Literal' || e._tag === 'NamedNode'
          ? e.value
          : {
              type: (this.types(e)[0] ?? `${SX}IriStem`).slice(SX.length),
              stem: this.str(this.one(e, 'stem'), 'sx:stem'),
            },
      );
    switch (t) {
      case 'IriStem':
      case 'LiteralStem':
      case 'LanguageStem':
        return { type: t, stem: stem() as string } as ShExJ.ValueSetValue;
      case 'IriStemRange':
      case 'LiteralStemRange':
      case 'LanguageStemRange':
        return { type: t, stem: stem(), exclusions: exclusions() } as ShExJ.ValueSetValue;
      case 'Language':
        return {
          type: 'Language',
          languageTag: this.str(this.one(n, 'languageTag'), 'sx:languageTag'),
        };
      default:
        return this.fail(`unknown value set value type ${t}`);
    }
  }

  shape(n: Term.Term): ShExJ.Shape {
    const shape: Mutable<ShExJ.Shape> = { type: 'Shape' };
    const ext = this.one(n, 'extends');
    if (ext !== undefined) shape.extends = this.list(ext).map((x) => this.shapeDeclOrExpr(x));
    const closed = this.one(n, 'closed');
    if (closed !== undefined) shape.closed = this.bool(closed);
    const extra = this.all(n, 'extra');
    if (extra.length > 0)
      shape.extra = Arr.sort(
        extra.map((e) => this.iri(e, 'sx:extra')),
        Order.String,
      );
    const expr = this.one(n, 'expression');
    if (expr !== undefined) shape.expression = this.tripleExpr(expr, true);
    return this.meta(n, shape);
  }

  /**
   * Reads a triple expression. A labelled expression used in several places
   * is defined (with its `id`) at the first shape's `sx:expression` that
   * uses it, or else at its first use, and referenced elsewhere.
   */
  tripleExpr(n: Term.Term, viaExpression = false): ShExJ.TripleExprOrRef {
    const types = this.types(n);
    const labelled = n._tag === 'NamedNode' || (this.teUses.get(n.key) ?? 0) > 1;
    if (labelled) {
      const label = this.label(n);
      if (this.teDefined.has(label) || types.length === 0) return label;
      if (!viaExpression && this.expressionSites.has(n.key)) return label;
      this.teDefined.add(label);
    }
    let te: Mutable<ShExJ.TripleExpr>;
    if (types.includes(`${SX}TripleConstraint`)) {
      const tc: Mutable<ShExJ.TripleConstraint> = {
        type: 'TripleConstraint',
        predicate: this.iri(this.one(n, 'predicate'), 'sx:predicate'),
      };
      const inverse = this.one(n, 'inverse');
      if (inverse !== undefined) tc.inverse = this.bool(inverse);
      const ve = this.one(n, 'valueExpr');
      if (ve !== undefined) tc.valueExpr = this.shapeDeclOrExpr(ve);
      te = tc;
    } else if (types.includes(`${SX}EachOf`) || types.includes(`${SX}OneOf`)) {
      te = {
        type: types.includes(`${SX}EachOf`) ? 'EachOf' : 'OneOf',
        expressions: this.list(this.one(n, 'expressions')).map((x) => this.tripleExpr(x)),
      };
    } else return this.fail(`${n.key} is not a triple expression`);
    const min = this.one(n, 'min');
    if (min !== undefined) te.min = this.num(min, 'sx:min');
    const max = this.one(n, 'max');
    if (max !== undefined) te.max = this.num(max, 'sx:max');
    this.meta(n, te);
    return labelled ? ({ id: this.label(n), ...te } as ShExJ.TripleExpr) : te;
  }

  schema(): ShExJ.Schema {
    const roots = Dataset.match(this.dataset, { predicate: rdfType, object: sx('Schema') });
    if (roots.length !== 1) this.fail(`expected exactly one sx:Schema, found ${roots.length}`);
    const root = roots[0]!.subject;
    const schema: Mutable<ShExJ.Schema> = { type: 'Schema' };
    const imports = this.one(root, 'imports');
    if (imports !== undefined)
      schema.imports = this.list(imports).map((i) => this.iri(i, 'sx:imports'));
    const startActs = this.semActsOf(root, 'startActs');
    if (startActs !== undefined) schema.startActs = startActs;
    const start = this.one(root, 'start');
    if (start !== undefined) schema.start = this.shapeDeclOrExpr(start);
    const shapes = this.one(root, 'shapes');
    if (shapes !== undefined) {
      schema.shapes = this.list(shapes).map((d) => {
        const decl: Mutable<ShExJ.ShapeDecl> = {
          type: 'ShapeDecl',
          id: this.label(d),
          shapeExpr: { type: 'Shape' },
        };
        const abstract = this.one(d, 'abstract');
        if (abstract !== undefined && this.bool(abstract)) decl.abstract = true;
        const restricts = this.one(d, 'restricts');
        if (restricts !== undefined)
          decl.restricts = this.list(restricts).map((x) => this.shapeDeclOrExpr(x));
        const se = this.one(d, 'shapeExpr');
        decl.shapeExpr =
          se === undefined ? this.fail(`${d.key} has no sx:shapeExpr`) : this.shapeDeclOrExpr(se);
        return decl;
      });
    }
    return schema;
  }

  semActsOf(n: Term.Term, p: string): ReadonlyArray<ShExJ.SemAct> | undefined {
    const l = this.one(n, p);
    if (l === undefined) return undefined;
    return this.list(l).map((a) => {
      const act: Mutable<ShExJ.SemAct> = {
        type: 'SemAct',
        name: this.iri(this.one(a, 'name'), 'sx:name'),
      };
      const code = this.one(a, 'code');
      if (code !== undefined) act.code = this.str(code, 'sx:code');
      return act;
    });
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
  const node = (label: string): Term.NamedNode | Term.BlankNode =>
    label.startsWith('_:') ? Term.blankNode(label.slice(2)) : Term.namedNode(label);
  const int = (v: number) => Term.literal(String(v), Term.namedNode(`${XSD}integer`));
  const num = (v: number) =>
    Number.isInteger(v) ? int(v) : Term.literal(String(v), Term.namedNode(`${XSD}decimal`));
  const bool = (v: boolean) => Term.literal(String(v), Term.namedNode(`${XSD}boolean`));
  const list = (items: ReadonlyArray<Term.Object>): Term.Object => {
    if (items.length === 0) return rdfNil;
    const cells = items.map(() => Term.blankNode());
    items.forEach((item, i) => {
      add(cells[i]!, rdfFirst, item);
      add(cells[i]!, rdfRest, cells[i + 1] ?? rdfNil);
    });
    return cells[0]!;
  };
  const objectValue = (v: ShExJ.ObjectValue): Term.Object =>
    typeof v === 'string'
      ? Term.namedNode(v)
      : v.language !== undefined
        ? Term.literal(v.value, v.language)
        : v.type !== undefined
          ? Term.literal(v.value, Term.namedNode(v.type))
          : Term.literal(v.value);
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
            add(b, sx('object'), objectValue(a.object));
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
    if (typeof s !== 'string') {
      const b = Term.blankNode();
      add(b, rdfType, sx('Wildcard'));
      return b;
    }
    return iri ? Term.literal(s, Term.namedNode(`${XSD}anyURI`)) : Term.literal(s);
  };
  const valueSetValue = (v: ShExJ.ValueSetValue): Term.Object => {
    if (typeof v === 'string' || !('type' in v) || 'value' in v)
      return objectValue(v as ShExJ.ObjectValue);
    const b = Term.blankNode();
    add(b, rdfType, sx(v.type));
    switch (v.type) {
      case 'Language':
        add(b, sx('languageTag'), Term.literal(v.languageTag));
        break;
      case 'IriStem':
      case 'LiteralStem':
      case 'LanguageStem':
        add(b, sx('stem'), stem(v.stem, false));
        break;
      default: {
        add(b, sx('stem'), stem(v.stem, false));
        const stemType = v.type.replace('Range', '');
        add(
          b,
          sx('exclusion'),
          list(
            (v.exclusions as ReadonlyArray<string | { readonly stem: string }>).map((e) => {
              if (typeof e === 'string')
                return v.type === 'IriStemRange' ? Term.namedNode(e) : Term.literal(e);
              const x = Term.blankNode();
              add(x, rdfType, sx(stemType));
              add(x, sx('stem'), Term.literal(e.stem));
              return x;
            }),
          ),
        );
      }
    }
    return b;
  };
  const shapeExpr = (e: ShExJ.ShapeExprOrRef, subject?: Term.Subject): Term.Object => {
    if (typeof e === 'string') return node(e);
    const s = subject ?? Term.blankNode();
    add(s, rdfType, sx(e.type));
    switch (e.type) {
      case 'ShapeAnd':
      case 'ShapeOr':
        add(s, sx('shapeExprs'), list(e.shapeExprs.map((x) => shapeExpr(x))));
        break;
      case 'ShapeNot':
        add(s, sx('shapeExpr'), shapeExpr(e.shapeExpr));
        break;
      case 'ShapeExternal':
        break;
      case 'NodeConstraint':
        if (e.nodeKind !== undefined) add(s, sx('nodeKind'), sx(e.nodeKind));
        if (e.datatype !== undefined) add(s, sx('datatype'), Term.namedNode(e.datatype));
        for (const f of [
          'length',
          'minlength',
          'maxlength',
          'totaldigits',
          'fractiondigits',
        ] as const)
          if (e[f] !== undefined) add(s, sx(f), int(e[f]));
        for (const f of ['mininclusive', 'minexclusive', 'maxinclusive', 'maxexclusive'] as const)
          if (e[f] !== undefined) add(s, sx(f), num(e[f]));
        if (e.pattern !== undefined) add(s, sx('pattern'), Term.literal(e.pattern));
        if (e.flags !== undefined) add(s, sx('flags'), Term.literal(e.flags));
        if (e.values !== undefined) add(s, sx('values'), list(e.values.map(valueSetValue)));
        meta(s, e);
        break;
      case 'Shape':
        if (e.extends !== undefined)
          add(s, sx('extends'), list(e.extends.map((x) => shapeExpr(x))));
        if (e.closed !== undefined) add(s, sx('closed'), bool(e.closed));
        for (const p of e.extra ?? []) add(s, sx('extra'), Term.namedNode(p));
        if (e.expression !== undefined) add(s, sx('expression'), tripleExpr(e.expression));
        meta(s, e);
        break;
    }
    return s;
  };
  const tripleExpr = (t: ShExJ.TripleExprOrRef): Term.Object => {
    if (typeof t === 'string') return node(t);
    const s = t.id !== undefined ? node(t.id) : Term.blankNode();
    add(s, rdfType, sx(t.type));
    if (t.type === 'TripleConstraint') {
      if (t.inverse !== undefined) add(s, sx('inverse'), bool(t.inverse));
      add(s, sx('predicate'), Term.namedNode(t.predicate));
      if (t.valueExpr !== undefined) add(s, sx('valueExpr'), shapeExpr(t.valueExpr));
    } else {
      add(s, sx('expressions'), list(t.expressions.map(tripleExpr)));
    }
    if (t.min !== undefined) add(s, sx('min'), int(t.min));
    if (t.max !== undefined) add(s, sx('max'), int(t.max));
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
      const s = node(d.id);
      add(s, rdfType, sx('ShapeDecl'));
      if (d.abstract !== undefined) add(s, sx('abstract'), bool(d.abstract));
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
