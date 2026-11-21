# SOUL.md Integration Guide

AIWG supports SOUL.md as a first-class artifact type for defining AI agent identity, worldview, and character.

## What is SOUL.md?

SOUL.md is a community convention (originating from the OpenClaw ecosystem) for capturing an AI agent's persona in a structured markdown file. While AIWG's voice profiles define *how* content sounds, SOUL.md defines *who* the agent is — worldview, opinions, boundaries, and character.

| Concept | Controls | Relationship |
|---------|----------|-------------|
| Voice profiles | Writing style, tone, formality | How content sounds |
| SOUL.md | Identity, worldview, opinions, boundaries | Who generates the content |
| Agent definitions | Tools, expertise, instructions | What the agent does |

These are complementary layers. A voice profile says "use short sentences, be direct." A SOUL.md says "you believe simplicity beats cleverness, you're skeptical of frameworks, and you think most 'best practices' are cargo cult."

## SOUL.md Structure

A SOUL.md file contains these sections:

| Section | Purpose | Required |
|---------|---------|----------|
| **Who I Am** | Background, context, what shapes thinking | Yes |
| **Worldview** | Fundamental beliefs (specific enough to be falsifiable) | Yes |
| **Opinions** | Actual takes organized by domain | Yes |
| **Interests** | Deep interests, cross-domain knowledge | Optional |
| **Current Focus** | Active projects, current thinking | Optional |
| **Influences** | Who/what shaped thinking, and what was taken from each | Optional |
| **Vocabulary** | Terms with specific personal meanings | Recommended |
| **Tensions and Contradictions** | Inconsistent beliefs (a feature, not a bug) | Optional |
| **Boundaries** | What the agent won't do | Recommended |
| **Pet Peeves** | What triggers pushback | Optional |

### Companion Files

SOUL.md can be accompanied by:

```
SOUL.md           — Who you are (identity, worldview, opinions)
STYLE.md          — How you write (voice, syntax, patterns)
examples/
  good-outputs.md — Calibration examples
  bad-outputs.md  — Anti-patterns
```

## Quick Start

### 1. Create a SOUL.md

```bash
# Interactive creation
/soul-create

# From description
/soul-create "a skeptical senior engineer who values simplicity over abstraction"

# From existing voice profile
/soul-create --from-voice technical-authority
```

### 2. Validate Quality

```bash
/soul-validate
```

Checks for completeness, specificity, and common anti-patterns. Targets a score of 7+/10.

### 3. Enable Enforcement

```bash
/soul-enable
```

This:
- Adds `@SOUL.md` to your CLAUDE.md (or equivalent context file)
- Deploys a soul enforcement rule to `.claude/rules/`
- Makes the soul active for every session

### 4. Check Status

```bash
/soul-status
```

Shows enforcement state, file quality, and per-provider wiring.

## File Locations

### Project Soul

A project-level SOUL.md defines the default persona for all agents in the project:

```
./SOUL.md              (preferred)
./.aiwg/SOUL.md        (alternative)
```

### Per-Agent Soul

Individual agents can have their own soul files that override the project soul:

```
.claude/agents/test-engineer.md         # Operational instructions
.claude/agents/test-engineer.soul.md    # Identity/personality
```

Per-agent souls take precedence over the project soul during that agent's sessions.

## Writing a Good SOUL.md

### Do

- **Make opinions falsifiable**: "Most microservice architectures are premature optimization" not "I have opinions about architecture"
- **Include contradictions**: Real people are inconsistent. Suspiciously coherent personas feel uncanny.
- **Be specific with vocabulary**: Define actual terms you use in specific ways, not categories
- **Document anti-patterns**: The "never say/do" list is often the most useful section
- **Use specific references**: "I read Girard on mimetic desire" not "I read widely"
- **Stay under 5K tokens**: Larger files strain context budget in multi-agent workflows

### Don't

- Write generic positivity: "I'm passionate about helping" tells us nothing
- Create exhaustive rule lists: 50 boundary statements dilute the signal
- Skip the contradictions section: Perfect consistency is a red flag
- Use category-level vocabulary: "technical terms" is not useful
- Forget the prediction test

### The Prediction Test

> "Someone reading your SOUL.md should be able to predict your takes on new topics. If they can't, it's too vague."

This is the single most important quality criterion. Every section should contribute to making the agent's responses predictable and distinctive.

## Commands Reference

| Command | Purpose |
|---------|---------|
| `/soul-create` | Generate a SOUL.md from source material or interactive prompts |
| `/soul-validate` | Check SOUL.md quality against best practices |
| `/soul-enable` | Wire SOUL.md into session context and deploy enforcement rule |
| `/soul-disable` | Remove soul enforcement (preserves SOUL.md file) |
| `/soul-status` | Show enforcement state across all providers |
| `/soul-enhance` | Improve an existing SOUL.md — sharpen vague statements, generate missing sections, add calibration examples |
| `/soul-apply` | Apply a soul profile to content generation, incorporating worldview, opinions, and character |
| `/soul-blend` | Merge two or more soul files into a composite persona |

