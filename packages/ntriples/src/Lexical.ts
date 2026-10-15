/**
 * Lexical rules shared by the N-Triples family of RDF syntaxes (N-Triples,
 * N-Quads, Turtle and TriG): character classes, escape decoding, language
 * tags with base direction, and canonical term formatting.
 *
 * These are low-level, pure helpers; most users want the `NTriples` and
 * `NQuads` modules instead.
 *
 * @since 0.1.0
 */
import * as Term from '@thomasfosterau/effect-rdf/Term';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDF_LANG_STRING = `${RDF}langString`;
const RDF_DIR_LANG_STRING = `${RDF}dirLangString`;
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/**
 * `PN_CHARS_BASE` from the Turtle / N-Triples grammars.
 *
 * @since 0.1.0
 * @category character classes
 */
export const isPnCharsBase = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x61 && c <= 0x7a) ||
  (c >= 0xc0 && c <= 0xd6) ||
  (c >= 0xd8 && c <= 0xf6) ||
  (c >= 0xf8 && c <= 0x2ff) ||
  (c >= 0x370 && c <= 0x37d) ||
  (c >= 0x37f && c <= 0x1fff) ||
  (c >= 0x200c && c <= 0x200d) ||
  (c >= 0x2070 && c <= 0x218f) ||
  (c >= 0x2c00 && c <= 0x2fef) ||
  (c >= 0x3001 && c <= 0xd7ff) ||
  (c >= 0xf900 && c <= 0xfdcf) ||
  (c >= 0xfdf0 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0xeffff);

/**
 * `PN_CHARS_U`: `PN_CHARS_BASE` or `_`.
 *
 * @since 0.1.0
 * @category character classes
 */
export const isPnCharsU = (c: number): boolean => c === 0x5f || isPnCharsBase(c);

/**
 * `PN_CHARS`: `PN_CHARS_U`, `-`, digits, `·` and combining marks.
 *
 * @since 0.1.0
 * @category character classes
 */
export const isPnChars = (c: number): boolean =>
  isPnCharsU(c) ||
  c === 0x2d ||
  (c >= 0x30 && c <= 0x39) ||
  c === 0xb7 ||
  (c >= 0x300 && c <= 0x36f) ||
  (c >= 0x203f && c <= 0x2040);

/**
 * Whether a code point is an ASCII digit.
 *
 * @since 0.1.0
 * @category character classes
 */
export const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/**
 * Whether a code point is an ASCII hexadecimal digit.
 *
 * @since 0.1.0
 * @category character classes
 */
export const isHex = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/**
 * Whether a code point may appear unescaped inside an `IRIREF`
 * (`[^#x00-#x20<>"{}|^`\]`).
 *
 * @since 0.1.0
 * @category character classes
 */
export const isIriChar = (c: number): boolean =>
  c > 0x20 &&
  c !== 0x3c && // <
  c !== 0x3e && // >
  c !== 0x22 && // "
  c !== 0x7b && // {
  c !== 0x7d && // }
  c !== 0x7c && // |
  c !== 0x5e && // ^
  c !== 0x60 && // `
  c !== 0x5c; // \

/**
 * Whether a string is an absolute IRI reference (starts with a scheme).
 *
 * @since 0.1.0
 * @category validation
 */
export const isAbsoluteIri = (iri: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri);

/**
 * Whether an IRI can be written as an N-Triples / Turtle `IRIREF`: it is
 * absolute and contains no characters that would need escaping.
 *
 * @since 0.1.0
 * @category validation
 */
export const isWritableIri = (iri: string): boolean => {
  if (!isAbsoluteIri(iri)) return false;
  for (let i = 0; i < iri.length; i++) if (!isIriChar(iri.charCodeAt(i))) return false;
  return true;
};

/**
 * Whether a string is a valid `BLANK_NODE_LABEL` (without the `_:`).
 *
 * @since 0.1.0
 * @category validation
 */
export const isBlankNodeLabel = (label: string): boolean => {
  if (label === '') return false;
  let first = true;
  let last = 0;
  for (const ch of label) {
    const c = ch.codePointAt(0)!;
    if (first) {
      if (!isPnCharsU(c) && !isDigit(c)) return false;
      first = false;
    } else if (!isPnChars(c) && c !== 0x2e) return false;
    last = c;
  }
  return last !== 0x2e;
};

/**
 * The result of decoding a numeric escape: the code point or an error
 * message.
 *
 * @since 0.1.0
 * @category escapes
 */
export type DecodedEscape =
  | { readonly _tag: 'Ok'; readonly value: string; readonly length: number }
  | { readonly _tag: 'Error'; readonly message: string };

/**
 * Decodes a `UCHAR` (`\uXXXX` or `\UXXXXXXXX`) starting at `index`, which
 * must point at the backslash. Surrogate code points and values beyond
 * U+10FFFF are rejected.
 *
 * @since 0.1.0
 * @category escapes
 */
