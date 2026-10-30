# AGENTS.md

`CLAUDE.md` is a symlink to this file. Project conventions live here; personal style preferences live in user memory.

This repo publishes the `@thomasfosterau/effect-rdf` package family: an Effect 4-native RDF 1.2 / RDF-star toolkit — the data model, parsers and serialisers for every common syntax, a SPARQL 1.1 / 1.2 engine with storage, protocol server and client, and SHACL and ShEx validation. Every package is self-contained TypeScript checked against the W3C and community conformance suites; those suites are the behavioural spec.

| Package                                | Directory                | Depends on (workspace)                |
| -------------------------------------- | ------------------------ | ------------------------------------- |
| `@thomasfosterau/effect-rdf`           | `packages/core`          | —                                     |
| `@thomasfosterau/effect-ntriples`      | `packages/ntriples`      | core                                  |
| `@thomasfosterau/effect-turtle`        | `packages/turtle`        | core, ntriples                        |
| `@thomasfosterau/effect-n3`            | `packages/n3`            | core, turtle                          |
| `@thomasfosterau/effect-jsonld`        | `packages/jsonld`        | core                                  |
| `@thomasfosterau/effect-rdfxml`        | `packages/rdfxml`        | core                                  |
| `@thomasfosterau/effect-rdfjson`       | `packages/rdfjson`       | core                                  |
| `@thomasfosterau/effect-xmp`           | `packages/xmp`           | core, rdfxml                          |
| `@thomasfosterau/effect-sparql`        | `packages/sparql`        | core, rdfxml, turtle                  |
| `@thomasfosterau/effect-shacl`         | `packages/shacl`         | core                                  |
| `@thomasfosterau/effect-shacl-sparql`  | `packages/shacl-sparql`  | core, shacl, sparql                   |
| `@thomasfosterau/effect-shex`          | `packages/shex`          | core, turtle                          |
| `@thomasfosterau/effect-sparql-sql`    | `packages/sparql-sql`    | core, sparql                          |
| `@thomasfosterau/effect-sparql-server` | `packages/sparql-server` | core, sparql and every syntax package |
| `@thomasfosterau/effect-sparql-client` | `packages/sparql-client` | core, sparql and every syntax package |

Every module of a package is an entry point (`exports["./*"]` → `src/*.ts`; `src/index.ts` re-exports them as namespaces). Test-only workspace dependencies are `devDependencies`; `.fallowrc.json`'s boundary rules allow both.

A new package adds a row here and in the root `README.md`, its own `CLAUDE.md` and `README.md`, a `.fallowrc.json` zone and rule, and its name in the `packages` list of the root `vite.config.ts`.

## Common pitfalls

