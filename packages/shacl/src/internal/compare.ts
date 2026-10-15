/**
 * Ordering of RDF terms following the SPARQL `<` operator, as required by the
 * SHACL value range and property pair constraint components.
 *
 * @internal
 */
import { Term, Xsd } from '@thomasfosterau/effect-rdf';
import * as BigDecimal from 'effect/BigDecimal';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

type Num =
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'decimal'; readonly value: BigDecimal.BigDecimal }
  | { readonly kind: 'float'; readonly value: number };

const toNum = (v: Xsd.Value): Num | undefined => {
  switch (v._tag) {
    case 'Integer':
      return { kind: 'integer', value: v.value };
    case 'Decimal':
      return { kind: 'decimal', value: v.value };
    case 'Float':
    case 'Double':
      return { kind: 'float', value: v.value };
    default:
      return undefined;
  }
};

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

const compareNum = (a: Num, b: Num): -1 | 0 | 1 | undefined => {
  if (a.kind === 'float' || b.kind === 'float') {
    const x =
      a.kind === 'float'
        ? a.value
        : Number(a.kind === 'integer' ? a.value : BigDecimal.format(a.value));
    const y =
      b.kind === 'float'
        ? b.value
        : Number(b.kind === 'integer' ? b.value : BigDecimal.format(b.value));
    if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
    return sign(x - y) || (x < y ? -1 : x > y ? 1 : 0);
  }
  if (a.kind === 'integer' && b.kind === 'integer')
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  const x = a.kind === 'integer' ? BigDecimal.fromBigInt(a.value) : a.value;
  const y = b.kind === 'integer' ? BigDecimal.fromBigInt(b.value) : b.value;
  return BigDecimal.Order(x, y);
};

const FOURTEEN_HOURS = 14 * 60 * 60 * 1000;

/**
 * Compares two terms. Returns `undefined` when they are not comparable (in
 * which case every SPARQL comparison yields an error, i.e. false).
 *
 * @internal
 */
export const compareTerms = (a: Term.Term, b: Term.Term): -1 | 0 | 1 | undefined => {
  if (a._tag !== 'Literal' || b._tag !== 'Literal') return undefined;
  const va = Xsd.toValue(a);
  const vb = Xsd.toValue(b);
  const na = toNum(va);
  const nb = toNum(vb);
  if (na !== undefined && nb !== undefined) return compareNum(na, nb);
  if (na !== undefined || nb !== undefined) return undefined;
  if (va._tag === 'String' && vb._tag === 'String') {
    // Only simple literals / xsd:string are ordered; language-tagged strings
    // are only comparable when they share a tag.
    if (a.language !== '' || b.language !== '') {
      if (a.language.toLowerCase() !== b.language.toLowerCase()) return undefined;
    } else if (a.datatype.value !== XSD_STRING || b.datatype.value !== XSD_STRING) {
      return undefined;
    }
    return va.value < vb.value ? -1 : va.value > vb.value ? 1 : 0;
  }
  if (va._tag === 'Boolean' && vb._tag === 'Boolean') {
    return va.value === vb.value ? 0 : va.value ? 1 : -1;
  }
  if (va._tag === 'DateTime' && vb._tag === 'DateTime') {
    if (va.kind !== vb.kind) return undefined;
    const d = va.epochMillis - vb.epochMillis;
    if ((va.timezone === undefined) === (vb.timezone === undefined)) return sign(d);
    // One value has a timezone and the other does not: the result is only
    // determinate when they are more than 14 hours apart.
    return Math.abs(d) > FOURTEEN_HOURS ? sign(d) : undefined;
  }
  if (va._tag === 'Duration' && vb._tag === 'Duration') {
    const m = sign(va.months - vb.months);
    const s = sign(va.seconds - vb.seconds);
    if (m === 0) return s;
    if (s === 0 || s === m) return m;
    return undefined;
  }
  if (va._tag === 'Other' && vb._tag === 'Other') {
    return a.key === b.key ? 0 : undefined;
  }
  return undefined;
};
