import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import { Xml } from '../../src/rdfxml/index.ts';

const parseOk = (input: string): Xml.Document => {
  const r = Xml.parseResult(input);
  if (Result.isFailure(r)) assert.fail(r.failure.message);
  return r.success;
};

const parseErr = (input: string): Xml.XmlParseError => {
  const r = Xml.parseResult(input);
  if (Result.isSuccess(r)) assert.fail('expected a parse error');
  return r.failure;
};

const elements = (el: Xml.Element): Array<Xml.Element> =>
  el.children.filter((c): c is Xml.Element => Predicate.isTagged(c, 'Element'));

const laughs = (body: string) =>
  `<!DOCTYPE a [<!ENTITY l0 "${body}">${Array.from(
    { length: 9 },
    (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`,
  ).join('')}]><a>&l9;</a>`;

const attributes = (n: number) => Array.from({ length: n }, (_, i) => `a${i}="${i}"`).join(' ');

const deep = (n: number) => '<a>'.repeat(n) + '</a>'.repeat(n);

const chain = (n: number, open: string, close: string) =>
  `<!DOCTYPE a [${Array.from(
    { length: n },
    (_, i) => `<!ENTITY e${i} "${open}${i + 1 < n ? `&e${i + 1};` : ''}${close}">`,
  ).join('')}]>`;

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
      expect(child?.namespace).toBe('urn:default');
      expect(other?.namespace).toBe('urn:b');
      expect(other?.children).toMatchObject([{ _tag: 'Text', value: 'text' }]);
      expect(other === undefined ? false : HashMap.has(other.inScopeNamespaces, '')).toBe(false);
      expect(plain?.namespace).toBe('urn:default');
    }),
  );

  it('expands character and predefined entity references', () => {
    const doc = parseOk(`<r a="&lt;&#x41;&#66;&quot;">&amp;&#x1F600;&apos;&gt;</r>`);
    expect(doc.root.attributes[0]?.value).toBe('<AB"');
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
    expect(doc.root.attributes[0]?.value).toBe('x y z');
    expect(doc.root.attributes[1]?.value).toBe('\n');
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
    expect(
      Option.getOrUndefined(HashMap.get(doc.doctype?.entities ?? HashMap.empty(), 'name')),
    ).toBe('World');
    const attrs = Record.fromEntries(doc.root.attributes.map((a) => [a.localName, a.value]));
    expect(attrs).toEqual({ tok: 'a', a: 'Hello World', kind: 'default' });
    expect(doc.root.attributes.find((a) => a.localName === 'kind')?.defaulted).toBe(true);
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

  it('rejects hostile documents with parse errors', () => {
    expect(parseErr(laughs('ha')).message).toContain('maxEntityExpansion (1000000) exceeded');
    expect(parseErr(laughs('<b/>')).message).toContain('maxEntityExpansion (1000000) exceeded');
    expect(
      parseErr(`<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>`).message,
    ).toContain('external entity "x" is not supported');
    expect(parseOk(deep(1024)).root.localName).toBe('a');
    expect(parseErr(deep(100_000)).message).toContain('maxDepth (1024) exceeded');
    expect(parseOk(`${chain(60, '<b>', '</b>')}<a>&e0;</a>`).root.children).toHaveLength(1);
    expect(parseErr(`${chain(2000, '<b>', '</b>')}<a>&e0;</a>`).message).toContain(
      'maxEntityDepth (64) exceeded',
    );
    expect(parseErr(`${chain(2000, 'x', '')}<a b="&e0;"/>`).message).toContain(
      'maxEntityDepth (64) exceeded',
    );
  });

  it('parses many references to entities with markup in linear time', () => {
    const entities = Array.from({ length: 3000 }, (_, i) => `<!ENTITY e${i} "<b/>">`).join('');
    const start = performance.now();
    const doc = parseOk(`<!DOCTYPE a [${entities}]><a>${'&e0;'.repeat(20_000)}</a>`);
    expect(doc.root.children).toHaveLength(20_000);
    expect(performance.now() - start).toBeLessThan(5_000);
  });

  it.each([3, 40])('finds duplicate attributes in a start tag with %i attributes', (n) => {
    expect(parseOk(`<e ${attributes(n)}/>`).root.attributes).toHaveLength(n);
    expect(parseErr(`<e ${attributes(n)} a1="x"/>`).message).toContain('Duplicate attribute "a1"');
    expect(
      parseErr(`<e xmlns:p="u" xmlns:q="u" ${attributes(n)} p:z="1" q:z="2"/>`).message,
    ).toContain('Duplicate attribute "{u}z"');
    const root = parseOk(
      `<!DOCTYPE e [<!ATTLIST e a1 CDATA "d" b CDATA "d">]><e ${attributes(n)}/>`,
    ).root;
    expect(root.attributes.find((a) => a.name === 'a1')?.value).toBe('1');
    expect(root.attributes.find((a) => a.name === 'b')?.defaulted).toBe(true);
  });

  it('reports positions on later lines and back on earlier ones', () => {
    const doc = parseOk(`<a>\n${'<b/>\n'.repeat(30)}<c\n x="1"/></a>`);
    const children = elements(doc.root);
    expect(children.at(0)?.position).toEqual({ offset: 4, line: 2, column: 1 });
    expect(children.at(29)?.position.line).toBe(31);
    expect(children.at(30)?.attributes.at(0)?.position).toMatchObject({ line: 33, column: 2 });
    expect(doc.root.position).toEqual({ offset: 0, line: 1, column: 1 });
  });

  it('counts \\r\\n, \\r and \\n as line ends, and offsets in the input as written', () => {
    const children = elements(parseOk('<a>\r\n<b/>\r<c/>\n<d/></a>').root);
    expect(children.map((c) => c.position)).toEqual([
      { offset: 5, line: 2, column: 1 },
      { offset: 10, line: 3, column: 1 },
      { offset: 15, line: 4, column: 1 },
    ]);
    expect(parseErr('<a>\r\n<b></a>')).toMatchObject({ line: 2, column: 4 });
  });

  it('drops a leading byte order mark', () => {
    const doc = parseOk('﻿<?xml version="1.0"?><a/>');
    expect(doc.version).toBe('1.0');
    expect(doc.root.position).toEqual({ offset: 21, line: 1, column: 22 });
  });

  it('reads the internal subset after comments and processing instructions', () => {
    const doc = parseOk(
      '<?xml version="1.0"?>\n<!-- c -->\n<?pi x?>\n<!DOCTYPE a [<!ENTITY e "x&#65;y"><!ENTITY % p "q"><!ENTITY s SYSTEM "s.xml"><!ENTITY e "ignored">]><a>&e;</a>',
    );
    expect(doc.root.children).toMatchObject([{ _tag: 'Text', value: 'xAy' }]);
    expect([...(doc.doctype?.entities ?? [])]).toEqual([['e', 'xAy']]);
    expect(doc.prolog.map((n) => n._tag)).toEqual(['Comment', 'ProcessingInstruction']);
  });

  it('reads no internal subset without a DOCTYPE in the prolog', () => {
    expect(parseErr('<a>&e;</a>').message).toContain('unknown entity');
    expect(parseErr('<a/><!DOCTYPE a [<!ENTITY e "x">]>')._tag).toBe('XmlParseError');
  });

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

