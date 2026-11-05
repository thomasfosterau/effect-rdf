/**
 * Framing Algorithm (JSON-LD 1.1 Framing §4).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import { type NodeMap, generateNodeMap, mergeNodeMaps } from './flatten.ts';
import {
  IdIssuer,
  type Json,
  type JsonObject,
  addValue,
  asArray,
  clone,
  compareStrings,
  fail,
  hasOwn,
  isAbsoluteIri,
  isBlankNodeId,
  isEmptyObject,
  isKeyword,
  isListObject,
  isObject,
  isString,
  isValueObject,
  getOrInit,
  stringifyJson,
} from './util.ts';
import * as Predicate from 'effect/Predicate';

/** @internal */
export type Embed = '@once' | '@always' | '@never' | '@link' | '@first' | '@last';

/** @internal */
export interface FrameOptions {
  readonly embed: Embed;
  readonly explicit: boolean;
  readonly omitDefault: boolean;
  readonly requireAll: boolean;
  readonly ordered: boolean;
  /** Frame the merged graph (true) or the default graph (false). */
  readonly merged: boolean;
  readonly is11: boolean;
}

interface Flags {
  readonly embed: Embed;
  readonly explicit: boolean;
  readonly requireAll: boolean;
}

/** Where a framed node was embedded: its parent, under a property (none at the top level). */
interface EmbedSite {
  readonly parent: Json;
  readonly property: Option.Option<string>;
}

interface State {
  readonly options: FrameOptions;
  readonly graphMap: NodeMap;
  readonly subjects: globalThis.Record<string, JsonObject>;
  readonly graph: string;
  readonly embedded: boolean;
  readonly subjectStack: Array<{ subject: JsonObject; graph: string }>;
  readonly link: globalThis.Record<string, globalThis.Record<string, JsonObject>>;
  readonly bnodeMap: globalThis.Record<string, Array<JsonObject>>;
  uniqueEmbeds: globalThis.Record<string, globalThis.Record<string, EmbedSite>>;
}

/**
 * Frames expanded input with an expanded frame. Returns the framed nodes
 * (expanded form) and the blank node identifiers that are referenced only
 * once and can therefore be pruned.
 *
 * @internal
 */
export const frame = (expanded: Json, expandedFrame: Json, options: FrameOptions): Array<Json> => {
  const graphMap: NodeMap = { '@default': {} };
  generateNodeMap(expanded, graphMap, new IdIssuer());
  let graph = '@default';
  if (options.merged) {
    graphMap['@merged'] = mergeNodeMaps(graphMap);
    graph = '@merged';
  }
  const state: State = {
    options,
    graphMap,
    subjects: graphMap[graph] ?? {},
    graph,
    embedded: false,
    subjectStack: [],
    link: {},
    bnodeMap: {},
    uniqueEmbeds: {},
  };
  const framed: Array<Json> = [];
  frameSubjects(
    state,
    Arr.sort(Record.keys(state.subjects), compareStrings),
    asArray(expandedFrame),
    framed,
    Option.none(),
  );
  const bnodesToClear = MutableHashSet.fromIterable(
    options.is11
      ? Record.keys(state.bnodeMap).filter((id) => state.bnodeMap[id]?.length === 1)
      : [],
  );
  // Framing's top level is an array of node objects, and cleanup keeps it an array.
  const cleaned: Array<Json> = cleanupPreserve(framed, bnodesToClear, new WeakSet());
  return cleaned;
};

const getFlag = (
  pattern: JsonObject,
  options: FrameOptions,
  name: 'embed' | 'explicit' | 'omitDefault' | 'requireAll',
): any => {
  const flag = `@${name}`;
  let value: Json = hasOwn(pattern, flag) ? asArray(pattern[flag])[0] : options[name];
  if (isValueObject(value)) value = value['@value'];
  if (name === 'embed') {
    if (value === true) value = '@once';
    else if (value === false) value = '@never';
    else if (!['@always', '@never', '@link', '@first', '@last', '@once'].includes(value)) {
      fail('invalid @embed value', String(value));
    }
  } else if (Predicate.isString(value)) {
    value = value === 'true';
  }
  return value;
};

