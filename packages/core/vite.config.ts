import { packageConfig } from '../../vite.package.ts';

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
});
