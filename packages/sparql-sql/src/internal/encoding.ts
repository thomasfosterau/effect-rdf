/**
 * The encoding of RDF terms as rows of the term dictionary.
 *
 * @internal
 */
import * as Match from 'effect/Match';
import * as BigDecimal from 'effect/BigDecimal';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';
import * as Store from '@thomasfosterau/effect-sparql/Store';

/** Term kinds stored in the `kind` column. */
export const Kind = {
  NamedNode: 1,
  BlankNode: 2,
  Literal: 3,
  Triple: 4,
} as const;

/**
 * Comparison classes stored in the `cls` column. They let the SQL
 * translation of SPARQL comparisons decide, per row, which comparison rule
 * applies (numeric, string, boolean, …) — and tell the store which rules the
 * data could need that SQL cannot evaluate exactly.
 */
export const Cls = {
  /** IRIs and blank nodes. */
  Resource: 0,
  /** Integers and decimals whose double value is exact and order preserving. */
  SafeNumber: 1,
  /** Finite `xsd:double`. */
  Double: 2,
  /** Finite `xsd:float` (`num` holds the float value). */
  Float: 3,
  /** `xsd:string`. */
  String: 4,
  /** Language-tagged strings (with or without a base direction). */
  LangString: 5,
  /** Valid `xsd:boolean` (`num` is 0 or 1). */
  Boolean: 6,
  /** Valid date/time and duration literals. */
  Temporal: 7,
  /** Integers and decimals that do not fit a double exactly. */
  UnsafeNumber: 8,
  /** Literals of datatypes unknown to the engine. */
  Unknown: 9,
  /** Triple terms. */
  Triple: 10,
  /** `NaN` and infinite doubles and floats. */
  SpecialFloat: 11,
  /** Ill-formed literals of numeric datatypes. */
  IllFormedNumeric: 12,
  /** Other well-formed literals of known datatypes (e.g. `xsd:anyURI`). */
  OtherKnown: 13,
  /** Other ill-formed literals of known datatypes. */
  IllFormed: 14,
} as const;

/** All comparison classes. */
export const ALL_CLASSES: ReadonlyArray<number> = Array.from({ length: 15 }, (_, i) => i);

/** Classes of literals that are well-formed and of a known datatype. */
export const WELL_FORMED_KNOWN: ReadonlyArray<number> = [1, 2, 3, 4, 6, 7, 8, 11, 13];

const XSD = 'http://www.w3.org/2001/XMLSchema#';

const TEMPORAL = new Set(
  [
    'dateTime',
    'dateTimeStamp',
    'date',
    'time',
    'gYear',
    'gYearMonth',
    'gMonth',
    'gMonthDay',
    'gDay',
    'duration',
    'dayTimeDuration',
    'yearMonthDuration',
  ].map((l) => XSD + l),
);

const MAX_SAFE = 2n ** 53n;

const decimalDigits = (d: BigDecimal.BigDecimal): number => {
  const n = BigDecimal.normalize(d);
  const v = n.value < 0n ? -n.value : n.value;
  return v.toString().length;
};

/** A term's comparison class and, for numbers and booleans, its numeric value. */
export interface Classification {
  readonly cls: number;
  readonly num: number | null;
}

// Built once: `classify` runs it for every numeric literal.
const numericClass = Match.type<Xsd.Value>().pipe(
  Match.withReturnType<Classification>(),
  Match.tag('Integer', (v) =>
    v.value <= MAX_SAFE && v.value >= -MAX_SAFE
      ? { cls: Cls.SafeNumber, num: Number(v.value) }
      : { cls: Cls.UnsafeNumber, num: Number(v.value) },
  ),
  Match.tag('Decimal', (v) =>
    decimalDigits(v.value) <= 15
      ? { cls: Cls.SafeNumber, num: Number(BigDecimal.format(v.value)) }
      : { cls: Cls.UnsafeNumber, num: BigDecimal.toNumberUnsafe(v.value) },
  ),
  Match.tag('Float', 'Double', (v) =>
    Number.isFinite(v.value)
      ? { cls: v._tag === 'Float' ? Cls.Float : Cls.Double, num: v.value }
      : { cls: Cls.SpecialFloat, num: null },
  ),
  Match.orElse(() => ({ cls: Cls.IllFormedNumeric, num: null })),
);

