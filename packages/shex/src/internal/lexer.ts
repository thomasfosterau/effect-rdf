/**
 * Shared lexical machinery for ShExC and ShapeMap: terminal regular
 * expressions (from the ShEx 2 grammar), unescaping helpers and a small
 * position-tracking scanner.
 *
 * @internal
 */

const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const PN_CHARS = `${PN_CHARS_U}\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const PN_PREFIX = `[${PN_CHARS_BASE}](?:[${PN_CHARS}.]*[${PN_CHARS}])?`;
const PNAME_NS = `(?:${PN_PREFIX})?:`;
const PLX = `%[0-9A-Fa-f]{2}|\\\\[_~.\\-!$&'()*+,;=/?#@%]`;
const PN_LOCAL = `(?:[${PN_CHARS_U}:0-9]|${PLX})(?:(?:[${PN_CHARS}.:]|${PLX})*(?:[${PN_CHARS}:]|${PLX}))?`;
const UCHAR = '\\\\u[0-9A-Fa-f]{4}|\\\\U[0-9A-Fa-f]{8}';
const ECHAR = '\\\\[tbnrf\\\\"\']';
const LANGTAG = '@[A-Za-z]+(?:-[0-9A-Za-z]+)*';

const sticky = (source: string) => new RegExp(source, 'uy');

/** @internal */
export const RE = {
  ATPNAME_LN: sticky(`@${PNAME_NS}${PN_LOCAL}`),
  ATPNAME_NS: sticky(`@${PNAME_NS}`),
  LANGTAG: sticky(LANGTAG),
  PNAME_LN: sticky(`${PNAME_NS}${PN_LOCAL}`),
  PNAME_NS: sticky(PNAME_NS),
  DOUBLE: sticky('[+-]?(?:[0-9]+\\.[0-9]*[eE][+-]?[0-9]+|\\.?[0-9]+[eE][+-]?[0-9]+)'),
  DECIMAL: sticky('[+-]?[0-9]*\\.[0-9]+'),
  INTEGER: sticky('[+-]?[0-9]+'),
  IRIREF: sticky(`<(?:[^\\u0000-\\u0020<>"{}|^\`\\\\]|${UCHAR})*>`),
  REGEXP: sticky(`/(?:[^/\\\\\\n\\r]|\\\\[nrt\\\\|.?*+(){}$\\-\\[\\]^/]|${UCHAR})+/[smix]*`),
  BLANK_NODE_LABEL: sticky(`_:[${PN_CHARS_U}0-9](?:[${PN_CHARS}.]*[${PN_CHARS}])?`),
  CODE: sticky(`\\{(?:[^%\\\\]|\\\\[%\\\\]|${UCHAR})*%\\}`),
  REPEAT_RANGE: sticky('\\{[+-]?[0-9]+(?:,(?:[+-]?[0-9]+|\\*)?)?\\}'),
  STRING_LITERAL_LONG1: sticky(`'''(?:(?:'|'')?(?:[^'\\\\]|${ECHAR}|${UCHAR}))*'''`),
  STRING_LITERAL_LONG2: sticky(`"""(?:(?:"|"")?(?:[^"\\\\]|${ECHAR}|${UCHAR}))*"""`),
  STRING_LITERAL1: sticky(`'(?:[^'\\\\\\n\\r]|${ECHAR}|${UCHAR})*'`),
  STRING_LITERAL2: sticky(`"(?:[^"\\\\\\n\\r]|${ECHAR}|${UCHAR})*"`),
  LANGTAG_SUFFIX: sticky(LANGTAG),
  WORD: sticky('[A-Za-z]+'),
  SKIP: sticky('(?:\\s+|#[^\\n\\r]*|/\\*(?:[^*]|\\*(?:[^/]|\\\\/))*\\*/)+'),
} as const;

/** Tests a sticky regexp at a position, returning the matched text. */
export const matchAt = (re: RegExp, input: string, pos: number): string | undefined => {
  re.lastIndex = pos;
  const m = re.exec(input);
  return m === null ? undefined : m[0];
};

const ECHARS: Record<string, string> = {
  t: '\t',
  b: '\b',
  n: '\n',
  r: '\r',
  f: '\f',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

/** Replaces `\uXXXX` / `\UXXXXXXXX` escapes. */
export const unescapeUchar = (s: string): string =>
  s.indexOf('\\') === -1
    ? s
    : s.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (_, u4: string, u8: string) =>
        String.fromCodePoint(parseInt(u4 ?? u8, 16)),
      );

/** Unescapes the body of a string literal (ECHAR and UCHAR). */
export const unescapeString = (s: string): string =>
  s.indexOf('\\') === -1
    ? s
    : s.replace(
        /\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})|\\(.)/gs,
        (_, u4: string | undefined, u8: string | undefined, c: string | undefined) =>
          c !== undefined ? (ECHARS[c] ?? c) : String.fromCodePoint(parseInt(u4 ?? u8!, 16)),
      );

/** Unescapes a PN_LOCAL (reserved character escapes). */
export const unescapeLocal = (s: string): string =>
  s.indexOf('\\') === -1 ? s : s.replace(/\\(.)/gu, '$1');

/**
 * Unescapes a ShExC `REGEXP` body: `\/` becomes `/` and numeric escapes are
 * replaced by their code points; every other escape is kept verbatim.
 */
export const unescapeRegexp = (s: string): string =>
  s.replace(
    /\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})|\\(.)/gs,
    (all, u4: string | undefined, u8: string | undefined, c: string | undefined) =>
      c !== undefined ? (c === '/' ? '/' : all) : String.fromCodePoint(parseInt(u4 ?? u8!, 16)),
  );

/** Unescapes a semantic action `CODE` body (`\%`, `\\` and UCHAR). */
export const unescapeCode = (s: string): string =>
  s.replace(
    /\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})|\\([%\\])/g,
    (_, u4: string | undefined, u8: string | undefined, c: string | undefined) =>
      c !== undefined ? c : String.fromCodePoint(parseInt(u4 ?? u8!, 16)),
  );

/** Converts a string offset to a 1-based line and column. */
export const lineColumn = (
  input: string,
  pos: number,
): { readonly line: number; readonly column: number } => {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < pos && i < input.length; i++) {
    if (input.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: pos - lineStart + 1 };
};

/** An internal parse failure carrying the input offset. */
export class Failure extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}
