/**
 * Synchronous Turtle parsing for tests, backed by `@thomasfosterau/effect-turtle`.
 */
import { Turtle } from '@thomasfosterau/effect-turtle';
import type { Dataset } from '@thomasfosterau/effect-rdf';
import * as Effect from 'effect/Effect';

export const parseTurtle = (input: string, baseIri?: string): Dataset.Dataset =>
  Effect.runSync(Turtle.parse(input, { baseIri })).dataset;
