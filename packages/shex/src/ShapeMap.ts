/**
 * ShapeMaps: associations of nodes with shapes, used both as validation
 * input and output. Supports the ShapeMap compact syntax for fixed maps
 * (`node@shape`, `node@START`) and query maps with triple pattern node
 * selectors (`{FOCUS p _}`, `{_ p FOCUS}`), as well as the JSON form.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import { RdfParseError } from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import {
  Failure,
  lineColumn,
  matchAt,
  RE,
  unescapeLocal,
  unescapeString,
  unescapeUchar,
} from './internal/lexer.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * The `START` shape of a schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface Start {
  readonly _tag: 'Start';
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const start: Start = { _tag: 'Start' };

/**
 * A shape label or `START`.
 *
 * @since 0.1.0
 * @category models
 */
export type ShapeSelector = string | Start;

/**
 * @since 0.1.0
 * @category guards
 */
export const isStart = (s: ShapeSelector): s is Start => typeof s !== 'string';

/**
 * A triple pattern selecting focus nodes: exactly one of `subject` and
 * `object` is `'FOCUS'`; the other is a term or the wildcard `'_'`.
 *
 * @since 0.1.0
 * @category models
 */
export interface TriplePattern {
  readonly _tag: 'TriplePattern';
  readonly subject: Term.Subject | 'FOCUS' | '_';
  readonly predicate: Term.NamedNode;
  readonly object: Term.Object | 'FOCUS' | '_';
}

/**
 * @since 0.1.0
 * @category models
 */
export type NodeSelector = Term.GroundTerm | TriplePattern;

/**
 * An association in a query shape map.
 *
 * @since 0.1.0
 * @category models
 */
export interface QueryAssociation {
  readonly node: NodeSelector;
  readonly shape: ShapeSelector;
}

/**
 * An association in a fixed shape map.
 *
 * @since 0.1.0
 * @category models
 */
export interface Association {
  readonly node: Term.GroundTerm;
  readonly shape: ShapeSelector;
}

/**
 * @since 0.1.0
 * @category models
 */
export type QueryShapeMap = ReadonlyArray<QueryAssociation>;

/**
 * @since 0.1.0
 * @category models
 */
export type FixedShapeMap = ReadonlyArray<Association>;

/**
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions {
  readonly baseIri?: string | undefined;
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
  /** Prefixes used only for shape labels (e.g. those of the schema). */
  readonly shapePrefixes?: Readonly<Record<string, string>> | undefined;
}

class MapParser {
  pos = 0;
  constructor(
    readonly input: string,
    readonly options: ParseOptions,
  ) {}

  fail(message: string): never {
    throw new Failure(message, this.pos);
  }

  ws(): void {
    const m = matchAt(RE.SKIP, this.input, this.pos);
    if (m !== undefined) this.pos += m.length;
  }

  eat(s: string): boolean {
    this.ws();
    if (this.input.startsWith(s, this.pos)) {
      this.pos += s.length;
      return true;
    }
    return false;
  }

  keyword(kw: string): boolean {
    this.ws();
    const m = matchAt(/[A-Za-z]+/y, this.input, this.pos);
    if (m !== undefined && m.toUpperCase() === kw) {
      this.pos += m.length;
      return true;
    }
    return false;
  }

  iri(prefixes: Readonly<Record<string, string>> | undefined): string | undefined {
    this.ws();
    let m = matchAt(RE.IRIREF, this.input, this.pos);
    if (m !== undefined) {
      this.pos += m.length;
      const iri = unescapeUchar(m.slice(1, -1));
      const base = this.options.baseIri;
      return base === undefined || Iri.isAbsolute(iri) ? iri : Iri.resolve(iri, base);
    }
    m = matchAt(RE.PNAME_LN, this.input, this.pos) ?? matchAt(RE.PNAME_NS, this.input, this.pos);
    if (m !== undefined) {
      const i = m.indexOf(':');
      const prefix = m.slice(0, i);
      const ns = prefixes?.[prefix] ?? this.options.prefixes?.[prefix];
      if (ns === undefined) this.fail(`unknown prefix "${prefix}:"`);
      this.pos += m.length;
      return ns + unescapeLocal(m.slice(i + 1));
    }
    return undefined;
  }

