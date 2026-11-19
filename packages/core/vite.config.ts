import { packageConfig } from '../../vite.package.ts';

const bench = (...files: ReadonlyArray<string>) => ({
  // Sequential, so one benchmark never competes with another for the CPU.
  command: files
    .map((file) => `node --experimental-strip-types --no-warnings bench/${file}.ts`)
    .join(' && '),
});

const sparql = ['sparql/results-text', 'sparql/parser', 'sparql/optional'];

export default packageConfig({
  // The SPARQL, N3 and SQL conformance suites run thousands of manifest
  // entries inside one test.
  testTimeout: 120_000,
  subpaths: [
    'csvw',
    'jsonld',
    'n3',
    'ntriples',
    'rdfjson',
    'rdfxml',
    'shacl',
    'shex',
    'sparql',
    'sparql/ai',
    'sparql/shacl',
    'sparql/sql',
    'turtle',
    'xmp',
  ],
  // Run by hand around a hot-path change; never in CI.
  tasks: {
    bench: bench('turtle/parser', 'n3/n3', 'rdfxml/xml', 'shex/shexc', ...sparql),
    'bench:turtle': bench('turtle/parser'),
    'bench:n3': bench('n3/n3'),
    'bench:n3js': bench('n3/n3js'),
    'bench:rdfxml': bench('rdfxml/xml'),
    'bench:shex': bench('shex/shexc'),
    'bench:sparql': bench(...sparql),
  },
});
