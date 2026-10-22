# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions are in [AGENTS.md](AGENTS.md).

## Setup

Node 22.18 or later and pnpm 11 (Corepack or the version pinned by `packageManager`), then:

```sh
pnpm install                     # dependencies, git hooks, the @effect/tsgo patch
./scripts/fetch-test-suites.sh   # W3C / community conformance suites into .test-suites
```

The conformance tests skip when the suites are absent; set `RDF_TEST_SUITES` to use a copy elsewhere (in a git worktree, symlink the main checkout's `.test-suites`).

## Branches

Branch off `main`, rebase rather than merge, squash-merge with a conventional prefix: see [AGENTS.md](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one required job, `ci`, whose steps are the gate list in [AGENTS.md](AGENTS.md#verification). [release.yml](.github/workflows/release.yml) runs changesets/action on `main`: it opens the version PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [AGENTS.md](AGENTS.md#branches-and-pull-requests) requires one.
3. `git fetch origin main && git rebase origin/main`
4. Docs: the package `README.md` for any exported change or conformance-rate change; the package `CLAUDE.md` for a new term or invariant.

## Running individual checks

```sh
vp lint                                       # oxlint
vp fmt                                        # oxfmt
vp run --concurrency-limit 2 check            # the whole type gate
vp run --filter ./packages/sparql check       # one package's type gate
vp run --concurrency-limit 2 -r test:unit     # every package's tests
vp test run test/Engine.test.ts               # single file (from inside the package)
vp run -r build                               # emit dist/
vp run check:dist                             # dist import guard (after the build)
vp run test:coverage                          # one Istanbul map for fallow
vp run fallow:audit                           # change-set review (not a CI gate)
vp run --filter ./packages/turtle bench       # a package's benchmark (turtle, n3, rdfxml, shex, sparql)
```
