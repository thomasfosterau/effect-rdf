import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import { Xml } from '../src/index.ts';

const parseOk = (input: string): Xml.Document => {
  const r = Xml.parseResult(input);
  if (Result.isFailure(r)) throw new Error(r.failure.message);
  return r.success;
};

const parseErr = (input: string): Xml.XmlParseError => {
  const r = Xml.parseResult(input);
  if (Result.isSuccess(r)) throw new Error('expected a parse error');
  return r.failure;
};

const elements = (el: Xml.Element): Array<Xml.Element> =>
  el.children.filter((c): c is Xml.Element => c._tag === 'Element');

describe('Xml.parse', () => {
  it.effect('parses elements, attributes and namespaces', () =>
    Effect.gen(function* () {
      const doc = yield* Xml.parse(
        `<?xml version="1.0" encoding="UTF-8"?>
<a:root xmlns:a="urn:a" xmlns="urn:default" a:x='1' y="2">
  <child z="3"/>
  <b:other xmlns:b="urn:b" xmlns="">text</b:other>
  <plain/>
</a:root>`,
      );
      expect(doc.version).toBe('1.0');
      expect(doc.encoding).toBe('UTF-8');
      const root = doc.root;
      expect(root.localName).toBe('root');
      expect(root.namespace).toBe('urn:a');
      expect(root.attributes.map((a) => [a.namespace, a.localName, a.value])).toEqual([
        ['urn:a', 'x', '1'],
        [undefined, 'y', '2'],
      ]);
      const [child, other, plain] = elements(root);
      expect(child!.namespace).toBe('urn:default');
      expect(other!.namespace).toBe('urn:b');
      expect(other!.children).toMatchObject([{ _tag: 'Text', value: 'text' }]);
      expect(other!.inScopeNamespaces.has('')).toBe(false);
      expect(plain!.namespace).toBe('urn:default');
    }),
  );

  it('expands character and predefined entity references', () => {
    const doc = parseOk(`<r a="&lt;&#x41;&#66;&quot;">&amp;&#x1F600;&apos;&gt;</r>`);
    expect(doc.root.attributes[0]!.value).toBe('<AB"');
    expect(doc.root.children).toMatchObject([{ _tag: 'Text', value: "&😀'>" }]);
  });

  it('merges CDATA sections with surrounding text', () => {
    const doc = parseOk(`<r>a<![CDATA[<b>&amp;]]>c</r>`);
    expect(doc.root.children).toMatchObject([{ _tag: 'Text', value: 'a<b>&amp;c' }]);
  });

  it('keeps comments and processing instructions', () => {
    const doc = parseOk(`<!-- before --><?pi data?><r><!-- c --><?t?></r><!--after-->`);
    expect(doc.prolog).toMatchObject([
      { _tag: 'Comment', value: ' before ' },
      { _tag: 'ProcessingInstruction', target: 'pi', data: 'data' },
    ]);
    expect(doc.root.children).toMatchObject([
      { _tag: 'Comment', value: ' c ' },
      { _tag: 'ProcessingInstruction', target: 't', data: '' },
    ]);
    expect(doc.epilog).toHaveLength(1);
  });

  it('normalises attribute values and line ends', () => {
    const doc = parseOk(`<r a="x\ty\r\nz" b="&#10;"/>`);
    expect(doc.root.attributes[0]!.value).toBe('x y z');
    expect(doc.root.attributes[1]!.value).toBe('\n');
    expect(parseOk('<r>a\r\nb\rc</r>').root.children).toMatchObject([{ value: 'a\nb\nc' }]);
  });

  it('supports internal DTD entities, including markup', () => {
    const doc = parseOk(`<!DOCTYPE r [
  <!ENTITY name "World">
  <!ENTITY greeting "Hello &name;">
  <!ENTITY markup "<b xmlns='urn:b'>bold</b>">
  <!ENTITY amp2 "&#38;#38;">
  <!ELEMENT r ANY>
  <!ATTLIST r kind CDATA "default" tok NMTOKEN #IMPLIED>
]>
<r tok="  a  " a="&greeting;">&greeting;! &markup; &amp2;</r>`);
    expect(doc.doctype?.name).toBe('r');
    expect(doc.doctype?.entities.get('name')).toBe('World');
    const attrs = Object.fromEntries(doc.root.attributes.map((a) => [a.localName, a.value]));
    expect(attrs).toEqual({ tok: 'a', a: 'Hello World', kind: 'default' });
    expect(doc.root.attributes.find((a) => a.localName === 'kind')!.defaulted).toBe(true);
    expect(doc.root.children).toMatchObject([
      { _tag: 'Text', value: 'Hello World! ' },
      { _tag: 'Element', localName: 'b', namespace: 'urn:b' },
      { _tag: 'Text', value: ' &' },
    ]);
  });

  it('reports well-formedness errors with positions', () => {
    const e = parseErr('<r>\n  <a></b>\n</r>');
    expect(e._tag).toBe('XmlParseError');
    expect(e.message).toContain('Mismatched end tag');
    expect(e.line).toBe(2);
    expect(e.column).toBe(6);
  });

  it.each([
    ['unclosed element', '<r><a></r>'],
    ['no root', '<!-- only a comment -->'],
    ['two roots', '<a/><b/>'],
    ['text after root', '<a/>text'],
    ['unbound prefix', '<p:a/>'],
    ['duplicate attribute', '<a x="1" x="2"/>'],
    ['duplicate expanded attribute', '<a xmlns:p="urn:x" xmlns:q="urn:x" p:x="1" q:x="2"/>'],
    ['empty prefixed namespace', '<a xmlns:p=""/>'],
    ['rebinding xml', '<a xmlns:xml="urn:x"/>'],
    ['declaring xmlns', '<a xmlns:xmlns="urn:x"/>'],
    ['"]]>" in content', '<a>]]></a>'],
    ['"--" in comment', '<a><!-- a -- b --></a>'],
    ['undefined entity', '<a>&nope;</a>'],
    ['recursive entity', '<!DOCTYPE a [<!ENTITY x "&y;"><!ENTITY y "&x;">]><a>&x;</a>'],
    ['"<" in attribute', '<a x="<"/>'],
    ['unquoted attribute', '<a x=1/>'],
    ['invalid character', '<a>\u0001</a>'],
    ['invalid character reference', '<a>&#0;</a>'],
    ['reserved PI target', '<a><?xml version="1.0"?></a>'],
    ['misplaced XML declaration', ' <?xml version="1.0"?><a/>'],
    ['bad XML version', '<?xml version="2.0"?><a/>'],
    ['invalid name', '<1a/>'],
    ['missing space between attributes', '<a x="1"y="2"/>'],
    ['external entity reference', '<!DOCTYPE a [<!ENTITY e SYSTEM "e.xml">]><a>&e;</a>'],
  ])('rejects %s', (_, input) => {
    expect(Result.isFailure(Xml.parseResult(input))).toBe(true);
  });

  it.effect('fails in the Effect error channel', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Xml.parse('<a>'));
      expect(error).toBeInstanceOf(Xml.XmlParseError);
    }),
  );

  it('validates names', () => {
    expect(Xml.isNCName('abc')).toBe(true);
    expect(Xml.isNCName('_a-b.c')).toBe(true);
    expect(Xml.isNCName('a:b')).toBe(false);
    expect(Xml.isNCName('1a')).toBe(false);
    expect(Xml.isName('a:b')).toBe(true);
    expect(Xml.isWhitespace(' \n\t')).toBe(true);
    expect(Xml.isValidText('ok\u0000')).toBe(false);
  });
});

