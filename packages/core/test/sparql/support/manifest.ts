/**
 * Reads W3C test manifests (Turtle) into plain test case descriptions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import { Term } from '@thomasfosterau/effect-rdf';
import { loop } from '../../../src/sparql/internal/loop.ts';
import { parseRdf } from './rdf.ts';

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const QT = 'http://www.w3.org/2001/sw/DataAccess/tests/test-query#';
const UT = 'http://www.w3.org/2009/sparql/tests/test-update#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const DAWGT = 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#';

export const suitesDir =
  process.env.RDF_TEST_SUITES ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../.test-suites');

export interface GraphData {
  readonly file: string;
  readonly name: string;
}

export interface TestCase {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly approval: string | undefined;
  readonly manifest: string;
  /** Query or update file. */
  readonly query: string | undefined;
  readonly data: ReadonlyArray<string>;
  readonly graphData: ReadonlyArray<GraphData>;
  readonly serviceData: ReadonlyArray<{ endpoint: string; data: ReadonlyArray<string> }>;
  readonly result: string | undefined;
  readonly resultData: ReadonlyArray<string>;
  readonly resultGraphData: ReadonlyArray<GraphData>;
  readonly updateSuccess: boolean;
  readonly requires: ReadonlyArray<string>;
  readonly laxCardinality: boolean;
}

/** The test's query or update file; fails the test when its manifest entry names none. */
export const queryFile = (t: TestCase): string =>
  t.query ?? assert.fail(`${t.id} has no query or update file`);

/** The test's expected-result file; fails the test when its manifest entry names none. */
export const expectedResultFile = (t: TestCase): string =>
  t.result ?? assert.fail(`${t.id} has no result file`);

type Node = Term.NamedNode | Term.BlankNode | Term.Literal;

const isNode = (t: Term.Term): t is Node =>
  Term.isNamedNode(t) || Term.isBlankNode(t) || Term.isLiteral(t);

const isNil = (t: Term.Term): boolean => Term.isNamedNode(t) && t.value === `${RDF}nil`;

class Graph {
  readonly bySubject = MutableHashMap.empty<string, Array<Term.Quad>>();
  readonly quads: ReadonlyArray<Term.Quad>;
  constructor(quads: ReadonlyArray<Term.Quad>) {
    this.quads = quads;
    quads.forEach((q) => {
      const k = q.subject.key;
      Option.match(MutableHashMap.get(this.bySubject, k), {
        onNone: () => MutableHashMap.set(this.bySubject, k, [q]),
        onSome: (l) => l.push(q),
      });
    });
  }
  objects(s: Term.Term, p: string): Array<Node> {
    // The manifest's objects are IRIs, blank nodes or literals (no triple terms).
    return Option.getOrElse(MutableHashMap.get(this.bySubject, s.key), () => [])
      .filter((q) => q.predicate.value === p)
      .map((q) => q.object)
      .filter(isNode);
  }
  object(s: Term.Term, p: string): Option.Option<Node> {
    return Arr.head(this.objects(s, p));
  }
  /** The members of an RDF list. */
  list(head: Option.Option<Term.Term>): Array<Node> {
    const out: Array<Node> = [];
    let node = Option.filter(head, (n) => !isNil(n));
    loop(() => {
      if (Option.isNone(node)) return false;
      const cell = node.value;
      Option.map(this.object(cell, `${RDF}first`), (first) => out.push(first));
      node = Option.filter(this.object(cell, `${RDF}rest`), (n) => !isNil(n));
      return true;
    });
    return out;
  }
}

const toPath = (t: Option.Option<Term.Term>): Option.Option<string> =>
  Option.flatMap(t, (n) =>
    Term.isNamedNode(n) ? Option.some(fileURLToPath(n.value)) : Option.none(),
  );

const paths = (nodes: ReadonlyArray<Term.Term>): Array<string> =>
  Arr.getSomes(nodes.map((n) => toPath(Option.some(n))));

/** The graph data of an action or result: a file IRI, or a node naming its graph. */
const readGraphData = (g: Graph, n: Term.Term, p: string): Array<GraphData> =>
  g.objects(n, p).flatMap((gd) => {
    if (Term.isNamedNode(gd)) return [{ file: fileURLToPath(gd.value), name: gd.value }];
    const name = Option.match(g.object(gd, `${RDFS}label`), {
      onNone: () => '',
      onSome: (l) => l.value,
    });
    return Arr.fromOption(
      Option.map(toPath(g.object(gd, `${UT}graph`)), (file) => ({ file, name })),
    );
  });