const childrenOf = (input: string) => parseOk(input).root.children;

describe('Xml.canonicalize', () => {
  it('renders visibly utilised namespaces only', () => {
    const nodes = childrenOf(
      `<r xmlns="urn:d" xmlns:a="urn:a" xmlns:unused="urn:u"><a:x><y a:attr="1"/></a:x></r>`,
    );
    expect(Xml.canonicalize(nodes)).toBe(
      '<a:x xmlns:a="urn:a"><y xmlns="urn:d" a:attr="1"></y></a:x>',
    );
  });

  it('undeclares the default namespace when needed', () => {
    const nodes = childrenOf(`<r xmlns="urn:d"><x><y xmlns=""/></x></r>`);
    expect(Xml.canonicalize(nodes)).toBe('<x xmlns="urn:d"><y xmlns=""></y></x>');
    expect(Xml.canonicalize(childrenOf('<r><x/></r>'))).toBe('<x></x>');
  });

  it('sorts attributes and escapes values', () => {
    const nodes = childrenOf(
      `<r xmlns:b="urn:b" xmlns:a="urn:z"><e z="&quot;&lt;&amp;&#9;&#10;&#13;" b:y="1" a:y="2" a="&gt;"/></r>`,
    );
    expect(Xml.canonicalize(nodes)).toBe(
      '<e xmlns:a="urn:z" xmlns:b="urn:b" a=">" z="&quot;&lt;&amp;&#x9;&#xA;&#xD;" b:y="1" a:y="2"></e>',
    );
  });

  it('escapes text, keeps comments and processing instructions', () => {
    const nodes = childrenOf(`<r>a &lt; b &amp;&gt; &#13;<!--c--><?pi x?></r>`);
    expect(Xml.canonicalize(nodes)).toBe('a &lt; b &amp;&gt; &#xD;<!--c--><?pi x?>');
  });
});
