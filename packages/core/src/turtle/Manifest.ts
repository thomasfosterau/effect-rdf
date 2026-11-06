/**
 * A reader for W3C test-suite manifests (`manifest.ttl`) as used by the RDF,
 * SPARQL, SHACL, ShEx and JSON-LD test suites.
 *
 * Manifests are parsed with the Turtle parser. `load` follows `mf:include`
 * recursively; reading files is delegated to a caller-supplied function so
 * that the module stays platform independent.
 *
 * @example
 * ```ts
 * import * as fs from 'node:fs'
 * import { Effect } from 'effect'
 * import { Manifest } from '@thomasfosterau/effect-rdf/turtle'
 *
 * const entries = Manifest.load(
 *   'https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-turtle/manifest.ttl',
 *   Manifest.fileReader('https://w3c.github.io/rdf-tests/', '/path/to/rdf-tests/', (path) =>
 *     Effect.sync(() => fs.readFileSync(path, 'utf8')),
 *   ),
 * )
 * ```
 *
 * @since 0.1.0
 */
import * as Dataset from '../Dataset.ts';
import * as Namespace from '../Namespace.ts';
import type * as Serialization from '../Serialization.ts';
import * as Term from '../Term.ts';
import { rdf, rdfs } from '../Vocab.ts';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Turtle from './Turtle.ts';

/**
 * The W3C test manifest vocabulary.
 *
 * @since 0.1.0
 * @category vocabularies
 */
export const mf = Namespace.vocabulary(
  'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#',
  ['Manifest', 'entries', 'include', 'name', 'action', 'result', 'assumedTestBase'],
);

/**
 * The RDF test vocabulary.
 *
 * @since 0.1.0
 * @category vocabularies
 */
export const rdft = Namespace.make('http://www.w3.org/ns/rdftest#');

/**
 * A single test entry.
 *
 * @since 0.1.0
 * @category models
 */
export interface Entry {
  /** The test IRI (or blank node key). */
  readonly id: string;
  /** The test node itself, for reading further properties from `dataset`. */
  readonly node: Term.Subject;
  /** The IRI of the test's `rdf:type`. */
  readonly type: string;
  /** The local name of the test type, e.g. `TestTurtleEval`. */
  readonly kind: string;
  /** `mf:name` (falls back to the local name of the test IRI). */
  readonly name: string;
  /** `rdfs:comment`, if any. */
  readonly comment: Option.Option<string>;
  /** The `mf:action` IRI, if the action is an IRI. */
  readonly action: Option.Option<string>;
  /** The `mf:result` IRI, if the result is an IRI. */
  readonly result: Option.Option<string>;
  /** The IRI of the manifest that lists this entry. */
  readonly manifest: string;
  /** The parsed manifest document. */
  readonly dataset: Dataset.Dataset;
}

/**
 * A parsed manifest.
 *
 * @since 0.1.0
 * @category models
 */
export interface Manifest {
  readonly iri: string;
  readonly label: Option.Option<string>;
  readonly assumedTestBase: Option.Option<string>;
  readonly entries: ReadonlyArray<Entry>;
  readonly includes: ReadonlyArray<string>;
  readonly dataset: Dataset.Dataset;
}

