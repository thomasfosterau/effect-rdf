/**
 * The "Quick tour" example of the repository README, kept verbatim (between
 * the markers) so that it is type-checked and run by the test suite.
 */
import { describe, expect, it } from '@effect/vitest';
import { readFileSync } from 'node:fs';

// --- README example: begin ---
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { Namespace, PrefixMap } from '@thomasfosterau/effect-rdf';
import { JsonLd } from '@thomasfosterau/effect-jsonld';
import { ValidationReport, Validator } from '@thomasfosterau/effect-shacl';
import { Evaluator } from '@thomasfosterau/effect-shacl-sparql';
import { Engine, QueryBuilder as Q, Store, TermSchema } from '@thomasfosterau/effect-sparql';
import { Turtle } from '@thomasfosterau/effect-turtle';

const ex = Namespace.make('http://example.org/');

const data = `
  @prefix ex: <http://example.org/> .
  ex:alice a ex:Person ; ex:name "Alice" ; ex:age 42 ; ex:knows ex:bob .
  ex:bob a ex:Person ; ex:name "Bob" ; ex:age -1 .
`;

const shapes = `
  @prefix sh: <http://www.w3.org/ns/shacl#> .
  @prefix ex: <http://example.org/> .
  @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
  ex:PersonShape a sh:NodeShape ;
    sh:targetClass ex:Person ;
    sh:property [ sh:path ex:name ; sh:minCount 1 ; sh:datatype xsd:string ] ;
    sh:property [
      sh:path ex:age ; sh:datatype xsd:integer ; sh:minInclusive 0 ;
      sh:message "{$this} has an invalid age: {?value}" ;
    ] ;
    # A SHACL-SPARQL constraint: nobody knows themselves.
    sh:sparql [
      sh:message "{$this} knows themselves" ;
      sh:select "SELECT $this WHERE { $this <http://example.org/knows> $this }" ;
    ] .
`;

const program = Effect.fn('program')(function* () {
  // 1. Parse Turtle into a core Dataset.
  const { dataset } = yield* Turtle.parse(data);

  // 2. Query it with the typed SPARQL query builder (rows are typed from the projection).
  const v = Q.vars('person', 'name', 'age');
  const query = Q.select('name', 'age')
    .where(Q.triple(v.person, ex('name'), v.name), Q.triple(v.person, ex('age'), v.age))
    .orderBy(Q.asc(v.name));
  const people = yield* Q.decode(
    query,
    Schema.Struct({ name: TermSchema.string, age: TermSchema.integer }),
  ).pipe(
    Stream.runCollect,
    Effect.provide(Engine.layer().pipe(Layer.provide(Store.layerMemory(dataset)))),
  );
  // [{ name: 'Alice', age: 42 }, { name: 'Bob', age: -1 }]

  // 3. Validate it with SHACL; the evaluator layer enables SHACL-SPARQL.
  const shapesGraph = (yield* Turtle.parse(shapes)).dataset;
  const report = yield* Validator.validate(dataset, shapesGraph).pipe(
    Effect.provide(Evaluator.layer()),
  );
  // report.conforms === false: "http://example.org/bob has an invalid age: -1"

  // 4. Serialise it as JSON-LD (compacted with the given prefixes).
  const jsonld = yield* JsonLd.serialize(dataset, {
    prefixes: PrefixMap.make({ ex: 'http://example.org/' }),
  });

  return { people, report: ValidationReport.format(report), jsonld };
});
// --- README example: end ---

describe('README quick tour', () => {
  it('matches the code in the README', () => {
    const between = (text: string, start: string, end: string) =>
      text.slice(text.indexOf(start) + start.length, text.indexOf(end, text.indexOf(start)));
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    const inReadme = between(readme, '## Quick tour', '\nEffect.runPromise');
    const inTest = between(
      self,
      '// --- README example: begin ---\n',
      '// --- README example: end',
    );
    expect(inReadme).toContain(inTest.trim());
  });

  it.effect('runs end to end', () =>
    Effect.gen(function* () {
      const { people, report, jsonld } = yield* program();
      expect(people).toEqual([
        { name: 'Alice', age: 42 },
        { name: 'Bob', age: -1 },
      ]);
      expect(report).toContain('http://example.org/bob has an invalid age: -1');
      expect(report).not.toContain('knows themselves');
      const json = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ '@context': Schema.Record(Schema.String, Schema.Unknown) }),
        ),
      )(jsonld);
      expect(json['@context']).toMatchObject({ ex: 'http://example.org/' });
      expect(jsonld).toContain('ex:alice');
    }),
  );
});
