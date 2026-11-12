/**
 * The module graph of the published entry points, walked statically over
 * `src/`: `@thomasfosterau/effect-parse` is an optional peer of effect-rdf,
 * reached only from the syntax and SPARQL-parser subpaths, so the root entry
 * and the subpaths that parse nothing (`/csvw`, `/rdfjson`, `/shacl`,
 * `/sparql/sql` and every flat module) must never import it, not even for a
 * type. `@thomasfosterau/effect-xml`, the other optional peer, is reached
 * only from the subpaths that read XML: `/rdfxml`, `/xmp` (through
 * `/rdfxml`) and `/sparql` (SPARQL XML results and the RDF/XML codec) with
 * the subpaths built on it. effect-xml itself requires effect-parse, so
 * `/rdfxml` and `/xmp` need both installed though neither imports
 * effect-parse. `@thomasfosterau/effect-ext`, the third optional peer, is
 * reached only from `/csvw` (URI templates and metadata discovery), which
 * still reaches neither effect-parse nor effect-xml. The root barrel also
 * re-exports no nested subpath.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Arr from 'effect/Array';
import { describe, expect, it } from 'vite-plus/test';

const src = path.resolve(import.meta.dirname, '../src');
const specifier =
  /(?:^|[\s;}])(?:import|export)\b[^'"]*?\bfrom\s*'([^']+)'|\bimport\s*\(\s*'([^']+)'\s*\)/g;

/** The specifiers `file` imports or re-exports; doc-comment `@example` imports do not count. */
const specifiersOf = (file: string) =>
  Array.from(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n')
      .matchAll(specifier),
    (match) => match[1] ?? match[2] ?? '',
  );

const isRelative = (spec: string) => spec.startsWith('.');

/** Every source file reachable from `entry` and every bare specifier they import. */
const walk = (entry: string) => {
  const visit = (file: string, seen: ReadonlyArray<string>): ReadonlyArray<string> =>
    seen.includes(file)
      ? seen
      : specifiersOf(file)
          .filter(isRelative)
          .map((spec) => path.resolve(path.dirname(file), spec))
          .reduce<ReadonlyArray<string>>((acc, next) => visit(next, acc), [...seen, file]);
  const files = visit(path.join(src, entry), []);
  const bare = Arr.dedupe(
    files.flatMap((file) => specifiersOf(file).filter((spec) => !isRelative(spec))),
  );
  return { files, bare };
};

const reaches = (entry: string, peer: string) =>
  walk(entry).bare.some((spec) => spec === peer || spec.startsWith(`${peer}/`));
const reachesParse = (entry: string) => reaches(entry, '@thomasfosterau/effect-parse');
const reachesXml = (entry: string) => reaches(entry, '@thomasfosterau/effect-xml');

const reachesExt = (entry: string) => reaches(entry, '@thomasfosterau/effect-ext');

const flatModules = fs.readdirSync(src).filter((name) => name.endsWith('.ts'));
const subpathModules = (subpath: string) =>
  fs
    .readdirSync(path.join(src, subpath))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `${subpath}/${name}`);

const parseFree = [
  ...flatModules,
  ...['csvw', 'rdfjson', 'shacl', 'sparql/sql'].flatMap(subpathModules),
];
const parsing = [
  'jsonld',
  'n3',
  'ntriples',
  'shex',
  'sparql',
  'sparql/ai',
  'sparql/shacl',
  'turtle',
];
const readingXml = ['rdfxml', 'sparql', 'sparql/ai', 'sparql/shacl', 'xmp'];
const subpaths = Arr.dedupe([...parsing, ...readingXml]);
const xmlFree = [
  ...flatModules,
  ...['csvw', 'rdfjson', 'shacl', 'sparql/sql'].flatMap(subpathModules),
  ...subpaths.filter((subpath) => !readingXml.includes(subpath)).map((s) => `${s}/index.ts`),
];

// Every entry but `/csvw`'s modules.
const extFree = [
  ...flatModules,
  ...['rdfjson', 'shacl', 'sparql/sql'].flatMap(subpathModules),
  ...subpaths.map((subpath) => `${subpath}/index.ts`),
];

describe('module graph', () => {
  it.each(parseFree)('%s never imports @thomasfosterau/effect-parse', (entry) => {
    expect(reachesParse(entry)).toBe(false);
  });

  // Documents which subpaths need the optional peer, so a change that drops
  // (or adds) the need is a visible edit here.
  it.each(parsing)('/%s reaches @thomasfosterau/effect-parse', (subpath) => {
    expect(reachesParse(`${subpath}/index.ts`)).toBe(true);
  });

  // `/rdfxml` and `/xmp` read XML through effect-xml only; effect-parse
  // reaches them as effect-xml's own (required) peer.
  it.each(['rdfxml', 'xmp'])('/%s imports effect-parse only through effect-xml', (subpath) => {
    expect(reachesParse(`${subpath}/index.ts`)).toBe(false);
  });

  it.each(xmlFree)('%s never imports @thomasfosterau/effect-xml', (entry) => {
    expect(reachesXml(entry)).toBe(false);
  });

  it.each(readingXml)('/%s reaches @thomasfosterau/effect-xml', (subpath) => {
    expect(reachesXml(`${subpath}/index.ts`)).toBe(true);
  });

  it.each(extFree)('%s never imports @thomasfosterau/effect-ext', (entry) => {
    expect(reachesExt(entry)).toBe(false);
  });

  // `/csvw` reads URI templates, `Link` headers and well-known URLs through
  // effect-ext's `./UriTemplate` entry only, never its root barrel.
  it('/csvw reaches @thomasfosterau/effect-ext through ./UriTemplate only', () => {
    const { bare } = walk('csvw/index.ts');
    expect(bare.filter((spec) => spec.startsWith('@thomasfosterau/effect-ext'))).toEqual([
      '@thomasfosterau/effect-ext/UriTemplate',
    ]);
  });

  it('/csvw reaches neither effect-parse nor effect-xml', () => {
    expect(reachesParse('csvw/index.ts')).toBe(false);
    expect(reachesXml('csvw/index.ts')).toBe(false);
  });

  it('the root entry re-exports no nested subpath', () => {
    const nested = walk('index.ts')
      .files.map((file) => path.relative(src, file))
      .filter((file) => file.includes('/') && !file.startsWith('internal/'));
    expect(nested).toEqual([]);
  });

  it('no module imports a Node platform package or a SQL driver', () => {
    const entries = [...flatModules, ...subpaths.map((subpath) => `${subpath}/index.ts`)];
    const bare = Arr.dedupe(entries.flatMap((entry) => walk(entry).bare));
    expect(
      bare.filter((spec) => /^@effect\/(platform-|sql-)/.test(spec) || spec === 'node:http'),
    ).toEqual([]);
  });
});
