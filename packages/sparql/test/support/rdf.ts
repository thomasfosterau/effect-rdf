/**
 * Loads RDF test files (Turtle, TriG, N-Triples, N-Quads, RDF/XML) with the
 * syntax packages of the monorepo.
 */
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as Effect from 'effect/Effect';
import { Term } from '@thomasfosterau/effect-rdf';
import { NQuads, NTriples } from '@thomasfosterau/effect-ntriples';
import { RdfXml } from '@thomasfosterau/effect-rdfxml';
import { TriG, Turtle } from '@thomasfosterau/effect-turtle';

export const parseRdf = (
  text: string,
  baseIri: string,
  extension: string,
  graph?: Term.Graph,
): Array<Term.Quad> => {
  const options = { baseIri, ...(graph !== undefined ? { graph } : {}) };
  const parser =
    extension === 'trig'
      ? TriG.parse
      : extension === 'nt'
        ? NTriples.parse
        : extension === 'nq'
          ? NQuads.parse
          : extension === 'rdf'
            ? RdfXml.parse
            : Turtle.parse;
  return Array.from(Effect.runSync(parser(text, options)).dataset);
};

export const parseFile = (path: string, graph?: Term.Graph): Array<Term.Quad> =>
  parseRdf(
    fs.readFileSync(path, 'utf8'),
    pathToFileURL(path).href,
    path.slice(path.lastIndexOf('.') + 1),
    graph,
  );
