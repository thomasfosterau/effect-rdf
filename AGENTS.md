# AGENTS.md

Project conventions for every coding agent live here. Claude Code reads it through `.claude/CLAUDE.md`, which imports this file, `CONTRIBUTING.md` and `README.md` and adds the Claude-only notes (hooks, plugins); each package's `CLAUDE.md` imports its `AGENTS.md` the same way. Personal style preferences live in user memory.

This repo publishes two packages: `@thomasfosterau/effect-rdf`, an Effect 4-native RDF 1.2 / RDF-star toolkit in one package — the data model, parsers and serialisers for every common syntax, a SPARQL 1.1 / 1.2 engine with a platform-neutral protocol server and client and a driver-agnostic SQL store, and SHACL and ShEx validation, one nested subpath per area — and `@thomasfosterau/effect-sparql-node`, the Node server, CLI and `HttpApi` definition over it. Everything is self-contained TypeScript checked against the W3C and community conformance suites; those suites are the behavioural spec.

| Package                              | Directory              | Subpaths                                                                                                                                                     | Depends on (workspace) |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `@thomasfosterau/effect-rdf`         | `packages/core`        | `/ntriples`, `/turtle`, `/n3`, `/jsonld`, `/rdfxml`, `/rdfjson`, `/xmp`, `/csvw`, `/shacl`, `/shex`, `/sparql`, `/sparql/shacl`, `/sparql/ai`, `/sparql/sql` | —                      |
| `@thomasfosterau/effect-sparql-node` | `packages/sparql-node` |                                                                                                                                                              | core                   |

Every module of a package is an entry point (`exports["./*"]` → `src/*.ts`; `src/index.ts` re-exports them as namespaces). A nested subpath is a directory `src/<subpath>/` (nested further for `sparql/shacl`, `sparql/ai`, `sparql/sql`) with its own `index.ts` barrel, exported as `./<subpath>` and `./<subpath>/*` (listed in the package's `vite.config.ts` `subpaths` and `.fallowrc.json`'s `entry`), and kept off the root barrel. Its tests are `test/<subpath>/`, its benchmarks `bench/<subpath>/`.

A new package adds a row here and in the root `README.md`, its own `AGENTS.md` (with a `CLAUDE.md` that is the one line `@AGENTS.md`) and `README.md`, a `.fallowrc.json` zone and rule, and its name in the `packages` list of the root `vite.config.ts`. A new SPARQL backend for a driver is such a package (`@thomasfosterau/effect-sparql-<driver>`, below), and its zone may import `core` only. A new subpath of effect-rdf adds its `exports` and `publishConfig.exports` entries, its name in `subpaths` in `packages/core/vite.config.ts`, its `entry` glob in `.fallowrc.json`, its place in `test/ModuleGraph.test.ts` (whether it may reach `@thomasfosterau/effect-parse`), a README section and its rules in `packages/core/AGENTS.md`.

