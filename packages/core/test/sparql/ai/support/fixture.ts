/**
 * The knowledge graph the `/sparql/ai` tests query: a few people and a
 * company, and the engine over it.
 */
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Engine from '../../../../src/sparql/Engine.ts';
import * as Store from '../../../../src/sparql/Store.ts';

export const EX = 'http://example.org/';
const RDF_TYPE = Term.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const LABEL = Term.namedNode('http://www.w3.org/2000/01/rdf-schema#label');
const ex = (local: string) => Term.namedNode(`${EX}${local}`);

const data = Dataset.make(
  Term.quad(ex('alice'), RDF_TYPE, ex('Person')),
  Term.quad(ex('bob'), RDF_TYPE, ex('Person')),
  Term.quad(ex('acme'), RDF_TYPE, ex('Company')),
  Term.quad(ex('alice'), LABEL, Term.literal('Alice Liddell', 'en')),
  Term.quad(ex('bob'), LABEL, Term.literal('Bob')),
  Term.quad(ex('alice'), ex('knows'), ex('bob')),
  Term.quad(ex('alice'), ex('worksFor'), ex('acme')),
);

// The engine over the data.
export const engine = Layer.effect(
  Engine.SparqlEngine,
  Effect.map(Store.makeMemory(data), (store) => Engine.make(store)),
);
