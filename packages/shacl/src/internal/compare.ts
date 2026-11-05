/**
 * Ordering of RDF terms following the SPARQL `<` operator, as required by the
 * SHACL value range and property pair constraint components.
 *
 * @internal
 */
import { Term, Xsd } from '@thomasfosterau/effect-rdf';
import * as BigDecimal from 'effect/BigDecimal';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

type Sign = -1 | 0 | 1;

type Num =
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'decimal'; readonly value: BigDecimal.BigDecimal }
  | { readonly kind: 'float'; readonly value: number };

// Built once: `toNum` runs for every numeric comparison.
const toNum: (v: Xsd.Value) => Option.Option<Num> = Match.type<Xsd.Value>().pipe(
  Match.tag('Integer', (v) => Option.some<Num>({ kind: 'integer', value: v.value })),
  Match.tag('Decimal', (v) => Option.some<Num>({ kind: 'decimal', value: v.value })),
  Match.tag('Float', 'Double', (v) => Option.some<Num>({ kind: 'float', value: v.value })),
  Match.orElse(() => Option.none<Num>()),
);

const sign = (n: number): Sign => (n < 0 ? -1 : n > 0 ? 1 : 0);

const toFloat = (n: Num): number =>
  n.kind === 'float'
    ? n.value
    : Number(n.kind === 'integer' ? n.value : BigDecimal.format(n.value));

const toDecimal = (n: Exclude<Num, { readonly kind: 'float' }>): BigDecimal.BigDecimal =>
  n.kind === 'integer' ? BigDecimal.fromBigInt(n.value) : n.value;

const compareNum = (a: Num, b: Num): Option.Option<Sign> => {
  if (a.kind === 'float' || b.kind === 'float') {
    const x = toFloat(a);
    const y = toFloat(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return Option.none();
    return Option.some(sign(x - y) || (x < y ? -1 : x > y ? 1 : 0));
  }
  if (a.kind === 'integer' && b.kind === 'integer')
    return Option.some(a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
  return Option.some(BigDecimal.Order(toDecimal(a), toDecimal(b)));
};

const FOURTEEN_HOURS = 14 * 60 * 60 * 1000;

const order = <A>(x: A, y: A): Sign => (x < y ? -1 : x > y ? 1 : 0);

const isString = Predicate.isTagged('String');
const isBoolean = Predicate.isTagged('Boolean');
const isDateTime = Predicate.isTagged('DateTime');
const isDuration = Predicate.isTagged('Duration');
const isOther = Predicate.isTagged('Other');

/** Simple literals / xsd:string are ordered; language-tagged strings only when they share a tag. */
const stringsComparable = (a: Term.Literal, b: Term.Literal): boolean =>
  a.language !== '' || b.language !== ''
    ? a.language.toLowerCase() === b.language.toLowerCase()
    : a.datatype.value === XSD_STRING && b.datatype.value === XSD_STRING;

const none = Option.none<Sign>();

const compareDateTimes = (
  x: Extract<Xsd.Value, { readonly _tag: 'DateTime' }>,
  y: Extract<Xsd.Value, { readonly _tag: 'DateTime' }>,
): Option.Option<Sign> => {
  if (x.kind !== y.kind) return none;
  const d = x.epochMillis - y.epochMillis;
  // One value has a timezone and the other does not: the result is only
  // determinate when they are more than 14 hours apart.
  return Predicate.isUndefined(x.timezone) === Predicate.isUndefined(y.timezone) ||
    Math.abs(d) > FOURTEEN_HOURS
    ? Option.some(sign(d))
    : none;
};

const compareDurations = (
  x: Extract<Xsd.Value, { readonly _tag: 'Duration' }>,
  y: Extract<Xsd.Value, { readonly _tag: 'Duration' }>,
): Option.Option<Sign> => {
  const m = sign(x.months - y.months);
  const s = sign(x.seconds - y.seconds);
  if (m === 0) return Option.some(s);
  return s === 0 || s === m ? Option.some(m) : none;
};

// Plain guards rather than a `Match`: this runs for every value of every
// range and property pair constraint. The right value must be of the same kind.
const compareValues = (
  va: Xsd.Value,
  vb: Xsd.Value,
  a: Term.Literal,
  b: Term.Literal,
): Option.Option<Sign> => {
  if (isString(va))
    return isString(vb) && stringsComparable(a, b) ? Option.some(order(va.value, vb.value)) : none;
  if (isBoolean(va))
    return isBoolean(vb) ? Option.some(va.value === vb.value ? 0 : va.value ? 1 : -1) : none;
  if (isDateTime(va)) return isDateTime(vb) ? compareDateTimes(va, vb) : none;
  if (isDuration(va)) return isDuration(vb) ? compareDurations(va, vb) : none;
  return isOther(va) && isOther(vb) && a.key === b.key ? Option.some(0) : none;
};

const compareLiterals = (a: Term.Literal, b: Term.Literal): Option.Option<Sign> => {
  const va = Xsd.toValue(a);
  const vb = Xsd.toValue(b);
  const na = toNum(va);
  const nb = toNum(vb);
  if (Option.isSome(na) && Option.isSome(nb)) return compareNum(na.value, nb.value);
  if (Option.isSome(na) || Option.isSome(nb)) return Option.none();
  return compareValues(va, vb, a, b);
};

/**
 * Compares two terms. Returns `None` when they are not comparable (in which
 * case every SPARQL comparison yields an error, i.e. false).
 *
 * @internal
 */
export const compareTerms = (a: Term.Term, b: Term.Term): Option.Option<Sign> =>
  Term.isLiteral(a) && Term.isLiteral(b) ? compareLiterals(a, b) : Option.none();
