/**
 * Typed accessors for the XMP Rights Management schema (`xmpRights:`).
 *
 * @since 0.1.0
 */
import type * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import type * as Metadata from './Metadata.ts';
import { XMP_RIGHTS } from './Namespaces.ts';

/**
 * Whether the resource is rights-managed (`xmpRights:Marked`).
 *
 * @since 0.1.0
 * @category getters
 */
export const marked: (self: Metadata.Metadata) => Option.Option<boolean> = Accessors.boolean(
  `${XMP_RIGHTS}Marked`,
);

/**
 * Sets whether the resource is rights-managed (`xmpRights:Marked`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setMarked: Metadata.Setter<boolean> = Accessors.setBoolean(`${XMP_RIGHTS}Marked`);

/**
 * The legal owners (`xmpRights:Owner`), an unordered array.
 *
 * @since 0.1.0
 * @category getters
 */
export const owner: (self: Metadata.Metadata) => Option.Option<ReadonlyArray<string>> =
  Accessors.items(`${XMP_RIGHTS}Owner`);

/**
 * Sets the legal owners (`xmpRights:Owner`), an unordered array.
 *
 * @since 0.1.0
 * @category setters
 */
export const setOwner: Metadata.Setter<Iterable<string>> = Accessors.setBag(`${XMP_RIGHTS}Owner`);

/**
 * How the resource may be used (`xmpRights:UsageTerms`), a language alternative. Reads the item in `language` (default `x-default`).
 *
 * @since 0.1.0
 * @category getters
 */
export const usageTerms: (self: Metadata.Metadata, language?: string) => Option.Option<string> =
  Accessors.localized(`${XMP_RIGHTS}UsageTerms`);

/**
 * Sets one language of how the resource may be used (`xmpRights:UsageTerms`), a language alternative.
 *
 * @since 0.1.0
 * @category setters
 */
export const setUsageTerms: Metadata.LocalizedSetter = Accessors.setLocalized(
  `${XMP_RIGHTS}UsageTerms`,
);

/**
 * The URL of a rights statement (`xmpRights:WebStatement`).
 *
 * @since 0.1.0
 * @category getters
 */
export const webStatement: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${XMP_RIGHTS}WebStatement`,
);

/**
 * Sets the URL of a rights statement (`xmpRights:WebStatement`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setWebStatement: Metadata.Setter<string> = Accessors.setText(
  `${XMP_RIGHTS}WebStatement`,
);
