import { describe, expect, it } from '@effect/vitest';
import { Dataset, Isomorphism, Namespace, Term, Vocab } from '@thomasfosterau/effect-rdf';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { Path, Shapes, Sparql, ValidationReport, Validator, Vocabulary } from '../src/index.ts';
import { parseTurtle } from './utils/turtle.ts';

const { sh } = Vocabulary;
const { rdf, xsd } = Vocab;
const ex = Namespace.make('http://example.org/');

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;
const ttl = (s: string) => parseTurtle(prefixes + s);

const personShapes = ttl(`
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [
    sh:path ex:name ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string ;
    sh:message "A person needs exactly one string name"@en ;
  ] ;
  sh:property [
    sh:path ex:age ;
    sh:datatype xsd:integer ;
    sh:minInclusive 0 ;
    sh:severity sh:Warning ;
  ] ;
  sh:property [
    sh:path ex:knows ;
    sh:class ex:Person ;
  ] .
`);

const personData = ttl(`
ex:Student rdfs:subClassOf ex:Person .
ex:alice a ex:Person ; ex:name "Alice" ; ex:age 30 ; ex:knows ex:bob .
ex:bob a ex:Student ; ex:name "Bob" ; ex:age -1 ; ex:knows ex:carol .
ex:carol ex:name "Carol" .
ex:dave a ex:Person .
`);

describe('Vocabulary', () => {
  it('exposes typed SHACL terms', () => {
    expect(sh.NodeShape.value).toBe('http://www.w3.org/ns/shacl#NodeShape');
    expect(sh.in.value).toBe('http://www.w3.org/ns/shacl#in');
  });
});

describe('Path', () => {
  const data = ttl(`
    ex:a ex:p ex:b . ex:b ex:p ex:c . ex:c ex:q ex:d . ex:x ex:p ex:a .
  `);
  it('evaluates complex paths', () => {
    const keys = (p: Path.Path, focus: Term.GroundTerm = ex('a')) =>
      Path.evaluate(data, focus, p)
        .map((t) => t.key)
        .sort();
    const p = Path.predicate(ex('p'));
    expect(keys(p)).toEqual([ex('b').key]);
    expect(keys(Path.inverse(p))).toEqual([ex('x').key]);
    expect(keys(Path.sequence(p, p, Path.predicate(ex('q'))))).toEqual([ex('d').key]);
    expect(keys(Path.zeroOrMore(p))).toEqual([ex('a').key, ex('b').key, ex('c').key].sort());
    expect(keys(Path.oneOrMore(p))).toEqual([ex('b').key, ex('c').key].sort());
    expect(keys(Path.zeroOrOne(p))).toEqual([ex('a').key, ex('b').key].sort());
    expect(keys(Path.alternative(p, Path.inverse(p)))).toEqual([ex('b').key, ex('x').key].sort());
    expect(keys(Path.inverse(Path.sequence(p, p)), ex('c'))).toEqual([ex('a').key]);
    expect(Path.toSparql(Path.sequence(Path.inverse(p), Path.zeroOrMore(p)))).toBe(
      '^<http://example.org/p>/<http://example.org/p>*',
    );
  });

  it('round-trips through RDF', () => {
    const path = Path.sequence(
      Path.alternative(Path.predicate(ex('p')), Path.inverse(Path.predicate(ex('q')))),
      Path.oneOrMore(Path.predicate(ex('r'))),
    );
    const { node, quads } = Path.toRdf(path);
    const decoded = Path.fromRdf(Dataset.fromIterable(quads), node);
    expect(Result.isSuccess(decoded) && Path.equals(decoded.success, path)).toBe(true);
  });

  it('rejects ill-formed paths', () => {
    const g = ttl(`ex:s sh:path [ ex:unknown ex:p ] .`);
    const node = Dataset.objectsOf(g, ex('s'), sh.path)[0]!;
    expect(Result.isFailure(Path.fromRdf(g, node))).toBe(true);
  });
});

