/**
 * The module graph of the published entry points, walked statically over
 * `src/`: `@thomasfosterau/effect-parse` is an optional peer of effect-rdf,
 * reached only from the syntax and SPARQL-parser subpaths, so the root entry
 * and the subpaths that parse nothing (`/csvw`, `/rdfjson`, `/shacl`,
 * `/sparql/sql` and every flat module) must never import it, not even for a
 * type. The root barrel also
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

const reachesParse = (entry: string) =>
  walk(entry).bare.some((spec) => spec.startsWith('@thomasfosterau/effect-parse'));

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
  'rdfxml',
  'shex',
  'sparql',
  'sparql/ai',
  'sparql/shacl',
  'turtle',
  'xmp',
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

  it('the root entry re-exports no nested subpath', () => {
    const nested = walk('index.ts')
      .files.map((file) => path.relative(src, file))
      .filter((file) => file.includes('/') && !file.startsWith('internal/'));
    expect(nested).toEqual([]);
  });

  it('no module imports a Node platform package or a SQL driver', () => {
    const entries = [...flatModules, ...parsing.map((subpath) => `${subpath}/index.ts`)];
    const bare = Arr.dedupe(entries.flatMap((entry) => walk(entry).bare));
    expect(
      bare.filter((spec) => /^@effect\/(platform-|sql-)/.test(spec) || spec === 'node:http'),
    ).toEqual([]);
  });
});
