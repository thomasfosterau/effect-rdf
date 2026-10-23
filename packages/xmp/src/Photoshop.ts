/**
 * Typed accessors for the Photoshop schema (`photoshop:`, XMP Specification
 * Part 2 §3.2): the IPTC-derived caption, credit and location properties
 * image editors write.
 *
 * @since 0.1.0
 */
import type * as DateTime from 'effect/DateTime';
import type * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import type * as Metadata from './Metadata.ts';
import { PHOTOSHOP } from './Namespaces.ts';

/**
 * The by-line title of the creator (`photoshop:AuthorsPosition`).
 *
 * @since 0.1.0
 * @category getters
 */
export const authorsPosition: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}AuthorsPosition`,
);

/**
 * Sets the by-line title of the creator (`photoshop:AuthorsPosition`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setAuthorsPosition: Metadata.Setter<string> = Accessors.setText(
  `${PHOTOSHOP}AuthorsPosition`,
);

/**
 * Who wrote the caption (`photoshop:CaptionWriter`).
 *
 * @since 0.1.0
 * @category getters
 */
export const captionWriter: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}CaptionWriter`,
);

/**
 * Sets who wrote the caption (`photoshop:CaptionWriter`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setCaptionWriter: Metadata.Setter<string> = Accessors.setText(
  `${PHOTOSHOP}CaptionWriter`,
);

/**
 * The IPTC category (`photoshop:Category`).
 *
 * @since 0.1.0
 * @category getters
 */
export const category: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}Category`,
);

/**
 * Sets the IPTC category (`photoshop:Category`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setCategory: Metadata.Setter<string> = Accessors.setText(`${PHOTOSHOP}Category`);

/**
 * The city the image was taken in (`photoshop:City`).
 *
 * @since 0.1.0
 * @category getters
 */
export const city: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}City`,
);

/**
 * Sets the city the image was taken in (`photoshop:City`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setCity: Metadata.Setter<string> = Accessors.setText(`${PHOTOSHOP}City`);

/**
 * The country the image was taken in (`photoshop:Country`).
 *
 * @since 0.1.0
 * @category getters
 */
export const country: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}Country`,
);

/**
 * Sets the country the image was taken in (`photoshop:Country`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setCountry: Metadata.Setter<string> = Accessors.setText(`${PHOTOSHOP}Country`);

/**
 * The provider credit line (`photoshop:Credit`).
 *
 * @since 0.1.0
 * @category getters
 */
export const credit: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}Credit`,
);

/**
 * Sets the provider credit line (`photoshop:Credit`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setCredit: Metadata.Setter<string> = Accessors.setText(`${PHOTOSHOP}Credit`);

/**
 * When the intellectual content was created (`photoshop:DateCreated`). An ISO 8601 date, as XMP stores it; the setter takes a `DateTime` or a string.
 *
 * @since 0.1.0
 * @category getters
 */
export const dateCreated: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}DateCreated`,
);

/**
 * Sets when the intellectual content was created (`photoshop:DateCreated`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setDateCreated: Metadata.Setter<DateTime.DateTime | string> = Accessors.setDate(
  `${PHOTOSHOP}DateCreated`,
);

/**
 * A short synopsis of the content (`photoshop:Headline`).
 *
 * @since 0.1.0
 * @category getters
 */
export const headline: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}Headline`,
);

/**
 * Sets a short synopsis of the content (`photoshop:Headline`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setHeadline: Metadata.Setter<string> = Accessors.setText(`${PHOTOSHOP}Headline`);

/**
 * Special instructions for using the resource (`photoshop:Instructions`).
 *
 * @since 0.1.0
 * @category getters
 */
export const instructions: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}Instructions`,
);

/**
 * Sets special instructions for using the resource (`photoshop:Instructions`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setInstructions: Metadata.Setter<string> = Accessors.setText(
  `${PHOTOSHOP}Instructions`,
);

/**
 * The original owner of the copyright (`photoshop:Source`).
 *
 * @since 0.1.0
 * @category getters
 */
export const source: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}Source`,
);

/**
 * Sets the original owner of the copyright (`photoshop:Source`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setSource: Metadata.Setter<string> = Accessors.setText(`${PHOTOSHOP}Source`);

/**
 * The province or state the image was taken in (`photoshop:State`).
 *
 * @since 0.1.0
 * @category getters
 */
export const state: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PHOTOSHOP}State`,
);

/**
 * Sets the province or state the image was taken in (`photoshop:State`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setState: Metadata.Setter<string> = Accessors.setText(`${PHOTOSHOP}State`);

/**
 * The supplemental IPTC categories (`photoshop:SupplementalCategories`). An unordered array.
 *
 * @since 0.1.0
 * @category getters
 */
export const supplementalCategories: (
  self: Metadata.Metadata,
) => Option.Option<ReadonlyArray<string>> = Accessors.items(`${PHOTOSHOP}SupplementalCategories`);

/**
 * Sets the supplemental IPTC categories (`photoshop:SupplementalCategories`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setSupplementalCategories: Metadata.Setter<Iterable<string>> = Accessors.setBag(
  `${PHOTOSHOP}SupplementalCategories`,
);

/**
 * The original transmission reference (`photoshop:TransmissionReference`).
 *
 * @since 0.1.0
 * @category getters
 */
export const transmissionReference: (self: Metadata.Metadata) => Option.Option<string> =
  Accessors.text(`${PHOTOSHOP}TransmissionReference`);

/**
 * Sets the original transmission reference (`photoshop:TransmissionReference`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setTransmissionReference: Metadata.Setter<string> = Accessors.setText(
  `${PHOTOSHOP}TransmissionReference`,
);

/**
 * The editorial urgency, 1 (high) to 8 (low) (`photoshop:Urgency`). An integer.
 *
 * @since 0.1.0
 * @category getters
 */
export const urgency: (self: Metadata.Metadata) => Option.Option<number> = Accessors.integer(
  `${PHOTOSHOP}Urgency`,
);

/**
 * Sets the editorial urgency, 1 (high) to 8 (low) (`photoshop:Urgency`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setUrgency: Metadata.Setter<number> = Accessors.setInteger(`${PHOTOSHOP}Urgency`);
