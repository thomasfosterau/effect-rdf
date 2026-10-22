/**
 * Factories for the typed property accessors of the schema modules.
 */
import * as DateTime from 'effect/DateTime';
import { dual } from 'effect/Function';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Metadata from '../Metadata.ts';

export const text =
  (iri: string) =>
  (self: Metadata.Metadata): Option.Option<string> =>
    Metadata.getText(self, iri);

export const items =
  (iri: string) =>
  (self: Metadata.Metadata): Option.Option<ReadonlyArray<string>> =>
    Metadata.getItems(self, iri);

export const localized =
  (iri: string) =>
  (self: Metadata.Metadata, language?: string): Option.Option<string> =>
    Metadata.getLocalized(self, iri, language);

export const boolean =
  (iri: string) =>
  (self: Metadata.Metadata): Option.Option<boolean> =>
    Option.flatMap(Metadata.getText(self, iri), (value) =>
      value === 'True' ? Option.some(true) : value === 'False' ? Option.some(false) : Option.none(),
    );

export const dualSetter = <A>(
  f: (self: Metadata.Metadata, value: A) => Metadata.Metadata,
): Metadata.Setter<A> => dual(2, f);

export const setter = <A>(iri: string, toValue: (value: A) => Metadata.Value): Metadata.Setter<A> =>
  dualSetter((self: Metadata.Metadata, value: A) => Metadata.set(self, iri, toValue(value)));

export const setText = (iri: string): Metadata.Setter<string> => setter(iri, Metadata.text);

export const setBag = (iri: string): Metadata.Setter<Iterable<string>> => setter(iri, Metadata.bag);

export const setSeq = (iri: string): Metadata.Setter<Iterable<string>> => setter(iri, Metadata.seq);

export const setBoolean = (iri: string): Metadata.Setter<boolean> =>
  setter(iri, (value: boolean) => Metadata.text(value ? 'True' : 'False'));

/** XMP dates are ISO 8601 with a time-zone offset (ISO 16684-1 §8.2.1.1). */
export const setDate = (iri: string): Metadata.Setter<DateTime.DateTime | string> =>
  setter(iri, (value: DateTime.DateTime | string) =>
    Metadata.text(DateTime.isDateTime(value) ? DateTime.formatIsoOffset(value) : value),
  );

const isMetadata = (u: unknown): u is Metadata.Metadata =>
  Predicate.hasProperty(u, 'properties') && Predicate.hasProperty(u, 'about');

export const setLocalized = (iri: string): Metadata.LocalizedSetter =>
  dual(
    (args) => isMetadata(args[0]),
    (self: Metadata.Metadata, value: string, language?: string) =>
      Metadata.setLocalized(self, iri, value, language),
  );

export const integer =
  (iri: string) =>
  (self: Metadata.Metadata): Option.Option<number> =>
    Option.flatMap(Metadata.getText(self, iri), (value) =>
      /^[+-]?[0-9]+$/.test(value.trim()) ? Option.some(Number(value)) : Option.none(),
    );

export const setInteger = (iri: string): Metadata.Setter<number> =>
  setter(iri, (value: number) => Metadata.text(String(Math.trunc(value))));
