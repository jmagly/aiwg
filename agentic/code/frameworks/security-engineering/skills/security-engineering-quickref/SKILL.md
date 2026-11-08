---
name: security-engineering-quickref
namespace: aiwg
platforms: [all]
kernel: true
description: AUTO-INVOKE when user mentions cryptography, AEAD, KDF, chain of trust, signing key, auth factor, MFA, secret hygiene, supply chain trust, physical threat, DFIR readiness, or incident evidence handoff. Security-engineering quick reference — decision domains for crypto primitives, chain-of-trust, auth factors, degraded modes, supply-chain trust, physical-threat modeling, and DFIR readiness routing.
---

# Security Engineering Framework — Quick Reference

This is your always-loaded directory for the AIWG **security-engineering** framework. It does **not** list every skill. Instead, it teaches the framework's decision domains and gives you **curated search phrases** that map to `aiwg discover` lookups.

## Canonical access pattern: discover → show

When you find a candidate via `aiwg discover`, fetch its body with `aiwg show <type> <name> --body`. **Never** use `find`, `ls`, `Glob`, or direct `Read` on `<provider>/skills/` paths — those reflect the kernel-pivot deploy state, not the full surface.

```bash
aiwg discover "<phrase>"             # find — returns ranked candidates
aiwg show skill <name> --body               # fetch — streams the SKILL.md body
```

If your platform's Skill tool errors on a non-kernel skill (expected — most aren't kernel), the fallback is `aiwg show`, never filesystem browsing. Last-resort if `aiwg` itself is broken: read directly from `$AIWG_ROOT/agentic/code/...` (the canonical corpus, always present).

## How to use this quickref

`aiwg show <type> <name>` returns a metadata card. Inspect its outline, then fetch a needed `--section "Heading"` or use `--body` for the full instructions. Fetch required rules with `--rules --with-rule-bodies` before governed work.

1. Identify the **decision domain** the user is working through (this framework is decision-aid, not audit)
2. Pick a **curated phrase** from that domain
3. Run `aiwg discover "<phrase>"` and surface the top match to the user

**Do not enumerate skills from memory.** Discovery is the lookup surface.

## What this framework is for

**Decision-aid skills for applied security**, distinct from the SDLC framework's broader security review (`flow-security-review-cycle`). Each skill in this framework forces explicit reasoning about a narrow class of security decisions and identifies anti-patterns the operator should reject before implementation.

This is **not** a vulnerability scanner or pen-test framework. It is a thinking-discipline framework for cryptographic and trust-boundary decisions that get baked into a system early and become hard to change.

## Decision domains

| Domain | The decision being made |
|---|---|
| **Cryptographic primitives** | Choosing AEAD / KDF / MAC / signature algorithms |
| **Chain of trust** | Designing the boot/bootstrap verification chain |
| **Authentication factors** | Architecting have/know/are factor stack |
| **Degraded modes** | Fail-closed vs fail-open behavior matrices |
| **Supply chain trust** | Beyond CVE/SBOM — pinning depth, reproducible builds, vendor+hash locks |
| **Runtime secret hygiene** | fd passing, scratch surface verification, error-path safety |
| **Physical threats** | Threats STRIDE and OWASP Top 10 don't cover |
| **DFIR readiness** | Preparing evidence handling, custody expectations, and handoff to forensics-complete |

| **Host hardening** | Read-only host baseline, lockout-safe remediation plans and static published-port binds |

## Curated discovery phrases

### Cryptographic primitives

```bash
aiwg discover "crypto primitive selection"     # → crypto-primitive-selection
aiwg discover "choose AEAD"                    # → crypto-primitive-selection
aiwg discover "ad-hoc KDF"                     # → crypto-primitive-selection
```

### Chain of trust

```bash
aiwg discover "chain of trust"                 # → chain-of-trust-design
aiwg discover "secure bootstrap"               # → chain-of-trust-design
aiwg discover "signed boot"                    # → chain-of-trust-design
```

### Authentication factors

```bash
aiwg discover "auth factor design"             # → auth-factor-design (score 0.59)
aiwg discover "FIDO2 PIN UV policy"            # → auth-factor-design
aiwg discover "coercion-resistance"            # → auth-factor-design
```

### Degraded modes

```bash
aiwg discover "degraded mode design"           # → degraded-mode-design
aiwg discover "fail closed fail open"          # → degraded-mode-design
```

### Supply chain trust

```bash
aiwg discover "supply chain trust"             # → supply-chain-trust (score 0.67)
aiwg discover "reproducible build"             # → supply-chain-trust
aiwg discover "dependency pinning"             # → supply-chain-trust
aiwg discover "npm supply-chain audit"         # → npm-supply-chain-audit
aiwg discover "cargo crate supply chain audit" # → cargo-supply-chain-audit (Rust/crates.io)
aiwg discover "rust dependency audit"          # → cargo-supply-chain-audit
aiwg discover "ci workflow audit"              # → ci-workflow-audit
aiwg discover "workflow pinning audit"         # → ci-workflow-audit
aiwg discover "npm release-age gate"           # → npm-release-age-gate
aiwg discover "pnpm release age gate"          # → pnpm-release-age-gate
aiwg discover "yarn release age gate"          # → yarn-release-age-gate
aiwg discover "bun release age gate"           # → bun-release-age-gate
aiwg discover "supply-chain hardening quickstart" # → supply-chain-hardening-quickstart
```