export const decodeUchar = (input: string, index: number): DecodedEscape => {
  const kind = input.charCodeAt(index + 1);
  const digits = kind === 0x75 ? 4 : kind === 0x55 ? 8 : 0;
  if (digits === 0) return { _tag: 'Error', message: 'Invalid escape sequence' };
  let value = 0;
  for (let k = 0; k < digits; k++) {
    const c = input.charCodeAt(index + 2 + k);
    if (Number.isNaN(c) || !isHex(c)) {
      return { _tag: 'Error', message: 'Invalid numeric escape sequence' };
    }
    value = value * 16 + parseInt(String.fromCharCode(c), 16);
  }
  if (value > 0x10ffff) {
    return { _tag: 'Error', message: 'Numeric escape is beyond U+10FFFF' };
  }
  if (value >= 0xd800 && value <= 0xdfff) {
    return { _tag: 'Error', message: 'Numeric escape encodes a surrogate code point' };
  }
  return { _tag: 'Ok', value: String.fromCodePoint(value), length: digits + 2 };
};

/**
 * Decodes the string-escape (`ECHAR`) character following a backslash, if
 * it is one of `t b n r f " ' \`.
 *
 * @since 0.1.0
 * @category escapes
 */
export const decodeEchar = (c: number): string | undefined => {
  switch (c) {
    case 0x74:
      return '\t';
    case 0x62:
      return '\b';
    case 0x6e:
      return '\n';
    case 0x72:
      return '\r';
    case 0x66:
      return '\f';
    case 0x22:
      return '"';
    case 0x27:
      return "'";
    case 0x5c:
      return '\\';
    default:
      return undefined;
  }
};

/**
 * A language tag with an optional base direction.
 *
 * @since 0.1.0
 * @category models
 */
export interface LanguageTag {
  readonly language: string;
  readonly direction: Term.Direction | undefined;
}

const LANG_DIR = /^([a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*)(?:--([a-zA-Z]+))?$/;

/**
 * Parses the text of a `LANG_DIR` token (without the leading `@`). Returns
 * `undefined` when the tag or direction is invalid; directions must be
 * `ltr` or `rtl`.
 *
 * @since 0.1.0
 * @category validation
 */
export const parseLanguageTag = (text: string): LanguageTag | undefined => {
  const m = LANG_DIR.exec(text);
  if (m === null) return undefined;
  const direction = m[2];
  if (direction !== undefined && direction !== 'ltr' && direction !== 'rtl') return undefined;
  return { language: m[1]!, direction };
};

/**
 * Builds a literal from a lexical form and an optional language tag or
 * datatype, rejecting the language-string datatypes used without a tag.
 * Returns an error message on failure.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeLiteral = (
  value: string,
  annotation: LanguageTag | Term.NamedNode | undefined,
): Term.Literal | string => {
  if (annotation === undefined) return Term.literal(value);
  if (Term.isNamedNode(annotation)) {
    if (annotation.value === RDF_LANG_STRING || annotation.value === RDF_DIR_LANG_STRING) {
      return `The datatype ${annotation.key} requires a language tag`;
    }
    return new Term.Literal(value, annotation);
  }
  return Term.literal(value, annotation);
};

// -----------------------------------------------------------------------------
// Canonical formatting
// -----------------------------------------------------------------------------

/**
 * Encodes an arbitrary blank node label as a valid N-Triples label. Valid
 * labels are returned unchanged.
 *
 * @since 0.1.0
 * @category formatting
 */
export const blankNodeLabel = (label: string): string => {
  if (isBlankNodeLabel(label)) return label;
  let out = 'x';
  for (const ch of label) {
    const c = ch.codePointAt(0)!;
    out += isPnCharsBase(c) || isDigit(c) ? ch : `_${c.toString(16)}_`;
  }
  return out;
};

/**
 * Formats an IRI as a canonical `IRIREF`.
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatIri = (iri: string): string => `<${Term.escapeIri(iri)}>`;

/**
 * Formats a literal in canonical N-Triples form: canonical string escapes,
 * lower-case language tags, and no datatype for `xsd:string`.
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatLiteral = (literal: Term.Literal): string => {
  const lexical = `"${Term.escapeString(literal.value)}"`;
  if (literal.language !== '') {
    const language = literal.language.toLowerCase();
    return literal.direction === undefined
      ? `${lexical}@${language}`
      : `${lexical}@${language}--${literal.direction}`;
  }
  if (literal.datatype.value === XSD_STRING) return lexical;
  return `${lexical}^^${formatIri(literal.datatype.value)}`;
};

/**
 * Formats a ground term (IRI, blank node, literal or triple term) in
 * canonical N-Triples form. Returns `undefined` for variables and the
 * default graph, which have no N-Triples representation.
 *
 * @since 0.1.0
 * @category formatting
 */
export const formatTerm = (term: Term.Term): string | undefined => {
  switch (term._tag) {
    case 'NamedNode':
      return formatIri(term.value);
    case 'BlankNode':
      return `_:${blankNodeLabel(term.value)}`;
    case 'Literal':
      return formatLiteral(term);
    case 'Triple': {
      const s = formatTerm(term.subject);
      const o = formatTerm(term.object);
      return s === undefined || o === undefined
        ? undefined
        : `<<( ${s} ${formatIri(term.predicate.value)} ${o} )>>`;
    }
    default:
      return undefined;
  }
};
