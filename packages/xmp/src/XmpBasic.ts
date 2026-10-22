/**
 * Typed accessors for the XMP Basic schema (`xmp:`, ISO 16684-1 §8.4). Dates are
 * read as the ISO 8601 strings XMP stores; setters accept a `DateTime` or a
 * string.
 *
 * @since 0.1.0
 */
import type * as DateTime from 'effect/DateTime';
import type * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import type * as Metadata from './Metadata.ts';
import { XMP } from './Namespaces.ts';

/**
 * When the resource was created (`xmp:CreateDate`).
 *
 * @since 0.1.0
 * @category getters
 */
export const createDate: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${XMP}CreateDate`,
);

/**
 * Sets when the resource was created (`xmp:CreateDate`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setCreateDate: Metadata.Setter<DateTime.DateTime | string> = Accessors.setDate(
  `${XMP}CreateDate`,
);

/**
 * When the resource was last modified (`xmp:ModifyDate`).
 *
 * @since 0.1.0
 * @category getters
 */
export const modifyDate: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${XMP}ModifyDate`,
);

/**
 * Sets when the resource was last modified (`xmp:ModifyDate`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setModifyDate: Metadata.Setter<DateTime.DateTime | string> = Accessors.setDate(
  `${XMP}ModifyDate`,
);

/**
 * When the metadata was last changed (`xmp:MetadataDate`).
 *
 * @since 0.1.0
 * @category getters
 */
export const metadataDate: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${XMP}MetadataDate`,
);

/**
 * Sets when the metadata was last changed (`xmp:MetadataDate`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setMetadataDate: Metadata.Setter<DateTime.DateTime | string> = Accessors.setDate(
  `${XMP}MetadataDate`,
);

/**
 * The application that created the resource (`xmp:CreatorTool`).
 *
 * @since 0.1.0
 * @category getters
 */
export const creatorTool: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${XMP}CreatorTool`,
);

/**
 * Sets the application that created the resource (`xmp:CreatorTool`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setCreatorTool: Metadata.Setter<string> = Accessors.setText(`${XMP}CreatorTool`);