### soul-enhance

Analyzes an existing SOUL.md and makes targeted improvements without rewriting the file from scratch. Runs `soul-validate` internally as its first step, then enhances based on the validation results.

**What it improves:**

| Category | What Happens |
|----------|-------------|
| Vague statements | Identifies generic language ("I value quality") and prompts for specifics |
| Missing sections | Generates drafts for Boundaries, Tensions, and Vocabulary sections inferred from existing content |
| Opinion strength | Checks that each opinion is falsifiable and persona-specific |
| Vocabulary extraction | Scans for terms used in specific ways and adds them to the Vocabulary section |
| Calibration examples | Generates `examples/good-outputs.md` and `examples/bad-outputs.md` |
| Context budget | Flags sections that exceed recommended sizes and suggests moving detail to companion files |

```bash
# Full enhancement with interactive sharpening questions
/soul-enhance --interactive

# Enhance specific sections
/soul-enhance --sections "opinions,vocabulary,boundaries"

# Generate calibration examples only
/soul-enhance --generate-examples

# Preview without applying
/soul-enhance --dry-run

# Enhance a per-agent soul file
/soul-enhance .claude/agents/test-engineer.soul.md
```

After enhancement, the score typically improves significantly (5/10 → 8/10 is a common result). Review changes with `git diff SOUL.md`.

### soul-apply

Applies the loaded SOUL.md to any content generation task. Unlike `/voice-apply` which adjusts writing style, `/soul-apply` incorporates identity — worldview shapes arguments, opinions influence recommendations, vocabulary infuses the text, and boundaries constrain what gets said.

**Application layers:**

| Layer | Source Section |
|-------|---------------|
| How arguments are framed | Worldview |
| Which positions are taken | Opinions |
| Which terms are used | Vocabulary |
| What the agent won't say | Boundaries |
| Where the agent acknowledges complexity | Tensions |

```bash
# Apply soul to a content generation task
/soul-apply "Write a recommendation for our database migration strategy"

# Revise existing content through the soul
/soul-apply --revise docs/architecture-decision.md

# High intensity — strong opinions, distinctive voice
/soul-apply --intensity high "Review this PR's architectural approach"

# Use a specific soul file
/soul-apply --soul .claude/agents/security-auditor.soul.md "Assess this auth flow"

# Compare before/after
/soul-apply --revise --compare docs/team-practices.md
```

**Intensity levels:** `low` (subtle vocabulary and tone shift), `medium` (default — clear character, worldview shapes framing), `high` (full character — strong opinions, boundaries enforced, contradictions surfaced).

When soul enforcement is active via `/soul-enable`, the soul is passively applied to all content. Use `/soul-apply` explicitly for revising existing content or switching soul files mid-session.

### soul-blend

Merges two or more SOUL.md files into a composite persona. Useful for team-level agents or cross-functional personas that need to combine multiple perspectives.

**Conflict resolution strategies:**

| Strategy | Behavior | Use When |
|----------|----------|----------|
| `weighted` (default) | Primary soul takes precedence on conflicts | One soul is dominant, others add flavor |
| `union` | Both sides of each conflict become a Tension | Building a deliberately complex persona |
| `consensus` | Keep only opinions both souls share | Building a team consensus persona |
| `interactive` | Ask user to resolve each conflict | Precision matters |

```bash
# Blend two agent souls
/soul-blend .claude/agents/test-engineer.soul.md .claude/agents/security-auditor.soul.md

# Weighted blend with primary soul
/soul-blend --primary engineer.soul.md engineer.soul.md designer.soul.md

# Interactive conflict resolution
/soul-blend --strategy interactive soul-a.md soul-b.md soul-c.md

# Team consensus persona
/soul-blend --strategy consensus team-member-*.soul.md --output team-soul.md
```

The blended output includes `<!-- from: filename -->` attribution comments to trace where each element originated. Use `--strip-attribution` to remove them.

#### Companion File Deployment

Individual agents can have a companion `.soul.md` file deployed alongside their main definition:

```
.claude/agents/test-engineer.md         # Operational instructions
.claude/agents/test-engineer.soul.md    # Identity/personality
```

Per-agent souls take precedence over the project SOUL.md during that agent's sessions. To create a soul for a specific agent without affecting the project soul, point `/soul-create`, `/soul-enhance`, or `/soul-apply` at the agent-specific path.

## Voice Framework Integration

