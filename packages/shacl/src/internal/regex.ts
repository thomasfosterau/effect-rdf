/**
 * Translation of XPath/XML Schema regular expressions (as used by
 * `sh:pattern` and `sh:flags`) to JavaScript `RegExp`s.
 *
 * @internal
 */

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
    switch (f) {
      case 's':
      case 'm':
      case 'i':
        if (!jsFlags.includes(f)) jsFlags += f;
        break;
      case 'x':
        source = stripWhitespace(source);
        break;
      case 'q':
        break;
      default:
        return { error: `unsupported regular expression flag '${f}'` };
    }
  }
  if (flags.includes('q')) source = escapeAll(pattern);
  try {
    return { regex: new RegExp(source, `${jsFlags}u`) };
  } catch {
    try {
      return { regex: new RegExp(source, jsFlags) };
    } catch (e) {
      return { error: `invalid regular expression ${JSON.stringify(pattern)}: ${String(e)}` };
    }
  }
};
