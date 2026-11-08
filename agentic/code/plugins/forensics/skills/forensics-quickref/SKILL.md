---
name: forensics-quickref
namespace: aiwg
platforms: [all]
kernel: true
description: AUTO-INVOKE when user mentions forensics, incident response, IOC, log analysis, evidence preservation, breach investigation, threat hunting, attack timeline. Forensics framework quick reference — discovery phrases for incident response, log analysis, evidence preservation, IOC extraction.
---

# Forensics Framework — Quick Reference

This is your always-loaded directory for the AIWG **forensics-complete** framework. It does **not** list every skill. Instead, it teaches the framework's mental model and gives you **curated search phrases** that map to `aiwg discover` lookups.

## Canonical access pattern: discover → show

When you find a candidate via `aiwg discover`, fetch its body with `aiwg show <type> <name> --body`. **Never** use `find`, `ls`, `Glob`, or direct `Read` on `<provider>/skills/` paths — those reflect the kernel-pivot deploy state, not the full surface.

```bash
aiwg discover "<phrase>"             # find — returns ranked candidates
aiwg show skill <name> --body               # fetch — streams the SKILL.md body
```

If your platform's Skill tool errors on a non-kernel skill (expected — most aren't kernel), the fallback is `aiwg show`, never filesystem browsing. Last-resort if `aiwg` itself is broken: read directly from `$AIWG_ROOT/agentic/code/...` (the canonical corpus, always present).

## How to use this quickref

`aiwg show <type> <name>` returns a metadata card. Inspect its outline, then fetch a needed `--section "Heading"` or use `--body` for the full instructions. Fetch required rules with `--rules --with-rule-bodies` before governed work.

1. Identify the **capability domain** the user's need belongs to
2. Pick a **curated phrase** from that domain (or paraphrase the user's words)
3. Run `aiwg discover "<phrase>"` and surface the top match (or top-3) to the user
4. If the top result isn't right, iterate the phrasing — the scorer is forgiving

**Do not enumerate skills from memory.** The framework ships ~20 skills and discovery is the lookup surface.

## What this framework is for

Digital forensics & incident response. RFC 3227-aligned triage, multi-source timeline reconstruction, IOC extraction, chain-of-custody preservation, and Sigma-rule-based threat hunting. Multi-platform (Linux / cloud / containers / memory).

## Capability domains

| Domain | Covers |
|---|---|
| **Triage & acquisition** | Quick host triage following RFC 3227, evidence acquisition with chain of custody, target system profiling |
| **Platform-specific analysis** | Linux, memory dumps, cloud (AWS/Azure/GCP), Docker/K8s containers, supply chain |
| **Investigation orchestration** | Full multi-agent investigation, log correlation, IOC extraction & STIX 2.1 mapping |
| **Threat hunting** | Sigma rule application across log sources |
| **Reporting** | Investigation reports with evidence, timeline reconstruction |

| **Host exposure** | Listener/firewall/Docker correlation, stale and over-broad rules, IPv6 and probe allowlists |

## Curated discovery phrases

### Triage & acquisition

```bash
aiwg discover "forensic triage"                # → forensics-triage
aiwg discover "evidence acquisition"           # → forensics-acquire (score 0.55)
aiwg discover "target system profile"          # → forensics-profile
aiwg discover "start forensics case"           # → forensics-quickref / forensics-investigate
```

### Platform-specific analysis

```bash
aiwg discover "linux forensics"                # → linux-forensics (score 0.51)
aiwg discover "memory forensics"               # → memory-forensics (score 0.94)
aiwg discover "cloud forensics"                # → cloud-forensics (score 0.63)
aiwg discover "container forensics"            # → container-forensics
aiwg discover "supply chain compromise"        # → supply-chain-forensics
```

### Host exposure reconstruction

```bash
aiwg discover "firewall analysis"              # → exposure-analysis
aiwg discover "docker published ports"         # → exposure-analysis
```

`exposure-analysis` is read-only. It correlates listeners, ordered host firewall
rules, Docker DNAT/FORWARD paths, IPv4/IPv6 and probe-source allowlists. The
bundled offline helper consumes sanitized captures and emits evidence hashes
plus PASS/FAIL/UNKNOWN summaries for post-deploy and monthly operator checks.
Unsupported native firewall semantics require manual review. Route preventive
baseline and remediation recommendations to `security-engineering/host-hardening`;
neither skill changes host firewall rules or services.

### Investigation orchestration

```bash
aiwg discover "forensics investigation"        # → forensics-investigate (top-3; refine if needed)
aiwg discover "log analysis"                   # → log-analysis
aiwg discover "extract iocs"                   # → forensics-ioc
aiwg discover "build forensic timeline"        # → forensics-timeline
```

### Threat hunting

```bash
aiwg discover "threat hunt with sigma rules"   # → sigma-hunting (score 1.00)
aiwg discover "forensics hunt"                 # → forensics-hunt
```

### Reporting & integrity

```bash
aiwg discover "forensic report"                # → forensics-report
aiwg discover "investigation status"           # → forensics-status
aiwg discover "evidence preservation"          # → evidence-preservation
aiwg discover "integrity verification"         # → integrity-verification
```

## Mental model — the investigation pipeline

```
Triage (RFC 3227)  →  Acquisition  →  Platform analysis  →  IOC extraction  →  Reporting
   forensics-triage    forensics-acquire   linux-forensics    forensics-ioc    forensics-report
                                           memory-forensics
                                           cloud-forensics
                                           container-forensics
```

Cross-cutting: `forensics-hunt` (Sigma) and `log-analysis` (correlation) feed both Analysis and IOC extraction.

## Artifact directory layout

Forensic artifacts go under `.aiwg/forensics/` when the framework is in use:

```
.aiwg/forensics/
├── profiles/            # Target profiles
├── plans/               # Investigation plans
├── triage/              # RFC 3227 quick captures and summaries
├── evidence/            # Chain-of-custody-preserved evidence
├── findings/            # Analysis findings
├── timelines/           # Reconstructed event timelines
├── iocs/                # Extracted indicators of compromise
├── reports/             # Investigation reports
├── sigma/               # Custom Sigma rules
└── chain-of-custody.md  # Master CoC log
```

For readiness and handoff from preventive security work, use `security-engineering/dfir-readiness`. For production incident coordination, use SDLC incident-response flows. See `docs/integrations/dfir-handoff.md`.

## When the curated phrases don't fit

```bash
aiwg discover "<your need, paraphrased>" --limit 5
```

If the top-3 results all score below ~0.20, the framework genuinely may not have a curated skill for that need. Then improvise — but always check first.

## Anti-pattern: don't enumerate

If a user asks "what forensics skills are available?", **do not list from this skill**. Run:

```bash
aiwg discover --type skill --limit 20 "<their interest area>"
```

This skill is the orientation layer. The index is the lookup.
