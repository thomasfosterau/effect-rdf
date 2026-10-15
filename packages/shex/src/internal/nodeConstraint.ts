/**
 * Node constraint evaluation (`satisfies2`): node kinds, datatypes, XML
 * Schema string and numeric facets, and value sets.
 *
 * @internal
 */
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';
import type * as ShExJ from '../ShExJ.ts';
import { compileXPathRegex } from './xpathRegex.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_STRING = `${XSD}string`;
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

const decimalDerived = new Set(
  [
    'decimal',
    'integer',
    'nonPositiveInteger',
    'negativeInteger',
    'long',
    'int',
    'short',
    'byte',
    'nonNegativeInteger',
    'unsignedLong',
    'unsignedInt',
    'unsignedShort',
    'unsignedByte',
    'positiveInteger',
  ].map((l) => XSD + l),
);

/** The string a string facet applies to. */
const lexicalForm = (n: Term.Term): string =>
  n._tag === 'Literal' || n._tag === 'NamedNode' || n._tag === 'BlankNode' ? n.value : n.key;

const codePointLength = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const regexCache = new Map<string, RegExp | Error>();

const getRegex = (pattern: string, flags: string | undefined): RegExp | Error => {
  const key = `${flags ?? ''}/${pattern}`;
  let re = regexCache.get(key);
  if (re === undefined) {
    try {
      re = compileXPathRegex(pattern, flags ?? '');
    } catch (e) {
      re = e instanceof Error ? e : new Error(String(e));
    }
    regexCache.set(key, re);
  }
  return re;
};

interface DecimalParts {
  readonly negative: boolean;
  /** Integer digits without leading zeros (may be empty). */
  readonly int: string;
  /** Fraction digits without trailing zeros (may be empty). */
  readonly frac: string;
}

