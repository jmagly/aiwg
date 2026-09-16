---
name: Bug Report
about: Report a defect with a clear reproduction
title: 'bug(<area>): <one-line summary>'
labels: ['bug']
---

## TL;DR

One paragraph stating what's broken and the impact.

## Environment (REQUIRED — issues missing any field will be returned for clarification)

Run these and paste the output verbatim. Don't paraphrase, don't summarize, don't leave any blank.

```bash
aiwg version                  # → fill in AIWG version below
uname -a                      # → fill in operating system below
node --version                # → fill in Node version below
```

- [ ] **AIWG version**: `<paste from aiwg version, e.g. 2026.5.2 [stable]>`
- [ ] **Operating system**: `<paste from uname -a — full line including kernel>`
- [ ] **Provider** (the AIWG harness you were running): one of `claude-code` / `grokbot` / `hermes` / `codex` / `copilot` / `cursor` / `warp` / `factory` / `opencode` / `windsurf` / `openclaw`
- [ ] **Node version**: `<paste from node --version>`
- [ ] **Install location**: one of `npm-global` / `linuxbrew` / `local-source` / `project-local`

> **Why these three matter most**: the same bug behaves differently across OS (Linux/macOS/Windows kernel quirks), AIWG versions (a fix may already be in `main` but not yet in your installed version), and provider (Claude Code's slash command behavior is not Hermes's slash command behavior is not Codex's). The May-2026 tester-report sweep needed two correction rounds because the original report cited the wrong provider. Get this right the first time.

## Steps to reproduce

```bash
# Exact commands, copy-paste-ready. No <placeholder>s without substitution instructions.
```

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include error messages **verbatim** in fenced code blocks.

```
# Paste exact error text here
```

## Suggested fix (optional but valued)

If you've already investigated, point at the suspected file or line (e.g., `src/cli/handlers/steward.ts:26`).

## Acceptance criteria

- [ ] Repro from "Steps to reproduce" no longer fails
- [ ] Regression test added (if the bug bypassed existing tests)
- [ ] Related docs updated (if behavior was documented incorrectly)

## Related

- Issues:
- PRs:
- Tracker source (if imported from elsewhere):
