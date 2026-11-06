/**
 * Translation of XPath/XML Schema regular expressions (as used by
 * `sh:pattern` and `sh:flags`) to JavaScript `RegExp`s.
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

/** A string as a JSON string literal, for messages. */
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const escapeAll = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes whitespace outside character classes (the XPath `x` flag). */
const stripWhitespace = (s: string): string => {
  let inClass = false;
  return s.replace(/\\[\s\S]?|[[\]]|[\t\n\r ]/g, (token) => {
    if (token === '[') inClass = true;
    else if (token === ']') inClass = false;
    else if (WHITESPACE.test(token)) return inClass ? token : '';
    return token;
  });
};

const WHITESPACE = /^[\t\n\r ]$/;

/**
 * Compiles an XPath regular expression with optional XPath flags
 * (`s`, `m`, `i`, `x`, `q`). Fails with an error message for invalid input.
 *
 * @internal
 */
export const compile = (pattern: string, flags: string): Result.Result<RegExp, string> => {
  const chars = Arr.fromIterable(flags);
  const unsupported = Arr.findFirst(chars, (f) => !'smixq'.includes(f));
  if (Option.isSome(unsupported))
    return Result.fail(`unsupported regular expression flag '${unsupported.value}'`);
  const jsFlags = Arr.join(Arr.dedupe(Arr.filter(chars, (f) => 'smi'.includes(f))), '');
  const source = flags.includes('q')
    ? escapeAll(pattern)
    : flags.includes('x')
      ? stripWhitespace(pattern)
      : pattern;
  // Unicode mode first (XPath character classes need it), then the legacy
  // syntax that accepts the escapes Unicode mode rejects.
  return Result.mapError(
    Result.orElse(
      Result.try(() => new RegExp(source, `${jsFlags}u`)),
      () => Result.try(() => new RegExp(source, jsFlags)),
    ),
    (failure) => `invalid regular expression ${quote(pattern)}: ${String(failure)}`,
  );
};