const validateFrame = (frameValue: Json): void => {
  if (!Array.isArray(frameValue) || frameValue.length !== 1 || !isObject(frameValue[0])) {
    fail('invalid frame', 'a frame must be a single object');
  }
  const f = frameValue[0];
  if (hasOwn(f, '@id')) {
    asArray(f['@id']).forEach((id) => {
      if (!(isObject(id) || (isString(id) && isAbsoluteIri(id))) || isBlankNodeId(id)) {
        fail('invalid frame', `invalid @id ${stringifyJson(id)}`);
      }
    });
  }
  if (hasOwn(f, '@type')) {
    asArray(f['@type']).forEach((type) => {
      if (
        !(isObject(type) || (isString(type) && isAbsoluteIri(type)) || type === '@json') ||
        isBlankNodeId(type)
      ) {
        fail('invalid frame', `invalid @type ${stringifyJson(type)}`);
      }
    });
  }
};

const createImplicitFrame = (flags: Flags): Array<JsonObject> => [
  {
    '@embed': [flags.embed],
    '@explicit': [flags.explicit],
    '@requireAll': [flags.requireAll],
  },
];

const createsCircularReference = (
  subject: JsonObject,
  graph: string,
  stack: ReadonlyArray<{ subject: JsonObject; graph: string }>,
): boolean =>
  stack.some((entry) => entry.graph === graph && entry.subject['@id'] === subject['@id']);

const addFrameOutput = (parent: Json, property: Option.Option<string>, output: Json): void => {
  if (isObject(parent)) {
    if (Option.isSome(property)) addValue(parent, property.value, output, true);
  } else {
    // A non-object parent in framing output is the top-level array.
    const top: Array<Json> = parent;
    top.push(output);
  }
};

const isSubjectReference = (v: Json): boolean =>
  isObject(v) && Record.keys(v).length === 1 && hasOwn(v, '@id');

