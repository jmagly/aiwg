# SDLC Complete Framework

## Overview

The SDLC Complete framework provides a comprehensive Plan → Act lifecycle for software delivery using AI agents. This specialized framework includes agents, commands, templates, and flows for managing the entire software development lifecycle.

**Supported Platforms:** Claude Code, Warp Terminal, Factory AI, GitHub Copilot, Cursor, OpenCode, OpenAI/Codex, Devin Desktop

## Framework Structure

### Content

- `agents/` — 90 specialized SDLC role agents (architecture-designer, requirements-analyst, security-gatekeeper, etc.)
- `skills/` — SDLC workflows as SKILL.md sources (intake-start, orchestrate-project, security-gate, etc.) — primary authoring format
- `commands/` — Generated command files (synthesized from skills during deployment; do not edit directly)
- `templates/` — Markdown templates for all SDLC artifacts
- `flows/` — Phase-based workflows (Inception → Elaboration → Construction → Transition)
- `add-ons/` — Compliance and legal extensions (GDPR, etc.)
- `metrics/` — Project health and tracking metrics
- `artifacts/` — Sample projects demonstrating complete lifecycle
- `config/` — Framework configuration (models.json, etc.)

### Source Code

- `src/` — Framework-specific TypeScript implementation
  - `analysis/` — Codebase analysis (UC-003: intake-from-codebase)
  - `traceability/` — Requirements traceability (UC-006)
  - `security/` — Security validation (UC-011)
  - `orchestration/` — Multi-agent SDLC orchestration
  - `git/` — Git workflow orchestration
  - `cicd/` — CI/CD pipeline generation
  - `metrics/` — DORA metrics and project tracking
  - `monitoring/` — Performance monitoring
  - `recovery/` — Error recovery and resilience
  - `testing/` — NFR test infrastructure, mocks, fixtures

## Key References

- `plan-act-sdlc.md` — Lifecycle phases and milestones
- `prompt-templates.md` — Copy-ready prompts by phase
- `actors-and-templates.md` — Role and artifact template mappings

## Relationship to Core Repository

This framework is part of the AIWG repository but serves as a standalone SDLC toolkit. The parent repository contains:

- `/agents/` — General-purpose writing agents (content-diversifier, writing-validator, prompt-optimizer)
- `/commands/` — General-purpose command documentation
- `/core/`, `/validation/`, `/examples/` — Writing Guide content

The SDLC framework agents apply writing guide principles to software artifacts but focus on development lifecycle management rather than general content creation.

## Installation

Use the AIWG CLI to deploy this framework:

```bash
# Install CLI
npm install -g aiwg

# Deploy to project (choose your platform)
aiwg use sdlc                           # Claude Code (default)
aiwg use sdlc --provider warp           # Warp Terminal
aiwg use sdlc --provider factory        # Factory AI
aiwg use sdlc --provider copilot        # GitHub Copilot
aiwg use sdlc --provider cursor         # Cursor
aiwg use sdlc --provider codex          # OpenAI/Codex
aiwg use sdlc --provider opencode       # OpenCode
aiwg use sdlc --provider devin       # Devin Desktop

# Scaffold new project with SDLC templates
aiwg new my-project
```

## Usage

See the parent repository's `CLAUDE.md` and `docs/quickstart.md` for comprehensive usage instructions.
