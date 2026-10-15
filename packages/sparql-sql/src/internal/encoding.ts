/**
 * The encoding of RDF terms as rows of the term dictionary.
 *
 * @internal
 */
import * as BigDecimal from 'effect/BigDecimal';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Xsd from '@thomasfosterau/effect-rdf/Xsd';

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

/** The comparison class and numeric value of a term. */
export const classify = (term: Term.GroundTerm): { readonly cls: number; readonly num: number | null } => {
  switch (term._tag) {
    case 'NamedNode':
    case 'BlankNode':
      return { cls: Cls.Resource, num: null };
    case 'Triple':
      return { cls: Cls.Triple, num: null };
    case 'Literal': {
      if (term.language !== '') return { cls: Cls.LangString, num: null };
      const dt = term.datatype.value;
      if (dt === Term.XSD_STRING) return { cls: Cls.String, num: null };
      if (!Xsd.isKnownDatatype(dt)) return { cls: Cls.Unknown, num: null };
      const valid = Xsd.isValidLexical(dt, term.value);
      if (Xsd.isNumericDatatype(dt)) {
        if (!valid) return { cls: Cls.IllFormedNumeric, num: null };
        const v = Xsd.toValue(term);
        switch (v._tag) {
          case 'Integer':
            return v.value <= MAX_SAFE && v.value >= -MAX_SAFE
              ? { cls: Cls.SafeNumber, num: Number(v.value) }
              : { cls: Cls.UnsafeNumber, num: Number(v.value) };
          case 'Decimal':
            return decimalDigits(v.value) <= 15
              ? { cls: Cls.SafeNumber, num: Number(BigDecimal.format(v.value)) }
              : { cls: Cls.UnsafeNumber, num: BigDecimal.toNumberUnsafe(v.value) };
          case 'Float':
          case 'Double':
            return Number.isFinite(v.value)
              ? { cls: v._tag === 'Float' ? Cls.Float : Cls.Double, num: v.value }
              : { cls: Cls.SpecialFloat, num: null };
          default:
            return { cls: Cls.IllFormedNumeric, num: null };
        }
      }
      if (!valid) return { cls: Cls.IllFormed, num: null };
      if (dt === `${XSD}boolean`) {
        return { cls: Cls.Boolean, num: term.value === 'true' || term.value === '1' ? 1 : 0 };
      }
      if (TEMPORAL.has(dt)) return { cls: Cls.Temporal, num: null };
      return { cls: Cls.OtherKnown, num: null };
    }
  }
};

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

/**
 * The dictionary row of a term. Triple terms store the ids of their
 * components in `value` (`"s p o"`), so that `(value, kind, datatype, lang,
 * dir)` is a unique key for every term.
 */
export const encode = (
  term: Term.GroundTerm,
  componentIds?: readonly [number, number, number],
): TermRow => {
  const { cls, num } = classify(term);
  switch (term._tag) {
    case 'NamedNode':
      return { kind: Kind.NamedNode, value: term.value, datatype: '', lang: '', dir: '', sub: null, pre: null, obj: null, cls, num };
    case 'BlankNode':
      return { kind: Kind.BlankNode, value: term.value, datatype: '', lang: '', dir: '', sub: null, pre: null, obj: null, cls, num };
    case 'Literal':
      return {
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
      };
    case 'Triple': {
      if (componentIds === undefined) throw new Error('Triple terms need component ids');
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
    }
  }
};

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
): Term.GroundTerm | readonly [number, number, number] => {
  switch (kind) {
    case Kind.NamedNode:
      return Term.namedNode(value);
    case Kind.BlankNode:
      return Term.blankNode(value);
    case Kind.Literal:
      return new Term.Literal(
        value,
        datatype(dt),
        lang,
        dir === 'ltr' || dir === 'rtl' ? dir : undefined,
      );
    default: {
      const [s, p, o] = value.split(' ').map(Number);
      return [s!, p!, o!];
    }
  }
};