const frameSubjects = (
  state: State,
  subjects: ReadonlyArray<string>,
  frameValue: Json,
  parent: Json,
  property: Option.Option<string>,
): void => {
  validateFrame(frameValue);
  const pattern: JsonObject = frameValue[0];
  const options = state.options;
  const flags: Flags = {
    embed: getFlag(pattern, options, 'embed'),
    explicit: getFlag(pattern, options, 'explicit'),
    requireAll: getFlag(pattern, options, 'requireAll'),
  };
  const link = getOrInit(state.link, state.graph, () => ({}));
  const matches = filterSubjects(state, subjects, pattern, flags);
  Arr.sort(Record.keys(matches), compareStrings).forEach((id) => {
    const subject = matches[id];
    if (subject === undefined) return;
    if (Option.isNone(property)) state.uniqueEmbeds = { [state.graph]: {} };
    const uniqueEmbeds = getOrInit(state.uniqueEmbeds, state.graph, () => ({}));
    const output: JsonObject = { '@id': id };
    if (isBlankNodeId(id)) addValue(state.bnodeMap, id, output, true);
    link[id] = output;
    if ((flags.embed === '@first' || flags.embed === '@last') && options.is11) {
      fail('invalid @embed value', flags.embed);
    }
    if (!state.embedded && hasOwn(uniqueEmbeds, id)) return;
    if (
      state.embedded &&
      (flags.embed === '@never' ||
        createsCircularReference(subject, state.graph, state.subjectStack))
    ) {
      addFrameOutput(parent, property, output);
      return;
    }
    if (
      state.embedded &&
      (flags.embed === '@first' || flags.embed === '@once') &&
      hasOwn(uniqueEmbeds, id)
    ) {
      addFrameOutput(parent, property, output);
      return;
    }
    if (flags.embed === '@last' && hasOwn(uniqueEmbeds, id)) removeEmbed(state, id);
    uniqueEmbeds[id] = { parent, property };
    state.subjectStack.push({ subject, graph: state.graph });
    // the subject is also the name of a graph
    const namedGraph = state.graphMap[id];
    if (hasOwn(state.graphMap, id) && namedGraph !== undefined) {
      let recurse: boolean;
      let subframe: Json;
      if (!hasOwn(pattern, '@graph')) {
        recurse = state.graph !== '@merged';
        subframe = {};
      } else {
        subframe = asArray(pattern['@graph'])[0];
        recurse = !(id === '@merged' || id === '@default');
        if (!isObject(subframe)) subframe = {};
      }
      if (recurse) {
        frameSubjects(
          { ...state, graph: id, subjects: namedGraph, embedded: false },
          Arr.sort(Record.keys(namedGraph), compareStrings),
          [subframe],
          output,
          Option.some('@graph'),
        );
      }
    }
    if (hasOwn(pattern, '@included')) {
      frameSubjects(
        { ...state, embedded: false },
        subjects,
        pattern['@included'],
        output,
        Option.some('@included'),
      );
    }
    Arr.sort(Record.keys(subject), compareStrings).forEach((prop) => {
      if (isKeyword(prop)) {
        output[prop] = clone(subject[prop]);
        if (prop === '@type') {
          asArray(subject['@type']).forEach((type) => {
            if (isBlankNodeId(type)) addValue(state.bnodeMap, type, output, true);
          });
        }
        return;
      }
      if (flags.explicit && !hasOwn(pattern, prop)) return;
      const underProp = Option.some(prop);
      // Properties of a flattened subject hold arrays of values.
      const objects: Array<Json> = subject[prop];
      objects.forEach((o) => {
        const subframe = hasOwn(pattern, prop) ? pattern[prop] : createImplicitFrame(flags);
        if (isListObject(o)) {
          const first = hasOwn(pattern, prop) ? asArray(pattern[prop])[0] : undefined;
          const listFrame =
            isObject(first) && hasOwn(first, '@list') ? first['@list'] : createImplicitFrame(flags);
          const list: JsonObject = { '@list': [] };
          addFrameOutput(output, underProp, list);
          const listProperty = Option.some('@list');
          asArray(o['@list']).forEach((oo) => {
            if (isSubjectReference(oo)) {
              frameSubjects(
                { ...state, embedded: true },
                [oo['@id']],
                listFrame,
                list,
                listProperty,
              );
            } else {
              addFrameOutput(list, listProperty, clone(oo));
            }
          });
        } else if (isSubjectReference(o)) {
          frameSubjects({ ...state, embedded: true }, [o['@id']], subframe, output, underProp);
        } else if (valueMatch(asArray(subframe)[0], o)) {
          addFrameOutput(output, underProp, clone(o));
        }
      });
    });
    // defaults
    Arr.sort(Record.keys(pattern), compareStrings).forEach((prop) => {
      if (prop === '@type') {
        const first = asArray(pattern[prop])[0];
        if (!isObject(first) || !hasOwn(first, '@default')) return;
      } else if (isKeyword(prop)) {
        return;
      }
      const next: JsonObject = asArray(pattern[prop])[0] ?? {};
      const omitDefaultOn = getFlag(next, options, 'omitDefault');
      if (!omitDefaultOn && !hasOwn(output, prop)) {
        let preserve: Json = '@null';
        if (hasOwn(next, '@default')) preserve = clone(next['@default']);
        output[prop] = [{ '@preserve': asArray(preserve) }];
      }
    });
    // reverse properties
    if (isObject(pattern['@reverse'])) {
      const reversePattern: JsonObject = pattern['@reverse'];
      Arr.sort(Record.keys(reversePattern), compareStrings).forEach((reverseProp) => {
        const subframe = reversePattern[reverseProp];
        Record.keys(state.subjects).forEach((s) => {
          const values = asArray(state.subjects[s]?.[reverseProp] ?? []);
          if (values.some((v: Json) => isObject(v) && v['@id'] === id)) {
            const reverse: JsonObject = (output['@reverse'] ??= {});
            addValue(reverse, reverseProp, [], true);
            frameSubjects(
              { ...state, embedded: true },
              [s],
              subframe,
              reverse[reverseProp],
              property,
            );
          }
        });
      });
    }
    addFrameOutput(parent, property, output);
    state.subjectStack.pop();
  });
};

