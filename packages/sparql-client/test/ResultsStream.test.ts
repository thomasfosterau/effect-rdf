import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import { Term } from '@thomasfosterau/effect-rdf';
import { Bindings, Results } from '@thomasfosterau/effect-sparql';
import * as ResultsStream from '../src/ResultsStream.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

const rows = [
  Bindings.make({
    s: Term.namedNode('http://example.org/a'),
    o: Term.literal('tab\there "quoted" \\ </result> {}[],:', 'en'),
  }),
  Bindings.make({
    s: Term.blankNode('b0'),
    o: Term.literal('42', Term.namedNode(`${XSD}integer`)),
  }),
  Bindings.make({ s: Term.namedNode('http://example.org/c') }),
  Bindings.make({
    s: Term.namedNode('http://example.org/d'),
    o: Term.triple(
      Term.namedNode('http://example.org/s'),
      Term.namedNode('http://example.org/p'),
      Term.literal('x', { language: 'ar', direction: 'rtl' }),
    ),
  }),
  Bindings.make({ o: Term.literal('ünïcödé ☃ 𝄞') }),
];

const result: Results.SelectResult = {
  _tag: 'Select',
  variables: [Term.variable('s'), Term.variable('o')],
  bindings: Stream.fromIterable(rows),
};

const chunked = (text: string, size: number): Stream.Stream<string> => {
  const chunks: Array<string> = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return Stream.fromIterable(chunks);
};

const collect = (mediaType: string, text: string, size: number) =>
  Stream.runCollect(Option.getOrThrow(ResultsStream.parse(mediaType, chunked(text, size))));

const solutions = (events: ReadonlyArray<ResultsStream.ResultEvent>) =>
  events.flatMap((e) => (e._tag === 'Solution' ? [e.bindings] : []));

describe('ResultsStream', () => {
  for (const codec of [Results.Json, Results.Xml, Results.Tsv]) {
    it.effect(`parses ${codec.format.name} incrementally`, () =>
      Effect.gen(function* () {
        const text = codec.serializeString(yield* Results.collect(result));
        for (const size of [1, 3, 17, 1000, text.length]) {
          const events = yield* collect(codec.format.mediaType, text, size);
          expect(events[0]).toEqual({ _tag: 'Variables', variables: ['s', 'o'] });
          const got = solutions(events);
          expect(got).toHaveLength(rows.length);
          got.forEach((b, i) => expect(b.key).toBe(rows[i]!.key));
        }
        const ask = codec.serializeString({ _tag: 'Ask', value: true });
        const events = yield* collect(codec.format.mediaType, ask, 2);
        expect(events.find((e) => e._tag === 'Boolean')).toEqual({ _tag: 'Boolean', value: true });
      }),
    );
  }

  it.effect('parses CSV incrementally', () =>
    Effect.gen(function* () {
      const text =
        'x,y\r\nhttp://example.org/a,"multi\r\nline ""quoted"""\r\n_:b,42\r\n,plain\r\nhttp://example.org/c,';
      const whole = yield* Results.Csv.parse(text);
      const expected = whole._tag === 'ResultSet' ? whole.bindings.map((b) => b.key) : [];
      expect(expected).toHaveLength(4);
      for (const size of [1, 2, 3, 7, 1000]) {
        const events = yield* collect('text/csv', text, size);
        expect(events[0]).toEqual({ _tag: 'Variables', variables: ['x', 'y'] });
        expect(solutions(events).map((b) => b.key)).toEqual(expected);
      }
      expect(solutions(yield* collect('text/csv', text, 4))[0]!.map.get('y')?.key).toBe(
        Term.literal('multi\r\nline "quoted"').key,
      );
      expect(yield* collect('text/csv', 'true\r\n', 1)).toEqual([{ _tag: 'Boolean', value: true }]);

      const parser = ResultsStream.csv();
      expect(parser.push('x\r\nhttp://a\r\nhttp://b')).toHaveLength(2);
      expect(parser.end()).toHaveLength(1);
      for (const bad of ['x\r\na\r\nb\r\n"c\r\n', 'x\r\na\r\n"b"c\r\nd\r\n']) {
        const streamed = yield* Effect.flip(collect('text/csv', bad, 3));
        const buffered = yield* Effect.flip(Results.Csv.parse(bad));
        expect([streamed.line, streamed.column]).toEqual([buffered.line, buffered.column]);
      }
    }),
  );

  it('emits solutions before the document is complete', () => {
    const parser = ResultsStream.json();
    expect(parser.push('{"head":{"vars":["x"]},"results":{"bindings":[{"x":{"type":"ur')).toEqual([
      { _tag: 'Variables', variables: ['x'] },
    ]);
    const events = parser.push('i","value":"http://a"}},{"x"');
    expect(events).toHaveLength(1);
    expect(parser.push(':{"type":"bnode","value":"b"}}]}}')).toHaveLength(1);
    expect(parser.end()).toEqual([]);

    const xml = ResultsStream.xml();
    const head =
      '<?xml version="1.0"?><sparql xmlns="http://www.w3.org/2005/sparql-results#"><head><variable name="x"/></head><results><result><binding name="x"><uri>http://a</uri></binding></result>';
    const first = xml.push(head);
    expect(first.map((e) => e._tag)).toEqual(['Variables', 'Solution']);
    expect(xml.push('<result/><result><binding name="x"><literal>a</li')).toHaveLength(1);
    expect(xml.push('teral></binding></result></results></sparql>')).toHaveLength(1);
    expect(xml.end()).toEqual([]);
  });

  it.effect('accepts members in any order and unknown members', () =>
    Effect.gen(function* () {
      const text =
        '{"results":{"bindings":[{"x":{"type":"literal","value":"v"}}],"distinct":false},"link":["a"],"head":{"vars":["x"],"link":[]}}';
      const events = yield* collect('application/sparql-results+json', text, 5);
      expect(events.map((e) => e._tag)).toEqual(['Solution', 'Variables']);
      const bool = yield* collect('application/json', ' { "head" : { } , "boolean" : false } ', 3);
      expect(bool).toEqual([
        { _tag: 'Variables', variables: [] },
        { _tag: 'Boolean', value: false },
      ]);
      const prefixed = yield* collect(
        'application/sparql-results+xml',
        '<s:sparql xmlns:s="http://www.w3.org/2005/sparql-results#"><s:head><s:variable name="x"/></s:head><s:results><s:result><s:binding name="x"><s:uri>http://a</s:uri></s:binding></s:result></s:results></s:sparql>',
        7,
      );
      expect(solutions(prefixed)).toHaveLength(1);
    }),
  );

  it.effect('reports malformed documents', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ['application/sparql-results+json', '{"head":{"vars":["x"]},"results":{"bindings":[{"x":'],
        [
          'application/sparql-results+json',
          '{"head":{"vars":["x"]},"results":{"bindings":[{"x":{"type":"nope"}}]}}',
        ],
        ['application/sparql-results+json', 'not json'],
        ['application/sparql-results+json', '{"head":{"vars":[]}} trailing'],
        [
          'application/sparql-results+xml',
          '<sparql xmlns="http://www.w3.org/2005/sparql-results#"><head>',
        ],
        ['text/tab-separated-values', '?x\n<unterminated\n'],
        ['text/tab-separated-values', ''],
      ];
      for (const [mediaType, text] of cases) {
        const error = yield* Effect.flip(collect(mediaType, text, 4));
        expect(error._tag, `${mediaType}: ${text}`).toBe('ResultsParseError');
      }
      expect(Option.isNone(ResultsStream.parse('text/html', Stream.empty))).toBe(true);
    }),
  );
});
