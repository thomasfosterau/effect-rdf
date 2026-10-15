/**
 * Namespaces used by Notation3: the SWAP builtin namespaces (`log:`,
 * `math:`, `string:`, `list:`, `time:`, `crypto:`) and the `i18n:`
 * namespace for directional language-tagged strings.
 *
 * @since 0.1.0
 */
import * as Namespace from '@thomasfosterau/effect-rdf/Namespace';

/**
 * The `log:` namespace (`http://www.w3.org/2000/10/swap/log#`). `=>` is
 * `log:implies` and `<=` is `log:isImpliedBy`.
 *
 * @since 0.1.0
 * @category namespaces
 */
export const log = Namespace.vocabulary('http://www.w3.org/2000/10/swap/log#', [
  'implies',
  'isImpliedBy',
  'equalTo',
  'notEqualTo',
  'includes',
  'notIncludes',
  'semantics',
  'conclusion',
  'conjunction',
  'collectAllIn',
  'forAllIn',
  'uri',
  'rawType',
  'dtlit',
  'langlit',
  'Formula',
  'Literal',
  'Other',
  'List',
]);

/**
 * The `math:` namespace (`http://www.w3.org/2000/10/swap/math#`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const math = Namespace.make('http://www.w3.org/2000/10/swap/math#');

/**
 * The `string:` namespace (`http://www.w3.org/2000/10/swap/string#`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const string = Namespace.make('http://www.w3.org/2000/10/swap/string#');

/**
 * The `list:` namespace (`http://www.w3.org/2000/10/swap/list#`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const list = Namespace.make('http://www.w3.org/2000/10/swap/list#');

/**
 * The `time:` namespace (`http://www.w3.org/2000/10/swap/time#`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const time = Namespace.make('http://www.w3.org/2000/10/swap/time#');

/**
 * The `crypto:` namespace (`http://www.w3.org/2000/10/swap/crypto#`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const crypto = Namespace.make('http://www.w3.org/2000/10/swap/crypto#');

/**
 * The `i18n:` namespace (`https://www.w3.org/ns/i18n#`). A literal typed
 * `i18n:{language}_{direction}` (e.g. `"…"^^i18n:ar-eg_rtl`) is parsed as a
 * directional language-tagged string, and directional language-tagged
 * strings are serialised that way.
 *
 * @since 0.1.0
 * @category namespaces
 */
export const i18n = Namespace.make('https://www.w3.org/ns/i18n#');

/**
 * `owl:sameAs`, written `=` in N3.
 *
 * @since 0.1.0
 * @category terms
 */
export const sameAs = Namespace.make('http://www.w3.org/2002/07/owl#')('sameAs');

/**
 * Prefixes for the N3 builtin namespaces.
 *
 * @since 0.1.0
 * @category prefixes
 */
export const prefixes = {
  log: log.base,
  math: math.base,
  string: string.base,
  list: list.base,
  time: time.base,
  crypto: crypto.base,
} as const;
