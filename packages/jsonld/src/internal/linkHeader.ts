/**
 * HTTP `Link` header values (RFC 8288, §3) as an `@thomasfosterau/effect-parse`
 * grammar. Like the user agents the RFC describes, it is lenient: it reads as
 * many link values as it can and ignores what follows them.
 *
 * @internal
 */
import * as Ascii from '@thomasfosterau/effect-parse/Ascii';
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import * as Token from '@thomasfosterau/effect-parse/Token';

/** @internal */
export interface Link {
  readonly target: string;
  readonly params: Readonly<Record<string, string>>;
}

const space = ' \t\r\n\f\v';
const ows = Token.takeWhile(space);

const target = Parser.delimited(Token.literal('<'), Token.takeTill('>'), Token.literal('>'));

const name = Token.takeTill([space, ';,='], { min: 1 }).pipe(Parser.map((n) => n.toLowerCase()));

/** `quoted-string`, with its `quoted-pair`s decoded. */
const quoted = Parser.delimited(
  Token.literal('"'),
  Ascii.escaped(Token.takeTill('"\\', { min: 1 }), '\\', Token.any),
  Token.literal('"'),
);

const value = Parser.alt(quoted, Token.takeTill([space, ';,']));

const param = Parser.preceded(
  Parser.seq(ows, Token.literal(';'), ows),
  Parser.seq(
    name,
    Parser.alt(
      Parser.preceded(Parser.seq(ows, Token.literal('='), ows), value),
      Parser.succeed(''),
    ),
  ),
);

const linkValue = Parser.delimited(
  ows,
  Parser.seq(target, Parser.repeat(param).pipe(Parser.map(Object.fromEntries))),
  Parser.seq(ows, Parser.opt(Token.literal(','))),
).pipe(Parser.map(([target, params]): Link => ({ target, params })));

const links = Parser.compile(Parser.repeat(linkValue));

/** The links of a header value (up to the first that cannot be read). */
export const parse = (value: string): ReadonlyArray<Link> => {
  const result = Parser.parsePeek(links, value);
  return result._tag === 'Success' ? result.success[1] : [];
};
