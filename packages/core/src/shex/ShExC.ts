/**
 * The ShEx compact syntax (ShExC): a hand-written parser producing ShExJ and
 * a printer from ShExJ back to ShExC.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Iri from '../Iri.ts';
import * as PrefixMap from '../PrefixMap.ts';
import { RdfParseError } from '../Serialization.ts';
import { lineColumn } from './internal/lexer.ts';
import { parseShExC } from './internal/shexcParser.ts';
import type * as ShExJ from './ShExJ.ts';
import * as Predicate from 'effect/Predicate';

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

const isPrefixMap = (
  prefixes: Readonly<Record<string, string>> | PrefixMap.PrefixMap,
): prefixes is PrefixMap.PrefixMap =>
  'prefixes' in prefixes && HashMap.isHashMap(prefixes.prefixes);

const toPrefixMap = (prefixes: ParseOptions['prefixes']): PrefixMap.PrefixMap =>
  prefixes === undefined
    ? PrefixMap.empty
    : isPrefixMap(prefixes)
      ? prefixes
      : PrefixMap.make(prefixes);

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
    const result = parseShExC(input, {
      baseIri: Option.fromUndefinedOr(options.baseIri),
      prefixes: toPrefixMap(options.prefixes),
    });
    if (Result.isFailure(result)) {
      const { line, column } = lineColumn(input, result.failure.offset);
      return Effect.fail(
        new RdfParseError({ format: 'ShExC', message: result.failure.message, line, column }),
      );
    }
    return Effect.succeed({
      schema: result.success.schema,
      prefixes: result.success.prefixes,
      baseIri: Option.getOrUndefined(result.success.baseIri),
    });
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

const quoteLiteral = (s: string): string => `"${escapeString(s)}"`;

/** A value without a string `type`, or with a `value`, is an object literal in ShExJ. */
const isObjectLiteral = (v: Exclude<ShExJ.ValueSetValue, string>): v is ShExJ.ObjectLiteral =>
  !Predicate.isString(v.type) || 'value' in v;

class Printer {
  readonly prefixes: PrefixMap.PrefixMap;
  readonly base: Option.Option<string>;
  readonly unit: string;

  constructor(options: PrintOptions) {
    this.prefixes = options.prefixes ?? PrefixMap.empty;
    this.base = Option.fromUndefinedOr(options.baseIri);
    this.unit = options.indent ?? '  ';
  }

  iri(iri: string): string {
    return Option.match(PrefixMap.compact(this.prefixes, iri), {
      onSome: ([prefix, local]) => `${prefix}:${local}`,
      onNone: () =>
        `<${escapeIri(
          Option.getOrElse(
            Option.flatMap(this.base, (base) => Iri.relativize(iri, base)),
            () => iri,
          ),
        )}>`,
    });
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
    return Predicate.isString(v) ? this.iri(v) : this.literal(v);
  }

  semActs(acts: ReadonlyArray<ShExJ.SemAct> = []): string {
    return acts
      .map((a) => ` %${this.iri(a.name)}${a.code === undefined ? '%' : `{${escapeCode(a.code)}%}`}`)
      .join('');
  }

  annotations(annots: ReadonlyArray<ShExJ.Annotation> = []): string {
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
    if (Predicate.isString(v)) return this.iri(v);
    if (isObjectLiteral(v)) return this.literal(v);
    return Match.value(v).pipe(
      Match.withReturnType<string>(),
      Match.discriminator('type')('IriStem', (member) => `${this.iri(member.stem)}~`),
      Match.discriminator('type')('LiteralStem', (member) => `${quoteLiteral(member.stem)}~`),
      Match.discriminator('type')('Language', (member) => `@${member.languageTag}`),
      Match.discriminator('type')('LanguageStem', (member) =>
        member.stem === '' ? '@~' : `@${member.stem}~`,
      ),
      Match.discriminator('type')(
        'IriStemRange',
        (member) =>
          `${Predicate.isString(member.stem) ? `${this.iri(member.stem)}~` : '.'}${member.exclusions
            .map((e) => ` - ${Predicate.isString(e) ? this.iri(e) : `${this.iri(e.stem)}~`}`)
            .join('')}`,
      ),
      Match.discriminator('type')(
        'LiteralStemRange',
        (member) =>
          `${Predicate.isString(member.stem) ? `${quoteLiteral(member.stem)}~` : '.'}${member.exclusions
            .map(
              (e) => ` - ${Predicate.isString(e) ? quoteLiteral(e) : `${quoteLiteral(e.stem)}~`}`,
            )
            .join('')}`,
      ),
      Match.discriminator('type')(
        'LanguageStemRange',
        (member) =>
          `${Predicate.isString(member.stem) ? (member.stem === '' ? '@~' : `@${member.stem}~`) : '.'}${member.exclusions
            .map((e) => ` - @${Predicate.isString(e) ? e : `${e.stem}~`}`)
            .join('')}`,
      ),
      Match.orElse(() => ''),
    );
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
    if (Arr.isReadonlyArrayEmpty(parts)) parts.push('.');
    return parts.join(' ') + this.annotations(nc.annotations) + this.semActs(nc.semActs);
  }

