/**
 * Building objects whose optional properties are set only when present, as
 * `exactOptionalPropertyTypes` requires.
 *
 * @internal
 */
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';

/**
 * `{ [key]: value }` when the value is present, `{}` otherwise; spread it
 * into an object literal.
 *
 * @internal
 */
export const optional = <K extends string, A>(
  key: K,
  value: Option.Option<A>,
): { readonly [P in K]?: A } =>
  Option.match(value, {
    onNone: (): { readonly [P in K]?: A } => ({}),
    onSome: (v): { readonly [P in K]?: A } => Record.singleton(key, v),
  });
