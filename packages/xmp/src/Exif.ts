/**
 * Typed accessors for the most used properties of the EXIF schema (`exif:`,
 * XMP Specification Part 2 §3.3.6). Any other EXIF property is read with
 * `Metadata.get`.
 *
 * @since 0.1.0
 */
import type * as DateTime from 'effect/DateTime';
import type * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import type * as Metadata from './Metadata.ts';
import { EXIF } from './Namespaces.ts';

/**
 * When the original image was taken (`exif:DateTimeOriginal`). An ISO 8601 date, as XMP stores it; the setter takes a `DateTime` or a string.
 *
 * @since 0.1.0
 * @category getters
 */
export const dateTimeOriginal: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${EXIF}DateTimeOriginal`,
);

/**
 * Sets when the original image was taken (`exif:DateTimeOriginal`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setDateTimeOriginal: Metadata.Setter<DateTime.DateTime | string> = Accessors.setDate(
  `${EXIF}DateTimeOriginal`,
);

/**
 * When the image was stored as digital data (`exif:DateTimeDigitized`). An ISO 8601 date, as XMP stores it; the setter takes a `DateTime` or a string.
 *
 * @since 0.1.0
 * @category getters
 */
export const dateTimeDigitized: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${EXIF}DateTimeDigitized`,
);

/**
 * Sets when the image was stored as digital data (`exif:DateTimeDigitized`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setDateTimeDigitized: Metadata.Setter<DateTime.DateTime | string> = Accessors.setDate(
  `${EXIF}DateTimeDigitized`,
);

/**
 * A user comment (`exif:UserComment`). A language alternative; reads the item in `language` (default `x-default`).
 *
 * @since 0.1.0
 * @category getters
 */
export const userComment: (self: Metadata.Metadata, language?: string) => Option.Option<string> =
  Accessors.localized(`${EXIF}UserComment`);

/**
 * Sets a user comment (`exif:UserComment`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setUserComment: Metadata.LocalizedSetter = Accessors.setLocalized(
  `${EXIF}UserComment`,
);

/**
 * The valid image width, in pixels (`exif:PixelXDimension`). An integer.
 *
 * @since 0.1.0
 * @category getters
 */
export const pixelXDimension: (self: Metadata.Metadata) => Option.Option<number> =
  Accessors.integer(`${EXIF}PixelXDimension`);

/**
 * Sets the valid image width, in pixels (`exif:PixelXDimension`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setPixelXDimension: Metadata.Setter<number> = Accessors.setInteger(
  `${EXIF}PixelXDimension`,
);

/**
 * The valid image height, in pixels (`exif:PixelYDimension`). An integer.
 *
 * @since 0.1.0
 * @category getters
 */
export const pixelYDimension: (self: Metadata.Metadata) => Option.Option<number> =
  Accessors.integer(`${EXIF}PixelYDimension`);

/**
 * Sets the valid image height, in pixels (`exif:PixelYDimension`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setPixelYDimension: Metadata.Setter<number> = Accessors.setInteger(
  `${EXIF}PixelYDimension`,
);
