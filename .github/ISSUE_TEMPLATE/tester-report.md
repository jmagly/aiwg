---
name: Tester Report (multi-finding)
about: Single session that surfaced multiple bugs — to be split during triage
title: 'tester-report(<env>): <session summary>'
labels: ['tester-report', 'triage']
---

## Session Summary

- Tester:
- Date:

## Environment (REQUIRED — applies to ALL findings in this report)

Run these and paste output verbatim:

```bash
aiwg version                  # AIWG version
uname -a                      # operating system
node --version                # Node version
```

- [ ] **AIWG version**: `<paste from aiwg version>`
- [ ] **Operating system**: `<paste from uname -a>`
- [ ] **Provider** (AIWG harness): one of `claude-code` / `grokbot` / `hermes` / `muse` / `codex` / `copilot` / `cursor` / `warp` / `factory` / `opencode` / `windsurf` / `openclaw`
- [ ] **Node version**: `<paste from node --version>`
- [ ] **Install location**: one of `npm-global` / `linuxbrew` / `local-source` / `project-local`

> If individual findings used different providers (e.g., one Claude Code, one Hermes), note the per-finding provider inline in the finding section. Same bug behaves differently across providers — the May-2026 tester-report sweep needed correction because the original report cited the wrong provider.

## Findings

For each finding, include enough detail that triage can split it into a discrete bug:

### Finding 1: <title>

- **Severity**: critical / high / medium / low
- **Steps to reproduce**:
- **Expected vs actual**:
- **Notes / hypothesis**:

### Finding 2: <title>

- ...

## Recommendation for triage

Which findings should be one ticket vs separate? Any duplicates of existing issues?

## Original artifacts

If this report originated elsewhere (Slack, email, another tracker), link or paste here.

---

> Triage owner: split each finding into its own bug-report issue. Close this report
> with links to the resulting issues. See `CONTRIBUTING.md` § "Import flow" for the
> imported-report pattern.
