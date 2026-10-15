import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import {
  Dataset,
  Isomorphism,
  Namespace,
  PrefixMap,
  Serialization,
  Term,
  Vocab,
} from '@thomasfosterau/effect-rdf';
import { RdfXml } from '../src/index.ts';
import { parseNTriples } from './support.ts';

const ex = Namespace.make('http://example.org/');
const { rdf, xsd } = Vocab;

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDF_NS = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';
const doc = (body: string, attrs = '') =>
  `<?xml version="1.0"?>\n<rdf:RDF ${RDF_NS} xmlns:ex="http://example.org/"${attrs}>\n${body}\n</rdf:RDF>`;

const expectGraph = (input: string, nt: string, options?: RdfXml.ParseOptions) =>
  Effect.gen(function* () {
    const result = yield* RdfXml.parse(input, options);
    const expected = parseNTriples(nt);
    if (!Isomorphism.isomorphic(result.dataset, expected)) {
      expect(Dataset.toNQuads(result.dataset)).toEqual(Dataset.toNQuads(expected));
    }
    expect(Isomorphism.isomorphic(result.dataset, expected)).toBe(true);
  });

describe('RdfXml.parse', () => {
  it.effect('parses typed nodes, property attributes and nested descriptions', () =>
    expectGraph(
      doc(`<ex:Person rdf:about="http://example.org/alice" ex:name="Alice" xml:lang="en">
  <ex:knows>
    <ex:Person ex:name="Bob"/>
  </ex:knows>
  <ex:age rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">42</ex:age>
  <ex:homepage rdf:resource="http://alice.example/"/>
</ex:Person>`),
      `<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
<http://example.org/alice> <http://example.org/name> "Alice"@en .
<http://example.org/alice> <http://example.org/knows> _:b .
_:b <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
_:b <http://example.org/name> "Bob"@en .
<http://example.org/alice> <http://example.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .
<http://example.org/alice> <http://example.org/homepage> <http://alice.example/> .`,
    ),
  );

  it.effect('resolves rdf:ID, rdf:about and xml:base', () =>
    expectGraph(
      doc(
        `<rdf:Description rdf:ID="a"><ex:p rdf:resource="b"/></rdf:Description>
<rdf:Description rdf:about="sub/c" xml:base="http://other.example/dir/"><ex:p rdf:resource="../d"/></rdf:Description>`,
        ' xml:base="http://example.org/base/doc"',
      ),
      `<http://example.org/base/doc#a> <http://example.org/p> <http://example.org/base/b> .
<http://other.example/dir/sub/c> <http://example.org/p> <http://other.example/d> .`,
    ),
  );

  it.effect('uses the base IRI option', () =>
    expectGraph(
      doc(`<rdf:Description rdf:about="x"><ex:p rdf:nodeID="n"/></rdf:Description>`),
      `<http://base.example/x> <http://example.org/p> _:n .`,
      { baseIri: 'http://base.example/doc' },
    ),
  );

  it.effect('expands rdf:li and handles containers', () =>
    expectGraph(
      doc(
        `<rdf:Seq rdf:about="http://example.org/s"><rdf:li>a</rdf:li><rdf:li rdf:resource="http://example.org/b"/><rdf:_7>c</rdf:_7><rdf:li>d</rdf:li></rdf:Seq>`,
      ),
      `<http://example.org/s> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Seq> .
<http://example.org/s> <http://www.w3.org/1999/02/22-rdf-syntax-ns#_1> "a" .
<http://example.org/s> <http://www.w3.org/1999/02/22-rdf-syntax-ns#_2> <http://example.org/b> .
<http://example.org/s> <http://www.w3.org/1999/02/22-rdf-syntax-ns#_7> "c" .
<http://example.org/s> <http://www.w3.org/1999/02/22-rdf-syntax-ns#_3> "d" .`,
    ),
  );

  it.effect('handles parseType Resource, Collection and Literal', () =>
    expectGraph(
      doc(`<rdf:Description rdf:about="http://example.org/s">
  <ex:r rdf:parseType="Resource"><ex:q>v</ex:q></ex:r>
  <ex:c rdf:parseType="Collection"><rdf:Description rdf:about="http://example.org/1"/><ex:T/></ex:c>
  <ex:e rdf:parseType="Collection"></ex:e>
  <ex:l rdf:parseType="Literal"><b xmlns="http://www.w3.org/1999/xhtml" class="x">bold</b> &amp; text</ex:l>
</rdf:Description>`),
      `<http://example.org/s> <http://example.org/r> _:r .
_:r <http://example.org/q> "v" .
<http://example.org/s> <http://example.org/c> _:l1 .
_:l1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/1> .
_:l1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> _:l2 .
_:l2 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> _:t .
_:t <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/T> .
_:l2 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <http://www.w3.org/1999/02/22-rdf-syntax-ns#nil> .
<http://example.org/s> <http://example.org/e> <http://www.w3.org/1999/02/22-rdf-syntax-ns#nil> .
<http://example.org/s> <http://example.org/l> "<b xmlns=\\"http://www.w3.org/1999/xhtml\\" class=\\"x\\">bold</b> &amp; text"^^<http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral> .`,
    ),
  );

  it.effect('reifies statements with rdf:ID on property elements', () =>
    expectGraph(
      doc(
        `<rdf:Description rdf:about="http://example.org/s"><ex:p rdf:ID="st">o</ex:p></rdf:Description>`,
        ' xml:base="http://example.org/doc"',
      ),
      `<http://example.org/s> <http://example.org/p> "o" .
<http://example.org/doc#st> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> .
<http://example.org/doc#st> <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> <http://example.org/s> .
<http://example.org/doc#st> <http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate> <http://example.org/p> .
<http://example.org/doc#st> <http://www.w3.org/1999/02/22-rdf-syntax-ns#object> "o" .`,
    ),
  );

  it.effect('supports RDF 1.2 base direction, triple terms and annotations', () =>
    expectGraph(
      doc(
        `<rdf:Description rdf:about="http://example.org/s" xml:lang="ar" its:dir="rtl">
  <ex:name>مرحبا</ex:name>
  <ex:claims rdf:parseType="Triple">
    <rdf:Description rdf:about="http://example.org/a"><ex:p rdf:resource="http://example.org/b"/></rdf:Description>
  </ex:claims>
  <ex:knows rdf:annotationNodeID="r" rdf:resource="http://example.org/o"/>
</rdf:Description>`,
        ' xmlns:its="http://www.w3.org/2005/11/its" its:version="2.0" rdf:version="1.2"',
      ),
      `<http://example.org/s> <http://example.org/name> "مرحبا"@ar--rtl .
<http://example.org/s> <http://example.org/claims> <<( <http://example.org/a> <http://example.org/p> <http://example.org/b> )>> .
<http://example.org/s> <http://example.org/knows> <http://example.org/o> .
_:r <http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> <<( <http://example.org/s> <http://example.org/knows> <http://example.org/o> )>> .`,
    ),
  );

  it.effect('ignores its:dir without an RDF 1.2 version announcement', () =>
    expectGraph(
      doc(
        `<rdf:Description rdf:about="http://example.org/s" xml:lang="en" its:dir="rtl" ex:p="x"/>`,
        ' xmlns:its="http://www.w3.org/2005/11/its"',
      ),
      `<http://example.org/s> <http://example.org/p> "x"@en .`,
    ),
  );

  it.effect('the version option enables RDF 1.2 features', () =>
    expectGraph(
      doc(
        `<rdf:Description rdf:about="http://example.org/s" xml:lang="en" its:dir="rtl" ex:p="x"/>`,
        ' xmlns:its="http://www.w3.org/2005/11/its"',
      ),
      `<http://example.org/s> <http://example.org/p> "x"@en--rtl .`,
      { version: '1.2' },
    ),
  );

  it.effect('accepts a node element as the document element', () =>
    expectGraph(
      `<ex:Thing ${RDF_NS} xmlns:ex="http://example.org/" rdf:about="http://example.org/t"/>`,
      `<http://example.org/t> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Thing> .`,
    ),
  );

  it.effect('places triples in the requested graph and returns prefixes', () =>
    Effect.gen(function* () {
      const result = yield* RdfXml.parse(
        doc(
          `<rdf:Description rdf:about="http://example.org/s" ex:p="o"/>`,
          ' xml:base="http://example.org/"',
        ),
        { graph: ex('g') },
      );
      expect(Dataset.toArray(result.dataset).map((q) => q.graph.key)).toEqual([
        '<http://example.org/g>',
      ]);
      expect(Option.getOrThrow(PrefixMap.get(result.prefixes, 'ex'))).toBe('http://example.org/');
      expect(result.baseIri).toBe('http://example.org/');
    }),
  );

  it.effect('reports errors with line and column', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        RdfXml.parse(
          doc(
            `<rdf:Description rdf:about="http://example.org/s">\n  <rdf:Description/>\n</rdf:Description>`,
          ),
        ),
      );
      expect(error).toBeInstanceOf(Serialization.RdfParseError);
      expect(error.format).toBe('RDF/XML');
      expect(error.line).toBe(4);
      expect(error.column).toBe(3);
      const xmlError = yield* Effect.flip(RdfXml.parse('<rdf:RDF'));
      expect(xmlError.line).toBe(1);
    }),
  );

  it.each([
    ['rdf:li as attribute', `<rdf:Description rdf:li="x"/>`],
    ['rdf:aboutEach', `<rdf:Description rdf:aboutEach="#x"/>`],
    ['duplicate rdf:ID', `<rdf:Description rdf:ID="a"/><rdf:Description rdf:ID="a"/>`],
    ['invalid rdf:ID', `<rdf:Description rdf:ID="1a"/>`],
    ['invalid rdf:nodeID', `<rdf:Description rdf:nodeID="_:a"/>`],
    ['rdf:about with rdf:nodeID', `<rdf:Description rdf:about="x" rdf:nodeID="a"/>`],
    [
      'rdf:resource with rdf:nodeID',
      `<rdf:Description><ex:p rdf:resource="x" rdf:nodeID="a"/></rdf:Description>`,
    ],
    [
      'parseType with rdf:resource',
      `<rdf:Description><ex:p rdf:parseType="Literal" rdf:resource="x"/></rdf:Description>`,
    ],
    [
      'two node elements in a property',
      `<rdf:Description><ex:p><ex:A/><ex:B/></ex:p></rdf:Description>`,
    ],
    ['mixed content', `<rdf:Description><ex:p>text<ex:A/></ex:p></rdf:Description>`],
    ['text in a node element', `<rdf:Description>text</rdf:Description>`],
    ['rdf:RDF as node element', `<rdf:RDF/>`],
    ['rdf:Description as property', `<rdf:Description><rdf:Description/></rdf:Description>`],
    ['unqualified element', `<Description xmlns=""/>`],
    ['unknown unqualified attribute', `<rdf:Description foo="x"/>`],
    [
      'invalid its:dir',
      `<rdf:Description xml:lang="en" its:dir="up" ex:p="x" xmlns:its="http://www.w3.org/2005/11/its" rdf:version="1.2"/>`,
    ],
    [
      'triple term with two triples',
      `<rdf:Description rdf:version="1.2"><ex:p rdf:parseType="Triple"><rdf:Description rdf:about="x" ex:a="1" ex:b="2"/></ex:p></rdf:Description>`,
    ],
  ])('rejects %s', (_, body) => {
    const exit = Effect.runSyncExit(RdfXml.parse(doc(body)));
    expect(exit._tag).toBe('Failure');
  });

  it.effect('parses streams', () =>
    Effect.gen(function* () {
      const chunks = [doc(`<rdf:Description rdf:about="http://example.org/s" ex:p="o"/>`)].flatMap(
        (s) => [s.slice(0, 10), s.slice(10)],
      );
      const quads = yield* Stream.runCollect(
        RdfXml.parser.parseStream(Stream.fromIterable(chunks)),
      );
      expect(Array.from(quads).map(String)).toEqual([
        '<http://example.org/s> <http://example.org/p> "o" .',
      ]);
    }),
  );
});

