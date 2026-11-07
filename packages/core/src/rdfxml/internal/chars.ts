/**
 * XML 1.0 character classes, as regular expressions, for the `Xml`
 * predicates and the namespace checks of the tree builder.
 *
 * @internal
 */

/** @internal */
export const NAME_START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';

/** @internal */
export const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;

const NAME_RE = new RegExp(`^[:${NAME_START}][:${NAME_CHAR}]*$`, 'u');
const NCNAME_RE = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, 'u');

const INVALID_CHAR_RE = new RegExp(
  '[^\\t\\n\\r\\u0020-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]',
  'u',
);

/** @internal */
export const isNCName = (value: string): boolean => NCNAME_RE.test(value);

/** @internal */
export const isName = (value: string): boolean => NAME_RE.test(value);

/** @internal */
export const isValidText = (value: string): boolean => !INVALID_CHAR_RE.test(value);