const removeEmbed = (state: State, id: string): void => {
  const embeds = state.uniqueEmbeds[state.graph];
  const embed = embeds?.[id];
  if (embeds === undefined || embed === undefined) return;
  const parent = embed.parent;
  const subject = { '@id': id };
  if (Array.isArray(parent)) {
    parent.forEach((v, i) => {
      if (isObject(v) && v['@id'] === id) parent[i] = subject;
    });
  } else if (isObject(parent) && Option.isSome(embed.property)) {
    const property = embed.property.value;
    const values = asArray(parent[property]);
    parent[property] = values.map((v: Json) => (isObject(v) && v['@id'] === id ? subject : v));
  }
  const removeDependents = (parentId: string): void => {
    Record.keys(embeds).forEach((next) => {
      const e = embeds[next];
      if (e !== undefined && isObject(e.parent) && e.parent['@id'] === parentId) {
        delete embeds[next];
        removeDependents(next);
      }
    });
  };
  removeDependents(id);
};

const filterSubjects = (
  state: State,
  subjects: ReadonlyArray<string>,
  pattern: JsonObject,
  flags: Flags,
) => {
  const result: globalThis.Record<string, JsonObject> = {};
  const graph = state.graphMap[state.graph];
  subjects.forEach((id) => {
    const subject = graph?.[id];
    if (subject !== undefined && filterSubject(state, subject, pattern, flags))
      result[id] = subject;
  });
  return result;
};

const filterSubject = (
  state: State,
  subject: JsonObject,
  pattern: JsonObject,
  flags: Flags,
): boolean => {
  let wildcard = true;
  let matchesSome = false;
  // Set when a key decides the match on its own, which ends the scan.
  let decided = Option.none<boolean>();
  const decide = (verdict: boolean): true => {
    decided = Option.some(verdict);
    return true;
  };
  Record.keys(pattern).some((key) => {
    let matchThis = false;
    const nodeValues = hasOwn(subject, key) ? asArray(subject[key]) : [];
    const frameValues = asArray(pattern[key]);
    const isEmpty = Arr.isReadonlyArrayEmpty(frameValues);
    if (key === '@id') {
      if (Arr.isReadonlyArrayEmpty(frameValues) || isObject(frameValues[0])) matchThis = true;
      else matchThis = frameValues.includes(nodeValues[0]);
      if (!flags.requireAll) return decide(matchThis);
    } else if (key === '@type') {
      wildcard = false;
      if (isEmpty) {
        if (Arr.isReadonlyArrayNonEmpty(nodeValues)) return decide(false);
        matchThis = true;
      } else if (frameValues.length === 1 && isEmptyObject(frameValues[0])) {
        matchThis = Arr.isReadonlyArrayNonEmpty(nodeValues);
      } else {
        frameValues.forEach((type) => {
          if (isObject(type) && hasOwn(type, '@default')) matchThis = true;
          else matchThis = matchThis || nodeValues.some((t) => t === type);
        });
        if (!flags.requireAll) return decide(matchThis);
      }
    } else if (isKeyword(key)) {
      return false;
    } else {
      const thisFrame = frameValues[0];
      let hasDefault = false;
      if (thisFrame !== undefined) {
        validateFrame([thisFrame]);
        hasDefault = hasOwn(thisFrame, '@default');
      }
      wildcard = false;
      if (Arr.isReadonlyArrayEmpty(nodeValues) && hasDefault) return false;
      if (Arr.isReadonlyArrayNonEmpty(nodeValues) && isEmpty) return decide(false);
      if (thisFrame === undefined) {
        if (Arr.isReadonlyArrayNonEmpty(nodeValues)) return decide(false);
        matchThis = true;
      } else if (isListObject(thisFrame)) {
        const listValue = asArray(thisFrame['@list'])[0];
        if (isListObject(nodeValues[0])) {
          const nodeListValues: Array<Json> = nodeValues[0]['@list'];
          if (isValueObject(listValue)) {
            matchThis = nodeListValues.some((lv) => valueMatch(listValue, lv));
          } else if (isObject(listValue)) {
            matchThis = nodeListValues.some((lv) => nodeMatch(state, listValue, lv, flags));
          }
        }
      } else if (isValueObject(thisFrame)) {
        matchThis = nodeValues.some((nv) => valueMatch(thisFrame, nv));
      } else if (isSubjectReference(thisFrame)) {
        matchThis = nodeValues.some((nv) => nodeMatch(state, thisFrame, nv, flags));
      } else if (isObject(thisFrame)) {
        matchThis = Arr.isReadonlyArrayNonEmpty(nodeValues);
      }
    }
    if (!matchThis && flags.requireAll) return decide(false);
    matchesSome = matchesSome || matchThis;
    return false;
  });
  return Option.getOrElse(decided, () => wildcard || matchesSome);
};

