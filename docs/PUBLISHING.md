# Publishing

The packages are released with [Changesets](https://github.com/changesets/changesets) and published to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

## Flow

1. Each change that needs one carries a changeset (see [CONTRIBUTING.md](CONTRIBUTING.md#changesets)).
2. On `trunk`, the [Release workflow](../.github/workflows/release.yml) opens or updates the `chore: version packages` PR (the `changeset:version` task). `"format": false` in `.changeset/config.json` because Changesets would otherwise run Vite+'s editor-only `oxfmt` shim; the task runs `vp fmt` instead.
3. Merging it triggers the `publish` job in the protected `release` environment. After approval it runs `vp run release`: every package's build and the offline `check:dist`, then `vp pm publish -r --access public --no-git-checks -- --ignore-scripts` (pnpm, which rewrites `workspace:` / `catalog:` specifiers, skips versions already on npm, publishes in dependency order and performs the OIDC exchange itself), then `changeset git-tag`, whose tags the Changesets action pushes and turns into GitHub releases. A failed publish stops before tagging. There is no publish script, and the release path calls neither `npm` nor `pnpm` directly.

`vp run release:dry-run` builds, checks and shows what would be published, without publishing or tagging.

Privileged jobs run only after `verify-lockfile` checks every action against `.github/workflows/actions.lock`, install with `--ignore-scripts` and restore no cache. Provenance is attached by pnpm once the repository is public.

## One-time setup (owner)

- **Settings → Actions → General**: allow GitHub Actions to create and approve pull requests.
- **Settings → Environments → `release`**: a required reviewer; deployments limited to `trunk`.
- **npmjs.com → each package → Settings → Trusted publishing**: GitHub Actions, `thomasfosterau/effect-rdf`, workflow `release.yml`, environment `release`. A trusted publisher needs the package to exist, so a new package's first version is published by hand, from a clean `trunk`: `vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run release`, then `git push origin --tags`.
- **Rulesets on `trunk`**: require pull requests and the `ci (node lts)` and `ci (node latest)` checks.
