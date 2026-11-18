---
activation: paths
summary: "Apply the audience-appropriate voice using project, user, then built-in profile precedence; write precisely with concrete examples and varied structure."
bound_to:
  skills:
    - output-mode-guide
    - voice-analyze
    - voice-apply
    - voice-blend
    - voice-create
enforcement: medium
paths:
  - "**/*.md"
  - "**/*.txt"
  - "docs/**"
  - "content/**"
  - "agentic/code/addons/voice-framework/**"
---

# Voice Framework Rules

**Enforcement Level**: MEDIUM
These rules apply when working with markdown, documentation, or content files.

## Voice Profiles

The Voice Framework provides consistent, authentic writing through predefined profiles.

### Built-in Profiles

Located in `agentic/code/addons/voice-framework/voices/templates/`:

| Profile | Use For | Characteristics |
|---------|---------|-----------------|
| `technical-authority` | Docs, architecture, API refs | Direct, precise, confident |
| `friendly-explainer` | Tutorials, onboarding, guides | Approachable, encouraging |
| `executive-brief` | Business cases, summaries | Concise, outcome-focused |
| `casual-conversational` | Blogs, newsletters, community | Relaxed, personal |

### Profile Priority (First Found Wins)

1. Project: `.aiwg/voices/` (project-specific)
2. User: `~/.config/aiwg/voices/` (user-wide)
3. Built-in: `voice-framework/voices/templates/` (AIWG defaults)

## Voice Skills

| Skill | Purpose |
|-------|---------|
| `voice-apply` | Apply voice profile to content |
| `voice-create` | Generate new voice from description |
| `voice-blend` | Combine multiple profiles (e.g., 70% technical + 30% casual) |
| `voice-analyze` | Analyze content's current voice characteristics |

### Usage Examples

Natural language (skills auto-trigger):
- "Write this in technical-authority voice"
- "Make it more casual"
- "Create a voice for API docs - precise, no-nonsense"
- "Blend 70% technical with 30% friendly"

## Writing Principles

When generating or reviewing content:

1. **Apply appropriate voice**: Match audience and context
2. **Maintain sophistication**: Preserve domain-appropriate vocabulary - don't dumb down
3. **Preserve evidence**: Use supplied opinions, trade-offs and constraints only where relevant; never invent them
4. **Vary structure**: Mix sentence lengths, paragraph structures, transition styles
5. **Be specific**: Replace vague claims with exact metrics and concrete examples

## Shared structural review

Profiles inherit the [shared structural rules](../../writing-quality/patterns/common-ai-tells.md).
Use their examples, fixes and cut/check/watch priorities during generation and
review. Review contrasts, mirrored pairs, moral endings, significance labels,
generic openings, effect triads, summary closers, colon reveals, fragments,
staged quips, throat-clearing and engagement bait. This is not authorship detection.
Em dashes, colons, semicolons, passive voice, plain transitions and real lists
are not patterns on their own. Preserve necessary uncertainty and source meaning.

Campaign review checks copied thesis lines across channels, repeated release
openers and closers, recycled jokes and signature moves used as lede formulas.
Verify substance for articles and how-tos: a usable configuration, command,
prompt, script or result. Never invent facts or manufacture errors or casualness.
Automated checks cover only part of these editorial guidelines.

## Content Quality Guidelines

Authority comes from expertise (not formality), sophistication from precision (not complexity), and authenticity from honesty (not casualness).

### Avoid

- Performative language ("It's important to note...")
- Excessive hedging ("might", "could potentially")
- Empty superlatives ("very", "really", "extremely")
- Passive constructions where active works better

### Prefer

- Direct statements
- Concrete examples
- Measured confidence
- Technical precision when warranted

## AI Pattern Detection

Use `/ai-pattern-detection` skill or `/writing-validator` command to identify and fix:
- Overused AI-characteristic phrases
- Repetitive sentence structures
- Generic language lacking specificity
- Missing authenticity markers