const nodeMatch = (state: State, pattern: JsonObject, value: Json, flags: Flags): boolean => {
  if (!isObject(value) || !hasOwn(value, '@id')) return false;
  const node = state.subjects[value['@id']];
  return node !== undefined && filterSubject(state, node, pattern, flags);
};

const lowerIfString = (s: Json) => (isString(s) ? s.toLowerCase() : s);

const valueMatch = (pattern: Json, value: Json): boolean => {
  if (!isObject(pattern)) return true;
  const v1 = value['@value'];
  const t1 = value['@type'];
  const l1 = value['@language'];
  const v2 = hasOwn(pattern, '@value') ? asArray(pattern['@value']) : [];
  const t2 = hasOwn(pattern, '@type') ? asArray(pattern['@type']) : [];
  const l2 = hasOwn(pattern, '@language') ? asArray(pattern['@language']) : [];
  if (Arr.isReadonlyArrayEmpty(v2) && Arr.isReadonlyArrayEmpty(t2) && Arr.isReadonlyArrayEmpty(l2))
    return true;
  if (!(v2.includes(v1) || isEmptyObject(v2[0]))) return false;
  if (
    !(
      (t1 === undefined && Arr.isReadonlyArrayEmpty(t2)) ||
      t2.includes(t1) ||
      (t1 !== undefined && isEmptyObject(t2[0]))
    )
  ) {
    return false;
  }
  if (
    !(
      (l1 === undefined && Arr.isReadonlyArrayEmpty(l2)) ||
      l2.map(lowerIfString).includes(lowerIfString(l1)) ||
      (l1 !== undefined && isEmptyObject(l2[0]))
    )
  ) {
    return false;
  }
  return true;
};

const cleanupPreserve = (
  input: Json,
  bnodesToClear: MutableHashSet.MutableHashSet<string>,
  seen: WeakSet<JsonObject>,
): Json => {
  if (Array.isArray(input)) return input.map((v) => cleanupPreserve(v, bnodesToClear, seen));
  if (isObject(input)) {
    if (hasOwn(input, '@preserve')) return input['@preserve'][0];
    if (isValueObject(input)) return input;
    if (isListObject(input)) {
      input['@list'] = cleanupPreserve(input['@list'], bnodesToClear, seen);
      return input;
    }
    if (seen.has(input)) return input;
    seen.add(input);
    Record.keys(input).forEach((prop) => {
      if (prop === '@id' && MutableHashSet.has(bnodesToClear, input[prop])) {
        delete input['@id'];
        return;
      }
      input[prop] = cleanupPreserve(input[prop], bnodesToClear, seen);
    });
  }
  return input;
};

/**
 * Replaces `@null` placeholders (from frame defaults) by `null`, dropping
 * them from arrays.
 *
 * @internal
 */
export const cleanupNull = (input: Json, seen: WeakSet<JsonObject> = new WeakSet()): Json => {
  if (Array.isArray(input)) {
    return input.map((v) => cleanupNull(v, seen)).filter((v) => v !== null);
  }
  if (input === '@null') return null;
  if (isObject(input)) {
    if (seen.has(input)) return input;
    seen.add(input);
    Record.keys(input).forEach((key) => {
      input[key] = cleanupNull(input[key], seen);
    });
  }
  return input;
};