const decimalParts = (lexical: string): DecimalParts | undefined => {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(lexical.trim());
  if (m === null || (m[2] === '' && (m[3] ?? '') === '')) return undefined;
  const int = m[2]!.replace(/^0+/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  return { negative: m[1] === '-' && (int !== '' || frac !== ''), int, frac };
};

const compareDecimalParts = (a: DecimalParts, b: DecimalParts): number => {
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const sign = a.negative ? -1 : 1;
  if (a.int.length !== b.int.length) return sign * (a.int.length < b.int.length ? -1 : 1);
  if (a.int !== b.int) return sign * (a.int < b.int ? -1 : 1);
  const len = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(len, '0');
  const fb = b.frac.padEnd(len, '0');
  if (fa === fb) return 0;
  return sign * (fa < fb ? -1 : 1);
};

const numberToDecimalParts = (n: number): DecimalParts | undefined => {
  if (!Number.isFinite(n)) return undefined;
  const s = String(n);
  if (/e/i.test(s)) {
    // Expand exponent notation exactly.
    const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
    if (m === null) return undefined;
    const digits = m[2]! + (m[3] ?? '');
    const exp = parseInt(m[4]!, 10) - (m[3] ?? '').length;
    const body =
      exp >= 0
        ? digits + '0'.repeat(exp)
        : (() => {
            const padded = digits.padStart(-exp + 1, '0');
            return `${padded.slice(0, exp)}.${padded.slice(exp)}`;
          })();
    return decimalParts(m[1] + body);
  }
  return decimalParts(s);
};

/** Numeric value of a literal for comparison, or undefined if not numeric/invalid. */
type Numeric =
  | { readonly kind: 'decimal'; readonly parts: DecimalParts }
  | { readonly kind: 'float'; readonly value: number };

const numericValue = (n: Term.Term): Numeric | undefined => {
  if (n._tag !== 'Literal') return undefined;
  const dt = n.datatype.value;
  if (!Xsd.isNumericDatatype(dt) || !Xsd.isValidLexical(dt, n.value)) return undefined;
  if (decimalDerived.has(dt)) {
    const parts = decimalParts(n.value);
    return parts === undefined ? undefined : { kind: 'decimal', parts };
  }
  const v = n.value.trim();
  const value =
    v === 'INF' || v === '+INF'
      ? Infinity
      : v === '-INF'
        ? -Infinity
        : v === 'NaN'
          ? NaN
          : Number(v);
  return { kind: 'float', value };
};

/** Compares a numeric value with a facet; returns NaN when incomparable. */
const compareWith = (v: Numeric, facet: number): number => {
  if (v.kind === 'decimal') {
    const f = numberToDecimalParts(facet);
    if (f === undefined) {
      if (Number.isNaN(facet)) return NaN;
      return facet === Infinity ? -1 : 1;
    }
    return compareDecimalParts(v.parts, f);
  }
  if (Number.isNaN(v.value) || Number.isNaN(facet)) return NaN;
  return v.value < facet ? -1 : v.value > facet ? 1 : 0;
};

const lowerEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Basic language-range filtering (RFC 4647 §3.3.1). */
const languageMatches = (tag: string, range: string): boolean => {
  if (range === '' || range === '*') return tag !== '';
  const t = tag.toLowerCase();
  const r = range.toLowerCase();
  return t === r || t.startsWith(`${r}-`);
};

const literalEquals = (n: Term.Literal, v: ShExJ.ObjectLiteral): boolean => {
  if (n.value !== v.value) return false;
  if (v.language !== undefined) return n.language !== '' && lowerEq(n.language, v.language);
  if (n.language !== '') return false;
  return n.datatype.value === (v.type ?? XSD_STRING);
};

/**
 * Whether a term matches a value set value.
 *
 * @internal
 */
export const valueMatches = (n: Term.Term, v: ShExJ.ValueSetValue): boolean => {
  if (typeof v === 'string') return n._tag === 'NamedNode' && n.value === v;
  if (!('type' in v) || 'value' in v) {
    return n._tag === 'Literal' && literalEquals(n, v as ShExJ.ObjectLiteral);
  }
  switch (v.type) {
    case 'IriStem':
      return n._tag === 'NamedNode' && n.value.startsWith(v.stem);
    case 'IriStemRange': {
      if (n._tag !== 'NamedNode') return false;
      if (typeof v.stem === 'string' && !n.value.startsWith(v.stem)) return false;
      return !v.exclusions.some((e) =>
        typeof e === 'string' ? n.value === e : n.value.startsWith(e.stem),
      );
    }
    case 'LiteralStem':
      return n._tag === 'Literal' && n.value.startsWith(v.stem);
    case 'LiteralStemRange': {
      if (n._tag !== 'Literal') return false;
      if (typeof v.stem === 'string' && !n.value.startsWith(v.stem)) return false;
      return !v.exclusions.some((e) =>
        typeof e === 'string' ? n.value === e : n.value.startsWith(e.stem),
      );
    }
    case 'Language':
      return n._tag === 'Literal' && n.language !== '' && lowerEq(n.language, v.languageTag);
    case 'LanguageStem':
      return n._tag === 'Literal' && n.language !== '' && languageMatches(n.language, v.stem);
    case 'LanguageStemRange': {
      if (n._tag !== 'Literal' || n.language === '') return false;
      if (typeof v.stem === 'string' && !languageMatches(n.language, v.stem)) return false;
      return !v.exclusions.some((e) =>
        typeof e === 'string' ? lowerEq(n.language, e) : languageMatches(n.language, e.stem),
      );
    }
    default:
      return false;
  }
};

/**
 * Evaluates a node constraint (without its semantic actions). Returns
 * `undefined` on success or a reason on failure.
 *
 * @internal
 */
export const checkNodeConstraint = (n: Term.Term, nc: ShExJ.NodeConstraint): string | undefined => {
  switch (nc.nodeKind) {
    case 'iri':
      if (n._tag !== 'NamedNode') return `${n.key} is not an IRI`;
      break;
    case 'bnode':
      if (n._tag !== 'BlankNode') return `${n.key} is not a blank node`;
      break;
    case 'literal':
      if (n._tag !== 'Literal') return `${n.key} is not a literal`;
      break;
    case 'nonliteral':
      if (n._tag !== 'NamedNode' && n._tag !== 'BlankNode')
        return `${n.key} is not an IRI or blank node`;
      break;
    default:
      break;
  }
  if (nc.datatype !== undefined) {
    if (n._tag !== 'Literal') return `${n.key} is not a literal of datatype <${nc.datatype}>`;
    const actual = n.language !== '' ? RDF_LANG_STRING : n.datatype.value;
    if (actual !== nc.datatype && !(n.language !== '' && n.datatype.value === nc.datatype))
      return `${n.key} does not have datatype <${nc.datatype}>`;
    if (
      n.language === '' &&
      (!Xsd.isValidLexical(nc.datatype, n.value) ||
        ((nc.datatype === `${XSD}float` || nc.datatype === `${XSD}double`) && n.value === '+INF'))
    )
      return `${n.key} is not a valid <${nc.datatype}>`;
  }
  if (
    nc.length !== undefined ||
    nc.minlength !== undefined ||
    nc.maxlength !== undefined ||
    nc.pattern !== undefined
  ) {
    const lex = lexicalForm(n);
    const len = codePointLength(lex);
    if (nc.length !== undefined && len !== nc.length)
      return `${n.key} has length ${len}, expected ${nc.length}`;
    if (nc.minlength !== undefined && len < nc.minlength)
      return `${n.key} has length ${len}, expected at least ${nc.minlength}`;
    if (nc.maxlength !== undefined && len > nc.maxlength)
      return `${n.key} has length ${len}, expected at most ${nc.maxlength}`;
    if (nc.pattern !== undefined) {
      const re = getRegex(nc.pattern, nc.flags);
      if (re instanceof Error) return `invalid pattern /${nc.pattern}/: ${re.message}`;
      re.lastIndex = 0;
      if (!re.test(lex)) return `${n.key} does not match /${nc.pattern}/${nc.flags ?? ''}`;
    }
  }
  const numericFacets: ReadonlyArray<readonly [keyof ShExJ.Facets, (c: number) => boolean]> = [
    ['mininclusive', (c) => c >= 0],
    ['minexclusive', (c) => c > 0],
    ['maxinclusive', (c) => c <= 0],
    ['maxexclusive', (c) => c < 0],
  ];
  for (const [facet, ok] of numericFacets) {
    const limit = nc[facet] as number | undefined;
    if (limit === undefined) continue;
    const v = numericValue(n);
    if (v === undefined) return `${n.key} is not numeric (${facet})`;
    if (!ok(compareWith(v, limit))) return `${n.key} violates ${facet} ${limit}`;
  }
  if (nc.totaldigits !== undefined || nc.fractiondigits !== undefined) {
    if (
      n._tag !== 'Literal' ||
      !decimalDerived.has(n.datatype.value) ||
      !Xsd.isValidLexical(n.datatype.value, n.value)
    )
      return `${n.key} is not an xsd:decimal value`;
    const parts = decimalParts(n.value);
    if (parts === undefined) return `${n.key} is not an xsd:decimal value`;
    const total = Math.max(1, parts.int.length + parts.frac.length);
    if (nc.totaldigits !== undefined && total > nc.totaldigits)
      return `${n.key} has ${total} digits, expected at most ${nc.totaldigits}`;
    if (nc.fractiondigits !== undefined && parts.frac.length > nc.fractiondigits)
      return `${n.key} has ${parts.frac.length} fraction digits, expected at most ${nc.fractiondigits}`;
  }
  if (nc.values !== undefined && !nc.values.some((v) => valueMatches(n, v)))
    return `${n.key} is not in the value set`;
  return undefined;
};
