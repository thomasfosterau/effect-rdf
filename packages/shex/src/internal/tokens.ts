/**
 * What ShExC adds to the Turtle terminals of `effect-turtle` (`Grammar`): its
 * whitespace (any Unicode white space) with `#` and `/* … *\/` comments,
 * and case-insensitive keywords.
 *
 * @internal
 */
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';
import * as TurtleGrammar from '@thomasfosterau/effect-turtle/Grammar';

/** The characters of ECMAScript's `\s`. */
const whitespace: Token.StringTokenSet = [' \t\n\v\f\r      　﻿', Token.range(' ', ' ')];

const blockComment = Parser.seq(
  Token.literal('/*'),
  Parser.repeat(
    Parser.alt(Token.takeTill('*', { min: 1 }), Parser.seq(Token.literal('*'), Token.noneOf('/'))),
  ),
  Token.literal('*/'),
);

/** Whitespace, `#` line comments and block comments (possibly none). */
export const skip: Parser.Parser<void> = Parser.asVoid(
  Parser.repeat(
    Parser.alt(Token.takeWhile(whitespace, { min: 1 }), TurtleGrammar.comment, blockComment).pipe(
      Parser.expected('whitespace or a comment'),
    ),
  ),
);

/** A token preceded by optional whitespace and comments. */
export const lexeme = <A, E, R>(self: Parser.Parser<A, E, R>): Parser.Parser<A, E, R> =>
  Parser.preceded(skip, self);

/** A case-insensitive keyword: a whole word of ASCII letters. */
export const keyword = (word: string): Parser.Parser<string> =>
  Token.takeWhile(TurtleGrammar.alpha, { min: 1 }).pipe(
    Parser.filter((w) => w.toUpperCase() === word),
    Parser.expected(word),
  );
