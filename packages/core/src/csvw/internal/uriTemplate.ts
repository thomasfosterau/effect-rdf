/**
 * RFC 6570 URI Template expansion for the `aboutUrl`, `propertyUrl` and
 * `valueUrl` templates and for metadata locations: `@thomasfosterau/effect-ext`'s
 * `UriTemplate` (an optional peer, reached only from `/csvw`) behind the one
 * lenient entry point the processor needs.
 *
 * @internal
 */
import { UriTemplate } from '@thomasfosterau/effect-ext/UriTemplate';
import * as Result from 'effect/Result';

/**
 * A template variable's value: a string or a list of strings.
 *
 * @internal
 */
export type Value = string | ReadonlyArray<string>;

/**
 * Expands a URI template with the given variables (an absent variable is
 * undefined). A template that is not RFC 6570 syntax, or that cannot be
 * expanded, is returned as written.
 *
 * @internal
 */
export const expand = (template: string, variables: Readonly<Record<string, Value>>): string =>
  Result.getOrElse(
    Result.flatMap(UriTemplate.parse(template), (parsed) => UriTemplate.expand(parsed, variables)),
    () => template,
  );
