# Contributing

Read the [README](../README.md) first. Agents should also read [AGENTS.md](../AGENTS.md).

## Workflow

- Branch off `trunk` and open a pull request into `trunk`; never commit to `trunk` directly. Open a draft PR as soon as you start, so others can see the work.
- One PR per change, however large. It is your job to get it green, reviewed and free of conflicts. Rebase onto `origin/trunk` rather than merging `trunk` in; PRs are squash-merged with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`) or the package area (`sparql:`, `turtle:`).
- Found something out of scope? File an issue and carry on. Keep issue bodies evergreen: edit the body with context, findings and the chosen fix rather than appending comments.
- Dependabot keeps dependencies current. Update one by hand only when your change needs it or Dependabot can't (see [Dependencies](#dependencies)).

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node, pnpm and the tools: `vp exec <bin>` instead of `npx`, `vp run <task>` for the tasks in `vite.config.ts`. `vp install` installs dependencies, the git hooks and the `prepare` step that patches the native `tsc` / oxlint with `@effect/tsgo`. The pre-commit hook runs `vp staged` (format and lint the staged files), then `vp run fallow:audit`.

| Command                                     | What it does                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `./scripts/fetch-test-suites.sh`            | Clones the W3C and community conformance suites into `.test-suites/` (or `$RDF_TEST_SUITES`); without them the conformance tests skip |
| `vp check`                                  | Format and lint (type-aware, with the Effect presets)                                                                                 |
| `vp run --concurrency-limit 2 check`        | The type gate: the Effect-patched native `tsc` per package                                                                            |
| `vp run --concurrency-limit 2 -r test:unit` | Unit and conformance tests; `vp test run test/<file>` from a package for one file                                                     |
| `vp run -r build` / `vp run check:dist`     | `vp pack` to `dist/`; no `effect/unstable/*` imports in it                                                                            |
| `vp run ci`                                 | Everything CI runs, in order, stopping at the first failure                                                                           |
| `vp run --filter ./packages/core bench`     | Benchmarks (`bench:turtle`, `bench:sparql`, …); never in CI                                                                           |

The type gate and suites are large; keep them to two packages at a time (`--concurrency-limit 2`), as above.

[Fallow](https://docs.fallow.tools) finds dead code, duplication and complexity. `vp run fallow:audit` (run by the pre-commit hook, after `vp run test:coverage`) fails on findings your change introduces; inherited ones are baselined in `.fallow-baselines/`, re-saved only to shrink. Treat it as guidance, not dogma; CI doesn't run it. Trace before deleting "unused" code: `vp exec fallow dead-code --trace <file>:<export>`.

### Dependencies

Every version lives in the `pnpm-workspace.yaml` catalog; `package.json` files use `catalog:`, `catalog:peers` or `workspace:*`. After editing it, run `vp install` and commit `pnpm-lock.yaml`. Dependabot can't do these, so make them in a PR from a new branch started from its head (never push to a `dependabot/*` branch, which stops it rebasing), and it closes its own PR once yours merges:

- `vite` (an npm alias) equals the `vite-plus` version, and `vitest` / `@vitest/coverage-istanbul` equal vite-plus's vitest.
- `@effect/tsgo`, `@typescript/native` (an npm alias) and vite-plus's oxlint must be a combination the `components` table in `node_modules/@effect/tsgo/dist/effect-tsgo.cjs` supports, or `vp install` fails.
- `catalogs.peers` holds the published peer ranges; raising one is a breaking change.

## Coding guidelines

- **Effect.** Use Effect v4 idioms throughout and prefer Effect's own modules (`Option`, `Array`, `Match`, `Schema`, `Config`, `effect/http`, …) to hand-rolled equivalents; convert existing code where practical. Exceptions: non-Effect APIs (adapt them at the edge) and hot paths (parsers, evaluators, the dataset index) where a measurement shows plain code is needed. Read `node_modules/effect` rather than guessing an API. Non-idiomatic code you can't fix trivially gets an issue listing the sites and the replacement.
- **Exports.** Follow Effect's layout: one PascalCase module per concept, re-exported as a namespace from `index.ts` (`export * as Turtle from './Turtle.ts'`) and importable through its own subpath (`./Turtle`, `./turtle/Turtle`). Format and engine families are lowercase nested subpaths (`./turtle`, `./sparql/sql`) with their own `index.ts`. Private code goes in `internal/`.
- **Errors** are `Schema.TaggedError` classes; services are `Context.Service` classes with `layer`s.
- **TypeScript**: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`; relative imports carry `.ts`.
- **Lint** findings are fixed, not suppressed. A rule is turned off only in `vite.config.ts`, scoped to the files where it cannot apply, with its reason.
- **Comments.** A file-level comment only when it adds non-obvious context (under 50 words). Doc comments on exports where they help someone reading IntelliSense, with `@since` and `@category`. Inline comments only for what the code can't say: workarounds, performance, non-obvious decisions. Never reference issues, PRs or CI runs; stable links to external specifications are fine.
- **Tests** live in `packages/<name>/test/` (a subpath's in `test/<subpath>/`), import from `vite-plus/test`, and use `@effect/vitest` (`it.effect`) when effectful. Test logic, edge cases and regressions, not what the type system enforces. The conformance suites are the behavioural spec: a skipped test is listed with its reason. The examples in [guide.md](guide.md) and `packages/core/docs/csvw.md` are run by tests; change both together.

## Before you push

Run `vp run ci`. For CI parity start clean: `rm -rf node_modules packages/*/node_modules packages/*/dist && vp install --frozen-lockfile`. Say in the PR body which gates couldn't run.

CI ([ci.yml](../.github/workflows/ci.yml)) runs `vp run ci` on Node `lts` and `latest`. Workflows pin actions by exact release tag, locked to commits by `.github/workflows/actions.lock`: run `gh actions-lock` after changing a `uses:`. `uvx zizmor --offline .github` audits the workflows.

## Changesets

Every change to a published package's behaviour or its emitted `.d.ts` (doc comments included, as a `patch`) needs a changeset: run `pnpm changeset` and commit the file with the change. Docs, CI and tooling changes need none. While on `0.x`, a breaking change is a `minor`. Never version or publish by hand: the Release workflow runs `vp run release` (`vp run release:dry-run` shows what it would publish); see [PUBLISHING.md](PUBLISHING.md).
