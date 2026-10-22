/**
 * XMP packets shaped after ISO 16684-1's examples and the PDF/A metadata
 * that veraPDF's corpus and Adobe's XMP Toolkit write.
 */

import { assert } from '@effect/vitest';
import * as Option from 'effect/Option';

const RDF_NS = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';

/** A PDF/A-2B document's metadata, one rdf:Description per schema. */
export const pdfA2b = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c015">
 <rdf:RDF ${RDF_NS}>
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Annual report</rdf:li>
     <rdf:li xml:lang="de">Jahresbericht</rdf:li>
    </rdf:Alt>
   </dc:title>
   <dc:creator>
    <rdf:Seq>
     <rdf:li>Ada Lovelace</rdf:li>
     <rdf:li>Charles Babbage</rdf:li>
    </rdf:Seq>
   </dc:creator>
   <dc:subject>
    <rdf:Bag>
     <rdf:li>engines</rdf:li>
    </rdf:Bag>
   </dc:subject>
  </rdf:Description>
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmp:CreateDate="2026-10-01T09:30:00+10:00"
    xmp:CreatorTool="effect-document">
   <xmp:ModifyDate>2026-10-02T10:00:00+10:00</xmp:ModifyDate>
  </rdf:Description>
  <rdf:Description rdf:about=""
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdf:Producer>effect-pdf 0.1.0</pdf:Producer>
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
${' '.repeat(99)}
<?xpacket end="w"?>`;

/** The forms ISO 16684-1 still requires readers to accept. */
export const deprecated = `<x:xapmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF ${RDF_NS}
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
   xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#"
   xmlns:ex="http://example.org/ns/">
  <rdf:Description rdf:about="uuid:6ec119d0-7f5b-11d9-8f5c-000d936e7b4a"
    xmpMM:DocumentID="xmp.did:1234"/>
  <rdf:Description>
   <xmpMM:DerivedFrom rdf:parseType="Resource">
    <stRef:documentID>xmp.did:0001</stRef:documentID>
    <stRef:instanceID>xmp.iid:0001</stRef:instanceID>
   </xmpMM:DerivedFrom>
   <dc:creator>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <rdf:value>Ada Lovelace</rdf:value>
      <ex:role>author</ex:role>
     </rdf:li>
    </rdf:Seq>
   </dc:creator>
   <ex:homepage rdf:resource="http://example.org/ada"/>
  </rdf:Description>
 </rdf:RDF>
</x:xapmeta>`;

/** An SVG with XMP in its <metadata>. */
export const svg = `<svg xmlns="http://www.w3.org/2000/svg">
 <metadata>
  <rdf:RDF ${RDF_NS} xmlns:dc="http://purl.org/dc/elements/1.1/">
   <rdf:Description rdf:about="" dc:format="image/svg+xml"/>
  </rdf:RDF>
 </metadata>
</svg>`;

/** A PDF/A-1 extension schema description for a custom `ex:` property. */
export const extension = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF ${RDF_NS}>
  <rdf:Description rdf:about=""
    xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
    xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
    xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas>
    <rdf:Bag>
     <rdf:li rdf:parseType="Resource">
      <pdfaSchema:schema>Example schema</pdfaSchema:schema>
      <pdfaSchema:namespaceURI>http://example.org/ns/</pdfaSchema:namespaceURI>
      <pdfaSchema:prefix>ex</pdfaSchema:prefix>
      <pdfaSchema:property>
       <rdf:Seq>
        <rdf:li rdf:parseType="Resource">
         <pdfaProperty:name>role</pdfaProperty:name>
         <pdfaProperty:valueType>Text</pdfaProperty:valueType>
         <pdfaProperty:category>external</pdfaProperty:category>
         <pdfaProperty:description>A creator's role</pdfaProperty:description>
        </rdf:li>
       </rdf:Seq>
      </pdfaSchema:property>
     </rdf:li>
     <rdf:li>not a structure</rdf:li>
    </rdf:Bag>
   </pdfaExtension:schemas>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

/** Wraps rdf:Description content in an rdf:RDF element. */
export const rdf = (body: string, ns = '') =>
  `<rdf:RDF ${RDF_NS} xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:ex="http://example.org/ns/"${ns}>${body}</rdf:RDF>`;

/** The value of a `Some`, failing the test on `None`. */
export const some = <A>(option: Option.Option<A>): A => {
  assert.isTrue(Option.isSome(option), 'expected Some');
  return Option.getOrElse(option, () => assert.fail('expected Some'));
};
