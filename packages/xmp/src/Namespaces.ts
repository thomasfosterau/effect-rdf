/**
 * The namespace IRIs of the XMP core schemas and the conventional prefix of
 * each, as the XMP specification (ISO 16684-1) and the PDF/A standards
 * (ISO 19005) name them.
 *
 * @since 0.1.0
 */
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';

/**
 * The `x:` namespace of the `<x:xmpmeta>` wrapper element.
 *
 * @since 0.1.0
 * @category namespaces
 */
export const X = 'adobe:ns:meta/';

/**
 * The RDF namespace.
 *
 * @since 0.1.0
 * @category namespaces
 */
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/**
 * The Dublin Core namespace (`dc:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const DC = 'http://purl.org/dc/elements/1.1/';

/**
 * The XMP Basic namespace (`xmp:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const XMP = 'http://ns.adobe.com/xap/1.0/';

/**
 * The XMP Rights Management namespace (`xmpRights:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const XMP_RIGHTS = 'http://ns.adobe.com/xap/1.0/rights/';

/**
 * The XMP Media Management namespace (`xmpMM:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const XMP_MM = 'http://ns.adobe.com/xap/1.0/mm/';

/**
 * The XMP note namespace (`xmpNote:`), which carries
 * `xmpNote:HasExtendedXMP` in JPEG files.
 *
 * @since 0.1.0
 * @category namespaces
 */
export const XMP_NOTE = 'http://ns.adobe.com/xmp/note/';

/**
 * The XMP qualifier namespace for identifiers (`xmpidq:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const XMP_IDQ = 'http://ns.adobe.com/xmp/Identifier/qual/1.0/';

/**
 * The Adobe PDF namespace (`pdf:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PDF = 'http://ns.adobe.com/pdf/1.3/';

/**
 * The PDF/A identification namespace (`pdfaid:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PDFA_ID = 'http://www.aiim.org/pdfa/ns/id/';

/**
 * The PDF/UA identification namespace (`pdfuaid:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PDFUA_ID = 'http://www.aiim.org/pdfua/ns/id/';

/**
 * The PDF/A extension schema container namespace (`pdfaExtension:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PDFA_EXTENSION = 'http://www.aiim.org/pdfa/ns/extension/';

/**
 * The PDF/A schema value type namespace (`pdfaSchema:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PDFA_SCHEMA = 'http://www.aiim.org/pdfa/ns/schema#';

/**
 * The PDF/A property value type namespace (`pdfaProperty:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PDFA_PROPERTY = 'http://www.aiim.org/pdfa/ns/property#';

/**
 * The PDF/A value type namespace (`pdfaType:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PDFA_TYPE = 'http://www.aiim.org/pdfa/ns/type#';

/**
 * The PDF/A field namespace (`pdfaField:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PDFA_FIELD = 'http://www.aiim.org/pdfa/ns/field#';

/**
 * The Photoshop namespace (`photoshop:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const PHOTOSHOP = 'http://ns.adobe.com/photoshop/1.0/';

/**
 * The EXIF namespace (`exif:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const EXIF = 'http://ns.adobe.com/exif/1.0/';

/**
 * The EXIF 2.3+ namespace of the CIPA (`exifEX:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const EXIF_EX = 'http://cipa.jp/exif/1.0/';

/**
 * The TIFF namespace (`tiff:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const TIFF = 'http://ns.adobe.com/tiff/1.0/';

/**
 * The ResourceEvent structure namespace (`stEvt:`), the fields of
 * `xmpMM:History` entries.
 *
 * @since 0.1.0
 * @category namespaces
 */
export const ST_EVT = 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#';

/**
 * The ResourceRef structure namespace (`stRef:`), the fields of
 * `xmpMM:DerivedFrom`.
 *
 * @since 0.1.0
 * @category namespaces
 */
export const ST_REF = 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#';

/**
 * The paged-text namespace (`xmpTPg:`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const XMP_TPG = 'http://ns.adobe.com/xap/1.0/t/pg/';

/**
 * The conventional prefix of every namespace in this module. The serializer
 * declares these prefixes unless `SerializeOptions.prefixes` names another.
 *
 * @since 0.1.0
 * @category prefixes
 */
export const prefixes: PrefixMap.PrefixMap = PrefixMap.make([
  ['x', X],
  ['rdf', RDF],
  ['dc', DC],
  ['xmp', XMP],
  ['xmpRights', XMP_RIGHTS],
  ['xmpMM', XMP_MM],
  ['xmpNote', XMP_NOTE],
  ['xmpidq', XMP_IDQ],
  ['pdf', PDF],
  ['pdfaid', PDFA_ID],
  ['pdfuaid', PDFUA_ID],
  ['pdfaExtension', PDFA_EXTENSION],
  ['pdfaSchema', PDFA_SCHEMA],
  ['pdfaProperty', PDFA_PROPERTY],
  ['pdfaType', PDFA_TYPE],
  ['pdfaField', PDFA_FIELD],
  ['photoshop', PHOTOSHOP],
  ['exif', EXIF],
  ['exifEX', EXIF_EX],
  ['tiff', TIFF],
  ['stEvt', ST_EVT],
  ['stRef', ST_REF],
  ['xmpTPg', XMP_TPG],
]);