// Built once: `classify` runs for every term `encode` writes.
const classifyTerm = Match.type<Term.GroundTerm>().pipe(
  Match.withReturnType<Classification>(),
  Match.tag('NamedNode', 'BlankNode', () => ({ cls: Cls.Resource, num: null })),
  Match.tag('Triple', () => ({ cls: Cls.Triple, num: null })),
  Match.tag('Literal', (term) => {
    if (term.language !== '') return { cls: Cls.LangString, num: null };
    const dt = term.datatype.value;
    if (dt === Term.XSD_STRING) return { cls: Cls.String, num: null };
    if (!Xsd.isKnownDatatype(dt)) return { cls: Cls.Unknown, num: null };
    const valid = Xsd.isValidLexical(dt, term.value);
    if (Xsd.isNumericDatatype(dt)) {
      if (!valid) return { cls: Cls.IllFormedNumeric, num: null };
      const v = Xsd.toValue(term);
      return numericClass(v);
    }
    if (!valid) return { cls: Cls.IllFormed, num: null };
    if (dt === `${XSD}boolean`) {
      return { cls: Cls.Boolean, num: term.value === 'true' || term.value === '1' ? 1 : 0 };
    }
    if (TEMPORAL.has(dt)) return { cls: Cls.Temporal, num: null };
    return { cls: Cls.OtherKnown, num: null };
  }),
  Match.exhaustive,
);

/** The comparison class and numeric value of a term. */
export const classify = (term: Term.GroundTerm): Classification => classifyTerm(term);

/** A row of the term dictionary (without the id). */
export interface TermRow {
  readonly kind: number;
  readonly value: string;
  readonly datatype: string;
  readonly lang: string;
  readonly dir: string;
  /** Triple term components. */
  readonly sub: number | null;
  readonly pre: number | null;
  readonly obj: number | null;
  readonly cls: number;
  readonly num: number | null;
}

// Built once: `encode` runs for every term a load or update writes.
const encodeRow = Match.fn(
  (
    term: Term.GroundTerm,
    _class: Classification,
    _componentIds?: readonly [number, number, number],
  ) => term,
).pipe(
  Match.withReturnType<TermRow>(),
  Match.tag('NamedNode', (term, _term, { cls, num }) => ({
    kind: Kind.NamedNode,
    value: term.value,
    datatype: '',
    lang: '',
    dir: '',
    sub: null,
    pre: null,
    obj: null,
    cls,
    num,
  })),
  Match.tag('BlankNode', (term, _term, { cls, num }) => ({
    kind: Kind.BlankNode,
    value: term.value,
    datatype: '',
    lang: '',
    dir: '',
    sub: null,
    pre: null,
    obj: null,
    cls,
    num,
  })),
  Match.tag('Literal', (term, _term, { cls, num }) => ({
    kind: Kind.Literal,
    value: term.value,
    datatype: term.datatype.value,
    lang: term.language,
    dir: term.direction ?? '',
    sub: null,
    pre: null,
    obj: null,
    cls,
    num,
  })),
  Match.tag('Triple', (_triple, _term, { cls, num }, componentIds) => {
    if (componentIds === undefined) {
      throw new Store.StoreError({ message: 'Triple terms need component ids' });
    }
    return {
      kind: Kind.Triple,
      value: componentIds.join(' '),
      datatype: '',
      lang: '',
      dir: '',
      sub: componentIds[0],
      pre: componentIds[1],
      obj: componentIds[2],
      cls,
      num,
    };
  }),
  Match.exhaustive,
);

/**
 * The dictionary row of a term. Triple terms store the ids of their
 * components in `value` (`"s p o"`), so that `(value, kind, datatype, lang,
 * dir)` is a unique key for every term.
 */
export const encode = (
  term: Term.GroundTerm,
  componentIds?: readonly [number, number, number],
): TermRow => encodeRow(term, classify(term), componentIds);

/** The unique key of a dictionary row. */
export const rowKey = (row: {
  readonly kind: number;
  readonly value: string;
  readonly datatype: string;
  readonly lang: string;
  readonly dir: string;
}): string => `${row.kind}\u0000${row.value}\u0000${row.datatype}\u0000${row.lang}\u0000${row.dir}`;

const datatypes = new Map<string, Term.NamedNode>();

const datatype = (iri: string): Term.NamedNode => {
  let n = datatypes.get(iri);
  if (n === undefined) {
    n = Term.namedNode(iri);
    if (datatypes.size < 10_000) datatypes.set(iri, n);
  }
  return n;
};

// Built once: `decode` runs for every term a query result reads back.
const decodeRow = Match.fn(
  (kind: number, _value: string, _dt: string, _lang: string, _dir: string) => kind,
).pipe(
  Match.withReturnType<Term.GroundTerm | readonly [number, number, number]>(),
  Match.when(Kind.NamedNode, (_kind, _k, value) => Term.namedNode(value)),
  Match.when(Kind.BlankNode, (_kind, _k, value) => Term.blankNode(value)),
  Match.when(
    Kind.Literal,
    (_kind, _k, value, dt, lang, dir) =>
      new Term.Literal(value, datatype(dt), lang, dir === 'ltr' || dir === 'rtl' ? dir : undefined),
  ),
  Match.orElse((_kind, _k, value) => {
    const [s, p, o] = value.split(' ').map(Number);
    return [s!, p!, o!];
  }),
);

/**
 * Decodes a non-triple dictionary row; returns the component ids for triple
 * terms.
 */
export const decode = (
  kind: number,
  value: string,
  dt: string,
  lang: string,
  dir: string,
): Term.GroundTerm | readonly [number, number, number] => decodeRow(kind, value, dt, lang, dir);
