/**
 * Reads W3C test manifests (Turtle) into plain test case descriptions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Term } from '@thomasfosterau/effect-rdf';
import { parseRdf } from './rdf.ts';

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const QT = 'http://www.w3.org/2001/sw/DataAccess/tests/test-query#';
const UT = 'http://www.w3.org/2009/sparql/tests/test-update#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const DAWGT = 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#';

export const suitesDir =
  process.env.RDF_TEST_SUITES ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.test-suites');

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

type Node = Term.NamedNode | Term.BlankNode | Term.Literal;

class Graph {
  readonly bySubject = new Map<string, Array<Term.Quad>>();
  constructor(readonly quads: ReadonlyArray<Term.Quad>) {
    for (const q of quads) {
      const k = q.subject.key;
      let l = this.bySubject.get(k);
      if (l === undefined) this.bySubject.set(k, (l = []));
      l.push(q);
    }
  }
  objects(s: Term.Term, p: string): Array<Node> {
    return (this.bySubject.get(s.key) ?? [])
      .filter((q) => q.predicate.value === p)
      .map((q) => q.object as Node);
  }
  object(s: Term.Term, p: string): Node | undefined {
    return this.objects(s, p)[0];
  }
  list(head: Term.Term | undefined): Array<Node> {
    const out: Array<Node> = [];
    let node = head;
    while (node !== undefined && !(node._tag === 'NamedNode' && node.value === `${RDF}nil`)) {
      const first = this.object(node, `${RDF}first`);
      if (first !== undefined) out.push(first);
      node = this.object(node, `${RDF}rest`);
    }
    return out;
  }
}

const toPath = (t: Term.Term | undefined): string | undefined =>
  t !== undefined && t._tag === 'NamedNode' ? fileURLToPath(t.value) : undefined;

export const readManifest = (file: string): Array<TestCase> => {
  const base = pathToFileURL(file).href;
  const g = new Graph(parseRdf(fs.readFileSync(file, 'utf8'), base, 'ttl'));
  const out: Array<TestCase> = [];
  for (const q of g.quads.filter((q) => q.predicate.value === `${MF}include`)) {
    for (const inc of g.list(q.object)) {
      const p = toPath(inc);
      if (p !== undefined && fs.existsSync(p)) out.push(...readManifest(p));
    }
  }
  // Some manifests have no <> subject; find any mf:entries.
  const manifests = Array.from(g.quads)
    .filter((q) => q.predicate.value === `${MF}entries`)
    .map((q) => q.subject);
  for (const m of manifests) {
    for (const entry of g.list(g.object(m, `${MF}entries`))) {
      const type = g.object(entry, `${RDF}type`);
      const action = g.object(entry, `${MF}action`);
      const result = g.object(entry, `${MF}result`);
      let query: string | undefined;
      let data: Array<string> = [];
      let graphData: Array<GraphData> = [];
      let serviceData: Array<{ endpoint: string; data: Array<string> }> = [];
      const readGraphData = (n: Term.Term, p: string): Array<GraphData> =>
        g.objects(n, p).flatMap((gd) => {
          if (gd._tag === 'NamedNode') return [{ file: fileURLToPath(gd.value), name: gd.value }];
          const file = toPath(g.object(gd, `${UT}graph`));
          const label = g.object(gd, `${RDFS}label`);
          return file !== undefined ? [{ file, name: label?.value ?? '' }] : [];
        });
      if (action !== undefined) {
        if (action._tag === 'NamedNode') query = fileURLToPath(action.value);
        else {
          query =
            toPath(g.object(action, `${QT}query`)) ?? toPath(g.object(action, `${UT}request`));
          data = [...g.objects(action, `${QT}data`), ...g.objects(action, `${UT}data`)]
            .map((t) => toPath(t))
            .filter((x): x is string => x !== undefined);
          graphData = [
            ...readGraphData(action, `${QT}graphData`),
            ...readGraphData(action, `${UT}graphData`),
          ];
          serviceData = g.objects(action, `${QT}serviceData`).map((sd) => ({
            endpoint: g.object(sd, `${QT}endpoint`)?.value ?? '',
            data: g
              .objects(sd, `${QT}data`)
              .map((t) => toPath(t))
              .filter((x): x is string => x !== undefined),
          }));
        }
      }
      let resultFile: string | undefined;
      let resultData: Array<string> = [];
      let resultGraphData: Array<GraphData> = [];
      let updateSuccess = true;
      if (result !== undefined) {
        if (result._tag === 'NamedNode') resultFile = fileURLToPath(result.value);
        else {
          resultData = g
            .objects(result, `${UT}data`)
            .map((t) => toPath(t))
            .filter((x): x is string => x !== undefined);
          resultGraphData = readGraphData(result, `${UT}graphData`);
          const r = g.object(result, `${UT}result`);
          if (r !== undefined && r.value !== `${UT}success`) updateSuccess = false;
        }
      }
      out.push({
        id: entry.value,
        name: g.object(entry, `${MF}name`)?.value ?? entry.value,
        type: type?.value.replace(/.*#/, '') ?? '',
        approval: g.object(entry, `${DAWGT}approval`)?.value.replace(/.*#/, ''),
        manifest: file,
        query,
        data,
        graphData,
        serviceData,
        result: resultFile,
        resultData,
        resultGraphData,
        updateSuccess,
        requires: g.objects(entry, `${MF}requires`).map((t) => t.value.replace(/.*#/, '')),
        laxCardinality: g.object(entry, `${MF}resultCardinality`)?.value === `${MF}LaxCardinality`,
      });
    }
  }
  return out;
};
