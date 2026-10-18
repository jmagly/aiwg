---
name: sdlc-quickref
namespace: aiwg
platforms: [all]
kernel: true
description: AUTO-INVOKE when user mentions SDLC, requirements, architecture, ADR, use case, user story, test plan, phase gate, inception, elaboration, construction, transition, intake, deploy. SDLC framework quick reference — phase model, capability domains, and curated discovery phrases for aiwg discover.
---

# SDLC Framework — Quick Reference

This is your always-loaded directory for the AIWG **SDLC framework** (300+ skills). It does **not** list every skill. Instead, it teaches you the framework's mental model and gives you **curated search phrases** that map to `aiwg discover` lookups. Use the phrases — each is validated to surface its target skill in the top-3 ranked results.

## Canonical access pattern: discover → show

When you find a candidate via `aiwg discover`, fetch its body with `aiwg show <type> <name>`. **Never** use `find`, `ls`, `Glob`, or direct `Read` on `<provider>/skills/` paths — those reflect the kernel-pivot deploy state, not the full surface.

```bash
aiwg discover "<phrase>"             # find — returns ranked candidates
aiwg show skill <name>               # fetch — streams the SKILL.md body
```

If your platform's Skill tool errors on a non-kernel skill (expected — most aren't kernel), the fallback is `aiwg show`, never filesystem browsing. Last-resort if `aiwg` itself is broken: read directly from `$AIWG_ROOT/agentic/code/...` (the canonical corpus, always present).

## How to use this quickref

