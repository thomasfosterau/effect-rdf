/**
 * Typed accessors for the most used properties of the TIFF schema (`tiff:`,
 * XMP Specification Part 2 §3.3.5): the camera and the image's basic
 * description. Any other TIFF property is read with `Metadata.get`.
 *
 * @since 0.1.0
 */
import type * as DateTime from 'effect/DateTime';
import type * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import type * as Metadata from './Metadata.ts';
import { TIFF } from './Namespaces.ts';

/**
 * The manufacturer of the recording equipment (`tiff:Make`).
 *
 * @since 0.1.0
 * @category getters
 */
export const make: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${TIFF}Make`,
);

/**
 * Sets the manufacturer of the recording equipment (`tiff:Make`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setMake: Metadata.Setter<string> = Accessors.setText(`${TIFF}Make`);

/**
 * The model of the recording equipment (`tiff:Model`).
 *
 * @since 0.1.0
 * @category getters
 */
export const model: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${TIFF}Model`,
);

/**
 * Sets the model of the recording equipment (`tiff:Model`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setModel: Metadata.Setter<string> = Accessors.setText(`${TIFF}Model`);

/**
 * The software that produced the image (`tiff:Software`).
 *
 * @since 0.1.0
 * @category getters
 */
export const software: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${TIFF}Software`,
);

/**
 * Sets the software that produced the image (`tiff:Software`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setSoftware: Metadata.Setter<string> = Accessors.setText(`${TIFF}Software`);

/**
 * The camera owner, photographer or image creator (`tiff:Artist`).
 *
 * @since 0.1.0
 * @category getters
 */
export const artist: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${TIFF}Artist`,
);

/**
 * Sets the camera owner, photographer or image creator (`tiff:Artist`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setArtist: Metadata.Setter<string> = Accessors.setText(`${TIFF}Artist`);

/**
 * When the file was last changed (`tiff:DateTime`). An ISO 8601 date, as XMP stores it; the setter takes a `DateTime` or a string.
 *
 * @since 0.1.0
 * @category getters
 */
export const dateTime: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${TIFF}DateTime`,
);

/**
 * Sets when the file was last changed (`tiff:DateTime`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setDateTime: Metadata.Setter<DateTime.DateTime | string> = Accessors.setDate(
  `${TIFF}DateTime`,
);

/**
 * The orientation, 1 to 8 as in TIFF (`tiff:Orientation`). An integer.
 *
 * @since 0.1.0
 * @category getters
 */
export const orientation: (self: Metadata.Metadata) => Option.Option<number> = Accessors.integer(
  `${TIFF}Orientation`,
);

/**
 * Sets the orientation, 1 to 8 as in TIFF (`tiff:Orientation`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setOrientation: Metadata.Setter<number> = Accessors.setInteger(`${TIFF}Orientation`);

/**
 * The image width, in pixels (`tiff:ImageWidth`). An integer.
 *
 * @since 0.1.0
 * @category getters
 */
export const imageWidth: (self: Metadata.Metadata) => Option.Option<number> = Accessors.integer(
  `${TIFF}ImageWidth`,
);

/**
 * Sets the image width, in pixels (`tiff:ImageWidth`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setImageWidth: Metadata.Setter<number> = Accessors.setInteger(`${TIFF}ImageWidth`);

/**
 * The image height, in pixels (`tiff:ImageLength`). An integer.
 *
 * @since 0.1.0
 * @category getters
 */
export const imageLength: (self: Metadata.Metadata) => Option.Option<number> = Accessors.integer(
  `${TIFF}ImageLength`,
);

/**
 * Sets the image height, in pixels (`tiff:ImageLength`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setImageLength: Metadata.Setter<number> = Accessors.setInteger(`${TIFF}ImageLength`);

/**
 * The image title (`tiff:ImageDescription`). A language alternative; reads the item in `language` (default `x-default`).
 *
 * @since 0.1.0
 * @category getters
 */
export const imageDescription: (
  self: Metadata.Metadata,
  language?: string,
) => Option.Option<string> = Accessors.localized(`${TIFF}ImageDescription`);

/**
 * Sets the image title (`tiff:ImageDescription`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setImageDescription: Metadata.LocalizedSetter = Accessors.setLocalized(
  `${TIFF}ImageDescription`,
);

/**
 * The copyright notice (`tiff:Copyright`). A language alternative; reads the item in `language` (default `x-default`).
 *
 * @since 0.1.0
 * @category getters
 */
export const copyright: (self: Metadata.Metadata, language?: string) => Option.Option<string> =
  Accessors.localized(`${TIFF}Copyright`);

/**
 * Sets the copyright notice (`tiff:Copyright`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setCopyright: Metadata.LocalizedSetter = Accessors.setLocalized(`${TIFF}Copyright`);
