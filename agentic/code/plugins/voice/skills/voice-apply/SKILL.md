---
namespace: aiwg
name: voice-apply
description: Apply a voice profile to transform content. Use when the user asks to write in a specific voice, match a tone, or sound like a particular voice profile.
version: 1.0.0
platforms: [all]
triggers:
  - "help write better content"
  - "help me make this writing clearer and consistent"
  - "choose voice writing validation or marketing flow"
  - "apply voice profile"

---

# Voice Apply Skill

## Local writing and participating consumer recipes

Use [author-controlled writing workflows](../../docs/writing-workflows.md) for the
actual `aiwg writing plan` and `aiwg writing proofread` commands, channel APIs,
bounded revision, explicit learning, scoped MCP resources and separate receipts.
Planning creates a structured artifact; proofreading applies exact listed
author-authorized corrections without a model or voice rewrite. A selected mode
is not an applied transformation. Unsupported consumers use explicit instruction
exports; never claim every provider response is intercepted. Keep original text
and unresolved review decisions recoverable. Publication controls remain with
the user's existing workflow.

## Reviewed voice application

For model-driven voice transformation, use the packaged [criticism/correction flow](../../flows/voice-critique-correction.flow.yaml) and [output impact guide](../../docs/voice-output-impact.md). The selected development lane uses one Astra draw and at most one correction with the primary session as reviewer. Neutral analytical packets are required; private author provenance stays outside generator and corrector context. Preserve the original unless a hash-bound review accepts both fidelity and cadence. This does not change deterministic proofread-only behavior or qualify all channels.

## Brief and fidelity contract