/** What a test entry's `mf:action` names: its query or update, data and service data. */
interface Action {
  readonly query: Option.Option<string>;
  readonly data: Array<string>;
  readonly graphData: Array<GraphData>;
  readonly serviceData: Array<{ endpoint: string; data: Array<string> }>;
}

const noAction: Action = { query: Option.none(), data: [], graphData: [], serviceData: [] };

const readAction = (g: Graph, action: Node): Action =>
  Term.isNamedNode(action)
    ? { ...noAction, query: Option.some(fileURLToPath(action.value)) }
    : {
        query: Option.orElse(toPath(g.object(action, `${QT}query`)), () =>
          toPath(g.object(action, `${UT}request`)),
        ),
        data: paths([...g.objects(action, `${QT}data`), ...g.objects(action, `${UT}data`)]),
        graphData: [
          ...readGraphData(g, action, `${QT}graphData`),
          ...readGraphData(g, action, `${UT}graphData`),
        ],
        serviceData: g.objects(action, `${QT}serviceData`).map((sd) => ({
          endpoint: Option.match(g.object(sd, `${QT}endpoint`), {
            onNone: () => '',
            onSome: (e) => e.value,
          }),
          data: paths(g.objects(sd, `${QT}data`)),
        })),
      };

/** What a test entry's `mf:result` names: its result file, or an update's expected data. */
interface Outcome {
  readonly result: Option.Option<string>;
  readonly resultData: Array<string>;
  readonly resultGraphData: Array<GraphData>;
  readonly updateSuccess: boolean;
}

const noOutcome: Outcome = {
  result: Option.none(),
  resultData: [],
  resultGraphData: [],
  updateSuccess: true,
};

const readOutcome = (g: Graph, result: Node): Outcome =>
  Term.isNamedNode(result)
    ? { ...noOutcome, result: Option.some(fileURLToPath(result.value)) }
    : {
        result: Option.none(),
        resultData: paths(g.objects(result, `${UT}data`)),
        resultGraphData: readGraphData(g, result, `${UT}graphData`),
        updateSuccess: !Option.exists(
          g.object(result, `${UT}result`),
          (r) => r.value !== `${UT}success`,
        ),
      };

const valueOf = (t: Option.Option<Node>): Option.Option<string> => Option.map(t, (n) => n.value);

export const readManifest = (file: string): Array<TestCase> => {
  const base = pathToFileURL(file).href;
  const g = new Graph(parseRdf(fs.readFileSync(file, 'utf8'), base, 'ttl'));
  const included = g.quads
    .filter((q) => q.predicate.value === `${MF}include`)
    .flatMap((q) => g.list(Option.some(q.object)))
    .flatMap((inc) =>
      Option.match(toPath(Option.some(inc)), {
        onNone: () => [],
        onSome: (p) => (fs.existsSync(p) ? readManifest(p) : []),
      }),
    );
  // Some manifests have no <> subject; find any mf:entries.
  const manifests = g.quads
    .filter((q) => q.predicate.value === `${MF}entries`)
    .map((q) => q.subject);
  const entries = manifests.flatMap((m) =>
    g.list(g.object(m, `${MF}entries`)).map((entry): TestCase => {
      const type = valueOf(g.object(entry, `${RDF}type`));
      const action = Option.match(g.object(entry, `${MF}action`), {
        onNone: () => noAction,
        onSome: (a) => readAction(g, a),
      });
      const outcome = Option.match(g.object(entry, `${MF}result`), {
        onNone: () => noOutcome,
        onSome: (r) => readOutcome(g, r),
      });
      return {
        id: entry.value,
        name: Option.getOrElse(valueOf(g.object(entry, `${MF}name`)), () => entry.value),
        type: Option.match(type, { onNone: () => '', onSome: (t) => t.replace(/.*#/, '') }),
        approval: Option.getOrUndefined(
          Option.map(valueOf(g.object(entry, `${DAWGT}approval`)), (a) => a.replace(/.*#/, '')),
        ),
        manifest: file,
        query: Option.getOrUndefined(action.query),
        data: action.data,
        graphData: action.graphData,
        serviceData: action.serviceData,
        result: Option.getOrUndefined(outcome.result),
        resultData: outcome.resultData,
        resultGraphData: outcome.resultGraphData,
        updateSuccess: outcome.updateSuccess,
        requires: g.objects(entry, `${MF}requires`).map((t) => t.value.replace(/.*#/, '')),
        laxCardinality: Option.exists(
          valueOf(g.object(entry, `${MF}resultCardinality`)),
          (c) => c === `${MF}LaxCardinality`,
        ),
      };
    }),
  );
  return [...included, ...entries];
};
