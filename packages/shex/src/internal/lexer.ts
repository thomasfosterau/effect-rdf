/**
 * Lexical helpers shared by the ShExC lexer and the error reporting: the
 * unescaping of `REGEXP` and `CODE` bodies, and offset-to-position
 * conversion. The terminals themselves are `tokens.ts`.
 *
 * @internal
 */

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
