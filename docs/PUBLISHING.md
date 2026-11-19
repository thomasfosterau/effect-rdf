# Publishing

The packages are released with [Changesets](https://github.com/changesets/changesets) and published to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

## Flow

1. Each change that needs one carries a changeset (see [CONTRIBUTING.md](CONTRIBUTING.md#changesets)).
2. On `trunk`, the [Release workflow](../.github/workflows/release.yml) opens or updates the `chore: version packages` PR (the `changeset:version` task). `"format": false` in `.changeset/config.json` because Changesets would otherwise run Vite+'s editor-only `oxfmt` shim; the task runs `vp fmt` instead.
3. Merging it triggers the `publish` job in the protected `release` environment. After approval it builds every package and runs `pnpm run release`: `pnpm -r publish --ignore-scripts` (which rewrites `workspace:` / `catalog:` specifiers and performs the OIDC exchange itself), then `changeset tag`.

Privileged jobs run only after `verify-lockfile` checks every action against `.github/workflows/actions.lock`, install with `--ignore-scripts` and restore no cache. Provenance is attached by pnpm once the repository is public.

## One-time setup (owner)

- **Settings → Actions → General**: allow GitHub Actions to create and approve pull requests.
- **Settings → Environments → `release`**: a required reviewer; deployments limited to `trunk`.
- **npmjs.com → each package → Settings → Trusted publishing**: GitHub Actions, `thomasfosterau/effect-rdf`, workflow `release.yml`, environment `release`. A trusted publisher needs the package to exist, so a new package's first version is published by hand.
- **Rulesets on `trunk`**: require pull requests and the `ci (node lts)` and `ci (node latest)` checks.