describe('Shapes', () => {
  it.effect('parses a shapes graph into a typed model', () =>
    Effect.gen(function* () {
      const shapes = yield* Shapes.parse(personShapes);
      const person = Option.getOrThrow(Shapes.get(shapes, ex('PersonShape')));
      expect(person._tag).toBe('NodeShape');
      expect(person.targets).toEqual([
        { _tag: 'TargetClass', class: ex('Person'), implicit: false },
      ]);
      expect(person.constraints.map((c) => c._tag)).toEqual(['Property', 'Property', 'Property']);
      const props = shapes.shapes.filter((s) => s._tag === 'PropertyShape');
      expect(props).toHaveLength(3);
      const age = props.find(
        (s) => s._tag === 'PropertyShape' && Path.equals(s.path, Path.predicate(ex('age'))),
      )!;
      expect(age.severity.value).toBe(sh.Warning.value);
      expect(age.constraints.map((c) => Shapes.componentOf(c).value)).toEqual([
        sh.DatatypeConstraintComponent.value,
        sh.MinInclusiveConstraintComponent.value,
      ]);
      expect(Shapes.targetedShapes(shapes)).toEqual([person]);
      expect(Shapes.usesSparql(shapes)).toBe(false);
    }),
  );

  it.effect('reports ill-formed shapes graphs', () =>
    Effect.gen(function* () {
      const bad = [
        `ex:S sh:targetNode ex:a ; sh:minCount "two" .`,
        `ex:S a sh:PropertyShape ; sh:path ex:p, ex:q .`,
        `ex:S sh:targetNode ex:a ; sh:pattern "(" .`,
        `ex:S sh:targetNode ex:a ; sh:in ex:notAList .`,
        `ex:S sh:targetNode ex:a ; sh:nodeKind ex:Whatever .`,
        `ex:S sh:targetNode ex:a ; sh:node "literal" .`,
      ];
      for (const src of bad) {
        const error = yield* Effect.flip(Shapes.parse(ttl(src)));
        expect(error._tag).toBe('ShapesGraphError');
      }
    }),
  );

  it.effect('recognises implicit class targets and SPARQL constructs', () =>
    Effect.gen(function* () {
      const shapes = yield* Shapes.parse(
        ttl(`
          ex:Person a rdfs:Class, sh:NodeShape ; sh:sparql [ sh:select "SELECT $this WHERE {}" ] .
          ex:T sh:target [ a sh:SPARQLTarget ; sh:select "SELECT ?this WHERE {}" ] .
        `),
      );
      const person = Option.getOrThrow(Shapes.get(shapes, ex('Person')));
      expect(person.targets).toEqual([
        { _tag: 'TargetClass', class: ex('Person'), implicit: true },
      ]);
      expect(person.constraints[0]?._tag).toBe('Sparql');
      expect(Shapes.usesSparql(shapes)).toBe(true);
    }),
  );
});