For author-controlled writing, prepare a structured
[writing brief](https://github.com/jmagly/aiwg/blob/main/docs/voice/writing-briefs.md) before generating prose.
Record reader task, supported propositions, limitations, intended action and
approved author notes. Missing first-person experiences or design rationale are
editorial gaps; do not invent them. Keep evidence strength independent of voice.
Proofread-only applies selected authorized correction IDs to the original source;
other operations expose explicit permissions and lineage for downstream execution.

Run [fidelity checks](https://github.com/jmagly/aiwg/blob/main/docs/voice/fidelity.md) after every final
structure/presentation pass. Uncertain paraphrases require review. Preserve the
original on configured fallback and report attempted versus retained changes
outside product prose. Automated literal guards are not semantic proof.

## Purpose

Transform content to match a specified voice profile. This skill loads voice profiles and applies their characteristics (tone, vocabulary, structure, perspective) to new or existing content.

Evidence constraints are recorded in [the natural voice ownership ADR](../../docs/natural-voice/ADR-001-evidence-and-ownership.md)
and [versioned ledger](../../docs/natural-voice/evidence-ledger.v1.json).
Treat phrase highlights as contextual editorial suggestions, never authorship
probabilities. Preserve supplied facts, uncertainty and author intent; an assertive
tone does not strengthen evidence. Author notes were already part of the cited
post-editing study. Neither topic-matched examples nor a fixed example count is
established as a universally best choice. The ledger is an evidence contract,
not a claim that the planned natural voice pipeline has been qualified.

## When This Skill Applies

- User asks to "write in X voice" or "use Y tone"
- User wants to "make this sound more [casual/formal/technical/etc.]"
- User provides content and asks to transform its style
- User references a voice profile by name
- User wants content to match a specific audience or context

## Trigger Phrases

| Natural Language | Action |
|------------------|--------|
| "Write this in technical voice" | Apply technical-authority profile |
| "Make it more casual" | Apply casual-conversational or calibrate toward casual |
| "This needs to sound executive" | Apply executive-brief profile |
| "Explain like I'm a beginner" | Apply friendly-explainer profile |
| "Use the [profile-name] voice" | Load and apply named profile |
| "Transform this to match [example]" | Analyze example, apply derived voice |

## Voice Profile Locations

Skill checks these locations (in order):
1. Project: `.aiwg/voices/`
2. User: `~/.config/aiwg/voices/`
3. Built-in: `voice-framework/voices/templates/`

## Built-in Voice Profiles

| Profile | Description | Best For |
|---------|-------------|----------|
| `technical-authority` | Direct, precise, confident | Docs, architecture, engineering |
| `friendly-explainer` | Approachable, encouraging | Tutorials, onboarding, education |
| `executive-brief` | Concise, outcome-focused | Business cases, stakeholder comms |
| `casual-conversational` | Relaxed, personal | Blog posts, social, newsletters |

## Application Process

### 1. Load Voice Profile

```python
# Load from YAML
profile = load_voice_profile("technical-authority")
```

### 2. Analyze Source Content (if transforming)

- Current tone characteristics
- Vocabulary patterns
- Structure patterns
- Gap analysis vs target voice

### 3. Apply Voice Characteristics

**Tone Calibration**:
- Adjust formality level (word choice, contractions)
- Preserve evidence strength and all required hedging; adjust expression only
- Set warmth (clinical vs personable)
- Tune energy (measured vs enthusiastic)

**Vocabulary Transformation**:
- Replace words per `prefer`/`avoid` guidance
- Introduce domain terminology naturally
- Use characteristic phrasing only where natural and supported; never insert signatures mechanically

**Structure Adjustment**:
- Modify sentence length distribution
- Adjust paragraph breaks
- Reorganize supported material within edit permissions; do not invent examples or analogies that add claims

**Perspective Shift**:
- Adjust narrative person (I, we, you, they)
- Preserve supported opinions and attribution; do not invent a viewpoint
- Set reader relationship tone

### 4. Verify Authenticity Markers

Check these properties only when supported by the source; never invent them to satisfy a profile:
- Acknowledges uncertainty (if specified)
- Shows tradeoffs (if specified)
- Uses specific numbers (if specified)
- References constraints (if specified)

## Usage Examples

### Apply Named Voice

```
User: "Write release notes in technical-authority voice"

Process:
1. Load technical-authority.yaml
2. Generate release notes with:
   - Precise technical terminology
   - Specific version numbers
   - Direct, confident statements
   - Tradeoff acknowledgments where relevant
```

### Transform Existing Content

```
User: "Make this documentation more friendly for beginners"

Input: "The API endpoint accepts a JSON payload containing the requisite parameters..."

Process:
1. Load friendly-explainer.yaml
2. Analyze: formal, technical, passive
3. Transform to: casual, accessible, active

Output: "To use this endpoint, send it some JSON with the info it needs..."
```

### Calibrate Voice

```
User: "This is too formal, dial it back 30%"

Process:
1. Identify current formality (~0.8)
2. Calculate target (0.8 - 0.3 = 0.5)
3. Adjust vocabulary and structure for medium formality
```

## Voice Blending

Combine multiple profiles:

```
User: "Write this with 70% technical-authority and 30% friendly-explainer"

Process:
1. Load both profiles
2. Weighted merge:
   - tone.formality: 0.7 * 0.7 + 0.3 * 0.3 = 0.58
   - tone.warmth: 0.7 * 0.3 + 0.3 * 0.8 = 0.45
   - etc.
3. Apply merged profile
```

## Script Reference

### voice_loader.py
Load and validate voice profiles:
```bash
python scripts/voice_loader.py --profile technical-authority
```

### voice_analyzer.py
Analyze content against voice profile:
```bash
python scripts/voice_analyzer.py --content input.md --profile technical-authority
```

## Integration

Works with:
- `/voice-apply` command for explicit invocation
- `/voice-create` command for generating new profiles
- SDLC templates (apply appropriate voice per artifact type)
- Marketing templates (brand voice consistency)

## Output Format

When reporting voice application:

```
Voice Applied: technical-authority

Transformations:
- Formality: 0.4 → 0.7 (increased)
- Evidence strength: unchanged; original qualifications retained
- Vocabulary: 12 replacements
- Structure: reordered supported clauses within approved edit scope

Authenticity Check:
✓ Acknowledges tradeoffs
✓ Uses specific numbers
✓ References constraints
```

## References

- @$AIWG_ROOT/agentic/code/addons/voice-framework/README.md — Voice framework addon overview and profile documentation
- @$AIWG_ROOT/agentic/code/addons/voice-framework/voices/templates/ — Built-in voice profile templates
- @$AIWG_ROOT/agentic/code/addons/writing-quality/README.md — Writing quality addon for authenticity enforcement
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference for voice commands
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md — Parsing voice and style directives accurately
