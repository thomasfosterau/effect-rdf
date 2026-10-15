/**
 * Semantic actions: a pluggable `SemActHandler` service consulted by the
 * validator for every semantic action it encounters, and an implementation
 * of the ShEx Test extension (`http://shex.io/extensions/Test/`).
 *
 * Actions whose name no handler recognises are ignored (they succeed), as
 * the ShEx specification recommends.
 *
 * @since 0.1.0
 */
import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as ShExJ from './ShExJ.ts';

/**
 * Where a semantic action was found.
 *
 * @since 0.1.0
 * @category models
 */
export type SemActSite =
  | 'start'
  | 'shape'
  | 'tripleExpression'
  | 'tripleConstraint'
  | 'nodeConstraint';

/**
 * The context a semantic action is evaluated in.
 *
 * @since 0.1.0
 * @category models
 */
export interface SemActContext {
  readonly site: SemActSite;
  /** The node being validated (the focus node, or the value node for node constraints). */
  readonly node: Term.Term | undefined;
  /** For triple constraint actions: the matched triple (as written in the data). */
  readonly triple?: Term.Triple | undefined;
  /** For shape and triple expression actions: the triples matched. */
  readonly triples?: ReadonlyArray<Term.Triple> | undefined;
}

/**
 * Evaluates a semantic action: `Option.some(true)` for success,
 * `Option.some(false)` for failure, `Option.none()` when the action is not
 * handled (it is then ignored).
 *
 * @since 0.1.0
 * @category models
 */
export type Handler = (action: ShExJ.SemAct, context: SemActContext) => Option.Option<boolean>;

/**
 * The semantic action handler used by the validator. Defaults to ignoring
 * every action.
 *
 * @since 0.1.0
 * @category services
 */
export const SemActHandler: Context.Reference<Handler> = Context.Reference<Handler>(
  '@thomasfosterau/effect-shex/SemActHandler',
  { defaultValue: () => () => Option.none() },
);

/**
 * Builds a handler dispatching on action names. A handler registered for a
 * name ending in `/` or `#` also handles every name it is a prefix of.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  handlers: Readonly<Record<string, (code: string | undefined, context: SemActContext) => boolean>>,
): Handler => {
  const entries = Object.entries(handlers);
  return (action, context) => {
    const exact = handlers[action.name];
    if (exact !== undefined) return Option.some(exact(action.code, context));
    for (const [name, h] of entries) {
      if ((name.endsWith('/') || name.endsWith('#')) && action.name.startsWith(name)) {
        return Option.some(h(action.code, context));
      }
    }
    return Option.none();
  };
};

/**
 * Combines handlers: the first one that handles an action wins.
 *
 * @since 0.1.0
 * @category combinators
 */
export const combine =
  (...handlers: ReadonlyArray<Handler>): Handler =>
  (action, context) => {
    for (const h of handlers) {
      const r = h(action, context);
      if (Option.isSome(r)) return r;
    }
    return Option.none();
  };

/**
 * Supplies code for actions written without code (`%<name>%`), e.g. from an
 * external semantic actions file. Actions are matched by name.
 *
 * @since 0.1.0
 * @category combinators
 */
export const withExternalCode =
  (handler: Handler, external: ReadonlyArray<ShExJ.SemAct>): Handler =>
  (action, context) => {
    if (action.code === undefined) {
      const ext = external.find((e) => e.name === action.name && e.code !== undefined);
      if (ext !== undefined) return handler(ext, context);
    }
    return handler(action, context);
  };

/**
 * A layer providing a handler.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (handler: Handler): Layer.Layer<never> =>
  Layer.succeed(SemActHandler, handler);

// -----------------------------------------------------------------------------
// The Test extension
// -----------------------------------------------------------------------------

/**
 * The namespace of the ShEx Test extension.
 *
 * @since 0.1.0
 * @category constants
 */
export const testExtensionIri = 'http://shex.io/extensions/Test/';

const termText = (t: Term.Term | undefined): string =>
  t === undefined
    ? ''
    : t._tag === 'Literal'
      ? t.language !== ''
        ? `"${t.value}"@${t.language}`
        : t.datatype.value === 'http://www.w3.org/2001/XMLSchema#string'
          ? t.value
          : `"${t.value}"^^${t.datatype.value}`
      : t._tag === 'NamedNode' || t._tag === 'BlankNode'
        ? t.value
        : t.key;

/**
 * The ShEx Test extension: `print(s|p|o|n|"text")` records a line and
 * succeeds, `fail(...)` records a line and fails. The `onPrint` callback
 * receives each line together with the action name.
 *
 * @since 0.1.0
 * @category test extension
 */
export const testExtension = (
  onPrint: (line: string, name: string) => void = () => {},
): Handler => {
  const re =
    /^\s*(print|fail|p)\s*\(\s*(?:([spon])|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)\s*$/s;
  const unescape = (s: string) => s.replace(/\\(.)/gs, '$1');
  return (action, context) => {
    if (!action.name.startsWith(testExtensionIri)) return Option.none();
    if (action.code === undefined) return Option.some(true);
    const m = re.exec(action.code);
    if (m === null) return Option.some(true);
    const [, fn, v, dq, sq] = m;
    let line: string;
    if (v !== undefined) {
      const t = context.triple;
      line = termText(
        v === 's'
          ? (t?.subject ?? context.node)
          : v === 'p'
            ? t?.predicate
            : v === 'o'
              ? (t?.object ?? context.node)
              : context.node,
      );
    } else line = unescape(dq ?? sq ?? '');
    onPrint(line, action.name);
    return Option.some(fn !== 'fail');
  };
};
