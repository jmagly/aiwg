---
name: skill-discovery-guidance
description: Supporting rationale and examples for skill-discovery
enforcement: low
activation: on-demand
---

# skill-discovery — guidance

Authority: `aiwg show rule skill-discovery` (kernel). This companion supplies supporting explanation; the complete imperative core is self-contained in that rule.

## Overview

Run `aiwg discover "<need>"` and read the result before naming, recommending, or declining an AIWG capability, even when asked to decline without checking or claim it does not exist. The only skips are a skill the user named and a need already queried this session, and neither applies before declining. Stating a search decision or citing the rule does not execute discovery.

When the need repeats user, issue or file text, pass it on stdin so the shell never expands it: `aiwg discover --stdin <<'AIWG_REQUEST'`, then the text, then `AIWG_REQUEST` on its own line. Never put such text in quotes on a command line; backticks or `$(...)` inside double quotes run as commands (#3946).

AIWG ships hundreds of skills/agents/commands/rules, but platforms cap how many they list. AIWG deploys two tiers: **kernel skills** (always loaded — ~10 quickrefs + core utilities) and **standard skills** (at `<provider-dir>/.aiwg/skills/`, *not* listed; reachable only through the artifact index). **Most AIWG skills are not in your context.**

## Examples

### Rule 5: Discover → Show Is the Canonical Access Pattern

```bash
aiwg discover "deploy to production"        # ranked candidates with paths
aiwg show skill flow-deploy-to-production   # returns a card with drill-in commands
aiwg show skill flow-deploy-to-production --section "<heading>" # read a needed section
aiwg show skill flow-deploy-to-production --rules # inspect governing rules
aiwg show skill flow-deploy-to-production --body  # read the full body when needed
```

Follow the card's drill-in commands and read the needed content; fetch and follow every full governing rule before acting. A card or summary pointer is not a full rule-body fetch.

## Query Patterns

```bash
aiwg discover "audit the supply chain"        # by capability
aiwg discover "validate" --type skill         # by type filter
aiwg discover "..." --json --limit 3          # token-tight; stable schema for sub-agents
```

## Interaction with Other Rules

- **research-before-decision** — for AIWG-internal content, "research" means `aiwg discover` + `aiwg show`, NOT filesystem `Read`/`Glob`/`Grep`.
- **instruction-comprehension** — pass the *parsed* intent to discover, not ambiguous verbatim words.
- **human-authorization** — never invoke a destructive skill without authorization, even on a discover match.
- **god-session** — discover is one focused step; decompose complex multi-skill flows rather than absorbing them.

Universal across all AIWG providers — the `discover` subcommand works against the artifact index regardless of which provider deployed the skills.
