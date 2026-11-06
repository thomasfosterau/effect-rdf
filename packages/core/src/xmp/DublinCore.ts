/**
 * Typed accessors for the Dublin Core schema (`dc:`, ISO 16684-1 §8.3).
 *
 * @since 0.1.0
 */
import type * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import type * as Metadata from './Metadata.ts';
import { DC } from './Namespaces.ts';

/**
 * The title (`dc:title`), a language alternative. Reads the item in `language` (default `x-default`).
 *
 * @since 0.1.0
 * @category getters
 */
export const title: (self: Metadata.Metadata, language?: string) => Option.Option<string> =
  Accessors.localized(`${DC}title`);

/**
 * Sets one language of the title (`dc:title`), a language alternative.
 *
 * @since 0.1.0
 * @category setters
 */
export const setTitle: Metadata.LocalizedSetter = Accessors.setLocalized(`${DC}title`);

/**
 * The creators (`dc:creator`), an ordered array: the document's authors.
 *
 * @since 0.1.0
 * @category getters
 */
export const creator: (self: Metadata.Metadata) => Option.Option<ReadonlyArray<string>> =
  Accessors.items(`${DC}creator`);

/**
 * Sets the creators (`dc:creator`), an ordered array: the document's authors.
 *
 * @since 0.1.0
 * @category setters
 */
export const setCreator: Metadata.Setter<Iterable<string>> = Accessors.setSeq(`${DC}creator`);

/**
 * The description (`dc:description`), a language alternative. Reads the item in `language` (default `x-default`).
 *
 * @since 0.1.0
 * @category getters
 */
export const description: (self: Metadata.Metadata, language?: string) => Option.Option<string> =
  Accessors.localized(`${DC}description`);

/**
 * Sets one language of the description (`dc:description`), a language alternative.
 *
 * @since 0.1.0
 * @category setters
 */
export const setDescription: Metadata.LocalizedSetter = Accessors.setLocalized(`${DC}description`);

/**
 * The subjects (`dc:subject`), an unordered array of keywords.
 *
 * @since 0.1.0
 * @category getters
 */
export const subject: (self: Metadata.Metadata) => Option.Option<ReadonlyArray<string>> =
  Accessors.items(`${DC}subject`);

/**
 * Sets the subjects (`dc:subject`), an unordered array of keywords.
 *
 * @since 0.1.0
 * @category setters
 */
export const setSubject: Metadata.Setter<Iterable<string>> = Accessors.setBag(`${DC}subject`);

/**
 * The rights statement (`dc:rights`), a language alternative. Reads the item in `language` (default `x-default`).
 *
 * @since 0.1.0
 * @category getters
 */
export const rights: (self: Metadata.Metadata, language?: string) => Option.Option<string> =
  Accessors.localized(`${DC}rights`);

/**
 * Sets one language of the rights statement (`dc:rights`), a language alternative.
 *
 * @since 0.1.0
 * @category setters
 */
export const setRights: Metadata.LocalizedSetter = Accessors.setLocalized(`${DC}rights`);

/**
 * The publishers (`dc:publisher`), an unordered array.
 *
 * @since 0.1.0
 * @category getters
 */
export const publisher: (self: Metadata.Metadata) => Option.Option<ReadonlyArray<string>> =
  Accessors.items(`${DC}publisher`);

/**
 * Sets the publishers (`dc:publisher`), an unordered array.
 *
 * @since 0.1.0
 * @category setters
 */
export const setPublisher: Metadata.Setter<Iterable<string>> = Accessors.setBag(`${DC}publisher`);

/**
 * The media type of the resource (`dc:format`).
 *
 * @since 0.1.0
 * @category getters
 */
export const format: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${DC}format`,
);

/**
 * Sets the media type of the resource (`dc:format`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setFormat: Metadata.Setter<string> = Accessors.setText(`${DC}format`);

/**
 * An unambiguous identifier of the resource (`dc:identifier`).
 *
 * @since 0.1.0
 * @category getters
 */
export const identifier: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${DC}identifier`,
);

/**
 * Sets an unambiguous identifier of the resource (`dc:identifier`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setIdentifier: Metadata.Setter<string> = Accessors.setText(`${DC}identifier`);
