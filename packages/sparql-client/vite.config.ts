import { packageConfig } from '../../vite.package.ts';

// `tsconfig.json` also covers `test/`, which imports the sparql package's test
// support files; declaring from it would emit stray .d.ts files there.
export default packageConfig({ packTsconfig: 'tsconfig.build.json' });