  term(): Term.GroundTerm | undefined {
    this.ws();
    const iri = this.iri(undefined);
    if (iri !== undefined) return Term.namedNode(iri);
    let m = matchAt(RE.BLANK_NODE_LABEL, this.input, this.pos);
    if (m !== undefined) {
      this.pos += m.length;
      return Term.blankNode(m.slice(2));
    }
    const c = this.input[this.pos];
    if (c === '"' || c === "'") {
      let q = 3;
      m = this.input.startsWith(c.repeat(3), this.pos)
        ? matchAt(
            c === "'" ? RE.STRING_LITERAL_LONG1 : RE.STRING_LITERAL_LONG2,
            this.input,
            this.pos,
          )
        : undefined;
      if (m === undefined) {
        q = 1;
        m = matchAt(c === "'" ? RE.STRING_LITERAL1 : RE.STRING_LITERAL2, this.input, this.pos);
      }
      if (m === undefined) this.fail('invalid string literal');
      this.pos += m.length;
      const value = unescapeString(m.slice(q, -q));
      const lang = matchAt(RE.LANGTAG, this.input, this.pos);
      if (lang !== undefined) {
        this.pos += lang.length;
        return Term.literal(value, lang.slice(1));
      }
      if (this.input.startsWith('^^', this.pos)) {
        this.pos += 2;
        const dt = this.iri(undefined) ?? this.fail('expected a datatype IRI');
        return Term.literal(value, Term.namedNode(dt));
      }
      return Term.literal(value);
    }
    for (const [re, dt] of [
      [RE.DOUBLE, 'double'],
      [RE.DECIMAL, 'decimal'],
      [RE.INTEGER, 'integer'],
    ] as const) {
      m = matchAt(re, this.input, this.pos);
      if (m !== undefined) {
        this.pos += m.length;
        return Term.literal(m, Term.namedNode(XSD + dt));
      }
    }
    m = matchAt(/(?:true|false)\b/y, this.input, this.pos);
    if (m !== undefined) {
      this.pos += m.length;
      return Term.literal(m, Term.namedNode(`${XSD}boolean`));
    }
    return undefined;
  }

  predicate(): Term.NamedNode {
    this.ws();
    if (matchAt(/a(?![A-Za-z0-9_:-])/y, this.input, this.pos) !== undefined) {
      this.pos++;
      return Term.namedNode(RDF_TYPE);
    }
    const iri = this.iri(undefined) ?? this.fail('expected a predicate');
    return Term.namedNode(iri);
  }

  nodeSelector(): NodeSelector {
    if (this.eat('{')) {
      let subject: TriplePattern['subject'];
      if (this.keyword('FOCUS')) subject = 'FOCUS';
      else if (this.eat('_')) subject = '_';
      else {
        const t = this.term();
        if (t === undefined || t._tag === 'Literal') return this.fail('expected a subject');
        subject = t;
      }
      const predicate = this.predicate();
      let object: TriplePattern['object'];
      if (this.keyword('FOCUS')) object = 'FOCUS';
      else if (this.eat('_')) object = '_';
      else object = this.term() ?? this.fail('expected an object');
      if ((subject === 'FOCUS') === (object === 'FOCUS'))
        this.fail('a triple pattern needs exactly one FOCUS');
      if (!this.eat('}')) this.fail("expected '}'");
      return { _tag: 'TriplePattern', subject, predicate, object };
    }
    return this.term() ?? this.fail('expected a node selector');
  }

  shapeSelector(): ShapeSelector {
    if (!this.eat('@')) this.fail("expected '@'");
    if (this.keyword('START')) return start;
    const iri = this.iri(this.options.shapePrefixes);
    if (iri !== undefined) return iri;
    const m = matchAt(RE.BLANK_NODE_LABEL, this.input, this.pos);
    if (m !== undefined) {
      this.pos += m.length;
      return m;
    }
    return this.fail('expected a shape label');
  }

