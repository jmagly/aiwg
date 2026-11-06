---
enforcement: medium
activation: paths
summary: Keep distributable AIWG artifacts in agentic/code, project output in the artifact store, and CI hook templates outside repository workflow directories.
bound_to:
  skills:
    - devkit-create-addon
    - devkit-create-extension
    - devkit-create-framework
    - devkit-create-agent
    - devkit-create-command
    - devkit-create-skill
    - scaffold-addon
    - scaffold-extension
    - scaffold-framework
    - new-bundle
    - add-agent
    - add-skill
    - add-command
    - add-behavior
    - add-template
    - validate-addon
    - validate-component
    - devkit-validate
    - dev-doctor
  agents:
    - aiwg-developer
paths:
  - agentic/code/**
  - .aiwg/**
  - .claude/**
  - .github/agents/**
  - .github/prompts/**
  - .github/instructions/**
  - .cursor/**
  - .warp/**
  - .codex/**
  - .factory/**
  - .opencode/**
  - .windsurf/**
  - .openclaw/**
  - .gitea/workflows/**
  - .github/workflows/**
---

# Addon Boundaries

**Enforcement Level**: MEDIUM
**Scope**: aiwg-development
**Addon**: aiwg-dev (devOnly)

## Overview

`agentic/code/` is framework source that ships to users. `.aiwg/` is project-local output for developing AIWG itself. These two directories serve entirely different purposes and must never be confused. Files placed in the wrong directory either fail to ship or pollute the framework with project-local artifacts.

## Problem Statement

Because AIWG dogfoods itself, the repository contains both the framework source AND SDLC project artifacts for the AIWG project. The `.aiwg/` directory exists and has substantial content — requirements documents, architecture decision records, test plans — but none of this content is part of the AIWG framework. It is project output, generated while developing AIWG using AIWG's own workflows.

This creates two distinct failure modes:

**Failure Mode 1: Framework artifact in `.aiwg/`**

A developer adds a schema or template to `.aiwg/flows/schemas/` thinking this extends the framework. It doesn't — `aiwg use` never reads `.aiwg/`. The artifact ships nowhere. Users never see it.

**Failure Mode 3: CI hook template placed in `.gitea/workflows/` or `.github/workflows/`**

A developer adds a CI hook template for a framework (e.g., `aiwg-sdlc.yml`) to `.gitea/workflows/` in this repo, thinking it will be deployed to user projects. Instead, it executes as AIWG's own CI on the next push — potentially running agentic automation against the AIWG repo itself with no review. With thousands of downstream users depending on each AIWG release, a broken CI run can cascade into a bad publish.

CI hook templates belong in `agentic/code/frameworks/<name>/ci/`. They are inert data here. The deployment pipeline (`--ci-hooks-enabled`) copies them into the target project's forge directories only when the user explicitly opts in.

**Failure Mode 2: `.aiwg/` reference in agent/skill definition**

A developer writes an agent that references `@.aiwg/requirements/UC-001.md`. The agent works fine in this repository but fails silently in every other project that installs AIWG — the reference points to a file that does not exist outside this repo.

## The Boundary

| Directory | Role | Ships to users? | How to reference |
|-----------|------|-----------------|-----------------|
| `agentic/code/addons/<name>/` | Framework source | YES via `aiwg use` | `@$AIWG_ROOT/agentic/code/addons/<name>/...` |
| `agentic/code/frameworks/<name>/` | Framework source | YES via `aiwg use` | `@$AIWG_ROOT/agentic/code/frameworks/<name>/...` |
| `agentic/code/frameworks/<name>/ci/` | CI hook templates for target projects | YES via `aiwg use --ci-hooks-enabled` | Source only — never executes here |
| `src/` | CLI and MCP source | YES via npm package | N/A (compiled) |
| `.aiwg/` | Project output (AIWG's own development) | NO | Only within this repo |
| `.claude/` | Deployment target (Copilot, etc.) | NO (overwritten) | Do not author here |
| `.gitea/workflows/` | AIWG's own CI (Gitea is authoritative) | NO | Only with human authorization |
| `.github/workflows/` | AIWG's own CI for GitHub mirror | NO | Only genuine repo CI |

## Mandatory Rules

### Rule 1: Framework Artifacts Go in `agentic/code/`

If you are adding a schema, template, rule, skill, agent, or process document that is intended to be part of the AIWG framework (i.e., available to users who run `aiwg use`), it belongs in:

```
agentic/code/addons/<addon-name>/
agentic/code/frameworks/<framework-name>/
```

**FORBIDDEN**:
```
.aiwg/flows/schemas/my-schema.yaml       ← invisible to installer
.aiwg/templates/my-template.md           ← invisible to installer
.aiwg/rules/my-rule.md                   ← invisible to installer
```

**REQUIRED**:
```
agentic/code/addons/my-addon/schemas/my-schema.yaml
agentic/code/addons/<addon>/templates/<template>.md
agentic/code/addons/my-addon/rules/my-rule.md
```

### Rule 2: Project Output Goes in `.aiwg/`

If you are generating SDLC artifacts for developing AIWG — requirements documents, architecture decision records, test plans, working notes — they belong in `.aiwg/`. This content tracks the AIWG project itself and is not installed elsewhere.

```
.aiwg/requirements/UC-001.md            ← correct for project artifact
.aiwg/architecture/adr-001.md           ← correct for project artifact
.aiwg/planning/iteration-7.md           ← correct for project artifact
```

### Rule 3: Only Reference Normalized `.aiwg/` Paths in Deployable Artifacts

Agent and skill definitions in `agentic/code/` may reference `.aiwg/` paths — this is how skills gain project-specific context when deployed. However, only **normalized paths** (declared in a framework's `memory.creates` or guaranteed by `aiwg init`) may be referenced. Repo-local paths silently fail in user projects.

**FORBIDDEN** (repo-local paths, only exist in this repository):
```
@.aiwg/planning/issue-driven-ralph-loop-design.md
@.aiwg/architecture/adr-rules-index-hierarchy.md
```

**ALLOWED** (normalized paths, guaranteed in user projects):
```
@.aiwg/AIWG.md                  ← Tier 1, always present
@.aiwg/requirements/             ← Tier 2, present when sdlc-complete installed
@.aiwg/research/                 ← Tier 2, present when research-complete installed
```

See `aiwg-dir-reference-contract.md` for the full normalized path list and detection guidance.

### Rule 4: Deployment Targets Are Not Authoring Locations

`.claude/`, `.github/`, `.cursor/`, and all other provider directories are generated output from `aiwg use`. Authoring there is equivalent to authoring in a build output directory — changes will be lost. See `skill-placement.md` for the full treatment of this rule.

## Decision Guide

When creating a new file, ask:

```
Is this intended for AIWG users to have after running `aiwg use`?
  YES → Is it a CI hook template (deployed via --ci-hooks-enabled)?
          YES → agentic/code/frameworks/<name>/ci/github/ or /gitea/
          NO  → agentic/code/addons/<name>/ or agentic/code/frameworks/<name>/
  NO  → Is this a project artifact for the AIWG project itself?
          YES → .aiwg/
          NO  → Is this CLI or MCP implementation code?
                  YES → src/
                  NO  → Is this AIWG's own CI workflow?
                          YES → .gitea/workflows/ (Gitea is authoritative) — requires human authorization
                          NO  → Reconsider what this file is and who it is for
```

**The CI template trap**: CI hook templates look like workflow files but must NOT go in `.gitea/workflows/` or `.github/workflows/` in this repo. They go in `agentic/code/frameworks/<name>/ci/` where they are inert data, not executable CI.

## References

- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/rules/skill-placement.md — Deployment target vs source
- @$AIWG_ROOT/docs/development/aiwg-development-guide.md — Source vs output distinction (full treatment)
- `CLAUDE.md` — The `.aiwg/` Boundary section

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-4-1