**A SPARQL backend for a specific driver is its own package**, `@thomasfosterau/effect-sparql-<driver>` (e.g. `-sqlite-node`, `-pg`): a store layer over `@thomasfosterau/effect-rdf/sparql/sql` (`SqlStore.layer`, which also provides that driver's `SqlClient`), with the driver as its dependency or peer and its own effect floor catalog only if the driver forces one. None exists yet: `/sparql/sql` holds the dialects (SQLite, PostgreSQL), the store and the translation on `effect/sql` alone, and its tests use `@effect/sql-sqlite-node` and PGlite as effect-rdf devDependencies only, never runtime dependencies or peers.

## Common pitfalls

- **Never edit a version in a `package.json`.** Versions live in the `pnpm-workspace.yaml` catalog (`catalogMode: strict` rejects anything else; published peer ranges are `catalog:peers`). After editing it, run `pnpm install` and commit `pnpm-lock.yaml`, or CI fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read their catalog comments first.
- **Development `exports` point at `src/`, published ones at `dist/`.** A sibling package is consumed from source in tests and type checks (no build edge needed); `publishConfig.exports` swaps in `dist/*.mjs` / `*.d.mts` at publish. A new module is public the moment it lands in `src/` (not `src/internal/`), so it needs doc comments and a README entry.
- **`effect` is a peer, never a dependency.** Two copies break `Context` / `Layer` / `Schema` identity; the consumer owns the singleton. `@thomasfosterau/effect-parse` is an **optional** peer of effect-rdf, reached only from the syntax and SPARQL-parser subpaths: the root entry, the flat modules, `/rdfjson`, `/csvw`, `/shacl` and `/sparql/sql` must never import it, not even for a type (`packages/core/test/ModuleGraph.test.ts`). It is a required peer of effect-sparql-node. `@thomasfosterau/effect-xml` is the other **optional** peer of effect-rdf, reached only from the subpaths that read XML (`/rdfxml`, `/xmp`, `/sparql` and the subpaths on it; the same test), and a required peer of effect-sparql-node. `@thomasfosterau/effect-ext` is the third **optional** peer of effect-rdf, reached only from `/csvw` and only through its `./UriTemplate` entry (URI templates, `Link` headers, well-known URLs; never its root barrel; the same test); effect-sparql-node does not need it.
- **Conformance tests skip silently without the suites.** Run `./scripts/fetch-test-suites.sh` once (or set `RDF_TEST_SUITES`; in a git worktree, symlink the main checkout's `.test-suites`). A green run without them proves only the unit tests.
- **The root README's quick tour is a test.** `packages/core/test/sparql/readme-example.test.ts` holds the same code; change both together.
- **Dependabot groups only the lockstep sets** (`.github/dependabot.yml`: `toolchain` — vite-plus, vitest, `@vitest/*`, `@effect/tsgo`; `effect` — `effect` + `@effect/*`; everything else arrives as its own PR), with a 1-day `cooldown` (its smallest unit; pnpm's `minimumReleaseAge` is 480 minutes, 8 hours). By hand on the toolchain PR's branch: the npm-alias entries (`vite`, `typescript`, `@typescript/native`) and an `@effect/tsgo` that supports the new oxlint; the `overrides` and `catalogs.peers` are hand moves too (the file's header lists them).
- **CI is hardened for Dependabot PRs**: `permissions: {}` at the top with per-job grants, every action pinned to a commit SHA (`voidzero-dev/setup-vp` alone to an exact, immutable release tag), `persist-credentials: false` on every checkout (the Release workflow pushes through the GitHub API), no secrets or OIDC outside the Release job, which never runs for Dependabot. Every job gets Vite+, Node and pnpm from `voidzero-dev/setup-vp` (the composite `.github/actions/setup`): CI's Node is `node-version: lts`, the Release jobs' `22`, and the `vp` version is the catalog's `vite-plus` pin. `uvx zizmor --offline .github` audits the workflows (config in `.github/zizmor.yml`).
- **effect-rdf's type check is one large native `tsc` program** (every subpath's sources, tests and benchmarks). Run the type gate as `vp run --concurrency-limit 2 check`, so it never runs beside more than one other `tsc`.

Package-local invariants, terms and import boundaries live only in each package's `AGENTS.md` (`packages/<dir>/AGENTS.md`); read it before changing that package.

## Conventions

- **One module per concept** in `src/`; `src/index.ts` re-exports modules as namespaces (`export * as Turtle from './Turtle.ts'`). Private helpers go in `src/internal/`.
- **Every export has a doc comment** whose first sentence stands alone in a hover, with `@since 0.1.0` (the version it first shipped in) and `@category`.
- **Everything that needs only `effect` (and the optional `@thomasfosterau/effect-parse`, `@thomasfosterau/effect-xml` and, for `/csvw` only, `@thomasfosterau/effect-ext`) is a subpath of effect-rdf**, never a package of its own: the syntaxes, CSVW, SHACL, ShEx, SPARQL, its SHACL-SPARQL evaluator (`/sparql/shacl`, the implementation of `/shacl`'s extension point), its `effect/ai` tools (`/sparql/ai`) and the driver-agnostic SQL store (`/sparql/sql`). Inside the package, imports flow towards the data model: a subpath imports the root modules and the subpaths it builds on through relative paths, the root never imports a subpath, and the module graph is acyclic (fallow's `circular-dependencies`). A separate package is only for code that brings a dependency effect-rdf lacks, and depends on effect-rdf through its published subpaths: `effect-sparql-node` (`@effect/platform-node`, and the 4.1-only `HttpApi` form of `SparqlApi`), and the future `effect-sparql-<driver>` backends (their SQL driver). No third-party runtime dependencies beyond Effect's own packages; prefer self-contained Effect-native code.
- **Syntax subpaths** implement the core `Serialization` interfaces and export `format`, `parser`, `serializer`, `codec`, `parse` and `serialize`. Parsers fail with `Serialization.RdfParseError` (with `line` / `column`), serialisers with `RdfSerializeError`.
- **TypeScript 7** (native `tsc`, Effect-patched), `strict`, `exactOptionalPropertyTypes` (optional members are `?: T | undefined`), `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (sources run under Node's type stripping); relative imports carry the `.ts` extension.
- **Tests** live in `packages/<dir>/test/**/*.test.ts` (a subpath's in `test/<subpath>/`); effectful ones use `@effect/vitest` (`it.effect`), anything else imports from `vite-plus/test`, never `vitest`. Conformance tests read the suites from `process.env.RDF_TEST_SUITES ?? <repo>/.test-suites` with `describe.skipIf(!exists)`; manifests are read with `@thomasfosterau/effect-rdf/turtle` (`Manifest`) and graphs compared with `Isomorphism.isomorphic`. Aim for 100%: a deliberately skipped test is in a skip list with its reason, and the package README states the pass rates (a subpath's suite in `test/<subpath>/`, its rates in its section of the package README).
- **Formatting and linting** are Oxfmt / Oxlint (single quotes, semicolons, width 100) with the Effect presets (`@enfect/oxlint`'s `recommended` and `@effect/tsgo`'s) plus oxlint's `correctness`, `suspicious` and `perf` categories over the `typescript`, `unicorn`, `oxc`, `import`, `promise`, `jsdoc` and `vitest` plugins. `vp check` must report zero errors; the `warn`-tier allowances in `vite.config.ts` carry their adoption counts, and a new site is a defect, not headroom.

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. No pre-push hook: run the gates yourself.
- `./scripts/fetch-test-suites.sh` — shallow-clones the W3C / community conformance suites into `.test-suites` (git-ignored).
- `vp check` — format + lint (Oxfmt + Oxlint, type-aware through oxlint-tsgolint with `typeCheck` on). `vp run --concurrency-limit 2 check` — the type gate: every package's `src`, `test` and config under its `tsconfig.json`. They are different commands.
- `vp run --concurrency-limit 2 -r test:unit` — every package's unit and conformance tests (nothing needs a database or a credential: PostgreSQL runs as PGlite in-process).
- `vp run -r build` — `vp pack` → every package's `dist/`.
- `vp run check:dist` — the import guard: no built `dist/` imports `effect/unstable/*`. Run after the build.
- `vp run test:coverage` — every package's suite under one Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads for exact per-function CRAP scores.
- `vp run --filter ./packages/core bench` — every parser benchmark over the conformance suites; `bench:<subpath>` runs one (turtle, n3, rdfxml, shex, sparql).
- `pnpm changeset` — add a changeset.

Node and pnpm only — no npm, npx, yarn or bun. Invoke everything through `vp` (`vp exec` to run a dependency's binary; `vp run <task>` instead of bare `pnpm`). The sanctioned non-`vp` invocations: `pnpm install` (and `pnpm install --frozen-lockfile` in CI), `pnpm changeset` / `pnpm publish` on the release path, `pnpm audit`. Single-check variants are in [CONTRIBUTING.md](CONTRIBUTING.md#running-individual-checks).

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran.

1. From a clean install, which is what CI sees: `rm -rf node_modules packages/*/node_modules packages/*/dist && pnpm install --frozen-lockfile`.
2. `vp check`
3. `vp run --concurrency-limit 2 check`
4. `./scripts/fetch-test-suites.sh` (network), then `vp run --concurrency-limit 2 -r test:unit`
5. `vp run -r build`
6. `vp run check:dist`
7. `pnpm audit --audit-level high` (network)
8. `vp run test:coverage`, then `vp exec fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` (the fallow gate below; not a CI step). The PreToolUse fallow gate audits against `coverage/coverage-final.json`, regenerating it first when it is missing or older than a changed file under `packages/*/{src,test}` (a minute or more; run `test:coverage` yourself to keep the commit fast). The complexity and duplication already on `main` when fallow was adopted is recorded in `.fallow-baselines/` (`audit.healthBaseline` / `dupesBaseline`); the audit fails on what a change adds or worsens. Re-save a baseline only to shrink it.

Steps 2–7 are CI's required `ci` job, in its order ([ci.yml](.github/workflows/ci.yml)). `CONTRIBUTING.md` and the PR template link here rather than restating the list.

## Branches and pull requests

- Branch off `trunk` (the default branch); PR against `trunk`. Commit subjects name the package they change (`sparql: …`, `turtle: …`) or take a conventional prefix for workspace-wide work (`chore:`, `docs:`, `ci:`). Rebase onto `origin/trunk` before opening or updating a PR.
- Agent work uses git worktrees under `.claude/worktrees/`, one per branch. Start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing. A worktree needs its own `pnpm install` (the global `vp` delegates to the checkout's own `vite-plus`) and a `.test-suites` symlink.
- Every change to a published package's behaviour carries a changeset (`pnpm changeset`). Changes to doc comments that reach the emitted `.d.ts` take a `patch` changeset; other docs-only changes (READMEs, guidance), CI and tooling need none. Never publish or version by hand: the Release workflow opens the version PR (`chore: version packages`) and the owner merges it. Publishing is npm trusted publishing (OIDC) from the protected `release` environment; there is no `NPM_TOKEN` ([PUBLISHING.md](PUBLISHING.md)).
- GitHub writes go to `thomasfosterau/effect-rdf` only — never to `effect-parse`, upstream suites or the owner's other repositories without the owner's explicit approval in the current session. If another repo needs something, say so in the PR body.

## Work tracker

- Issues in `thomasfosterau/effect-rdf` are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO.
- The issue is the spec — read its comments; later comments override the body. Re-verify its code claims against current `trunk` before editing.
- Record decisions and findings as comments on the issue they were found working. Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence and stop.

## Effect

Read the installed package before writing Effect code — `node_modules/effect/dist/*.d.ts`, `node_modules/effect/src/`, and the `node_modules/effect/AGENTS.md` and `ai-docs/` it ships; never guess at an Effect API.

- Effect **4** — the pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published `effect` peer is `^4.0.0` (`catalogs.peers`), per package: raise a package's floor only when one of its own dependencies requires a newer `effect`, in a named catalog whose comment names that dependency (effect-sparql-node's `catalogs.platform-node-peers`, `^4.1.2`, forced by `@effect/platform-node`). effect-rdf's is `^4.0.0`: proved by running its `check` and `test:unit` with the dev pin at 4.0.0: everything passes except `packages/core/test/sparql/ai/McpClient.test.ts`, which needs `effect/ai`'s 4.1-only `McpTest` (the module it tests, `Mcp`, runs on 4.0). Keep any other 4.1-only test helper out of core's tests. Raising a floor is a breaking change for that package.
- Services: `class X extends Context.Service<X, XShape>()('@thomasfosterau/effect-<name>/X') {}` with `Layer`s (`layer`, `layerMemory`, …) and a plain `make` constructor.
- Errors: `Schema.TaggedError<E>()('Tag', { message: Schema.String, … })`; public fallible operations return `Effect` / `Stream` with typed errors.
- `Effect.fn` / `Effect.fnUntraced` for reusable effectful functions; pure helpers stay pure (and synchronous `…Result` variants return `Result`). Hot loops (parsers, evaluators, the dataset index) are plain code, not an Effect per step.
- `Option` instead of `undefined` in public return types where it reads well; `dual` APIs where natural; `Schema.decodeTo` + `SchemaTransformation` for schema transformations; HTTP is `effect/http/*`, SQL `effect/sql/*` (not `effect/unstable/*`, removed in rc.118).

## Documentation surfaces

`README.md` at the root is the landing page; each package `README.md` is the API reference consumers read on npm (with usage examples and a conformance summary); each package `AGENTS.md` carries its boundary, invariants and terms (it is not published); `CONTRIBUTING.md` carries human setup, CI expectations and single-check commands; `PUBLISHING.md` the release pipeline and its one-time owner setup; `SECURITY.md` the reporting channel, the untrusted-input defences and the supply-chain posture. No `docs/` tree is committed; decisions go in issue comments.

---

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to...                                     | Run                                          |
| ----------------------------------------------------------------- | -------------------------------------------- |
| delete an "unused" export or file                                 | `fallow dead-code --trace <file>:<export>`   |
| delete an "unused" dependency                                     | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR                                               | `fallow audit --base <ref>`                  |
| check which architecture rules apply to a file before changing it | `fallow guard <files>`                       |
| understand a finding                                              | `fallow explain <issue-type>`                |
