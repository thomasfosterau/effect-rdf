/**
 * Translation of XPath/XML Schema regular expressions (as used by
 * `sh:pattern` and `sh:flags`) to JavaScript `RegExp`s.
 *
 * @internal
 */
import * as Match from 'effect/Match';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

/** A string as a JSON string literal, for messages. */
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const escapeAll = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes whitespace outside character classes (the XPath `x` flag). */
const stripWhitespace = (s: string): string => {
  let out = '';
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      out += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    if (!inClass && /[\t\n\r ]/.test(c)) continue;
    out += c;
  }
  return out;
};

/**
 * Compiles an XPath regular expression with optional XPath flags
 * (`s`, `m`, `i`, `x`, `q`). Returns an error message for invalid input.
 *
 * @internal
 */
export const compile = (
  pattern: string,
  flags: string,
): { readonly regex: RegExp } | { readonly error: string } => {
  let source = pattern;
  let jsFlags = '';
  for (const f of flags) {
    const error = Match.value(f).pipe(
      Match.when(Match.is('s', 'm', 'i'), (flag) => {
        if (!jsFlags.includes(flag)) jsFlags += flag;
        return undefined;
      }),
      Match.when('x', () => {
        source = stripWhitespace(source);
        return undefined;
      }),
      Match.when('q', () => undefined),
      Match.orElse((flag) => `unsupported regular expression flag '${flag}'`),
    );
    if (error !== undefined) return { error };
  }
  if (flags.includes('q')) source = escapeAll(pattern);
  // Unicode mode first (XPath character classes need it), then the legacy
  // syntax that accepts the escapes Unicode mode rejects.
  const compiled = Result.orElse(
    Result.try(() => new RegExp(source, `${jsFlags}u`)),
    () => Result.try(() => new RegExp(source, jsFlags)),
  );
  return Result.isSuccess(compiled)
    ? { regex: compiled.success }
    : { error: `invalid regular expression ${quote(pattern)}: ${String(compiled.failure)}` };
};
