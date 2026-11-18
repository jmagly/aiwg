# Voice Framework Addon

Evidence status: design intent.

Voice profile and composable output-mode system for crafting and applying consistent writing. Define custom voices, apply runtime language constraints, and create personal or project styles.

## Overview

The Voice Framework combines positive voice definition with the
[shared structural editing rules](../writing-quality/patterns/common-ai-tells.md).
Profiles inherit tiered examples and fixes for rhetorical frames, campaign reuse
and substance in articles and how-tos. These are editing guidelines, not
authorship detection. Preserve supported facts and intentional expression;
never manufacture errors, quips or signature formulas. The
[contextual diagnostics guide](docs/contextual-diagnostics.md) describes the
automated checks and the editorial review they still require.

## Author-controlled writing

[Writing workflows](docs/writing-workflows.md) documents the local plan/proofread
CLI, five channel packs, bounded revision, explicit learning, scoped MCP reads
and separate receipts. These are opt-in consumers with explicit state reporting.
Selection alone does not apply a profile to provider responses.

Legacy YAML voices below remain supported as expression presets. Their numeric
tone fields are not evidence-confidence or authorship measures, and signature
phrase examples are optional author choices rather than automatic insertions.

## Installation

```bash
# Deploy with Writing Quality addon
aiwg use writing

# Or deploy with all frameworks
aiwg use all
```

## Built-in Voice Profiles

Located in `voices/templates/`:

| Profile | Description | Best For |
|---------|-------------|----------|
| `technical-authority` | Direct, precise, confident | API docs, architecture, engineering specs |
| `friendly-explainer` | Approachable, encouraging | Tutorials, onboarding guides, education |
| `executive-brief` | Concise, outcome-focused | Business cases, stakeholder communications |
| `casual-conversational` | Relaxed, personal | Blog posts, social media, newsletters |

## Skills

The Voice Framework provides 5 skills discoverable from task context:

### voice-apply

Transform content to match a specified voice profile.

**Triggers:**
- "Write this in technical voice"
- "Make it more casual"
- "Use the executive-brief voice"
- "Transform this to match [example]"

### voice-create

Generate new voice profiles from descriptions or examples.

**Triggers:**
- "Create a voice for API documentation"
- "Make a voice profile from this sample"
- "Define a new voice that's precise but friendly"

### voice-blend

Combine multiple voice profiles with weighted ratios.

**Triggers:**
- "Blend 70% technical with 30% friendly"
- "Mix executive and casual voices"
- "Combine these two profiles"

### voice-analyze

Analyze content's current voice characteristics.

**Triggers:**
- "What voice is this written in?"
- "Analyze the tone of this document"
- "How formal is this content?"

### output-mode-guide

Configure, apply, troubleshoot, or extend composable output modes (also called output masks).

**Triggers:**
- "Use the Wittgenstein-inspired output mode"
- "Apply engineering standards language"
- "Create my preferred syntax style"
- "Why is this output mask not changing anything?"

See `docs/output-modes.md` for the user guide and links to custom-profile,
integration, and troubleshooting guidance.

## Voice Profile Locations

Skills check these locations in priority order:

1. **Project:** `.aiwg/voices/` (project-specific profiles)
2. **User:** `~/.config/aiwg/voices/` (user-wide profiles)
3. **Built-in:** `voice-framework/voices/templates/` (AIWG defaults)

## Voice Profile Schema

Voice profiles are YAML files defining:

```yaml
name: technical-authority
description: Direct, precise, confident voice for technical content

tone:
  formality: 0.7       # 0=casual, 1=formal
  confidence: 0.9      # 0=tentative, 1=assertive
  warmth: 0.3          # 0=clinical, 1=personable
  energy: 0.4          # 0=measured, 1=enthusiastic

vocabulary:
  prefer:
    - "specifically"
    - "in practice"
    - "for example"
  avoid:
    - "leverage"
    - "utilize"
    - "seamlessly"
  signature_phrases:
    - "the key constraint here is"
    - "worth noting that"

structure:
  sentence_length: "varied"
  paragraph_style: "technical"
  use_lists: true
  include_examples: true

perspective:
  person: "second"      # first, second, third
  opinion_level: 0.6    # 0=objective, 1=opinionated
  uncertainty_shown: true

authenticity:
  acknowledge_tradeoffs: true
  reference_constraints: true
  use_specific_numbers: true
```

## Usage Examples

### Apply a Built-in Voice

```
User: "Write release notes in technical-authority voice"

Output: Release notes with precise terminology, specific version numbers,
direct statements, and tradeoff acknowledgments.
```

### Transform Existing Content

```
User: "Make this documentation more friendly for beginners"

Input: "The API endpoint accepts a JSON payload containing the requisite parameters..."

Output: "To use this endpoint, send it some JSON with the info it needs..."
```

### Create a Custom Voice

```
User: "Create a voice for our internal docs - casual but technically precise"

Output: New voice profile YAML saved to .aiwg/voices/internal-docs.yaml
```

### Blend Voices

```
User: "Write this with 70% technical and 30% friendly"

Process: Weighted merge of both profiles, applying combined characteristics.
```

## Shared review guidance

Voice profiles describe expression preferences. The writing-quality
[review checklist](../writing-quality/validation/banned-patterns.md) supplements
them with structural and campaign review. A profile selection or a clean scan
does not certify quality or authorize publication.

## Dependencies

None. Works standalone or with any framework.

## File Structure

```
voice-framework/
├── manifest.json           # Addon metadata
├── README.md               # This file
├── skills/
│   ├── voice-apply/        # Apply voice profiles
│   │   └── SKILL.md
│   ├── voice-create/       # Create new profiles
│   │   └── SKILL.md
│   ├── voice-blend/        # Combine profiles
│   │   └── SKILL.md
│   └── voice-analyze/      # Analyze voice characteristics
│       └── SKILL.md
├── voices/
│   └── templates/          # Built-in voice profiles
│       ├── technical-authority.yaml
│       ├── friendly-explainer.yaml
│       ├── executive-brief.yaml
│       └── casual-conversational.yaml
└── schemas/
    └── voice-profile.schema.json  # YAML validation schema
```

## Contributing

To add new built-in voices:

1. Create YAML profile in `voices/templates/`
2. Follow the schema in `schemas/voice-profile.schema.json`
3. Update `manifest.json` to include the new voice
4. Add examples to the skill documentation

## License

MIT - See [LICENSE](../../../../LICENSE)

## Reviewed voice transformation

See the [selected workflow and output impact](docs/voice-output-impact.md) for the development default, neutral profile policy, measured acceptance, fallback behavior and qualification limits.
