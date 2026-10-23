/**
 * Framing Algorithm (JSON-LD 1.1 Framing §4).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
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

interface State {
  readonly options: FrameOptions;
  readonly graphMap: NodeMap;
  readonly subjects: Record<string, JsonObject>;
  readonly graph: string;
  readonly embedded: boolean;
  readonly subjectStack: Array<{ subject: JsonObject; graph: string }>;
  readonly link: Record<string, Record<string, JsonObject>>;
  readonly bnodeMap: Record<string, Array<JsonObject>>;
  uniqueEmbeds: Record<string, Record<string, { parent: Json; property: string | null }>>;
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
    subjects: graphMap[graph]!,
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
    Arr.sort(Object.keys(state.subjects), compareStrings),
    asArray(expandedFrame),
    framed,
    null,
  );
  const bnodesToClear = options.is11
    ? new Set(Object.keys(state.bnodeMap).filter((id) => state.bnodeMap[id]!.length === 1))
    : new Set<string>();
  return cleanupPreserve(framed, bnodesToClear, new Set()) as Array<Json>;
};

const getFlag = (
  frame: JsonObject,
  options: FrameOptions,
  name: 'embed' | 'explicit' | 'omitDefault' | 'requireAll',
): any => {
  const flag = `@${name}`;
  let value: Json = hasOwn(frame, flag) ? asArray(frame[flag])[0] : options[name];
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

const validateFrame = (frame: Json): void => {
  if (!Array.isArray(frame) || frame.length !== 1 || !isObject(frame[0])) {
    fail('invalid frame', 'a frame must be a single object');
  }
  const f = frame[0];
  if (hasOwn(f, '@id')) {
    for (const id of asArray(f['@id'])) {
      if (!(isObject(id) || (isString(id) && isAbsoluteIri(id))) || isBlankNodeId(id)) {
        fail('invalid frame', `invalid @id ${stringifyJson(id)}`);
      }
    }
  }
  if (hasOwn(f, '@type')) {
    for (const type of asArray(f['@type'])) {
      if (
        !(isObject(type) || (isString(type) && isAbsoluteIri(type)) || type === '@json') ||
        isBlankNodeId(type)
      ) {
        fail('invalid frame', `invalid @type ${stringifyJson(type)}`);
      }
    }
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
): boolean => {
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i]!;
    if (entry.graph === graph && entry.subject['@id'] === subject['@id']) return true;
  }
  return false;
};

const addFrameOutput = (parent: Json, property: string | null, output: Json): void => {
  if (isObject(parent)) addValue(parent, property!, output, true);
  else (parent as Array<Json>).push(output);
};

const isSubjectReference = (v: Json): boolean =>
  isObject(v) && Object.keys(v).length === 1 && hasOwn(v, '@id');

const frameSubjects = (
  state: State,
  subjects: ReadonlyArray<string>,
  frameValue: Json,
  parent: Json,
  property: string | null,
): void => {
  validateFrame(frameValue);
  const frame: JsonObject = frameValue[0];
  const options = state.options;
  const flags: Flags = {
    embed: getFlag(frame, options, 'embed'),
    explicit: getFlag(frame, options, 'explicit'),
    requireAll: getFlag(frame, options, 'requireAll'),
  };
  if (!hasOwn(state.link, state.graph)) state.link[state.graph] = {};
  const link = state.link[state.graph]!;
  const matches = filterSubjects(state, subjects, frame, flags);
  const ids = Arr.sort(Object.keys(matches), compareStrings);
  for (const id of ids) {
    const subject = matches[id]!;
    if (property === null) state.uniqueEmbeds = { [state.graph]: {} };
    else state.uniqueEmbeds[state.graph] ??= {};
    const uniqueEmbeds = state.uniqueEmbeds[state.graph]!;
    const output: JsonObject = { '@id': id };
    if (isBlankNodeId(id)) addValue(state.bnodeMap, id, output, true);
    link[id] = output;
    if ((flags.embed === '@first' || flags.embed === '@last') && options.is11) {
      fail('invalid @embed value', flags.embed);
    }
    if (!state.embedded && hasOwn(uniqueEmbeds, id)) continue;
    if (
      state.embedded &&
      (flags.embed === '@never' ||
        createsCircularReference(subject, state.graph, state.subjectStack))
    ) {
      addFrameOutput(parent, property, output);
      continue;
    }
    if (
      state.embedded &&
      (flags.embed === '@first' || flags.embed === '@once') &&
      hasOwn(uniqueEmbeds, id)
    ) {
      addFrameOutput(parent, property, output);
      continue;
    }
    if (flags.embed === '@last' && hasOwn(uniqueEmbeds, id)) removeEmbed(state, id);
    uniqueEmbeds[id] = { parent, property };
    state.subjectStack.push({ subject, graph: state.graph });
    // the subject is also the name of a graph
    if (hasOwn(state.graphMap, id)) {
      let recurse: boolean;
      let subframe: Json;
      if (!hasOwn(frame, '@graph')) {
        recurse = state.graph !== '@merged';
        subframe = {};
      } else {
        subframe = asArray(frame['@graph'])[0];
        recurse = !(id === '@merged' || id === '@default');
        if (!isObject(subframe)) subframe = {};
      }
      if (recurse) {
        frameSubjects(
          { ...state, graph: id, subjects: state.graphMap[id]!, embedded: false },
          Arr.sort(Object.keys(state.graphMap[id]!), compareStrings),
          [subframe],
          output,
          '@graph',
        );
      }
    }
    if (hasOwn(frame, '@included')) {
      frameSubjects(
        { ...state, embedded: false },
        subjects,
        frame['@included'],
        output,
        '@included',
      );
    }
    for (const prop of Arr.sort(Object.keys(subject), compareStrings)) {
      if (isKeyword(prop)) {
        output[prop] = clone(subject[prop]);
        if (prop === '@type') {
          for (const type of subject['@type']) {
            if (isBlankNodeId(type)) addValue(state.bnodeMap, type, output, true);
          }
        }
        continue;
      }
      if (flags.explicit && !hasOwn(frame, prop)) continue;
      for (const o of subject[prop] as Array<Json>) {
        const subframe = hasOwn(frame, prop) ? frame[prop] : createImplicitFrame(flags);
        if (isListObject(o)) {
          const first = hasOwn(frame, prop) ? asArray(frame[prop])[0] : undefined;
          const listFrame =
            isObject(first) && hasOwn(first, '@list') ? first['@list'] : createImplicitFrame(flags);
          const list: JsonObject = { '@list': [] };
          addFrameOutput(output, prop, list);
          for (const oo of o['@list']) {
            if (isSubjectReference(oo)) {
              frameSubjects({ ...state, embedded: true }, [oo['@id']], listFrame, list, '@list');
            } else {
              addFrameOutput(list, '@list', clone(oo));
            }
          }
        } else if (isSubjectReference(o)) {
          frameSubjects({ ...state, embedded: true }, [o['@id']], subframe, output, prop);
        } else if (valueMatch(asArray(subframe)[0], o)) {
          addFrameOutput(output, prop, clone(o));
        }
      }
    }
    // defaults
    for (const prop of Arr.sort(Object.keys(frame), compareStrings)) {
      if (prop === '@type') {
        const first = asArray(frame[prop])[0];
        if (!isObject(first) || !hasOwn(first, '@default')) continue;
      } else if (isKeyword(prop)) {
        continue;
      }
      const next: JsonObject = asArray(frame[prop])[0] ?? {};
      const omitDefaultOn = getFlag(next, options, 'omitDefault');
      if (!omitDefaultOn && !hasOwn(output, prop)) {
        let preserve: Json = '@null';
        if (hasOwn(next, '@default')) preserve = clone(next['@default']);
        output[prop] = [{ '@preserve': asArray(preserve) }];
      }
    }
    // reverse properties
    if (isObject(frame['@reverse'])) {
      for (const reverseProp of Arr.sort(Object.keys(frame['@reverse']), compareStrings)) {
        const subframe = frame['@reverse'][reverseProp];
        for (const s of Object.keys(state.subjects)) {
          const values = asArray(state.subjects[s]![reverseProp] ?? []);
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
        }
      }
    }
    addFrameOutput(parent, property, output);
    state.subjectStack.pop();
  }
};

const removeEmbed = (state: State, id: string): void => {
  const embeds = state.uniqueEmbeds[state.graph]!;
  const embed = embeds[id]!;
  const parent = embed.parent;
  const property = embed.property;
  const subject = { '@id': id };
  if (Array.isArray(parent)) {
    for (let i = 0; i < parent.length; i++) {
      if (isObject(parent[i]) && parent[i]['@id'] === id) parent[i] = subject;
    }
  } else if (isObject(parent) && property !== null) {
    const values = asArray(parent[property]);
    parent[property] = values.map((v: Json) => (isObject(v) && v['@id'] === id ? subject : v));
  }
  const removeDependents = (id: string): void => {
    for (const next of Object.keys(embeds)) {
      const e = embeds[next]!;
      if (isObject(e.parent) && e.parent['@id'] === id) {
        delete embeds[next];
        removeDependents(next);
      }
    }
  };
  removeDependents(id);
};

const filterSubjects = (
  state: State,
  subjects: ReadonlyArray<string>,
  frame: JsonObject,
  flags: Flags,
) => {
  const result: Record<string, JsonObject> = {};
  for (const id of subjects) {
    const subject = state.graphMap[state.graph]![id];
    if (subject !== undefined && filterSubject(state, subject, frame, flags)) result[id] = subject;
  }
  return result;
};

const filterSubject = (
  state: State,
  subject: JsonObject,
  frame: JsonObject,
  flags: Flags,
): boolean => {
  let wildcard = true;
  let matchesSome = false;
  for (const key of Object.keys(frame)) {
    let matchThis = false;
    const nodeValues = hasOwn(subject, key) ? asArray(subject[key]) : [];
    const frameValues = asArray(frame[key]);
    const isEmpty = frameValues.length === 0;
    if (key === '@id') {
      if (frameValues.length === 0 || isObject(frameValues[0])) matchThis = true;
      else matchThis = frameValues.includes(nodeValues[0]);
      if (!flags.requireAll) return matchThis;
    } else if (key === '@type') {
      wildcard = false;
      if (isEmpty) {
        if (nodeValues.length > 0) return false;
        matchThis = true;
      } else if (frameValues.length === 1 && isEmptyObject(frameValues[0])) {
        matchThis = nodeValues.length > 0;
      } else {
        for (const type of frameValues) {
          if (isObject(type) && hasOwn(type, '@default')) matchThis = true;
          else matchThis = matchThis || nodeValues.some((t) => t === type);
        }
        if (!flags.requireAll) return matchThis;
      }
    } else if (isKeyword(key)) {
      continue;
    } else {
      const thisFrame = frameValues[0];
      let hasDefault = false;
      if (thisFrame !== undefined) {
        validateFrame([thisFrame]);
        hasDefault = hasOwn(thisFrame, '@default');
      }
      wildcard = false;
      if (nodeValues.length === 0 && hasDefault) continue;
      if (nodeValues.length > 0 && isEmpty) return false;
      if (thisFrame === undefined) {
        if (nodeValues.length > 0) return false;
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
        matchThis = nodeValues.length > 0;
      }
    }
    if (!matchThis && flags.requireAll) return false;
    matchesSome = matchesSome || matchThis;
  }
  return wildcard || matchesSome;
};

const nodeMatch = (state: State, pattern: JsonObject, value: Json, flags: Flags): boolean => {
  if (!isObject(value) || !hasOwn(value, '@id')) return false;
  const node = state.subjects[value['@id']];
  return node !== undefined && filterSubject(state, node, pattern, flags);
};

const valueMatch = (pattern: Json, value: Json): boolean => {
  if (!isObject(pattern)) return true;
  const v1 = value['@value'];
  const t1 = value['@type'];
  const l1 = value['@language'];
  const v2 = hasOwn(pattern, '@value') ? asArray(pattern['@value']) : [];
  const t2 = hasOwn(pattern, '@type') ? asArray(pattern['@type']) : [];
  const l2 = hasOwn(pattern, '@language') ? asArray(pattern['@language']) : [];
  if (v2.length === 0 && t2.length === 0 && l2.length === 0) return true;
  if (!(v2.includes(v1) || isEmptyObject(v2[0]))) return false;
  if (
    !(
      (t1 === undefined && t2.length === 0) ||
      t2.includes(t1) ||
      (t1 !== undefined && isEmptyObject(t2[0]))
    )
  ) {
    return false;
  }
  const lower = (s: Json) => (isString(s) ? s.toLowerCase() : s);
  if (
    !(
      (l1 === undefined && l2.length === 0) ||
      l2.map(lower).includes(lower(l1)) ||
      (l1 !== undefined && isEmptyObject(l2[0]))
    )
  ) {
    return false;
  }
  return true;
};

const cleanupPreserve = (
  input: Json,
  bnodesToClear: ReadonlySet<string>,
  seen: Set<Json>,
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
    for (const prop of Object.keys(input)) {
      if (prop === '@id' && bnodesToClear.has(input[prop])) {
        delete input['@id'];
        continue;
      }
      input[prop] = cleanupPreserve(input[prop], bnodesToClear, seen);
    }
  }
  return input;
};

/**
 * Replaces `@null` placeholders (from frame defaults) by `null`, dropping
 * them from arrays.
 *
 * @internal
 */
export const cleanupNull = (input: Json, seen: Set<Json> = new Set()): Json => {
  if (Array.isArray(input)) {
    return input.map((v) => cleanupNull(v, seen)).filter((v) => v !== null);
  }
  if (input === '@null') return null;
  if (isObject(input)) {
    if (seen.has(input)) return input;
    seen.add(input);
    for (const key of Object.keys(input)) input[key] = cleanupNull(input[key], seen);
  }
  return input;
};