### Runtime secret hygiene

```bash
aiwg discover "secret handling runtime"        # → secret-handling-runtime
aiwg discover "fd passing secrets"             # → secret-handling-runtime
aiwg discover "scratch surface verification"   # → secret-handling-runtime
```

### Physical threats

```bash
aiwg discover "physical threat modeling"       # → physical-threat-modeling
aiwg discover "evil-maid attack"               # → physical-threat-modeling
aiwg discover "DMA attack"                     # → physical-threat-modeling
```

### DFIR readiness

```bash
aiwg discover "DFIR readiness"                 # → dfir-readiness
aiwg discover "incident response evidence"     # → dfir-readiness or forensics-quickref
aiwg discover "chain of custody readiness"     # → dfir-readiness
```

### Host hardening and firewall exposure

```bash
aiwg discover "system hardening"              # → host-hardening
aiwg discover "firewall analysis"             # → forensics exposure-analysis
aiwg discover "docker published ports"        # → exposure-analysis / published-port-binding
```

`host-hardening` reviews SSH key/console access, persistent default-deny,
Docker/VPN ordering, datastore ACLs, exporter targets and audit retention.
It produces dated backup requirements, diff-style plans and named health
rechecks; it never applies host changes, even with an apply request. The static
checker flags missing Compose/docker run bind addresses. `published-port-binding`
governs repository changes. For post-deploy/monthly checks, consume fresh
sanitized captures and alert on FAIL or UNKNOWN summaries through existing
operator scheduling. `exposure-analysis` owns actual firewall reconstruction.

## Anti-patterns each skill rejects

| Skill | Anti-patterns it identifies |
|---|---|
| `crypto-primitive-selection` | CBC-without-MAC, ad-hoc KDF, key reuse, PBKDF2 on high-entropy input, openssl enc without explicit flags |
| `chain-of-trust-design` | Circular trust roots, signing-key custody confusion, missing measured-boot anchors |
| `auth-factor-design` | Python deps in PRF hot paths, missing coercion-resistance, FIDO2 PIN/UV policy gaps |
| `degraded-mode-design` | "Type Y to override" prompts, missing degraded-mode matrix, fail-open by accident |
| `supply-chain-trust` | Dependency pinning by version (not hash), reproducible-build gaps, firmware version-not-locked |
| `npm-supply-chain-audit` | install lifecycle scripts, Git dependency prepare hooks, publish-token exposure, missing verifier docs |
| `ci-workflow-audit` | tag-pinned actions/containers, bare `:latest`, PR-triggered jobs with `secrets.*`, curl-pipe-shell without hash checks |
| `npm-release-age-gate` | missing `min-release-age`, npm 10 silently ignoring the gate, permanent bypasses |
| `pnpm-release-age-gate` | missing `minimumReleaseAge`, missing `blockExoticSubdeps`, Corepack pin < v9.0 silently ignoring the gate |
| `yarn-release-age-gate` | missing `npmMinimalAgeGate`, Corepack pin < v4.0 silently ignoring the gate, Yarn Classic v1.x lacking gate support |
| `bun-release-age-gate` | missing `install.minimumReleaseAge`, Bun < v1.1.30 silently ignoring the gate, unit confusion (Bun uses seconds vs pnpm minutes vs npm days vs Yarn duration strings) |
| `secret-handling-runtime` | SECRETS_ENV aggregation, missing scratch-surface verification, identifier reuse |
| `physical-threat-modeling` | evil-maid, DMA, hostile peripheral, travel-host, coercion, cold-boot, supply-chain implant, side-channel |
| `dfir-readiness` | collecting evidence from the security framework, destructive containment by default, missing custody handoff |

## When to use this framework vs the SDLC security flow

| Use this framework | Use `flow-security-review-cycle` (SDLC) |
|---|---|
| Deciding the *primitive* (which AEAD?) | Reviewing whether the *implementation* uses any AEAD correctly |
| Designing the boot chain | Threat-modeling the application boundary |
| Picking an MFA scheme | Auditing existing auth code |
| Defining degraded-mode behavior | Vulnerability scan + STRIDE on a feature |
| Preparing evidence handling and DFIR handoff | Running production incident comms or collecting forensic evidence |

The SDLC's `flow-security-review-cycle` is the broader periodic audit. The skills here are pinpoint decision aids — invoke them when the decision is being made, not after.

For active evidence-bearing investigations, use `forensics-complete`. For production incident coordination, severity, communications, and post-incident review, use SDLC incident-response flows. The handoff guide is `docs/integrations/dfir-handoff.md`.

## Rules deployed

This framework ships 4 applied-cryptography rules into the rules index:

- `no-unauthenticated-encryption`
- `no-key-reuse-across-purposes`
- `no-adhoc-kdf`
- `crypto-flag-verification`
- `published-port-binding` — explicit Docker publish binds and exposure review

These deploy via the standard rules-index pipeline.

## When the curated phrases don't fit

```bash
aiwg discover "<your need, paraphrased>" --limit 5
```

For asks outside the seven listed skills (e.g., "audit a TLS config", "review a JWT implementation"), the SDLC framework's `flow-security-review-cycle` is the right surface.

## Anti-pattern: don't enumerate

If a user asks "what security skills are available?", **do not list from this skill**. Run:

```bash
aiwg discover --type skill --limit 20 "<their interest area>"
```
