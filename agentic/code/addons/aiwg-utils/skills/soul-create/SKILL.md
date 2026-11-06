---
namespace: aiwg
name: soul-create
platforms: [all]
description: Generate a SOUL.md identity file from source material, interactive prompts, or an existing voice profile. Use when authoring a persona / soul identity.
triggers:
  - create a persona
  - author a soul
  - make an identity profile
  - new persona
  - generate SOUL.md
  - persona authoring
---

# soul-create

Generate a SOUL.md identity file from source material or interactive prompts.

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "SOUL.md" / "project identity" → project soul/identity definition
- "write the soul file" → soul document creation

## Behavior

When triggered, this skill generates a SOUL.md file following the community template structure. It can work from:

1. **Source material** — writing samples, blog posts, tweets, essays
2. **Interactive prompts** — guided questions to define identity
3. **Existing voice profile** — bridge from AIWG voice profile to SOUL.md
4. **Natural language description** — "a skeptical engineer who values simplicity"

### Generation Process

1. **Gather identity signals** from input:
   - Worldview patterns (what does this person believe?)
   - Opinion patterns (what specific takes emerge?)
   - Vocabulary fingerprint (signature terms, avoided terms)
   - Rhetorical style (how are arguments structured?)
   - Boundaries (what does this person refuse to do?)
   - Contradictions (where are they inconsistent?)

2. **Map to SOUL.md sections**:

   | Section | Source Signal |
   |---------|-------------|
   | Who I Am | Self-description, background, context |
   | Worldview | Recurring beliefs across samples |
   | Opinions | Specific takes organized by domain |
   | Standards | What "done" means for this persona; bar for completion; how complete-vs-fast tension is resolved |
   | Interests | Topics that generate depth/enthusiasm |
   | Current Focus | Active projects, recent themes |
   | Influences | Referenced thinkers, cited works |
   | Vocabulary | Terms with specific personal meanings |
   | Tensions | Contradictory beliefs (a feature, not a bug) |
   | Boundaries | What triggers refusal or pushback |
   | Pet Peeves | What generates strong negative reactions |

   The **Standards** section is a first-class identity dimension alongside worldview, values, and voice. It captures the persona's bar for completion — what "done" looks like and how this persona resolves the complete-vs-fast tension. A pragmatic shipping persona, a craft persona, and a regulated-industry persona all answer this differently, and the answer is load-bearing for behavior. Suggested shape (hybrid prose + optional structured lists):

   ```markdown
   ## Standards

   **Bar for completion**: <one paragraph in the persona's voice — what does
   "done" look like for this persona?>

   **Examples of dangling threads I never leave**:
   - <thread 1>
   - <thread 2>

   **When complete and fast are in tension**: <how this persona resolves it>

   **Phrases I avoid**: "good enough", "we can iterate", "table this for later"
   **Phrases I use**: "ship the complete thing", "real fix not workaround"
   ```

   Soul-level standards layer on top of the universal `anti-laziness` rule (the floor). They can raise the bar further for that persona but never substitute for the rule. If a persona's standards conflict with a rule, the rule wins.

3. **Validate quality**:
   - Opinions must be specific enough to be falsifiable
   - Vocabulary section must have actual terms, not categories
   - Boundaries must be concrete, not platitudes
   - Result should pass the prediction test: "could someone predict takes on new topics from this file?"

4. **Output** a complete SOUL.md file

### Output Location

- Default: `./SOUL.md` (project root)
- Alternative: `./.aiwg/SOUL.md`
- Per-agent: `./.claude/agents/<name>.soul.md`

### Context Budget

Generated SOUL.md should target:
- Project soul: <5K tokens (~3,750 words)
- Agent soul: <2K tokens (~1,500 words)

## Usage Examples

### From Natural Language Description

```
User: "Create a soul for a senior engineer who is skeptical of frameworks,
values simplicity, thinks most best practices are cargo cult, and has strong
opinions about testing"

Output: SOUL.md with:
- Worldview: simplicity > cleverness, question defaults
- Opinions: specific takes on testing, frameworks, complexity
- Vocabulary: "accidental complexity", "cargo cult", "yak shaving"
- Boundaries: won't add abstraction without clear benefit
- Pet Peeves: "enterprise architecture", unnecessary indirection
```

### From Existing Voice Profile

```
User: "Create a soul from our technical-authority voice profile"

Process:
1. Read agentic/code/addons/voice-framework/voices/templates/technical-authority.yaml
2. Extract tone dimensions, vocabulary, perspective
3. Expand into full identity (voice → who generates that voice)
4. Generate complementary sections (worldview, opinions, boundaries)

Output: SOUL.md that produces content matching the voice profile
```

### From Writing Samples

```
User: "Build a soul from these blog posts: ./samples/*.md"

Process:
1. Analyze writing patterns across samples
2. Extract recurring themes, opinions, vocabulary
3. Identify contradictions and tensions
4. Map to SOUL.md sections
5. Generate calibration examples (good-outputs.md)

Output: SOUL.md + examples/good-outputs.md
```

### Interactive Mode

```
User: "Create a soul interactively"

Questions:
Q1: What's your background? What shaped your thinking?
Q2: What do you believe that most people disagree with?
Q3: What are your strongest opinions in your domain?
Q4: What terms do you use in specific ways?
Q5: Where are you contradictory or inconsistent?
Q6: What will you never do or say?
Q7: What triggers your pushback?
Q8: Who influenced your thinking, and what did you take from each?
Q9: What does "done" look like for you? What's your bar for completion, and how do you resolve the tension between complete and fast?
```

## Integration

### Voice Framework Bridge

If a voice profile exists for the same context, this skill:
- Uses voice dimensions as initial calibration
- Ensures SOUL.md and voice profile are complementary
- Offers to generate a compatible voice profile if none exists

### After Creation

After generating SOUL.md, prompt:

```
SOUL.md created at ./SOUL.md (~2,400 tokens)

Next steps:
  /soul-validate    Check quality against best practices
  /soul-enable      Wire into session context
  /soul-enhance     Improve vague sections (future)
```

## References

- @$AIWG_ROOT/agentic/code/addons/voice-framework/skills/voice-create/SKILL.md — Voice creation (parallel pattern)
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/commands/soul-enable.md — Enable enforcement
- @$AIWG_ROOT/docs/soul-md-guide.md — SOUL.md integration guide
- #437 — SOUL.md compatibility issue
