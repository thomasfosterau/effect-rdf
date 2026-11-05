/**
 * BCP 47 language tags, as RDF 1.2 requires them: well-formedness (BCP 47
 * §2.2.9, the `Language-Tag` ABNF of §2.1), the canonical lower-case form
 * RDF terms carry, and a `Schema` for validating tags at a boundary.
 *
 * The syntax packages keep their grammar's own `LANGTAG` production
 * (`[a-zA-Z]+ ('-' [a-zA-Z0-9]+)*`), which the W3C suites test and which is
 * looser than BCP 47; use `isWellFormed` where full BCP 47 is wanted.
 *
 * @since 0.1.0
 */
import * as Schema from 'effect/Schema';

const ALNUM = '[a-z0-9]';
// language = 2*3ALPHA ["-" extlang] / 4ALPHA / 5*8ALPHA; extlang = 3ALPHA *2("-" 3ALPHA)
const LANGUAGE = '(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})';
const SCRIPT = '(?:-[a-z]{4})?';
const REGION = '(?:-(?:[a-z]{2}|[0-9]{3}))?';
const VARIANTS = `(?:-(?:${ALNUM}{5,8}|[0-9]${ALNUM}{3}))*`;
// singleton = alphanum except "x"
const EXTENSIONS = `(?:-[0-9a-wy-z](?:-${ALNUM}{2,8})+)*`;
const PRIVATE_USE = `x(?:-${ALNUM}{1,8})+`;
const LANGTAG = `${LANGUAGE}${SCRIPT}${REGION}${VARIANTS}${EXTENSIONS}(?:-${PRIVATE_USE})?`;

// The grandfathered tags (BCP 47 §2.1, `irregular` and `regular`).
const GRANDFATHERED = [
  'en-gb-oed',
  'i-ami',
  'i-bnn',
  'i-default',
  'i-enochian',
  'i-hak',
  'i-klingon',
  'i-lux',
  'i-mingo',
  'i-navajo',
  'i-pwn',
  'i-tao',
  'i-tay',
  'i-tsu',
  'sgn-be-fr',
  'sgn-be-nl',
  'sgn-ch-de',
  'art-lojban',
  'cel-gaulish',
  'no-bok',
  'no-nyn',
  'zh-guoyu',
  'zh-hakka',
  'zh-min',
  'zh-min-nan',
  'zh-xiang',
].join('|');

const WELL_FORMED = new RegExp(`^(?:${LANGTAG}|${PRIVATE_USE}|${GRANDFATHERED})$`, 'i');

/**
 * Whether a string is a well-formed BCP 47 language tag (§2.2.9): it matches
 * the `Language-Tag` ABNF, case-insensitively. Registry validity (known
 * subtags, no duplicate variants or extensions) is not checked.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isWellFormed = (tag: string): boolean => WELL_FORMED.test(tag);

/**
 * The form a language tag takes in an RDF term: lower case (RDF 1.2 compares
 * tags case-insensitively, and `Term.literal` lower-cases them).
 *
 * @since 0.1.0
 * @category formatting
 */
export const normalize = (tag: string): string => tag.toLowerCase();

/**
 * Schema of a well-formed BCP 47 language tag (`isWellFormed`): a string,
 * decoded unchanged.
 *
 * @since 0.1.0
 * @category schemas
 */
export const LanguageTagSchema: Schema.String = Schema.String.check(
  Schema.makeFilter((tag: string) => isWellFormed(tag), {
    identifier: 'isLanguageTag',
    title: 'Language tag',
    description: 'A well-formed BCP 47 language tag.',
    expected: 'a BCP 47 language tag',
  }),
).annotate({ identifier: 'LanguageTag' });

/**
 * The type `LanguageTagSchema` decodes to: a string.
 *
 * @since 0.1.0
 * @category schemas
 */
export type LanguageTagSchema = typeof LanguageTagSchema.Type;
