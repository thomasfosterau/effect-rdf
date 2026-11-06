---
'@thomasfosterau/effect-sparql-node': minor
---

The CLI is built with `effect/cli`: generated `--help`, `--version` and shell completions, typed flags, and every flag backed by a `SPARQL_SERVER_*` environment variable through `Config` (a flag wins over the environment, which wins over the default). The flag names and their behaviour are unchanged; `--base-url` must now be an absolute IRI. New exports: `Cli.command`, `Cli.config`, `Cli.Flags`, `Cli.toArguments` and `Cli.envPrefix`; `Cli.run` takes an optional `{ version }`.