  shapeMap(): QueryShapeMap {
    const out: Array<QueryAssociation> = [];
    this.ws();
    if (this.pos >= this.input.length) return out;
    do {
      const node = this.nodeSelector();
      const shape = this.shapeSelector();
      out.push({ node, shape });
    } while (this.eat(','));
    this.ws();
    if (this.pos < this.input.length) this.fail('unexpected input');
    return out;
  }
}

/**
 * Parses a (query) shape map in the compact syntax.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options: ParseOptions = {},
): Effect.Effect<QueryShapeMap, RdfParseError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(new MapParser(input, options).shapeMap());
    } catch (e) {
      if (e instanceof Failure) {
        const { line, column } = lineColumn(input, e.pos);
        return Effect.fail(
          new RdfParseError({ format: 'ShapeMap', message: e.message, line, column }),
        );
      }
      return Effect.fail(new RdfParseError({ format: 'ShapeMap', message: String(e) }));
    }
  });

/**
 * Parses a single RDF term in N-Triples / Turtle notation (`<iri>`,
 * `_:label`, `"lexical"^^<dt>`, …), as used by the JSON form of shape maps.
 * A bare string that is not a term is taken as an IRI.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseTerm = (input: string, options: ParseOptions = {}): Term.GroundTerm => {
  try {
    const p = new MapParser(input, options);
    const t = p.term();
    p.ws();
    if (t !== undefined && p.pos === input.length) return t;
  } catch {
    // fall through
  }
  if (input.startsWith('_:')) return Term.blankNode(input.slice(2));
  return Term.namedNode(
    options.baseIri === undefined || Iri.isAbsolute(input)
      ? input
      : Iri.resolve(input, options.baseIri),
  );
};

/**
 * Reads the JSON form of a fixed shape map: an array of
 * `{ "node": term, "shape": label | "START" }` objects. Node terms use
 * N-Triples notation or are bare IRIs.
 *
 * @since 0.1.0
 * @category parsing
 */
export const fromJson = (json: unknown, options: ParseOptions = {}): FixedShapeMap => {
  if (!Array.isArray(json)) return [];
  return json.map((entry: { node: string; shape: string }) => ({
    node: parseTerm(entry.node, options),
    shape:
      entry.shape === 'START'
        ? start
        : entry.shape.startsWith('_:') ||
            options.baseIri === undefined ||
            Iri.isAbsolute(entry.shape)
          ? entry.shape
          : Iri.resolve(entry.shape, options.baseIri),
  }));
};

/**
 * Resolves a query shape map against a dataset, producing a fixed shape map
 * (duplicates removed, order preserved).
 *
 * @since 0.1.0
 * @category combinators
 */
export const resolve = (map: QueryShapeMap, dataset: Dataset.Dataset): FixedShapeMap => {
  const out: Array<Association> = [];
  const seen = new Set<string>();
  const push = (node: Term.GroundTerm, shape: ShapeSelector) => {
    const key = `${node.key} ${isStart(shape) ? '' : shape}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ node, shape });
  };
  for (const { node, shape } of map) {
    if (node._tag !== 'TriplePattern') {
      push(node, shape);
      continue;
    }
    const pattern: Dataset.Pattern = {
      predicate: node.predicate,
      ...(node.subject !== 'FOCUS' && node.subject !== '_' ? { subject: node.subject } : {}),
      ...(node.object !== 'FOCUS' && node.object !== '_' ? { object: node.object } : {}),
    };
    for (const q of Dataset.match(dataset, pattern)) {
      push(node.subject === 'FOCUS' ? q.subject : q.object, shape);
    }
  }
  return out;
};

/**
 * Formats a shape selector for display.
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatShape = (shape: ShapeSelector): string =>
  isStart(shape) ? 'START' : shape.startsWith('_:') ? shape : `<${shape}>`;

/**
 * Formats a fixed shape map in the compact syntax.
 *
 * @since 0.1.0
 * @category formatting
 */
export const format = (map: FixedShapeMap): string =>
  map.map((a) => `${a.node.key}@${formatShape(a.shape)}`).join(',\n');
