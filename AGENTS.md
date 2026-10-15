# Repository conventions

Guidance for contributors and coding agents working on this monorepo.

## Layout

- pnpm workspace + Vite+ (`vp`); every package lives in `packages/<dir>` and is
  named `@thomasfosterau/effect-<name>` (the core package is
  `@thomasfosterau/effect-rdf` in `packages/core`).
- A package has `package.json` (`"type": "module"`,
  `"exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }`, the shared
  `publishConfig`, `"scripts": { "build": "vp pack" }`, `effect` as a
  `catalog:` peer and dev dependency, workspace packages as `workspace:*`),
  `vite.config.ts` and `tsconfig.json` shaped like core's (with
  `testTimeout: 60_000`), `src/`, `test/` and a `README.md` with usage
  examples and a conformance summary.
- One module per concept in `src/`; `src/index.ts` re-exports modules as
  namespaces (`export * as Turtle from './Turtle.ts'`). Private helpers go in
  `src/internal/`. Every export has JSDoc with `@since 0.1.0` and `@category`.
- Dependencies flow towards core: syntax packages and engines depend on
  `effect-rdf`; integrations that join two packages get their own package
  (e.g. `effect-shacl-sparql`) so that each package stays lean. Avoid
  third-party runtime dependencies; prefer self-contained Effect-native code.

## Effect 4 idioms

- Effect **4** (`effect` 4.x) — not v3. Check `node_modules/effect/ai-docs/`
  and `node_modules/effect/src/` before using an API.
- Services: `class X extends Context.Service<X, Shape>()('@thomasfosterau/effect-<name>/X') {}`
  with `Layer`s (`layer`, `layerMemory`, …) and a plain `make` constructor.
- Errors: `Schema.TaggedError<E>()('Tag', { message: Schema.String, … })`;
  public fallible operations return `Effect` / `Stream` with typed errors.
  Parsers fail with `Serialization.RdfParseError` (with `line` / `column`),
  serialisers with `RdfSerializeError`.
- `Effect.fn` / `Effect.fnUntraced` for reusable effectful functions; pure
  helpers stay pure (and synchronous `…Result` variants return `Result`).
  Hot loops (parsers, evaluators) are plain code, not an Effect per step.
- `Option` instead of `undefined` in public return types where it reads well;
  `dual` APIs where natural; `Schema.decodeTo` + `SchemaTransformation` for
  schema transformations; HTTP is `effect/http/*`, SQL `effect/sql/*`.
- Syntax packages implement the core `Serialization` interfaces and export
  `format`, `parser`, `serializer`, `codec`, `parse` and `serialize`.

## TypeScript and style

- TypeScript 7, `strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`; relative imports use
  the `.ts` extension.
- Formatting and linting are oxfmt / oxlint via `vp check` (single quotes,
  semicolons, width 100). `vp check` must report zero errors and warnings.

## Tests and conformance

- Unit tests in `packages/<dir>/test/*.test.ts` with `@effect/vitest`
  (`it.effect` for effectful tests).
- Conformance tests read the suites from
  `process.env.RDF_TEST_SUITES ?? <repo>/.test-suites` (fetched by
  `./scripts/fetch-test-suites.sh`; in a git worktree, symlink the main
  checkout's `.test-suites`) and use `describe.skipIf(!exists)` so they pass
  when the suites are absent. Manifests are read with
  `@thomasfosterau/effect-turtle` (`Manifest`); graphs are compared with
  `Isomorphism.isomorphic`.
- Aim for 100%: deliberately skipped tests are listed in a skip list with a
  reason, and package READMEs state the pass rates.
- Code shown in the root README is kept in a test
  (`packages/shacl-sparql/test/readme-example.test.ts`) so it type-checks and
  runs.

## Before committing

Run `vp check` and `vp test` (from the root, or in the package you changed)
and `vp run -r build` when exports change. Do not commit `.test-suites`,
`node_modules` or `dist`.