describe('Xml.canonicalize', () => {
  const content = (input: string) => parseOk(input).root.children;

  it('renders visibly utilised namespaces only', () => {
    const nodes = content(
      `<r xmlns="urn:d" xmlns:a="urn:a" xmlns:unused="urn:u"><a:x><y a:attr="1"/></a:x></r>`,
    );
    expect(Xml.canonicalize(nodes)).toBe(
      '<a:x xmlns:a="urn:a"><y xmlns="urn:d" a:attr="1"></y></a:x>',
    );
  });

  it('undeclares the default namespace when needed', () => {
    const nodes = content(`<r xmlns="urn:d"><x><y xmlns=""/></x></r>`);
    expect(Xml.canonicalize(nodes)).toBe('<x xmlns="urn:d"><y xmlns=""></y></x>');
    expect(Xml.canonicalize(content('<r><x/></r>'))).toBe('<x></x>');
  });

  it('sorts attributes and escapes values', () => {
    const nodes = content(
      `<r xmlns:b="urn:b" xmlns:a="urn:z"><e z="&quot;&lt;&amp;&#9;&#10;&#13;" b:y="1" a:y="2" a="&gt;"/></r>`,
    );
    expect(Xml.canonicalize(nodes)).toBe(
      '<e xmlns:a="urn:z" xmlns:b="urn:b" a=">" z="&quot;&lt;&amp;&#x9;&#xA;&#xD;" b:y="1" a:y="2"></e>',
    );
  });

  it('escapes text, keeps comments and processing instructions', () => {
    const nodes = content(`<r>a &lt; b &amp;&gt; &#13;<!--c--><?pi x?></r>`);
    expect(Xml.canonicalize(nodes)).toBe('a &lt; b &amp;&gt; &#xD;<!--c--><?pi x?>');
  });
});
