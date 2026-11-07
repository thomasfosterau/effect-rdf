# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-rdf/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected package and version.

## Supply-chain hardening

These packages are published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** Once the source repository is public, every version the release workflow publishes carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements), cryptographically linking the artifact to the exact source commit and workflow. Provenance is only attached when the source repository and the package are both public, so while this repository is private `pnpm publish` skips it with a warning.
- **Install scripts disabled in the release job.** The release workflow installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts`, and turns off pnpm 11's `verify-deps-before-run` for that job (`pnpm_config_verify_deps_before_run: "false"`) so a later `pnpm run` cannot silently re-install with scripts; a compromised (transitive) dependency cannot execute install hooks in the privileged publish job. The publish itself runs as `pnpm -r publish --ignore-scripts`, so no package lifecycle script (`prepublishOnly`, `prepack`, …) runs there either. No unpinned tooling is installed there: pnpm (pinned by `packageManager`) performs the OIDC exchange itself, so npm is never upgraded in the job. CI runs the workspace's own `prepare` (the `@effect/tsgo` patch the type gate needs) but only ever holds read permissions.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject malicious workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval. The Release workflow splits versioning from publishing (changesets/action's `select-mode`, `version` and `publish` sub-actions): only its `publish` job runs in that environment and holds `id-token: write`, so refreshing the version PR needs no approval and cannot publish.
- **Locked dependencies with a cooling-off period.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; `minimumReleaseAge` holds newly published third-party versions for a day before pnpm will install them; Dependabot proposes updates for review with the same cooldown.

## Untrusted input

These packages parse documents and run queries that may come from anyone. The defences below are part of each package's contract; a change that weakens one is a security change.

- **Parsers fail, they do not throw.** Every syntax subpath's `parse` returns a typed `RdfParseError` (with `line` / `column`) for malformed input instead of throwing; the conformance suites' negative tests pin it.
- **RDF/XML never loads external entities.** `@thomasfosterau/effect-rdf/rdfxml` resolves no external DTD or entity, caps entity expansion at 1,000,000 characters ("billion laughs"), entity-reference nesting at 64 levels and element nesting at 1,024, failing with an `XmlParseError` rather than exhausting the stack; its hostile-document tests pin them. The limits are enforced by `@thomasfosterau/effect-xml`'s tokenizer, configured by `/rdfxml`; SPARQL XML results are read by the same parser.
- **XMP inherits those limits.** `@thomasfosterau/effect-rdf/xmp` parses packets with the RDF/XML parser above, rejects blank-node cycles, and bounds-checks every JPEG segment, Extended XMP chunk and PNG chunk length against the input, failing with an `XmpExtractError` on a truncated or malformed file. A compressed PNG `iTXt` chunk is inflated incrementally and fails once it passes `maxXmpBytes` (4 MiB by default), so a deflate bomb cannot exhaust memory.
- **Network access is opt-in.** JSON-LD remote contexts and documents load only through a `DocumentLoader` the caller provides, ShEx imports only through a `SchemaLoader`, and SPARQL `SERVICE` / `LOAD` reach the network only when a federation handler (`@thomasfosterau/effect-rdf/sparql`'s `Federation`) is installed. Without one, a remote reference fails with a typed error. A server that accepts queries from untrusted clients should not install an unrestricted loader or federation handler (SSRF).
- **The SPARQL server can be bounded.** `@thomasfosterau/effect-rdf/sparql`'s `SparqlServer` (and `@thomasfosterau/effect-sparql-node`'s `NodeSparqlServer` and `effect-sparql-server` CLI) supports a read-only mode (updates answer `403`) and a per-query time limit (`503`); expose a public endpoint with both.
- **AI tool input is untrusted.** `@thomasfosterau/effect-rdf/sparql/ai`'s tools run model-generated SPARQL, so they are read-only by default (`sparql_query` accepts only queries; `sparql_update` exists only in the separate `toolkitWithUpdate`), cap every result at `maxRows` rows or triples, time out each call (10 seconds by default) and refuse `SERVICE` unless `federation: true`. Only build the toolkit over an engine you are willing to let a model read, and don't enable updates for agents that read untrusted content (prompt injection).

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](./PUBLISHING.md).
