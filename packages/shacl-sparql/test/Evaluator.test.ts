import { describe, expect, it } from '@effect/vitest';
import { type Dataset, Namespace, Term } from '@thomasfosterau/effect-rdf';
import { Path, ValidationReport, Validator } from '@thomasfosterau/effect-shacl';
import { Generator, Parser } from '@thomasfosterau/effect-sparql';
import { Turtle } from '@thomasfosterau/effect-turtle';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { Evaluator, Query } from '../src/index.ts';

const ex = Namespace.make('http://example.org/');

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex: sh:declare [ sh:prefix "ex" ; sh:namespace "http://example.org/"^^xsd:anyURI ] .
`;
const ttl = (s: string): Dataset.Dataset => Effect.runSync(Turtle.parse(prefixes + s)).dataset;

const validate = (data: Dataset.Dataset, shapes: Dataset.Dataset = data) =>
  Validator.validate(data, shapes).pipe(Effect.provide(Evaluator.layer()));

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const messages = (report: ValidationReport.ValidationReport) =>
  report.results.flatMap((r) => r.messages.map((m) => m.value)).sort();

describe('SPARQL-based constraints', () => {
  it.effect('report one result per solution, with ?value, ?path and messages', () =>
    Effect.gen(function* () {
      const graph = ttl(`
        ex:Shape a sh:NodeShape ;
          sh:targetClass ex:Person ;
          sh:sparql [
            sh:prefixes ex: ;
            sh:message "{$this} has a forbidden {?path}: {?value}" ;
            sh:select """SELECT $this ?path ?value WHERE {
              $this ?path ?value . FILTER (?path = ex:nickname) }""" ;
          ] .
        ex:alice a ex:Person ; ex:nickname "Al" .
        ex:bob a ex:Person .
      `);
      const report = yield* validate(graph);
      expect(report.results).toHaveLength(1);
      const [result] = report.results;
      expect(result!.focusNode.key).toBe(ex('alice').key);
      expect(Option.map(result!.resultPath, Path.toSparql)).toEqual(
        Option.some('<http://example.org/nickname>'),
      );
      expect(messages(report)).toEqual([
        'http://example.org/alice has a forbidden http://example.org/nickname: Al',
      ]);
      expect(Option.isSome(result!.sourceConstraint)).toBe(true);
    }),
  );

  it.effect('substitute $PATH in property shapes and default ?value to nothing', () =>
    Effect.gen(function* () {
      const graph = ttl(`
        ex:Shape a sh:NodeShape ;
          sh:targetNode ex:a ;
          sh:property [
            sh:path ( ex:knows ex:name ) ;
            sh:sparql [
              sh:select """SELECT $this ?value WHERE {
                $this $PATH ?value . FILTER (strlen(?value) < 3) }""" ;
            ] ;
          ] .
        ex:a ex:knows ex:b, ex:c . ex:b ex:name "Bo" . ex:c ex:name "Carol" .
      `);
      const report = yield* validate(graph);
      expect(report.results.map((r) => Option.getOrUndefined(r.value)?.key)).toEqual([
        Term.literal('Bo').key,
      ]);
      expect(Option.map(report.results[0]!.resultPath, Path.toSparql)).toEqual(
        Option.some('<http://example.org/knows>/<http://example.org/name>'),
      );
    }),
  );

  it.effect('pre-bind $shapesGraph and $currentShape', () =>
    Effect.gen(function* () {
      const shapes = ttl(`
        ex:Shape a sh:NodeShape ;
          sh:targetNode ex:a ;
          ex:limit 1 ;
          sh:sparql [
            sh:prefixes ex: ;
            sh:select """SELECT $this WHERE {
              GRAPH $shapesGraph { $currentShape ex:limit ?limit }
              { SELECT $this (COUNT(?o) AS ?n) WHERE { $this ex:p ?o } GROUP BY $this }
              FILTER (?n > ?limit) }""" ;
          ] .
      `);
      expect((yield* validate(ttl('ex:a ex:p 1, 2 .'), shapes)).conforms).toBe(false);
      expect((yield* validate(ttl('ex:a ex:p 1 .'), shapes)).conforms).toBe(true);
    }),
  );

  it.effect('fail validation when a solution binds ?failure to true', () =>
    Effect.gen(function* () {
      const graph = ttl(`
        ex:Shape a sh:NodeShape ; sh:targetNode ex:a ;
          sh:sparql [ sh:select "SELECT $this ?failure WHERE { BIND (true AS ?failure) }" ] .
      `);
      const error = yield* Effect.flip(validate(graph));
      expect(error._tag).toBe('SparqlEvaluationError');
    }),
  );

  it.effect('skip deactivated constraints', () =>
    Effect.gen(function* () {
      const graph = ttl(`
        ex:Shape a sh:NodeShape ; sh:targetNode ex:a ;
          sh:sparql [ sh:deactivated true ; sh:select "SELECT $this WHERE { }" ] .
      `);
      expect((yield* validate(graph)).conforms).toBe(true);
    }),
  );
});

describe('SPARQL-based constraint components', () => {
  const component = `
    ex:MaxWordsComponent a sh:ConstraintComponent ;
      sh:parameter [ sh:path ex:maxWords ] ;
      sh:parameter [ sh:path ex:separator ; sh:optional true ] ;
      sh:message "Value has more than {$maxWords} words" ;
      sh:validator [
        a sh:SPARQLAskValidator ;
        sh:ask """ASK { FILTER (
          strlen(replace(str($value), concat("[^", COALESCE(?separator, " "), "]"), "")) < $maxWords) }""" ;
      ] .
  `;

  it.effect('evaluate ASK validators per value node with parameters', () =>
    Effect.gen(function* () {
      const graph = ttl(`${component}
        ex:Shape a sh:NodeShape ; sh:targetNode ex:a ;
          sh:property [ sh:path ex:title ; ex:maxWords 2 ] ;
          sh:property [ sh:path ex:tags ; ex:maxWords 2 ; ex:separator "," ] .
        ex:a ex:title "one", "one two", "one two three" ; ex:tags "a,b", "a,b,c" .
      `);
      const report = yield* validate(graph);
      expect(
        report.results.map((r) => Option.getOrUndefined(r.value)?.key ?? '').sort(compare),
      ).toEqual([Term.literal('a,b,c').key, Term.literal('one two three').key].sort(compare));
      expect(messages(report)).toEqual([
        'Value has more than 2 words',
        'Value has more than 2 words',
      ]);
      expect(report.results[0]!.sourceConstraintComponent.key).toBe(ex('MaxWordsComponent').key);
    }),
  );

  it.effect('prefer node and property SELECT validators', () =>
    Effect.gen(function* () {
      const graph = ttl(`
        ex:LangComponent a sh:ConstraintComponent ;
          sh:parameter [ sh:path ex:lang ] ;
          sh:nodeValidator [
            sh:message "Node {$this} lacks a {?lang} label" ;
            sh:select """SELECT $this WHERE {
              FILTER NOT EXISTS { $this <http://www.w3.org/2000/01/rdf-schema#label> ?l .
                FILTER (lang(?l) = $lang) } }""" ;
          ] ;
          sh:propertyValidator [
            sh:message "{?value} is not in {$lang}" ;
            sh:select """SELECT $this ?value WHERE {
              $this $PATH ?value . FILTER (lang(?value) != $lang) }""" ;
          ] .
        ex:Shape a sh:NodeShape ; sh:targetNode ex:a ; ex:lang "de" ;
          sh:property [ sh:path ex:name ; ex:lang "en" ] .
        ex:a rdfs:label "A"@en ; ex:name "Ah"@fr, "A"@en .
      `);
      const report = yield* validate(graph);
      expect(messages(report)).toEqual([
        'Ah is not in en',
        'Node http://example.org/a lacks a de label',
      ]);
      const nodeResult = report.results.find((r) => Option.isNone(r.resultPath))!;
      expect(Option.getOrUndefined(nodeResult.value)?.key).toBe(ex('a').key);
    }),
  );
});

describe('SPARQL-based targets', () => {
  it.effect('select focus nodes with sh:SPARQLTarget and target types', () =>
    Effect.gen(function* () {
      const graph = ttl(`
        ex:BornIn a sh:SPARQLTargetType ;
          rdfs:subClassOf sh:Target ;
          sh:parameter [ sh:path ex:country ] ;
          sh:prefixes ex: ;
          sh:select "SELECT ?this WHERE { ?this ex:bornIn $country }" .
        ex:GermanShape a sh:NodeShape ;
          sh:target [ a ex:BornIn ; ex:country ex:Germany ] ;
          sh:property [ sh:path ex:name ; sh:minCount 1 ] .
        ex:AdultShape a sh:NodeShape ;
          sh:target [ a sh:SPARQLTarget ; sh:prefixes ex: ;
            sh:select "SELECT ?this WHERE { ?this ex:age ?age FILTER (?age >= 18) }" ] ;
          sh:property [ sh:path ex:licence ; sh:minCount 1 ] .
        ex:anna ex:bornIn ex:Germany . ex:bert ex:bornIn ex:France .
        ex:carl ex:age 30 . ex:dora ex:age 12 .
      `);
      const report = yield* validate(graph);
      expect(report.results.map((r) => r.focusNode.key).sort()).toEqual(
        [ex('anna').key, ex('carl').key].sort(),
      );
    }),
  );

  it.effect('ignore target types without a mandatory parameter value', () =>
    Effect.gen(function* () {
      const graph = ttl(`
        ex:BornIn a sh:SPARQLTargetType ;
          sh:parameter [ sh:path ex:country ] ;
          sh:select "SELECT ?this WHERE { ?this <http://example.org/bornIn> $country }" .
        ex:Shape a sh:NodeShape ; sh:target [ a ex:BornIn ] ; sh:minCount 5 .
        ex:anna ex:bornIn ex:Germany .
      `);
      expect((yield* validate(graph)).conforms).toBe(true);
    }),
  );
});

describe('Pre-binding restrictions', () => {
  const failing = (select: string) =>
    Effect.gen(function* () {
      const graph = ttl(`
        ex:Shape a sh:NodeShape ; sh:targetNode ex:a ;
          sh:sparql [ sh:select """${select}""" ] .
      `);
      return (yield* Effect.flip(validate(graph))).message;
    });

  it.effect('reject MINUS, VALUES, SERVICE, AS $this and incomplete sub-queries', () =>
    Effect.gen(function* () {
      expect(yield* failing('SELECT $this WHERE { $this ?p ?o MINUS { $this ?p 1 } }')).toMatch(
        /MINUS/,
      );
      expect(yield* failing('SELECT $this WHERE { VALUES ?x { 1 } }')).toMatch(/VALUES/);
      expect(yield* failing('SELECT $this WHERE { } VALUES ?x { 1 }')).toMatch(/VALUES/);
      expect(
        yield* failing('SELECT $this WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }'),
      ).toMatch(/SERVICE/);
      expect(yield* failing('SELECT $this WHERE { BIND (1 AS $this) }')).toMatch(/AS/);
      expect(
        yield* failing('SELECT $this WHERE { { SELECT * WHERE { FILTER ($this) } } }'),
      ).toMatch(/sub-queries must project/);
      expect(yield* failing('SELECT ?x WHERE { ?x ?p ?o }')).toMatch(/must project \?this/);
      expect(yield* failing('SELECT $this WHERE { $this ?p ?o')).toMatch(/does not parse/);
    }),
  );

  it('substitutes $PATH only in predicate positions', () => {
    const parsed = Effect.runSync(
      Parser.parseQuery('SELECT $this ?v WHERE { $this $PATH ?v FILTER EXISTS { ?v $PATH ?w } }'),
    );
    const path = Path.sequence(
      Path.predicate(ex('a')),
      Path.zeroOrMore(Path.inverse(Path.predicate(ex('b')))),
    );
    const substituted = Query.substitutePath(parsed, path);
    expect(Result.isSuccess(substituted)).toBe(true);
    expect(Generator.print(Result.getOrThrow(substituted))).toContain(
      '?v (<http://example.org/a> / (^(<http://example.org/b>))*) ?w',
    );
    const misuse = Effect.runSync(Parser.parseQuery('SELECT $this WHERE { $this ?p $PATH }'));
    expect(Result.isFailure(Query.substitutePath(misuse, path))).toBe(true);
  });

  it('collects prefixes through owl:imports and rejects conflicts', () => {
    const graph = ttl(`
      ex:q sh:prefixes ex:lib .
      ex:lib owl:imports ex: ; sh:declare [ sh:prefix "foaf" ; sh:namespace "http://xmlns.com/foaf/0.1/" ] .
      ex:bad sh:prefixes ex:conflict .
      ex:conflict owl:imports ex: ; sh:declare [ sh:prefix "ex" ; sh:namespace "http://other.org/" ] .
    `);
    expect(Query.prefixes(graph, ex('q'))).toEqual(
      Result.succeed({ ex: 'http://example.org/', foaf: 'http://xmlns.com/foaf/0.1/' }),
    );
    expect(Result.isFailure(Query.prefixes(graph, ex('bad')))).toBe(true);
  });
});
