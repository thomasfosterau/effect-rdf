/**
 * Node constraint evaluation (`satisfies2`): node kinds, datatypes, XML
 * Schema string and numeric facets, and value sets.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Term from '../../Term.ts';
import * as Xsd from '../../Xsd.ts';
import type * as ShExJ from '../ShExJ.ts';
import * as Regex from '../../internal/regex.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_STRING = `${XSD}string`;
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

const decimalDerived = MutableHashSet.fromIterable(
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
  Term.isLiteral(n) || Term.isNamedNode(n) || Term.isBlankNode(n) ? n.value : n.key;

/** The number of code points (a lone surrogate counts as one, as string iteration does). */
const codePointLength = (s: string): number =>
  s.length - (s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);

interface DecimalParts {
  readonly negative: boolean;
  /** Integer digits without leading zeros (may be empty). */
  readonly int: string;
  /** Fraction digits without trailing zeros (may be empty). */
  readonly frac: string;
}

const decimalParts = (lexical: string): Option.Option<DecimalParts> => {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(lexical.trim());
  if (m === null || ((m[2] ?? '') === '' && (m[3] ?? '') === '')) return Option.none();
  const int = (m[2] ?? '').replace(/^0+/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  return Option.some({ negative: m[1] === '-' && (int !== '' || frac !== ''), int, frac });
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

const numberToDecimalParts = (n: number): Option.Option<DecimalParts> => {
  if (!Number.isFinite(n)) return Option.none();
  const s = String(n);
  if (/e/i.test(s)) {
    // Expand exponent notation exactly.
    const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
    if (m === null) return Option.none();
    const digits = (m[2] ?? '') + (m[3] ?? '');
    const exp = parseInt(m[4] ?? '', 10) - (m[3] ?? '').length;
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

const numericValue = (n: Term.Term): Option.Option<Numeric> => {
  if (!Term.isLiteral(n)) return Option.none();
  const dt = n.datatype.value;
  if (!Xsd.isNumericDatatype(dt) || !Xsd.isValidLexical(dt, n.value)) return Option.none();
  if (MutableHashSet.has(decimalDerived, dt)) {
    return Option.map(decimalParts(n.value), (parts): Numeric => ({ kind: 'decimal', parts }));
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
  return Option.some({ kind: 'float', value });
};

/** Compares a numeric value with a facet; returns NaN when incomparable. */
const compareWith = (v: Numeric, facet: number): number => {
  if (v.kind === 'decimal') {
    const { parts } = v;
    return Option.match(numberToDecimalParts(facet), {
      onNone: () => (Number.isNaN(facet) ? NaN : facet === Infinity ? -1 : 1),
      onSome: (f) => compareDecimalParts(parts, f),
    });
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
 * Whether a value is in an IRI or literal stem range: under its stem (any
 * value, for a wildcard) and under none of its exclusions.
 */
const inStemRange = (value: string, range: ShExJ.IriStemRange | ShExJ.LiteralStemRange): boolean =>
  (!Predicate.isString(range.stem) || value.startsWith(range.stem)) &&
  !range.exclusions.some((e) => (Predicate.isString(e) ? value === e : value.startsWith(e.stem)));

// Built once: `valueMatches` runs it for every value set value a node is checked against.
const stemValueMatches: (
  v: Exclude<ShExJ.ValueSetValue, ShExJ.ObjectValue>,
  n: Term.Term,
) => boolean = Match.fn(
  (v: Exclude<ShExJ.ValueSetValue, ShExJ.ObjectValue>, _n: Term.Term) => v,
).pipe(
  Match.withReturnType<boolean>(),
  Match.when({ type: 'IriStem' }, (v, _v, n) => Term.isNamedNode(n) && n.value.startsWith(v.stem)),
  Match.when(
    { type: 'IriStemRange' },
    (v, _v, n) => Term.isNamedNode(n) && inStemRange(n.value, v),
  ),
  Match.when(
    { type: 'LiteralStem' },
    (v, _v, n) => Term.isLiteral(n) && n.value.startsWith(v.stem),
  ),
  Match.when(
    { type: 'LiteralStemRange' },
    (v, _v, n) => Term.isLiteral(n) && inStemRange(n.value, v),
  ),
  Match.when(
    { type: 'Language' },
    (v, _v, n) => Term.isLiteral(n) && n.language !== '' && lowerEq(n.language, v.languageTag),
  ),
  Match.when(
    { type: 'LanguageStem' },
    (v, _v, n) => Term.isLiteral(n) && n.language !== '' && languageMatches(n.language, v.stem),
  ),
  Match.when({ type: 'LanguageStemRange' }, (v, _v, n) => {
    if (!Term.isLiteral(n) || n.language === '') return false;
    if (Predicate.isString(v.stem) && !languageMatches(n.language, v.stem)) return false;
    return !v.exclusions.some((e) =>
      Predicate.isString(e) ? lowerEq(n.language, e) : languageMatches(n.language, e.stem),
    );
  }),
  Match.orElse(() => false),
);

/**
 * Whether a term matches a value set value.
 *
 * @internal
 */
export const valueMatches = (n: Term.Term, v: ShExJ.ValueSetValue): boolean => {
  if (Predicate.isString(v)) return Term.isNamedNode(n) && n.value === v;
  // A value without `type`, or with a `value`, is an object literal in ShExJ.
  if (!('type' in v) || 'value' in v) return Term.isLiteral(n) && literalEquals(n, v);
  return stemValueMatches(v, n);
};

const failure = (cond: boolean, message: () => string): Option.Option<string> =>
  cond ? Option.some(message()) : Option.none();

// Built once: `checkNodeConstraint` runs it for every node constraint it evaluates.
const nodeKindFailure = Match.fn((nc: ShExJ.NodeConstraint, _n: Term.Term) => nc.nodeKind).pipe(
  Match.withReturnType<Option.Option<string>>(),
  Match.when('iri', (_kind, _nc, n) =>
    failure(!Term.isNamedNode(n), () => `${n.key} is not an IRI`),
  ),
  Match.when('bnode', (_kind, _nc, n) =>
    failure(!Term.isBlankNode(n), () => `${n.key} is not a blank node`),
  ),
  Match.when('literal', (_kind, _nc, n) =>
    failure(!Term.isLiteral(n), () => `${n.key} is not a literal`),
  ),
  Match.when('nonliteral', (_kind, _nc, n) =>
    failure(!Term.isResource(n), () => `${n.key} is not an IRI or blank node`),
  ),
  Match.orElse(() => Option.none()),
);

/** The numeric range facets: how each reads its limit, and which comparisons it accepts. */
const numericFacets: ReadonlyArray<
  readonly [
    name: string,
    limit: (nc: ShExJ.NodeConstraint) => Option.Option<number>,
    ok: (c: number) => boolean,
  ]
> = [
  ['mininclusive', (nc) => Option.fromUndefinedOr(nc.mininclusive), (c) => c >= 0],
  ['minexclusive', (nc) => Option.fromUndefinedOr(nc.minexclusive), (c) => c > 0],
  ['maxinclusive', (nc) => Option.fromUndefinedOr(nc.maxinclusive), (c) => c <= 0],
  ['maxexclusive', (nc) => Option.fromUndefinedOr(nc.maxexclusive), (c) => c < 0],
];

/** The datatype check of a node constraint with a `datatype`. */
const datatypeFailure = (n: Term.Term, datatype: string): Option.Option<string> => {
  if (!Term.isLiteral(n)) return Option.some(`${n.key} is not a literal of datatype <${datatype}>`);
  const actual = n.language !== '' ? RDF_LANG_STRING : n.datatype.value;
  if (actual !== datatype && !(n.language !== '' && n.datatype.value === datatype))
    return Option.some(`${n.key} does not have datatype <${datatype}>`);
  return failure(
    n.language === '' &&
      (!Xsd.isValidLexical(datatype, n.value) ||
        ((datatype === `${XSD}float` || datatype === `${XSD}double`) && n.value === '+INF')),
    () => `${n.key} is not a valid <${datatype}>`,
  );
};

/** The string facets (`length`, `minlength`, `maxlength`, `pattern`). */
const stringFacetFailure = (n: Term.Term, nc: ShExJ.NodeConstraint): Option.Option<string> => {
  const lex = lexicalForm(n);
  const len = codePointLength(lex);
  if (nc.length !== undefined && len !== nc.length)
    return Option.some(`${n.key} has length ${len}, expected ${nc.length}`);
  if (nc.minlength !== undefined && len < nc.minlength)
    return Option.some(`${n.key} has length ${len}, expected at least ${nc.minlength}`);
  if (nc.maxlength !== undefined && len > nc.maxlength)
    return Option.some(`${n.key} has length ${len}, expected at most ${nc.maxlength}`);
  if (nc.pattern === undefined) return Option.none();
  const compiled = Regex.compileCached(nc.pattern, 'xpath', nc.flags ?? '');
  if (Result.isFailure(compiled))
    return Option.some(`invalid pattern /${nc.pattern}/: ${compiled.failure}`);
  return failure(
    !Regex.test(compiled.success, lex),
    () => `${n.key} does not match /${nc.pattern}/${nc.flags ?? ''}`,
  );
};

/** The numeric range facets, in order: the first one the node violates. */
const numericFacetFailure = (n: Term.Term, nc: ShExJ.NodeConstraint): Option.Option<string> =>
  Arr.findFirst(numericFacets, ([facet, limitOf, ok]) =>
    Option.flatMap(limitOf(nc), (limit) =>
      Option.match(numericValue(n), {
        onNone: () => Option.some(`${n.key} is not numeric (${facet})`),
        onSome: (v) =>
          failure(!ok(compareWith(v, limit)), () => `${n.key} violates ${facet} ${limit}`),
      }),
    ),
  );

/** The digits facets (`totaldigits`, `fractiondigits`). */
const digitsFailure = (n: Term.Term, nc: ShExJ.NodeConstraint): Option.Option<string> => {
  const parts =
    Term.isLiteral(n) &&
    MutableHashSet.has(decimalDerived, n.datatype.value) &&
    Xsd.isValidLexical(n.datatype.value, n.value)
      ? decimalParts(n.value)
      : Option.none();
  return Option.match(parts, {
    onNone: () => Option.some(`${n.key} is not an xsd:decimal value`),
    onSome: ({ int, frac }) => {
      const total = Math.max(1, int.length + frac.length);
      if (nc.totaldigits !== undefined && total > nc.totaldigits)
        return Option.some(`${n.key} has ${total} digits, expected at most ${nc.totaldigits}`);
      return failure(
        nc.fractiondigits !== undefined && frac.length > nc.fractiondigits,
        () => `${n.key} has ${frac.length} fraction digits, expected at most ${nc.fractiondigits}`,
      );
    },
  });
};

/**
 * Evaluates a node constraint (without its semantic actions): none on
 * success, or the reason it fails.
 *
 * @internal
 */
export const checkNodeConstraint = (
  n: Term.Term,
  nc: ShExJ.NodeConstraint,
): Option.Option<string> => {
  const kindFailure = nodeKindFailure(nc, n);
  if (Option.isSome(kindFailure)) return kindFailure;
  if (nc.datatype !== undefined) {
    const f = datatypeFailure(n, nc.datatype);
    if (Option.isSome(f)) return f;
  }
  if (
    nc.length !== undefined ||
    nc.minlength !== undefined ||
    nc.maxlength !== undefined ||
    nc.pattern !== undefined
  ) {
    const f = stringFacetFailure(n, nc);
    if (Option.isSome(f)) return f;
  }
  const numeric = numericFacetFailure(n, nc);
  if (Option.isSome(numeric)) return numeric;
  if (nc.totaldigits !== undefined || nc.fractiondigits !== undefined) {
    const f = digitsFailure(n, nc);
    if (Option.isSome(f)) return f;
  }
  return failure(
    nc.values !== undefined && !nc.values.some((v) => valueMatches(n, v)),
    () => `${n.key} is not in the value set`,
  );
};
