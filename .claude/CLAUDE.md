# Claude Code

Read README.md, docs/CONTRIBUTING.md and AGENTS.md (imported below). This file covers only Claude Code specifics.

- A PostToolUse hook ([settings.json](settings.json)) runs `vp fmt` on files you edit. The fallow audit is the Vite+ pre-commit hook, not a Claude hook.
- Use worktrees under `.claude/worktrees/`, one per branch; each needs its own `vp install` and a `.test-suites` symlink.

@../README.md

@../docs/CONTRIBUTING.md

@../AGENTS.md