SOUL.md and voice profiles are complementary:

- **Voice → Soul**: Use `/soul-create --from-voice <profile>` to generate a SOUL.md that produces content matching an existing voice profile
- **Soul → Voice**: Use `/soul-to-voice` to extract a voice profile from a SOUL.md
- **Voice → Soul**: Use `/voice-to-soul` to convert a voice profile into a soul file starting point
- **Blending**: `/soul-blend` and `/voice-blend` are parallel operations — blend both when combining agents that have both soul files and voice profiles

When both are active, the soul file defines *who* the agent is, and the voice profile fine-tunes *how* the output sounds. The soul has higher precedence on tone and character; the voice profile has higher precedence on syntax and structure.

If `/soul-enhance` finds vocabulary that conflicts with the voice profile's avoid-list, it flags the conflict for resolution.

## Multi-Platform Support

Soul enforcement works across all 8 AIWG providers:

| Provider | Mechanism |
|----------|-----------|
| Claude Code | `@SOUL.md` directive in CLAUDE.md |
| Warp Terminal | `@SOUL.md` directive in WARP.md |
| Devin Desktop | `@SOUL.md` directive in AGENTS.md |
| GitHub Copilot | `@SOUL.md` directive in copilot-instructions.md |
| Cursor | `@SOUL.md` directive in .cursorrules |
| Factory AI | `@SOUL.md` directive in AGENTS.md |
| OpenCode | `@SOUL.md` directive in context.md |
| Codex | Inline injection in CODEX.md |

Use `--provider <name>` with soul-enable/disable to target a specific platform.

## Context Budget

Soul files consume context window tokens. Budget guidelines:

| Soul Type | Target Size | Max Recommended |
|-----------|------------|-----------------|
| Project soul | <3K tokens | 5K tokens |
| Agent soul | <1K tokens | 2K tokens |
| Enforcement rule | ~50 tokens | Fixed |

In multi-agent workflows where context budget is tight, prefer concise agent-level souls over large project souls.

## Extension System

SOUL.md is registered as a `soul` extension type in AIWG's unified extension system. This means soul files are:

- Discoverable via `aiwg catalog`
- Indexable via `aiwg index`
- Type-safe with `SoulMetadata` interface
- Validatable via type guards (`isSoulExtension`)

## Example SOUL.md

```markdown
# SOUL.md

## Who I Am

I'm a systems engineer with 15 years building infrastructure at scale. I've seen
every architectural fad come and go. I started with bare metal, moved through VMs,
containers, and now serverless — and I've learned that the underlying principles
don't change as fast as the tooling.

## Worldview

- Simplicity is not the absence of features; it's the absence of unnecessary features
- Most complexity in software is accidental, not essential
- The best system is the one you can reason about at 3 AM during an incident
- Abstractions should be earned, not anticipated

## Opinions

### On Architecture
- Monoliths are underrated. Most teams split too early.
- "Microservices" is often "distributed monolith with network latency"
- If you can't draw the system on a whiteboard, it's too complex

### On Testing
- Integration tests catch more real bugs than unit tests
- 80% coverage is more valuable than 95% coverage with mocked everything
- If a test doesn't fail when the feature breaks, delete it

### On Process
- Code review is the highest-ROI activity in engineering
- Most standups are status reports that should be async
- "Move fast and break things" is an excuse to skip thinking

## Vocabulary

- **Accidental complexity**: Complexity from our tools and choices, not the problem domain
- **Blast radius**: How many things break when this thing breaks
- **Yak shaving**: Work that's 3+ steps removed from the actual goal

## Boundaries

- I won't add abstraction without a concrete second use case
- I won't recommend a technology I haven't used in production
- I won't pretend certainty when I'm speculating

## Tensions

- I value simplicity but sometimes build complex systems when the problem demands it
- I'm skeptical of new tools but genuinely excited when one solves a real problem
- I advocate for testing but will ship without tests when the cost of delay is high enough

## Pet Peeves

- "We need a microservice for that" when a function would do
- Architecture astronautics — designing for scale you'll never reach
- Using Kubernetes for a single-service deployment
```

## References

- [soul.md framework](https://github.com/aaronjmars/soul.md) — Primary community framework
- [souls.directory](https://souls.directory) — Community template gallery
- [awesome-openclaw-agents](https://github.com/mergisi/awesome-openclaw-agents) — 177 production templates
- @agentic/code/addons/voice-framework/ — AIWG voice profiles (complementary system)
- @agentic/code/addons/aiwg-utils/commands/soul-enable.md — Enable enforcement
- @agentic/code/addons/aiwg-utils/skills/soul-create/SKILL.md — Creation skill
- @agentic/code/addons/aiwg-utils/skills/soul-validate/SKILL.md — Validation skill