- **Never edit a version in a `package.json`.** Versions live in the `pnpm-workspace.yaml` catalog (`catalogMode: strict` rejects anything else; published peer ranges are `catalog:peers`). After editing it, run `pnpm install` and commit `pnpm-lock.yaml`, or CI fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read their catalog comments first.
- **Development `exports` point at `src/`, published ones at `dist/`.** A sibling package is consumed from source in tests and type checks (no build edge needed); `publishConfig.exports` swaps in `dist/*.mjs` / `*.d.mts` at publish. A new module is public the moment it lands in `src/` (not `src/internal/`), so it needs doc comments and a README entry.
- **`effect` is a peer, never a dependency.** Two copies break `Context` / `Layer` / `Schema` identity; the consumer owns the singleton. `@thomasfosterau/effect-parse` is a peer of the packages whose grammars use it.
- **Conformance tests skip silently without the suites.** Run `./scripts/fetch-test-suites.sh` once (or set `RDF_TEST_SUITES`; in a git worktree, symlink the main checkout's `.test-suites`). A green run without them proves only the unit tests.
- **The root README's quick tour is a test.** `packages/shacl-sparql/test/readme-example.test.ts` holds the same code; change both together.
- **Dependabot groups every lockstep set** (`.github/dependabot.yml`: `toolchain`, `effect`, `effect-parse`, `changesets`, `fallow`, `github-actions`), with a 1-day `cooldown` (its smallest unit; pnpm's `minimumReleaseAge` is 480 minutes, 8 hours). By hand on the toolchain PR's branch: the npm-alias entries (`vite`, `typescript`, `@typescript/native`) and an `@effect/tsgo` that supports the new oxlint; the `overrides` and `catalogs.peers` are hand moves too (the file's header lists them).
- **CI is hardened for Dependabot PRs**: `permissions: {}` at the top with per-job grants, every action pinned to a commit SHA, `persist-credentials: false` except in the Release job (which pushes), no secrets or OIDC outside the Release job, which never runs for Dependabot. `uvx zizmor --offline .github` audits the workflows (config in `.github/zizmor.yml`).
- **Fourteen native `tsc` processes exhaust memory.** Run the type gate as `vp run --concurrency-limit 2 check`.

Package-local invariants, terms and import boundaries live only in each package's `CLAUDE.md` (`packages/<dir>/CLAUDE.md`); read it before changing that package.

## Conventions

- **One module per concept** in `src/`; `src/index.ts` re-exports modules as namespaces (`export * as Turtle from './Turtle.ts'`). Private helpers go in `src/internal/`.
- **Every export has a doc comment** whose first sentence stands alone in a hover, with `@since 0.1.0` (the version it first shipped in) and `@category`.
- **Dependencies flow towards core**: syntax packages and engines depend on `effect-rdf`; an integration joining two packages gets its own package (e.g. `effect-shacl-sparql`) so each stays lean. No third-party runtime dependencies beyond Effect's own packages; prefer self-contained Effect-native code.
- **Syntax packages** implement the core `Serialization` interfaces and export `format`, `parser`, `serializer`, `codec`, `parse` and `serialize`. Parsers fail with `Serialization.RdfParseError` (with `line` / `column`), serialisers with `RdfSerializeError`.
- **TypeScript 7** (native `tsc`, Effect-patched), `strict`, `exactOptionalPropertyTypes` (optional members are `?: T | undefined`), `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (sources run under Node's type stripping); relative imports carry the `.ts` extension.
- **Tests** live in `packages/<dir>/test/*.test.ts`; effectful ones use `@effect/vitest` (`it.effect`), anything else imports from `vite-plus/test`, never `vitest`. Conformance tests read the suites from `process.env.RDF_TEST_SUITES ?? <repo>/.test-suites` with `describe.skipIf(!exists)`; manifests are read with `@thomasfosterau/effect-turtle` (`Manifest`) and graphs compared with `Isomorphism.isomorphic`. Aim for 100%: a deliberately skipped test is in a skip list with its reason, and the package README states the pass rates.
- **Formatting and linting** are Oxfmt / Oxlint (single quotes, semicolons, width 100) with the Effect presets (`@enfect/oxlint`'s `recommended` and `@effect/tsgo`'s) plus oxlint's `correctness`, `suspicious` and `perf` categories over the `typescript`, `unicorn`, `oxc`, `import`, `promise`, `jsdoc` and `vitest` plugins. `vp check` must report zero errors; the `warn`-tier allowances in `vite.config.ts` carry their adoption counts, and a new site is a defect, not headroom.

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. No pre-push hook: run the gates yourself.
- `./scripts/fetch-test-suites.sh` — shallow-clones the W3C / community conformance suites into `.test-suites` (git-ignored).
- `vp check` — format + lint (Oxfmt + Oxlint). `vp run --concurrency-limit 2 check` — the type gate: every package's `src`, `test` and config under its `tsconfig.json`. They are different commands.
- `vp run --concurrency-limit 2 -r test:unit` — every package's unit and conformance tests (nothing needs a database or a credential: PostgreSQL runs as PGlite in-process).
- `vp run -r build` — `vp pack` → every package's `dist/`.
- `vp run check:dist` — the import guard: no built `dist/` imports `effect/unstable/*`. Run after the build.
- `vp run test:coverage` — every package's suite under one Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads for exact per-function CRAP scores.
- `vp run --filter ./packages/<dir> bench` — a parser benchmark (turtle, n3, rdfxml, shex, sparql) over the conformance suites.
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
8. `vp run test:coverage`, then `fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` (the fallow gate below; not a CI step). The PreToolUse fallow gate audits against `coverage/coverage-final.json` and never refreshes it, so run `test:coverage` first. The complexity and duplication already on `main` when fallow was adopted is recorded in `.fallow-baselines/` (`audit.healthBaseline` / `dupesBaseline`); the audit fails on what a change adds or worsens. Re-save a baseline only to shrink it.

Steps 2–7 are CI's required `ci` job, in its order ([ci.yml](.github/workflows/ci.yml)). `CONTRIBUTING.md` and the PR template link here rather than restating the list.

## Branches and pull requests

- Branch off `trunk` (the default branch); PR against `trunk`. Commit subjects name the package they change (`sparql: …`, `turtle: …`) or take a conventional prefix for workspace-wide work (`chore:`, `docs:`, `ci:`). Rebase onto `origin/trunk` before opening or updating a PR.
- Agent work uses git worktrees under `.claude/worktrees/`, one per branch. Start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing. A worktree needs its own `pnpm install` (the `vp` shim re-execs the nearest `node_modules/vite-plus/bin/vp`) and a `.test-suites` symlink.
- Every change to a published package's behaviour carries a changeset (`pnpm changeset`). Changes to doc comments that reach the emitted `.d.ts` take a `patch` changeset; other docs-only changes (READMEs, guidance), CI and tooling need none. Never publish or version by hand: the Release workflow opens the version PR (`chore: version packages`) and the owner merges it. Publishing is npm trusted publishing (OIDC) from the protected `release` environment; there is no `NPM_TOKEN` ([PUBLISHING.md](PUBLISHING.md)).
- GitHub writes go to `thomasfosterau/effect-rdf` only — never to `effect-parse`, upstream suites or the owner's other repositories without the owner's explicit approval in the current session. If another repo needs something, say so in the PR body.

## Work tracker

- Issues in `thomasfosterau/effect-rdf` are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO.
- The issue is the spec — read its comments; later comments override the body. Re-verify its code claims against current `trunk` before editing.
- Record decisions and findings as comments on the issue they were found working. Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence and stop.

## Effect

Read the installed package before writing Effect code — `node_modules/effect/dist/*.d.ts`, `node_modules/effect/src/`, and the `node_modules/effect/AGENTS.md` and `ai-docs/` it ships; never guess at an Effect API.

- Effect **4** — the pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peer floor (`>=4.0.0-rc.118`) is under `catalogs.peers`. Raising the floor is a breaking change for every package.
- Services: `class X extends Context.Service<X, XShape>()('@thomasfosterau/effect-<name>/X') {}` with `Layer`s (`layer`, `layerMemory`, …) and a plain `make` constructor.
- Errors: `Schema.TaggedError<E>()('Tag', { message: Schema.String, … })`; public fallible operations return `Effect` / `Stream` with typed errors.
- `Effect.fn` / `Effect.fnUntraced` for reusable effectful functions; pure helpers stay pure (and synchronous `…Result` variants return `Result`). Hot loops (parsers, evaluators, the dataset index) are plain code, not an Effect per step.
- `Option` instead of `undefined` in public return types where it reads well; `dual` APIs where natural; `Schema.decodeTo` + `SchemaTransformation` for schema transformations; HTTP is `effect/http/*`, SQL `effect/sql/*` (not `effect/unstable/*`, removed in rc.118).

## Agent sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile and puts `vp` (a re-exec shim that prefers the nearest worktree's `node_modules`) and `fallow` on PATH for non-interactive shells. It hydrates no secrets (none are needed, and nothing here can publish) and does not fetch the conformance suites.
- `.claude/settings.json` should enable the `@enfect/claude` plugin (Effect guidance, skills and post-write pattern checks; marketplace `mpsuesser/enfect`, pinned by `ref` to a reviewed commit).
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` fails; it reads the coverage map on disk, so run `vp run test:coverage` first. A PostToolUse hook runs `vp fmt` on every source, JSON or Markdown file you write or edit.
- Every gate in [Verification](#verification) runs in an agent session; fetching the suites and `pnpm audit` need the network.

## Documentation surfaces

`README.md` at the root is the landing page; each package `README.md` is the API reference consumers read on npm (with usage examples and a conformance summary); each package `CLAUDE.md` carries its boundary, invariants and terms (it is not published); `CONTRIBUTING.md` carries human setup, CI expectations and single-check commands; `PUBLISHING.md` the release pipeline and its one-time owner setup; `SECURITY.md` the reporting channel, the untrusted-input defences and the supply-chain posture. No `docs/` tree is committed; decisions go in issue comments.

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
