---
enforcement: critical
---

# AIWG Rules

Deployable enforcement policies that define default behaviors AIWG users can count on.

## What Are Rules?

Rules are structured enforcement documents that configure AI assistant behavior. Unlike guidelines or suggestions, rules are **non-negotiable defaults** that AIWG deploys to every supported platform.

When a user runs `aiwg use sdlc` or `aiwg new`, rules are copied or injected into the platform's native rule location. The AI assistant then follows them automatically.

The universal `activation: core` rules are `no-attribution` (CRITICAL) and
`anti-laziness` (HIGH), owned by `agentic/code/addons/aiwg-utils/rules/`.
Their compact `.core.md` bodies load in every deploy mode. Read the full
no-attribution rule with `aiwg show rule no-attribution`.
The historical tiers below describe inventory; activation controls delivery.

## Tiers

| Tier | Deployed When | Purpose |
|------|--------------|---------|
| **core** | Always (`aiwg use`, `aiwg new`) | Universal behaviors every user can count on |
| **sdlc** | With SDLC framework (`aiwg use sdlc`) | Workflow-specific enforcement |
| **research** | When research features active | Research corpus management |

### Core Rules (Always Deployed)

These define what AIWG **is** as a tool:

| Rule | Enforcement | What It Does |
|------|-------------|-------------|
| `no-attribution` | CRITICAL | Zero AI branding in commits, PRs, docs, code |
| `token-security` | CRITICAL | Never hardcode, log, or expose tokens |
| `versioning` | CRITICAL | CalVer format, no leading zeros |
| `citation-policy` | CRITICAL | Never fabricate citations or sources |
| `anti-laziness` | HIGH | Never delete tests or remove features to pass |
| `executable-feedback` | HIGH | Execute tests before returning code |
| `failure-mitigation` | HIGH | Mitigate known LLM failure archetypes |

These 7 rules ship with every AIWG installation. They're the behaviors that make AIWG a trustworthy tool rather than an unpredictable assistant.

## Deployment Strategy: Consolidated Index

Instead of deploying all 31 individual rule files (~9,321 lines), AIWG deploys a single **`RULES-INDEX.md`** file (~200 lines) containing:

- 2-3 sentence summaries of each rule (enough to determine relevance)
- @-links to full rule files for on-demand loading
- Organization by tier and enforcement level
- Quick Reference table mapping task types to relevant rules

This achieves **~95% context reduction** while preserving discoverability. Agents scan the summaries and load full rules via @-links only when needed.

### Before/After

```
# Before: 31 individual files deployed
.claude/rules/
├── no-attribution.md
├── token-security.md
├── versioning.md
├── ... (28 more files)

# After: Single consolidated index
.claude/rules/
└── RULES-INDEX.md
```

### Cleanup Behavior

When redeploying, old individually-deployed `.md` files in the target rules directory are automatically cleaned up. Non-`.md` files (e.g., Cursor's `.mdc` files) are preserved.

### Fallback

If `RULES-INDEX.md` is not found in the source, providers fall back to deploying individual rule files.

## Platform Deployment

Rules deploy to platform-native locations:

| Platform | Target | Mechanism |
|----------|--------|-----------|
| Claude Code | `.claude/rules/RULES-INDEX.md` | File copy |
| Cursor | `.cursor/rules/RULES-INDEX.md` | File copy |
| Copilot | `.github/copilot-instructions.md` | Content injection |
| Codex | `.codex/rules/RULES-INDEX.md` | File copy |
| Warp | `.warp/rules/RULES-INDEX.md` | File copy |
| Factory AI | `.factory/rules/RULES-INDEX.md` | File copy |
| OpenCode | `.opencode/rule/RULES-INDEX.md` | File copy |
| Windsurf | `.windsurf/rules/RULES-INDEX.md` | File copy |

**File copy platforms** deploy the consolidated `RULES-INDEX.md` with summaries and @-links.

**Content injection platforms** embed the index content into the platform's context file.

## CLI Integration

```bash
# Deploy all rules for a framework
aiwg use sdlc          # Deploys core + sdlc tier rules

# Deploy to specific platform
aiwg use sdlc --provider cursor   # Deploys to .cursor/rules/

# Scaffold new project with rules
aiwg new my-project    # Includes core tier rules

# Regenerate rules for a platform
aiwg regenerate claude  # Syncs rules to .claude/rules/

# List deployed rules
aiwg rules list

# Check rule compliance
aiwg rules check
```

## Rule Structure

Each rule file follows this format:

```markdown
# Rule Name

**Enforcement Level**: CRITICAL | HIGH | MEDIUM
**Scope**: What this rule applies to
**Issue**: #NNN (Gitea tracking issue)

## Principle
Why this rule exists.

## Mandatory Rules
### Rule 1: ...
**FORBIDDEN**: (what not to do)
**REQUIRED**: (what to do instead)

## References
Links to related rules, schemas, and research.
```

## Manifest

`manifest.json` (v2.0.0) registers all rules with metadata for the CLI:

- **name**: Rule identifier
- **file**: Filename in this directory
- **enforcement**: critical | high | medium
- **tier**: core | sdlc | research
- **description**: One-line purpose
- **issue**: Gitea issue reference
- **consolidation**: Strategy metadata (`index-with-links`, deploy single index file)
- **deployment.platforms**: Per-platform target paths for `RULES-INDEX.md`

## Adding New Rules

1. Create the rule file in this directory following the standard structure
2. Add an entry to `manifest.json`
3. Choose the appropriate tier (core = universal, sdlc = workflow, research = corpus)
4. Set enforcement level based on impact of violations
5. Run `aiwg rules check` to validate

## Relationship to .claude/rules/

`.claude/rules/` is the **deployment target** for Claude Code. This directory (`agentic/code/frameworks/sdlc-complete/rules/`) is the **canonical source**.

- Source of truth: `agentic/code/frameworks/sdlc-complete/rules/`
- Claude Code deployment: `.claude/rules/`
- Other platforms: Platform-specific locations per deployment map

The `aiwg use` and `aiwg regenerate` commands sync from source to targets.

For this repository (which dogfoods AIWG), `.claude/rules/` may also contain project-specific rules that aren't part of the framework. Only rules listed in `manifest.json` are deployed to other projects.