describe('Validator', () => {
  it.effect('validates with RDFS subclass reasoning', () =>
    Effect.gen(function* () {
      const report = yield* Validator.validate(personData, personShapes);
      expect(report.conforms).toBe(false);
      const summary = report.results
        .map(
          (r) =>
            `${(r.focusNode as Term.NamedNode).value} ${sh.localName(r.sourceConstraintComponent as Term.NamedNode)} ${sh.localName(r.severity)}`,
        )
        .sort();
      expect(summary).toEqual([
        'http://example.org/bob ClassConstraintComponent Violation',
        'http://example.org/bob MinInclusiveConstraintComponent Warning',
        'http://example.org/dave MinCountConstraintComponent Violation',
      ]);
      expect(ValidationReport.violations(report)).toHaveLength(2);
      const dave = report.results.find((r) => r.focusNode.key === ex('dave').key)!;
      expect(dave.messages.map((m) => m.value)).toEqual(['A person needs exactly one string name']);
      expect(Option.map(dave.resultPath, Path.toSparql)).toEqual(Option.some(ex('name').key));
      expect(ValidationReport.format(report)).toContain('MinCountConstraintComponent');
    }),
  );

  it.effect('converts reports to the standard RDF vocabulary', () =>
    Effect.gen(function* () {
      const report = yield* Validator.validate(personData, personShapes);
      const ds = ValidationReport.toDataset(report);
      expect(Dataset.subjectsOf(ds, rdf.type, sh.ValidationReport)).toHaveLength(1);
      expect(Dataset.subjectsOf(ds, rdf.type, sh.ValidationResult)).toHaveLength(3);
      expect(
        Dataset.has(
          ds,
          Term.quad(
            Dataset.subjectsOf(ds, rdf.type, sh.ValidationReport)[0]!,
            sh.conforms,
            Term.literal('false', xsd.boolean),
          ),
        ),
      ).toBe(true);
      const back = ValidationReport.fromDataset(ds);
      expect(Result.isSuccess(back)).toBe(true);
      const again = ValidationReport.toDataset(Result.getOrThrow(back));
      expect(Isomorphism.isomorphic(ds, again)).toBe(true);
    }),
  );

  it.effect('covers value, string and pair constraints', () =>
    Effect.gen(function* () {
      const shapes = ttl(`
        ex:S sh:targetNode ex:n ;
          sh:property [ sh:path ex:code ; sh:pattern "^[a-z]+$" ; sh:flags "i" ; sh:maxLength 3 ] ;
          sh:property [ sh:path ex:label ; sh:languageIn ( "en" "de" ) ; sh:uniqueLang true ] ;
          sh:property [ sh:path ex:start ; sh:lessThan ex:end ] ;
          sh:property [ sh:path ex:colour ; sh:in ( ex:Red ex:Green ) ; sh:hasValue ex:Red ] ;
          sh:property [ sh:path ex:same ; sh:equals ex:other ; sh:disjoint ex:code ] .
      `);
      const data = ttl(`
        ex:n ex:code "AB", "abcd", "a1" ;
          ex:label "x"@en, "y"@en-GB, "z"@fr ;
          ex:start 5 ; ex:end 3 ;
          ex:colour ex:Blue ;
          ex:same "AB" ; ex:other "q" .
      `);
      const report = yield* Validator.validate(data, shapes);
      const counts = new Map<string, number>();
      for (const r of report.results) {
        const name = sh.localName(r.sourceConstraintComponent as Term.NamedNode)!;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      expect(Object.fromEntries(counts)).toEqual({
        PatternConstraintComponent: 1, // "a1"
        MaxLengthConstraintComponent: 1, // "abcd"
        LanguageInConstraintComponent: 1, // "z"@fr
        LessThanConstraintComponent: 1,
        InConstraintComponent: 1,
        HasValueConstraintComponent: 1,
        EqualsConstraintComponent: 2,
        DisjointConstraintComponent: 1,
      });
    }),
  );

  it.effect('supports closed shapes and logical constraints', () =>
    Effect.gen(function* () {
      const shapes = ttl(`
        ex:S sh:targetNode ex:a, ex:b ;
          sh:closed true ; sh:ignoredProperties ( rdf:type ) ;
          sh:property [ sh:path ex:p ] ;
          sh:or ( [ sh:property [ sh:path ex:p ; sh:minCount 1 ] ] [ sh:nodeKind sh:BlankNode ] ) ;
          sh:not [ sh:hasValue ex:b ] .
      `);
      const data = ttl(`ex:a a ex:T ; ex:p 1 ; ex:q 2 . ex:b ex:p 1 .`);
      const report = yield* Validator.validate(data, shapes, { details: true });
      const tags = report.results
        .map(
          (r) =>
            `${(r.focusNode as Term.NamedNode).value} ${sh.localName(r.sourceConstraintComponent as Term.NamedNode)}`,
        )
        .sort();
      expect(tags).toEqual([
        'http://example.org/a ClosedConstraintComponent',
        'http://example.org/b NotConstraintComponent',
      ]);
      const closed = report.results.find((r) => r.focusNode.key === ex('a').key)!;
      expect(Option.map(closed.resultPath, Path.toSparql)).toEqual(Option.some(ex('q').key));
    }),
  );

  it.effect('attaches nested details for sh:node when requested', () =>
    Effect.gen(function* () {
      const shapes = ttl(`
        ex:S sh:targetNode ex:a ; sh:property [ sh:path ex:p ; sh:node ex:Inner ] .
        ex:Inner sh:property [ sh:path ex:q ; sh:minCount 1 ] .
      `);
      const data = ttl(`ex:a ex:p ex:b .`);
      const withDetails = yield* Validator.validate(data, shapes, { details: true });
      expect(withDetails.results[0]?.details).toHaveLength(1);
      const withoutDetails = yield* Validator.validate(data, shapes);
      expect(withoutDetails.results[0]?.details).toHaveLength(0);
    }),
  );

  it.effect('detects recursive shapes', () =>
    Effect.gen(function* () {
      const shapes = ttl(`
        ex:S sh:targetNode ex:a ; sh:property [ sh:path ex:knows ; sh:node ex:S ] .
      `);
      const data = ttl(`ex:a ex:knows ex:b . ex:b ex:knows ex:a .`);
      const error = yield* Effect.flip(Validator.validate(data, shapes));
      expect(error._tag).toBe('RecursiveShapeError');
      const report = yield* Validator.validate(data, shapes, { recursion: 'ignore' });
      expect(report.conforms).toBe(true);
    }),
  );

  it.effect('can include the shapes graph in the data graph', () =>
    Effect.gen(function* () {
      const shapes = ttl(`
        ex:S sh:targetSubjectsOf sh:targetSubjectsOf ; sh:property [ sh:path sh:targetSubjectsOf ; sh:nodeKind sh:Literal ] .
      `);
      const without = yield* Validator.validate(Dataset.empty, shapes);
      expect(without.conforms).toBe(true);
      const withShapes = yield* Validator.validate(Dataset.empty, shapes, {
        includeShapesGraph: true,
      });
      expect(withShapes.conforms).toBe(false);
    }),
  );

  it.effect('skips deactivated shapes', () =>
    Effect.gen(function* () {
      const shapes = ttl(`ex:S sh:targetNode ex:a ; sh:deactivated true ; sh:minLength 100 .`);
      expect(yield* Validator.conforms(Dataset.empty, shapes)).toBe(true);
    }),
  );

  it.effect('provides a pre-compiled Validator service', () =>
    Effect.gen(function* () {
      const validator = yield* Validator.Validator;
      expect(yield* validator.conforms(personData)).toBe(false);
      const error = yield* Effect.flip(validator.check(personData));
      expect(error._tag).toBe('ConformanceError');
      const good = ttl(`ex:x a ex:Person ; ex:name "X" .`);
      expect(yield* validator.check(good)).toBe(good);
    }).pipe(Effect.provide(Validator.layer(personShapes))),
  );

  it.effect('fails building the layer from an ill-formed shapes graph', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.provide(
          Effect.gen(function* () {
            return yield* Validator.Validator;
          }),
          Validator.layer(ttl(`ex:S sh:targetNode ex:a ; sh:maxCount ex:x .`)),
        ),
      );
      expect(error._tag).toBe('ShapesGraphError');
    }),
  );

  it.effect('exposes a Schema that only accepts conforming datasets', () =>
    Effect.gen(function* () {
      const shapes = yield* Shapes.parse(personShapes);
      const schema = Validator.schema(shapes);
      const good = ttl(`ex:x a ex:Person ; ex:name "X" .`);
      expect(yield* Schema.decodeEffect(schema)(good)).toBe(good);
      const error = yield* Effect.flip(Schema.decodeEffect(schema)(personData));
      expect(error.message).toContain('MinCountConstraintComponent');
    }),
  );
});

