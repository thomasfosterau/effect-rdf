/**
 * The ShEx compact syntax (ShExC): a hand-written parser producing ShExJ and
 * a printer from ShExJ back to ShExC.
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import { RdfParseError } from '@thomasfosterau/effect-rdf/Serialization';
import { Failure, lineColumn } from './internal/lexer.ts';
import { parseShExC } from './internal/shexcParser.ts';
import type * as ShExJ from './ShExJ.ts';

/**
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions {
  /** The base IRI against which relative IRIs are resolved. */
  readonly baseIri?: string | undefined;
  /** Prefixes available before any `PREFIX` declaration. */
  readonly prefixes?: Readonly<Record<string, string>> | PrefixMap.PrefixMap | undefined;
}

/**
 * The result of parsing a ShExC document with its metadata.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParseResult {
  readonly schema: ShExJ.Schema;
  /** The prefixes in scope at the end of the document. */
  readonly prefixes: PrefixMap.PrefixMap;
  /** The base IRI in effect at the end of the document. */
  readonly baseIri: string | undefined;
}

const toRecord = (
  prefixes: ParseOptions['prefixes'],
): Readonly<Record<string, string>> | undefined =>
  prefixes === undefined
    ? undefined
    : 'prefixes' in prefixes && prefixes.prefixes instanceof Map
      ? Object.fromEntries(prefixes.prefixes)
      : (prefixes as Readonly<Record<string, string>>);

/**
 * Parses a ShExC document, returning the schema together with its prefixes
 * and final base IRI.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseWithMetadata = (
  input: string,
  options: ParseOptions = {},
): Effect.Effect<ParseResult, RdfParseError> =>
  Effect.suspend(() => {
    try {
      const result = parseShExC(input, {
        baseIri: options.baseIri,
        prefixes: toRecord(options.prefixes),
      });
      return Effect.succeed({
        schema: result.schema,
        prefixes: PrefixMap.make(result.prefixes),
        baseIri: result.baseIri,
      });
    } catch (e) {
      if (e instanceof Failure) {
        const { line, column } = lineColumn(input, e.pos);
        return Effect.fail(
          new RdfParseError({ format: 'ShExC', message: e.message, line, column }),
        );
      }
      return Effect.fail(new RdfParseError({ format: 'ShExC', message: String(e) }));
    }
  });

/**
 * Parses a ShExC document to a ShExJ schema.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options: ParseOptions = {},
): Effect.Effect<ShExJ.Schema, RdfParseError> =>
  Effect.map(parseWithMetadata(input, options), (r) => r.schema);

// -----------------------------------------------------------------------------
// Printer
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category models
 */
export interface PrintOptions {
  /** Prefixes used to abbreviate IRIs (and declared at the top). */
  readonly prefixes?: PrefixMap.PrefixMap | undefined;
  /** A base IRI used to relativise IRIs (and declared at the top). */
  readonly baseIri?: string | undefined;
  /** Indentation unit. Defaults to two spaces. */
  readonly indent?: string | undefined;
}

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const escapeIri = (iri: string): string =>
  iri.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000- <>"{}|^`\\]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

