import { packageConfig } from '../../vite.package.ts';

// Private and source-less: no `build`; its coverage run measures the core
// subpaths these suites exercise.
export default packageConfig({
  published: false,
  coverageOf: ['../../packages/core/src/csvw/**/*.ts', '../../packages/core/src/shacl/**/*.ts'],
});
