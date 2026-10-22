/**
 * Typed accessors for the Adobe PDF schema (`pdf:`) and the PDF/UA
 * identification schema (`pdfuaid:`, ISO 14289).
 *
 * @since 0.1.0
 */
import type * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import type * as Metadata from './Metadata.ts';
import { PDF, PDFUA_ID } from './Namespaces.ts';

/**
 * The application that wrote the PDF (`pdf:Producer`).
 *
 * @since 0.1.0
 * @category getters
 */
export const producer: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PDF}Producer`,
);

/**
 * Sets the application that wrote the PDF (`pdf:Producer`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setProducer: Metadata.Setter<string> = Accessors.setText(`${PDF}Producer`);

/**
 * The keywords (`pdf:Keywords`), one text value.
 *
 * @since 0.1.0
 * @category getters
 */
export const keywords: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PDF}Keywords`,
);

/**
 * Sets the keywords (`pdf:Keywords`), one text value.
 *
 * @since 0.1.0
 * @category setters
 */
export const setKeywords: Metadata.Setter<string> = Accessors.setText(`${PDF}Keywords`);

/**
 * The PDF version, such as `"1.7"` (`pdf:PDFVersion`).
 *
 * @since 0.1.0
 * @category getters
 */
export const pdfVersion: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PDF}PDFVersion`,
);

/**
 * Sets the PDF version, such as `"1.7"` (`pdf:PDFVersion`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setPdfVersion: Metadata.Setter<string> = Accessors.setText(`${PDF}PDFVersion`);

/**
 * Whether the document is trapped (`pdf:Trapped`): `"True"`, `"False"` or `"Unknown"`.
 *
 * @since 0.1.0
 * @category getters
 */
export const trapped: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${PDF}Trapped`,
);

/**
 * Sets whether the document is trapped (`pdf:Trapped`): `"True"`, `"False"` or `"Unknown"`.
 *
 * @since 0.1.0
 * @category setters
 */
export const setTrapped: Metadata.Setter<string> = Accessors.setText(`${PDF}Trapped`);

/**
 * The PDF/UA part the document conforms to (`pdfuaid:part`), such as `1`.
 *
 * @since 0.1.0
 * @category getters
 */
export const uaPart = (self: Metadata.Metadata): Option.Option<number> =>
  Accessors.integer(`${PDFUA_ID}part`)(self);

/**
 * Sets the PDF/UA part the document conforms to (`pdfuaid:part`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setUaPart: Metadata.Setter<number> = Accessors.setInteger(`${PDFUA_ID}part`);
