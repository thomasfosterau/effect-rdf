# CLAUDE.md

Claude Code's entry point. The project's conventions, commands and gates are in the three files imported below; only what is specific to Claude Code (its hooks, settings and plugins) is written here.

@../AGENTS.md
@../CONTRIBUTING.md
@../README.md

## Claude Code sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; it needs `vite.plus` and `viteplus.dev` on the environment's network allowlist), links `vp` and `vpx` into `~/.local/bin` (the CLI lives under `$VP_HOME` when set, as in the Vite+ container image, else `~/.local/share/vite-plus`), and runs `vp install --frozen-lockfile`. Everything else goes through Vite+: `vp exec fallow …` for fallow, `vpx <file>.ts` for a TypeScript script. Nothing else is put on PATH. If the installer can't run, `vp` falls back to this checkout's `node_modules` copy. It hydrates no secrets (none are needed, and nothing here can publish) and does not fetch the conformance suites.
- `.claude/settings.json` should enable the `@enfect/claude` plugin (Effect guidance, skills and post-write pattern checks; marketplace `mpsuesser/enfect`, pinned by `ref` to a reviewed commit).
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` (run as `vp exec fallow`) fails; it audits only this checkout and its `.claude/worktrees/*`, skipping any other tree with a notice, and runs `vp run test:coverage` first when the coverage map is missing or older than a changed source or test file (a failing run, like any runtime error, fails open with a notice). A PostToolUse hook runs `vp fmt` on every source, JSON or Markdown file you write or edit.
- Every gate in [Verification](../AGENTS.md#verification) runs in an agent session; fetching the suites and `pnpm audit` need the network.