const escapeString = (s: string): string =>
  s.replace(/["\\\n\r\t\b\f]/g, (c) =>
    c === '"'
      ? '\\"'
      : c === '\\'
        ? '\\\\'
        : c === '\n'
          ? '\\n'
          : c === '\r'
            ? '\\r'
            : c === '\t'
              ? '\\t'
              : c === '\b'
                ? '\\b'
                : '\\f',
  );

const escapeRegexp = (s: string): string =>
  s.replace(/\//g, '\\/').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

const escapeCode = (s: string): string => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%');

class Printer {
  readonly prefixes: PrefixMap.PrefixMap;
  readonly base: string | undefined;
  readonly unit: string;

  constructor(options: PrintOptions) {
    this.prefixes = options.prefixes ?? PrefixMap.empty;
    this.base = options.baseIri;
    this.unit = options.indent ?? '  ';
  }

  iri(iri: string): string {
    const compact = PrefixMap.compact(this.prefixes, iri);
    if (compact._tag === 'Some') return `${compact.value[0]}:${compact.value[1]}`;
    if (this.base !== undefined) {
      const rel = Iri.relativize(iri, this.base);
      if (rel._tag === 'Some') return `<${escapeIri(rel.value)}>`;
    }
    return `<${escapeIri(iri)}>`;
  }

  label(label: string): string {
    return label.startsWith('_:') ? label : this.iri(label);
  }

  predicate(p: string): string {
    return p === RDF_TYPE ? 'a' : this.iri(p);
  }

  literal(l: ShExJ.ObjectLiteral): string {
    const quoted = `"${escapeString(l.value)}"`;
    if (l.language !== undefined) return `${quoted}@${l.language}`;
    if (l.type === undefined || l.type === `${XSD}string`) return quoted;
    if (l.type === `${XSD}integer` && /^[+-]?\d+$/.test(l.value)) return l.value;
    if (l.type === `${XSD}decimal` && /^[+-]?\d*\.\d+$/.test(l.value)) return l.value;
    if (l.type === `${XSD}double` && /^[+-]?(\d+\.\d*|\.?\d+)[eE][+-]?\d+$/.test(l.value))
      return l.value;
    if (l.type === `${XSD}boolean` && (l.value === 'true' || l.value === 'false')) return l.value;
    return `${quoted}^^${this.iri(l.type)}`;
  }

  objectValue(v: ShExJ.ObjectValue): string {
    return typeof v === 'string' ? this.iri(v) : this.literal(v);
  }

  semActs(acts: ReadonlyArray<ShExJ.SemAct> | undefined): string {
    if (acts === undefined) return '';
    return acts
      .map((a) => ` %${this.iri(a.name)}${a.code === undefined ? '%' : `{${escapeCode(a.code)}%}`}`)
      .join('');
  }

  annotations(annots: ReadonlyArray<ShExJ.Annotation> | undefined): string {
    if (annots === undefined) return '';
    return annots
      .map((a) => ` // ${this.predicate(a.predicate)} ${this.objectValue(a.object)}`)
      .join('');
  }

  cardinality(c: ShExJ.Cardinality): string {
    const min = c.min ?? 1;
    const max = c.max ?? 1;
    if (c.min === undefined && c.max === undefined) return '';
    if (min === 0 && max === -1) return '*';
    if (min === 1 && max === -1) return '+';
    if (min === 0 && max === 1) return '?';
    if (max === -1) return `{${min},}`;
    if (min === max) return `{${min}}`;
    return `{${min},${max}}`;
  }

  valueSetValue(v: ShExJ.ValueSetValue): string {
    if (typeof v === 'string') return this.iri(v);
    if (!('type' in v) || typeof v.type !== 'string' || 'value' in v) {
      return this.literal(v as ShExJ.ObjectLiteral);
    }
    const lit = (s: string) => `"${escapeString(s)}"`;
    switch (v.type) {
      case 'IriStem':
        return `${this.iri(v.stem)}~`;
      case 'LiteralStem':
        return `${lit(v.stem)}~`;
      case 'Language':
        return `@${v.languageTag}`;
      case 'LanguageStem':
        return v.stem === '' ? '@~' : `@${v.stem}~`;
      case 'IriStemRange':
        return `${typeof v.stem === 'string' ? `${this.iri(v.stem)}~` : '.'}${v.exclusions
          .map((e) => ` - ${typeof e === 'string' ? this.iri(e) : `${this.iri(e.stem)}~`}`)
          .join('')}`;
      case 'LiteralStemRange':
        return `${typeof v.stem === 'string' ? `${lit(v.stem)}~` : '.'}${v.exclusions
          .map((e) => ` - ${typeof e === 'string' ? lit(e) : `${lit(e.stem)}~`}`)
          .join('')}`;
      case 'LanguageStemRange':
        return `${typeof v.stem === 'string' ? (v.stem === '' ? '@~' : `@${v.stem}~`) : '.'}${v.exclusions
          .map((e) => ` - @${typeof e === 'string' ? e : `${e.stem}~`}`)
          .join('')}`;
      default:
        return '';
    }
  }

  nodeConstraint(nc: ShExJ.NodeConstraint): string {
    const parts: Array<string> = [];
    if (nc.nodeKind !== undefined) parts.push(nc.nodeKind.toUpperCase());
    if (nc.datatype !== undefined) parts.push(this.iri(nc.datatype));
    if (nc.values !== undefined)
      parts.push(`[${nc.values.map((v) => this.valueSetValue(v)).join(' ')}]`);
    if (nc.length !== undefined) parts.push(`LENGTH ${nc.length}`);
    if (nc.minlength !== undefined) parts.push(`MINLENGTH ${nc.minlength}`);
    if (nc.maxlength !== undefined) parts.push(`MAXLENGTH ${nc.maxlength}`);
    if (nc.pattern !== undefined) parts.push(`/${escapeRegexp(nc.pattern)}/${nc.flags ?? ''}`);
    if (nc.mininclusive !== undefined) parts.push(`MININCLUSIVE ${nc.mininclusive}`);
    if (nc.minexclusive !== undefined) parts.push(`MINEXCLUSIVE ${nc.minexclusive}`);
    if (nc.maxinclusive !== undefined) parts.push(`MAXINCLUSIVE ${nc.maxinclusive}`);
    if (nc.maxexclusive !== undefined) parts.push(`MAXEXCLUSIVE ${nc.maxexclusive}`);
    if (nc.totaldigits !== undefined) parts.push(`TOTALDIGITS ${nc.totaldigits}`);
    if (nc.fractiondigits !== undefined) parts.push(`FRACTIONDIGITS ${nc.fractiondigits}`);
    if (parts.length === 0) parts.push('.');
    return parts.join(' ') + this.annotations(nc.annotations) + this.semActs(nc.semActs);
  }

  /**
   * Prints a shape expression. `inline` forbids annotations and semantic
   * actions at the top level, which are then wrapped in parentheses.
   */
  shapeExpr(e: ShExJ.ShapeExprOrRef, indent: string, inline: boolean): string {
    if (typeof e === 'string') return `@${this.label(e)}`;
    switch (e.type) {
      case 'ShapeOr':
        return e.shapeExprs.map((s) => this.junct(s, indent, 'ShapeOr')).join(' OR ');
      case 'ShapeAnd':
        return e.shapeExprs.map((s) => this.junct(s, indent, 'ShapeAnd')).join(' AND ');
      case 'ShapeNot':
        return `NOT ${this.junct(e.shapeExpr, indent, 'ShapeNot')}`;
      case 'NodeConstraint': {
        const s = this.nodeConstraint(e);
        return inline && (e.annotations !== undefined || e.semActs !== undefined) ? `(${s})` : s;
      }
      case 'Shape': {
        const s = this.shape(e, indent);
        return inline && (e.annotations !== undefined || e.semActs !== undefined) ? `(${s})` : s;
      }
      case 'ShapeExternal':
        return 'EXTERNAL';
    }
  }

  junct(e: ShExJ.ShapeExprOrRef, indent: string, parent: string): string {
    if (typeof e === 'string') return `@${this.label(e)}`;
    const needsParens =
      e.type === 'ShapeOr' ||
      (e.type === 'ShapeAnd' && parent !== 'ShapeOr') ||
      (e.type === 'ShapeNot' && parent === 'ShapeNot') ||
      e.type === 'ShapeExternal';
    const s = this.shapeExpr(e, indent, false);
    return needsParens ? `(${s})` : s;
  }

  shape(s: ShExJ.Shape, indent: string): string {
    const head: Array<string> = [];
    for (const ext of s.extends ?? []) head.push(`EXTENDS ${this.junct(ext, indent, 'ShapeNot')}`);
    if (s.extra !== undefined)
      head.push(`EXTRA ${s.extra.map((p) => this.predicate(p)).join(' ')}`);
    if (s.closed === true) head.push('CLOSED');
    const inner = indent + this.unit;
    const body =
      s.expression === undefined
        ? '{ }'
        : `{\n${inner}${this.tripleExpr(s.expression, inner, false)}\n${indent}}`;
    return [...head, body].join(' ') + this.annotations(s.annotations) + this.semActs(s.semActs);
  }

  tripleExpr(t: ShExJ.TripleExprOrRef, indent: string, nested: boolean): string {
    if (typeof t === 'string') return `&${this.label(t)}`;
    const id = t.id !== undefined ? `$${this.label(t.id)} ` : '';
    switch (t.type) {
      case 'TripleConstraint': {
        const value = t.valueExpr === undefined ? '.' : this.shapeExpr(t.valueExpr, indent, true);
        return `${id}${t.inverse === true ? '^' : ''}${this.predicate(t.predicate)} ${value}${this.cardinality(t)}${this.annotations(t.annotations)}${this.semActs(t.semActs)}`;
      }
      case 'EachOf':
      case 'OneOf': {
        const sep = t.type === 'EachOf' ? ` ;\n${indent}` : `\n${indent}| `;
        const inner = indent + this.unit;
        const items = t.expressions.map((e) =>
          this.tripleExpr(e, inner, typeof e !== 'string' && e.type !== 'TripleConstraint'),
        );
        const decorated =
          id !== '' ||
          this.cardinality(t) !== '' ||
          t.annotations !== undefined ||
          t.semActs !== undefined;
        if (!decorated && !nested) return items.join(sep);
        if (!decorated && t.type === 'EachOf' && nested) return `(${items.join(sep)})`;
        return `${id}(${items.join(sep)})${this.cardinality(t)}${this.annotations(t.annotations)}${this.semActs(t.semActs)}`;
      }
    }
  }

  schema(schema: ShExJ.Schema): string {
    const out: Array<string> = [];
    if (this.base !== undefined) out.push(`BASE <${escapeIri(this.base)}>`);
    for (const [p, ns] of this.prefixes.prefixes) out.push(`PREFIX ${p}: <${escapeIri(ns)}>`);
    for (const imp of schema.imports ?? []) out.push(`IMPORT ${this.iri(imp)}`);
    if (out.length > 0) out.push('');
    if (schema.startActs !== undefined) out.push(this.semActs(schema.startActs).trim());
    if (schema.start !== undefined) out.push(`start = ${this.shapeExpr(schema.start, '', false)}`);
    for (const decl of schema.shapes ?? []) {
      const head = `${decl.abstract === true ? 'ABSTRACT ' : ''}${this.label(decl.id)}`;
      const restricts = (decl.restricts ?? [])
        .map((r) => ` RESTRICTS ${this.junct(r, '', 'ShapeNot')}`)
        .join('');
      const body =
        typeof decl.shapeExpr === 'object' && decl.shapeExpr.type === 'ShapeExternal'
          ? 'EXTERNAL'
          : typeof decl.shapeExpr === 'string'
            ? `@${this.label(decl.shapeExpr)}`
            : this.shapeExpr(decl.shapeExpr, '', false);
      out.push(`${head}${restricts} ${body}`);
    }
    return `${out.join('\n')}\n`;
  }
}

/**
 * Prints a ShExJ schema as ShExC. Parsing the output yields an equivalent
 * schema.
 *
 * @since 0.1.0
 * @category printing
 */
export const print = (schema: ShExJ.Schema, options: PrintOptions = {}): string =>
  new Printer(options).schema(schema);
