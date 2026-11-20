# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; this file adds only what is specific to agents.

- Read the `AGENTS.md` of each package you touch (`packages/<name>/AGENTS.md`): its boundary and invariants.
- You may open pull requests in this repository (GitHub MCP tools or `gh`; with `gh`, pass `-R thomasfosterau/effect-rdf` when the cwd might be another checkout). Say which gates ran and which couldn't.
- Out-of-scope work you notice: file an issue (search for duplicates first) and move on.
- Write idiomatic Effect v4 and read `node_modules/effect` rather than guessing an API. Non-idiomatic code that isn't a trivial fix gets an issue listing the sites and the replacement.

## Pitfalls

- Without `.test-suites/` the conformance tests skip silently; a green run then proves only the unit tests. In a git worktree, symlink the main checkout's `.test-suites`.
- `vp check` (format + lint) and `vp run check` (the type gate) are different commands; run the type gate and suites with `--concurrency-limit 2`, or a small machine runs out of memory.
- `effect` is a peer, never a dependency: two copies break `Context` / `Layer` / `Schema` identity.
- Publish only through the Release workflow (`vp run release`; there is no publish script). Release-path registry calls go through `vp pm`, never `npm` / `pnpm` directly; `vp pm view` fails inside this repo (`devEngines.runtime` is `lts`), so rely on `vp pm publish -r` skipping published versions. `release` depends only on the build and offline checks: it runs in the OIDC job.

## Fallow

- `vp install` links the `fallow` skill into `.claude/skills/fallow` from the installed package (approved under `permissions` in `pnpm-workspace.yaml`). The pre-commit `fallow:audit` gate and the rest of the repository's rules are in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