describe('RdfXml.serialize', () => {
  const roundTrip = (quads: ReadonlyArray<Term.Quad>, options?: RdfXml.SerializeOptions) =>
    Effect.gen(function* () {
      const xml = yield* RdfXml.serialize(quads, options);
      const parsed = yield* RdfXml.parse(xml);
      expect(Isomorphism.isomorphic(parsed.dataset, Dataset.fromIterable(quads))).toBe(true);
      return xml;
    });

  it.effect('writes typed nodes, nested blank nodes and configured prefixes', () =>
    Effect.gen(function* () {
      const bob = Term.blankNode();
      const address = Term.blankNode();
      const xml = yield* roundTrip(
        [
          Term.quad(ex('alice'), rdf.type, ex('Person')),
          Term.quad(ex('alice'), ex('knows'), bob),
          Term.quad(bob, rdf.type, ex('Person')),
          Term.quad(bob, ex('name'), Term.literal('Bob')),
          Term.quad(ex('alice'), ex('address'), address),
          Term.quad(address, ex('city'), Term.literal('Paris', 'fr')),
          Term.quad(ex('alice'), ex('age'), Term.literal('42', xsd.integer)),
        ],
        {
          prefixes: PrefixMap.make({ ex: 'http://example.org/', unused: 'http://unused.example/' }),
        },
      );
      expect(xml).toBe(`<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:ex="http://example.org/">
  <ex:Person rdf:about="http://example.org/alice">
    <ex:address rdf:parseType="Resource">
      <ex:city xml:lang="fr">Paris</ex:city>
    </ex:address>
    <ex:age rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">42</ex:age>
    <ex:knows>
      <ex:Person>
        <ex:name>Bob</ex:name>
      </ex:Person>
    </ex:knows>
  </ex:Person>
</rdf:RDF>
`);
    }),
  );

  it.effect('generates namespaces and node IDs for shared blank nodes', () =>
    Effect.gen(function* () {
      const shared = Term.blankNode('not an NCName');
      const xml = yield* roundTrip([
        Term.quad(ex('a'), Term.namedNode('http://other.example/v#p'), shared),
        Term.quad(ex('b'), Term.namedNode('http://other.example/v#p'), shared),
        Term.quad(shared, Term.namedNode('urn:x:y'), Term.literal('')),
      ]);
      expect(xml).toContain('xmlns:ns1="http://other.example/v#"');
      expect(xml).toContain('rdf:nodeID="b0"');
      expect(xml).toContain('<ns2:y/>');
    }),
  );

  it.effect('handles blank node cycles', () =>
    Effect.gen(function* () {
      const a = Term.blankNode();
      const b = Term.blankNode();
      yield* roundTrip([Term.quad(a, ex('p'), b), Term.quad(b, ex('p'), a)]);
    }),
  );

  it.effect('relativises IRIs against the base IRI', () =>
    Effect.gen(function* () {
      const xml = yield* RdfXml.serialize([Term.quad(ex('a'), ex('p'), ex('b/c'))], {
        baseIri: 'http://example.org/',
      });
      expect(xml).toContain('xml:base="http://example.org/"');
      expect(xml).toContain('rdf:about="a"');
      expect(xml).toContain('rdf:resource="b/c"');
    }),
  );

  it.effect('escapes literals and keeps whitespace', () =>
    Effect.gen(function* () {
      const xml = yield* roundTrip([
        Term.quad(ex('a'), ex('p'), Term.literal('<&>"\' \n\r\t  ]]>')),
        Term.quad(ex('a'), ex('q'), Term.literal('<b>x</b>', rdf.XMLLiteral)),
      ]);
      expect(xml).toContain('&lt;&amp;&gt;');
    }),
  );

  it.effect('writes RDF 1.2 directional literals and triple terms', () =>
    Effect.gen(function* () {
      const xml = yield* roundTrip([
        Term.quad(ex('a'), ex('p'), Term.literal('שלום', { language: 'he', direction: 'rtl' })),
        Term.quad(ex('a'), ex('q'), Term.triple(Term.blankNode('x'), ex('r'), Term.blankNode('y'))),
        Term.quad(
          ex('a'),
          ex('nested'),
          Term.triple(ex('s'), ex('t'), Term.triple(ex('u'), ex('v'), Term.literal('w', 'en'))),
        ),
      ]);
      expect(xml).toContain('rdf:version="1.2"');
      expect(xml).toContain('its:dir="rtl"');
      expect(xml).toContain('rdf:parseType="Triple"');
    }),
  );

  it.effect('fails for data RDF/XML cannot represent', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<ReadonlyArray<Term.Quad>> = [
        [Term.quad(ex('a'), ex('p'), ex('b'), ex('g'))],
        [Term.quad(ex('a'), Term.namedNode('http://example.org/p/'), ex('b'))],
        [Term.quad(ex('a'), Term.namedNode('http://example.org/123'), ex('b'))],
        [Term.quad(ex('a'), Term.namedNode(`${RDF}li`), ex('b'))],
        [Term.quad(ex('a'), Term.namedNode(`${RDF}Description`), ex('b'))],
        [Term.quad(Term.triple(ex('a'), ex('b'), ex('c')), ex('p'), ex('b'))],
        [Term.quad(ex('a'), ex('p'), Term.literal('bad \u0001 char'))],
      ];
      for (const quads of cases) {
        const error = yield* Effect.flip(RdfXml.serialize(quads));
        expect(error).toBeInstanceOf(Serialization.RdfSerializeError);
      }
    }),
  );

  it.effect('serialises an empty graph', () =>
    Effect.gen(function* () {
      const xml = yield* roundTrip([], { xmlDeclaration: false });
      expect(xml).toBe('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>\n');
    }),
  );

  it('splits IRIs into namespace and local name', () => {
    expect(RdfXml.splitIri('http://example.org/ns#local')).toEqual(
      Option.some(['http://example.org/ns#', 'local']),
    );
    expect(RdfXml.splitIri('http://example.org/a-b.c')).toEqual(
      Option.some(['http://example.org/', 'a-b.c']),
    );
    expect(RdfXml.splitIri('urn:isbn:123abc')).toEqual(Option.some(['urn:isbn:123', 'abc']));
    expect(RdfXml.splitIri('http://example.org/')).toEqual(Option.none());
  });
});

describe('RdfXml.codec', () => {
  it.effect('exposes a Schema transforming documents and datasets', () =>
    Effect.gen(function* () {
      const dataset = Dataset.make(Term.quad(ex('a'), ex('p'), Term.literal('x')));
      const xml = yield* Schema.encodeEffect(RdfXml.codec.schema)(dataset);
      const decoded = yield* Schema.decodeEffect(RdfXml.codec.schema)(xml);
      expect(Isomorphism.isomorphic(decoded, dataset)).toBe(true);
      const invalid = yield* Effect.flip(Schema.decodeEffect(RdfXml.codec.schema)('<oops'));
      expect(invalid.message).toContain('RDF/XML parse error');
    }),
  );

  it('describes the format', () => {
    expect(RdfXml.format.mediaType).toBe('application/rdf+xml');
    expect(RdfXml.codec.format.extensions).toContain('rdf');
    expect(RdfXml.format.datasets).toBe(false);
  });
});