describe('SHACL-SPARQL extension point', () => {
  const shapes = ttl(`
    ex:S sh:targetNode ex:a ;
      sh:sparql [ sh:select "SELECT $this WHERE { $this ex:bad ?x }" ] .
  `);
  const data = ttl(`ex:a ex:bad 1 .`);

  it.effect('fails with UnsupportedFeatureError without an evaluator', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Validator.validate(data, shapes));
      expect(error._tag).toBe('UnsupportedFeatureError');
    }),
  );

  it.effect('can ignore unsupported SPARQL constraints', () =>
    Effect.gen(function* () {
      const report = yield* Validator.validate(data, shapes, { sparql: 'ignore' });
      expect(report.conforms).toBe(true);
    }),
  );

  it.effect('delegates to a SparqlConstraintEvaluator', () =>
    Effect.gen(function* () {
      const report = yield* Validator.validate(data, shapes);
      expect(report.results).toHaveLength(1);
      const [result] = report.results;
      expect(result?.sourceConstraintComponent.key).toBe(sh.SPARQLConstraintComponent.key);
      expect(Option.isSome(result!.sourceConstraint)).toBe(true);
      expect(Option.map(result!.value, (v) => v.key)).toEqual(
        Option.some(Term.literal('1', xsd.integer).key),
      );
    }).pipe(
      Effect.provide(
        Layer.succeed(Sparql.SparqlConstraintEvaluator, {
          evaluateConstraint: (input) =>
            Effect.succeed(
              Dataset.objectsOf(input.dataGraph, input.focusNode as Term.NamedNode, ex('bad')).map(
                (value) => ({ value }),
              ),
            ),
          selectTargets: () => Effect.succeed([]),
        }),
      ),
    ),
  );
});