1. Identify which **capability domain** the user's need belongs to (table below)
2. Pick a **curated phrase** from that domain (or paraphrase the user's words)
3. Run `aiwg discover "<phrase>"` and surface the top match (or top-3) to the user
4. If no curated phrase fits, improvise — `aiwg discover` is forgiving with natural language

**Do not enumerate skills from memory.** The framework ships hundreds of skills and the kernel set you can see is just the orientation layer.

## What this framework is for

End-to-end software-development-lifecycle support. Phase-based workflows (Inception → Elaboration → Construction → Transition → Production) with multi-agent artifact generation, gate criteria, traceability, and 100+ document templates.

## Capability domains

| Domain | Covers |
|---|---|
| **Project bootstrap** | Starting a new project, scaffolding intake, scanning a codebase to seed an SDLC corpus |
| **Phase transitions** | Moving between Inception / Elaboration / Construction / Transition / Production |
| **Continuous workflows** | Recurring cycles: requirements, architecture, tests, security, performance, risk |
| **Quality gates** | Phase-boundary validation, traceability, gate criteria |
| **Team & process** | Onboarding, knowledge transfer, retrospectives, cross-team sync |
| **Production & ops** | Deployment, hypercare, incident response |
| **Compliance** | Regulatory frameworks (SOC2, GDPR, HIPAA, PCI-DSS) and change control |
| **Artifact generation** | Architecture docs, ADRs, test plans, deployment plans, runbooks |

## Curated discovery phrases

Each phrase has been tested — running it through `aiwg discover` returns the listed skill in the top-3 ranked results. Use them verbatim or as a starting point for your own phrasing.

### Project bootstrap

```bash
aiwg discover "start a new project"            # → new-project (score 1.00)
aiwg discover "scan codebase for intake"       # → intake-from-codebase
aiwg discover "intake wizard"                  # → intake-wizard
```

### Phase transitions

```bash
aiwg discover "inception to elaboration"       # → flow-inception-to-elaboration
aiwg discover "elaboration to construction"    # → flow-elaboration-to-construction
aiwg discover "construction to transition"     # → flow-construction-to-transition
aiwg discover "concept to inception"           # → flow-concept-to-inception
```

### Continuous workflows

```bash
aiwg discover "risk management cycle"          # → flow-risk-management-cycle (score 0.93)
aiwg discover "execute test strategy"          # → flow-test-strategy-execution
aiwg discover "performance optimization cycle" # → flow-performance-optimization
aiwg discover "security review cycle"          # → flow-security-review-cycle
aiwg discover "requirements evolution"         # → flow-requirements-evolution
aiwg discover "architecture evolution"         # → flow-architecture-evolution
aiwg discover "iteration dual track"           # → flow-iteration-dual-track
aiwg discover "delivery track"                 # → flow-delivery-track
aiwg discover "discovery track"                # → flow-discovery-track
aiwg discover "define data shape"              # → schema-intake (schema-governance addon)
aiwg discover "change an existing schema"      # → schema-evolve (schema-governance addon)
```

### Quality gates

```bash
aiwg discover "phase gate check"               # → flow-gate-check
aiwg discover "gate evaluation"                # → gate-evaluation
aiwg discover "traceability check"             # → check-traceability
aiwg discover "handoff checklist"              # → flow-handoff-checklist
```

### Team & process

```bash
aiwg discover "team onboarding"                # → flow-team-onboarding (score 1.00)
aiwg discover "knowledge transfer"             # → flow-knowledge-transfer
aiwg discover "retrospective"                  # → flow-retrospective-cycle (score 1.00)
aiwg discover "cross-team synchronization"     # → flow-cross-team-sync (score 1.00)
```

### Production & ops

```bash
aiwg discover "deploy production"              # → flow-deploy-to-production (score 0.51)
aiwg discover "production hypercare"           # → flow-hypercare-monitoring
aiwg discover "production incident triage"     # → flow-incident-response (score 0.55)
```

### Compliance

```bash
aiwg discover "compliance validation"          # → flow-compliance-validation (score 1.00)
aiwg discover "change control"                 # → flow-change-control
```

### Artifact generation

```bash
aiwg discover "create SAD"                     # → artifact-orchestration (score 1.00)
aiwg discover "generate use case realization"  # → generate-realization
aiwg discover "build proof of concept"         # → build-poc
aiwg discover "decision support matrix"        # → decision-support
```

## Mental model — the phase machine

```
Inception (4-6w)  →  Elaboration (4-8w)  →  Construction (8-16w)  →  Transition (2-4w)  →  Production
   │                    │                       │                        │
   LO milestone        LA milestone            IOC milestone            PR milestone
```

- **Inception** — validate problem, vision, risks, business case
- **Elaboration** — detailed requirements, architecture baseline, risk retirement, test strategy
- **Construction** — feature implementation, automated testing, security validation, performance
- **Transition** — production deployment, UAT, support handover, hypercare (2-4w)
- **Production** — ongoing operations, incident response, feature iteration

Cross-cutting: risk-management, architecture-evolution, requirements-evolution, security-review, performance-optimization, test-strategy run continuously across all phases.

## Artifact directory layout

All SDLC artifacts go under `.aiwg/`:

```
.aiwg/
├── intake/        # Project intake forms, solution profiles
├── requirements/  # Use cases, user stories, NFRs
├── architecture/  # SAD, ADRs, diagrams
├── planning/      # Phase and iteration plans
├── risks/         # Risk register
├── testing/       # Test strategy, plans
├── security/      # Threat models, security gates
├── deployment/    # Deployment plans, runbooks
├── working/       # Temporary scratch (safe to delete)
└── reports/       # Generated reports
```

## When the curated phrases don't fit

Improvise. The discovery scorer uses trigger phrases (4× weight), capability descriptions (2× weight), titles, tags, summaries, and paths. Multi-token queries require ≥50% token overlap, so noise queries return zero results.

```bash
aiwg discover "<your need, paraphrased>" --limit 5
```

If the top-3 results all score below ~0.20, the framework genuinely may not have a curated skill for that need. Then you can improvise — but always check first.

## Anti-pattern: don't enumerate

If a user asks "what SDLC skills are available?" or "what can the SDLC framework do?", **do not list from this skill or from memory**. Run:

```bash
aiwg discover --type skill --limit 20 "<their interest area>"
```

This skill is the orientation layer; the index is the lookup. Enumerating from memory means you're treating the kernel set as exhaustive — which it deliberately isn't.
