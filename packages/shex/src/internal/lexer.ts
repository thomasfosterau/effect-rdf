/**
 * Lexical helpers shared by the ShExC lexer and the error reporting: the
 * unescaping of `REGEXP` and `CODE` bodies, and offset-to-position
 * conversion. The terminals are Turtle's (`effect-turtle/Grammar`) and `tokens.ts`.
 *
 * @internal
 */

import * as Schema from 'effect/Schema';

/**
 * Replaces one escape: a numeric escape (`\uXXXX`, `\UXXXXXXXX`, the only
 * ones longer than two characters) by its code point, any other by `keep`
 * applied to the escaped character.
 */
const unescapeOne =
  (keep: (c: string, all: string) => string) =>
  (all: string): string =>
    all.length > 2 ? String.fromCodePoint(parseInt(all.slice(2), 16)) : keep(all.slice(1), all);

/**
 * Unescapes a ShExC `REGEXP` body: `\/` becomes `/` and numeric escapes are
 * replaced by their code points; every other escape is kept verbatim.
 */
export const unescapeRegexp = (s: string): string =>
  s.replace(
    /\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})|\\(.)/gs,
    unescapeOne((c, all) => (c === '/' ? '/' : all)),
  );

/** Unescapes a semantic action `CODE` body (`\%`, `\\` and UCHAR). */
export const unescapeCode = (s: string): string =>
  s.replace(
    /\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})|\\([%\\])/g,
    unescapeOne((c) => c),
  );

/** A 1-based line and column in the source text. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** Converts a string offset to a 1-based line and column. */
export const lineColumn = (input: string, pos: number): Position => {
  const before = input.slice(0, Math.max(pos, 0));
  return {
    line: before.split('\n').length,
    column: pos - (before.lastIndexOf('\n') + 1) + 1,
  };
};

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** Quotes a string as a JSON string literal, for error messages. */
export const quote = (s: string): string => encodeJsonString(s);
