import * as Effect from 'effect/Effect';
import type * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Turtle from '@thomasfosterau/effect-turtle/Turtle';

/** Parses Turtle test data, keeping blank node labels as written. */
export const parseTurtle = (input: string, baseIri?: string): Dataset.Dataset =>
  Effect.runSync(Turtle.parse(input, { baseIri, blankNodePrefix: '' })).dataset;