const localName = (iri: string): string => iri.replace(/^.*[#/]/, '');

const iriOf = (term: Option.Option<Term.Object>): Option.Option<string> =>
  Option.flatMap(term, (t) => (Term.isNamedNode(t) ? Option.some(t.value) : Option.none()));

const stringOf = (term: Option.Option<Term.Object>): Option.Option<string> =>
  Option.flatMap(term, (t) => (Term.isLiteral(t) ? Option.some(t.value) : Option.none()));

/**
 * Parses a manifest document. `iri` is the manifest's own IRI, used as the
 * base IRI.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  text: string,
  iri: string,
): Effect.Effect<Manifest, Serialization.RdfParseError> =>
  Effect.map(Turtle.parse(text, { baseIri: iri }), ({ dataset }) => {
    const subjects = Dataset.subjectsOf(dataset, rdf.type, mf.Manifest);
    const manifest: Term.Subject =
      subjects.find((s) => Term.isNamedNode(s) && s.value === iri) ??
      subjects[0] ??
      Term.namedNode(iri);
    const listAt = (p: Term.NamedNode): ReadonlyArray<Term.Object> =>
      Dataset.objectsOf(dataset, manifest, p).flatMap((head) =>
        Option.getOrElse(Dataset.list(dataset, head), () => []),
      );
    const entries = listAt(mf.entries).flatMap((node): ReadonlyArray<Entry> => {
      if (!Term.isResource(node)) return [];
      const type = iriOf(Dataset.objectOf(dataset, node, rdf.type));
      const id = Term.isNamedNode(node) ? node.value : node.key;
      return [
        {
          id,
          node,
          type: Option.getOrElse(type, () => ''),
          kind: Option.match(type, { onNone: () => '', onSome: localName }),
          name: Option.getOrElse(stringOf(Dataset.objectOf(dataset, node, mf.name)), () =>
            localName(id),
          ),
          comment: stringOf(Dataset.objectOf(dataset, node, rdfs.comment)),
          action: iriOf(Dataset.objectOf(dataset, node, mf.action)),
          result: iriOf(Dataset.objectOf(dataset, node, mf.result)),
          manifest: iri,
          dataset,
        },
      ];
    });
    return {
      iri,
      label: stringOf(Dataset.objectOf(dataset, manifest, rdfs.label)),
      assumedTestBase: iriOf(Dataset.objectOf(dataset, manifest, mf.assumedTestBase)),
      entries,
      includes: listAt(mf.include).flatMap((t) => (Term.isNamedNode(t) ? [t.value] : [])),
      dataset,
    };
  });

/**
 * Loads a manifest and, recursively, every manifest it includes, returning
 * all entries (each manifest is read at most once).
 *
 * @since 0.1.0
 * @category loading
 */
export const load = <E, R>(
  iri: string,
  read: (iri: string) => Effect.Effect<string, E, R>,
): Effect.Effect<ReadonlyArray<Entry>, E | Serialization.RdfParseError, R> =>
  Effect.suspend(() => {
    const seen = MutableHashSet.empty<string>();
    const entries: Array<Entry> = [];
    // Breadth first: a manifest's entries, then those of each include in turn
    const visit = (
      queue: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<Entry>, E | Serialization.RdfParseError, R> => {
      if (!Arr.isReadonlyArrayNonEmpty(queue)) return Effect.succeed(entries);
      const [next, ...rest] = queue;
      if (MutableHashSet.has(seen, next)) return visit(rest);
      MutableHashSet.add(seen, next);
      return read(next).pipe(
        Effect.flatMap((text) => parse(text, next)),
        Effect.flatMap((manifest) => {
          entries.push(...manifest.entries);
          return visit([...rest, ...manifest.includes]);
        }),
      );
    };
    return visit([iri]);
  });

/**
 * Builds a `read` function for `load` that maps IRIs under `iriPrefix` to
 * paths under `pathPrefix` and reads them with `readFile`.
 *
 * @since 0.1.0
 * @category loading
 */
export const fileReader =
  <E, R>(
    iriPrefix: string,
    pathPrefix: string,
    readFile: (path: string) => Effect.Effect<string, E, R>,
  ) =>
  (iri: string): Effect.Effect<string, E, R> =>
    readFile(toPath(iri, iriPrefix, pathPrefix));

/**
 * Maps an IRI under `iriPrefix` to a path under `pathPrefix`.
 *
 * @since 0.1.0
 * @category loading
 */
export const toPath = (iri: string, iriPrefix: string, pathPrefix: string): string =>
  iri.startsWith(iriPrefix) ? pathPrefix + iri.slice(iriPrefix.length) : iri;