  /**
   * Prints a shape expression. `inline` forbids annotations and semantic
   * actions at the top level, which are then wrapped in parentheses.
   */
  shapeExpr(e: ShExJ.ShapeExprOrRef, indent: string, inline: boolean): string {
    if (Predicate.isString(e)) return `@${this.label(e)}`;
    return Match.value(e).pipe(
      Match.withReturnType<string>(),
      Match.discriminator('type')('ShapeOr', (expr) =>
        expr.shapeExprs.map((s) => this.junct(s, indent, 'ShapeOr')).join(' OR '),
      ),
      Match.discriminator('type')('ShapeAnd', (expr) =>
        expr.shapeExprs.map((s) => this.junct(s, indent, 'ShapeAnd')).join(' AND '),
      ),
      Match.discriminator('type')(
        'ShapeNot',
        (expr) => `NOT ${this.junct(expr.shapeExpr, indent, 'ShapeNot')}`,
      ),
      Match.discriminator('type')('NodeConstraint', (expr) => {
        const s = this.nodeConstraint(expr);
        return inline && (expr.annotations !== undefined || expr.semActs !== undefined)
          ? `(${s})`
          : s;
      }),
      Match.discriminator('type')('Shape', (expr) => {
        const s = this.shape(expr, indent);
        return inline && (expr.annotations !== undefined || expr.semActs !== undefined)
          ? `(${s})`
          : s;
      }),
      Match.discriminator('type')('ShapeExternal', () => 'EXTERNAL'),
      Match.exhaustive,
    );
  }

  junct(e: ShExJ.ShapeExprOrRef, indent: string, parent: string): string {
    if (Predicate.isString(e)) return `@${this.label(e)}`;
    const needsParens =
      e.type === 'ShapeOr' ||
      (e.type === 'ShapeAnd' && parent !== 'ShapeOr') ||
      (e.type === 'ShapeNot' && parent === 'ShapeNot') ||
      e.type === 'ShapeExternal';
    const s = this.shapeExpr(e, indent, false);
    return needsParens ? `(${s})` : s;
  }

  shape(s: ShExJ.Shape, indent: string): string {
    const head = [
      ...Arr.map(s.extends ?? [], (ext) => `EXTENDS ${this.junct(ext, indent, 'ShapeNot')}`),
      ...(s.extra === undefined
        ? []
        : [`EXTRA ${s.extra.map((p) => this.predicate(p)).join(' ')}`]),
      ...(s.closed === true ? ['CLOSED'] : []),
    ];
    const inner = indent + this.unit;
    const body =
      s.expression === undefined
        ? '{ }'
        : `{\n${inner}${this.tripleExpr(s.expression, inner, false)}\n${indent}}`;
    return [...head, body].join(' ') + this.annotations(s.annotations) + this.semActs(s.semActs);
  }

  tripleExpr(t: ShExJ.TripleExprOrRef, indent: string, nested: boolean): string {
    if (Predicate.isString(t)) return `&${this.label(t)}`;
    const id = t.id !== undefined ? `$${this.label(t.id)} ` : '';
    return Match.value(t).pipe(
      Match.withReturnType<string>(),
      Match.discriminator('type')('TripleConstraint', (expr) => {
        const value =
          expr.valueExpr === undefined ? '.' : this.shapeExpr(expr.valueExpr, indent, true);
        return `${id}${expr.inverse === true ? '^' : ''}${this.predicate(expr.predicate)} ${value}${this.cardinality(expr)}${this.annotations(expr.annotations)}${this.semActs(expr.semActs)}`;
      }),
      Match.discriminator('type')('EachOf', 'OneOf', (expr) => {
        const sep = expr.type === 'EachOf' ? ` ;\n${indent}` : `\n${indent}| `;
        const inner = indent + this.unit;
        const items = expr.expressions.map((e) =>
          this.tripleExpr(e, inner, !Predicate.isString(e) && e.type !== 'TripleConstraint'),
        );
        const decorated =
          id !== '' ||
          this.cardinality(expr) !== '' ||
          expr.annotations !== undefined ||
          expr.semActs !== undefined;
        if (!decorated && !nested) return items.join(sep);
        if (!decorated && expr.type === 'EachOf' && nested) return `(${items.join(sep)})`;
        return `${id}(${items.join(sep)})${this.cardinality(expr)}${this.annotations(expr.annotations)}${this.semActs(expr.semActs)}`;
      }),
      Match.exhaustive,
    );
  }

  schema(schema: ShExJ.Schema): string {
    const header = [
      ...Arr.fromOption(Option.map(this.base, (base) => `BASE <${escapeIri(base)}>`)),
      ...Arr.map(PrefixMap.entries(this.prefixes), ([p, ns]) => `PREFIX ${p}: <${escapeIri(ns)}>`),
      ...Arr.map(schema.imports ?? [], (imp) => `IMPORT ${this.iri(imp)}`),
    ];
    const out = [
      ...header,
      ...(Arr.isReadonlyArrayNonEmpty(header) ? [''] : []),
      ...(schema.startActs === undefined ? [] : [this.semActs(schema.startActs).trim()]),
      ...(schema.start === undefined ? [] : [`start = ${this.shapeExpr(schema.start, '', false)}`]),
      ...Arr.map(schema.shapes ?? [], (decl) => this.decl(decl)),
    ];
    return `${out.join('\n')}\n`;
  }

  decl(decl: ShExJ.ShapeDecl): string {
    const head = `${decl.abstract === true ? 'ABSTRACT ' : ''}${this.label(decl.id)}`;
    const restricts = (decl.restricts ?? [])
      .map((r) => ` RESTRICTS ${this.junct(r, '', 'ShapeNot')}`)
      .join('');
    const body =
      !Predicate.isString(decl.shapeExpr) && decl.shapeExpr.type === 'ShapeExternal'
        ? 'EXTERNAL'
        : Predicate.isString(decl.shapeExpr)
          ? `@${this.label(decl.shapeExpr)}`
          : this.shapeExpr(decl.shapeExpr, '', false);
    return `${head}${restricts} ${body}`;
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
