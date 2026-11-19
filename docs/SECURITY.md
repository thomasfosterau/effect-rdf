# Security

## Reporting a vulnerability

Report vulnerabilities privately with GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-rdf/security/advisories/new) button, not in a public issue. Include a description, reproduction steps and the affected package and version.

## Untrusted input

The packages parse documents and run queries that may come from anyone. These defences are part of their contract; weakening one is a security change.

- **Parsers fail with typed errors**, never throw.
- **IRI and language-tag validation runs in linear time** (no backtracking patterns).
- **Patterns from the data never reach the JavaScript regex engine.** SPARQL `REGEX` / `REPLACE`, SHACL `sh:pattern`, ShEx `pattern`, CSVW `format` and the N3 string built-ins run on effect-rdf's own matcher: linear in the input, with a capped program size; back-references and lookahead run on a step-budgeted backtracker; lookbehind is rejected.
- **RDF/XML loads no external entity or DTD** and caps entity expansion (1,000,000 characters), entity nesting (64) and element nesting (1,024). XMP inherits these, bounds-checks every JPEG / PNG segment and caps inflated `iTXt` at `maxXmpBytes`.
- **JSON-LD nesting is bounded**; too-deep input fails with a `JsonLdError`.
- **Network access is opt-in**: JSON-LD remote documents only through a `DocumentLoader`, ShEx imports through a `SchemaLoader`, SPARQL `SERVICE` / `LOAD` through an installed `Federation`. Don't install an unrestricted one on a public endpoint (SSRF).
- **The SPARQL server can be bounded** with a read-only mode (`403` on updates) and a per-query time limit (`503`); use both on a public endpoint.
- **`/sparql/ai` tools run model-generated SPARQL**: read-only unless built with `toolkitWithUpdate`, capped at `maxRows`, timed out, and no `SERVICE` unless `federation: true`.

## Supply chain

- Trusted publishing from a protected `release` environment that needs approval; only that job holds `id-token: write`, it installs with `--ignore-scripts`, and nothing privileged runs unless `.github/workflows/actions.lock` verifies. See [PUBLISHING.md](PUBLISHING.md).
- Workflows default to `permissions: {}` and never persist checkout credentials.
- Installs use the committed lockfile; `minimumReleaseAge` holds new versions for 8 hours, Dependabot waits a day, and CI runs `pnpm audit --audit-level high`.
