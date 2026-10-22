/**
 * Typed accessors for the XMP Media Management schema (`xmpMM:`).
 *
 * @since 0.1.0
 */
import type * as Option from 'effect/Option';
import * as Accessors from './internal/accessors.ts';
import type * as Metadata from './Metadata.ts';
import { XMP_MM } from './Namespaces.ts';

/**
 * The identifier shared by every version of the document (`xmpMM:DocumentID`).
 *
 * @since 0.1.0
 * @category getters
 */
export const documentId: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${XMP_MM}DocumentID`,
);

/**
 * Sets the identifier shared by every version of the document (`xmpMM:DocumentID`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setDocumentId: Metadata.Setter<string> = Accessors.setText(`${XMP_MM}DocumentID`);

/**
 * The identifier of this version of the document (`xmpMM:InstanceID`).
 *
 * @since 0.1.0
 * @category getters
 */
export const instanceId: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${XMP_MM}InstanceID`,
);

/**
 * Sets the identifier of this version of the document (`xmpMM:InstanceID`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setInstanceId: Metadata.Setter<string> = Accessors.setText(`${XMP_MM}InstanceID`);

/**
 * The `xmpMM:DocumentID` of the original the document was derived from (`xmpMM:OriginalDocumentID`).
 *
 * @since 0.1.0
 * @category getters
 */
export const originalDocumentId: (self: Metadata.Metadata) => Option.Option<string> =
  Accessors.text(`${XMP_MM}OriginalDocumentID`);

/**
 * Sets the `xmpMM:DocumentID` of the original the document was derived from (`xmpMM:OriginalDocumentID`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setOriginalDocumentId: Metadata.Setter<string> = Accessors.setText(
  `${XMP_MM}OriginalDocumentID`,
);

/**
 * The document version (`xmpMM:VersionID`).
 *
 * @since 0.1.0
 * @category getters
 */
export const versionId: (self: Metadata.Metadata) => Option.Option<string> = Accessors.text(
  `${XMP_MM}VersionID`,
);

/**
 * Sets the document version (`xmpMM:VersionID`).
 *
 * @since 0.1.0
 * @category setters
 */
export const setVersionId: Metadata.Setter<string> = Accessors.setText(`${XMP_MM}VersionID`);
