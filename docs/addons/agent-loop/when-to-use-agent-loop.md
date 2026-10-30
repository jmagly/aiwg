# When to Use Al (And When Not To)

Understanding Al's sweet spot and avoiding the token-burning trap.

## The Controversy

Al divides people. Some swear by it. Others have war stories about it running all night, burning tokens, producing junk. Both are right - Al is a power tool, and like any power tool, it can build or destroy depending on how you use it.

**The truth**: Al's effectiveness is directly proportional to how well-defined your project is before you invoke it.

## The Two Extremes

### The Disaster Case: Greenfield + Vague Directive

> "Check whether this vague app request is ready for an implementation loop."

Your assistant identifies missing requirements before using the loop; the following command illustrates the failure case.

#### Command reference

```bash
# DON'T DO THIS
/ralph "make me a baking app" --completion "app works"
```

What happens:

1. AI has no context about what "baking app" means
2. No architecture decisions have been made
3. No requirements exist
4. AI hallucinates features, changes direction, contradicts itself
5. Each iteration builds on shaky foundations
6. Thrashing intensifies as hallucinated components conflict
7. Token usage explodes
8. Result: A mess that barely runs, if at all

**Why this fails**: The AI is trying to answer "WHAT to build" while simultaneously trying to figure out "HOW to build it." These are fundamentally different problems. Mixing them creates chaos.

### The Success Case: Documented Project + Implementation Focus

> "Implement the documented login use case and verify its completion commands."

Your assistant uses the defined use case and architecture to scope the implementation loop.

#### Command reference

```bash
# DO THIS
/ralph "Implement UC-AUTH-001 user login per the architecture doc" \
  --completion "npm test -- auth passes AND npx tsc --noEmit passes"
```

What happens:

1. UC-AUTH-001 defines exactly what login should do
2. Architecture doc specifies technology choices
3. AI knows the patterns, conventions, dependencies
4. Each iteration focuses purely on implementation details
5. Failures are specific: wrong import, missing mock, edge case
6. AI learns from specific failures and fixes them
7. Convergence to working code is predictable

**Why this works**: The "WHAT" is settled. Al focuses entirely on "HOW" - the implementation mechanics where iteration genuinely helps.

## The AIWG + Al Synergy

AIWG was designed with Al in mind. The entire SDLC framework exists to create a corpus so complete that an AI can't thrash on what to build - it can only focus on how.

### What AIWG Provides

| AIWG Artifact | Eliminates This Uncertainty |
|---------------|----------------------------|
| Project Intake | What problem are we solving? |
| Requirements (UC-*, US-*) | What features do we need? |
| Software Architecture Doc | What tech stack, patterns, structure? |
| ADRs | What decisions were made, and why? |
| NFR modules | What are the quality requirements? |
| Pseudo-code / interface specs | What's the API shape? |

### The Transformation

```
Without AIWG:
┌─────────────────────────────────────────────────────────┐
│  Al → "What to build?" → Hallucinate → Thrash → $$$  │
└─────────────────────────────────────────────────────────┘

With AIWG:
┌─────────────────────────────────────────────────────────┐
│  AIWG → Defines "What" → Al → "How to build" → Done  │
└─────────────────────────────────────────────────────────┘
```

### Documentation as Specification

By the time you've completed AIWG's Discovery Track:

- Every feature is defined in a use case
- Every decision is recorded in an ADR
- The architecture is documented with component diagrams
- Non-functional requirements are explicit
- Even pseudo-code or interface shapes may exist

**The docs are one step away from code.** Al's job becomes mechanical: translate this specification into working code, iterate on the implementation details until tests pass.

## When Al Excels

### Implementation of Well-Defined Features

> "Implement UC-PAY-003 and use its payment tests as the completion check."

Your assistant iterates on the specified use case with the completion command below.

#### Command reference

```bash
/ralph "Implement @.aiwg/requirements/UC-PAY-003.md" \
  --completion "npm test -- payment passes"
```

The use case document tells Al exactly what to build. Al figures out the implementation.

### Mechanical Transformations

> "Convert the utility files to TypeScript following ADR-012 and verify compilation."

Your assistant uses the ADR to constrain the iterative transformation.

#### Command reference

```bash
/ralph "Convert src/utils/*.js to TypeScript per @.aiwg/architecture/adr-012-typescript.md" \
  --completion "npx tsc --noEmit passes"
```

The ADR defines the transformation rules. Al applies them iteratively.

### Test-Driven Fixes

> "Fix the failing authentication tests and verify the authentication suite."

Your assistant uses the failing tests to define the bounded loop target.

#### Command reference

```bash
/ralph "Fix all failing tests in src/auth/" \
  --completion "npm test -- auth passes"
```

Tests define expected behavior. Al makes code match expectations.

### Dependency Resolution

> "Update to React 19 and resolve breaking changes until tests and the build pass."

Your assistant uses the test and build commands as completion checks for the migration.

#### Command reference

```bash
/ralph "Update to React 19 and fix all breaking changes" \
  --completion "npm test passes AND npm run build succeeds"
```

Al excels at the tedious iteration of finding compatible versions and fixing API changes.

### Code Quality Gates

> "Raise service test coverage to the specified threshold and verify the report."

Your assistant uses the scoped coverage target as the loop completion criterion.

#### Command reference

```bash
/ralph "Achieve 80% test coverage in src/services/" \
  --completion "coverage report shows src/services >80%"
```

Clear metric, well-defined scope. Al adds tests until the threshold is met.

## When NOT to Use Al

### Greenfield Without Documentation

> "Define the requirements and architecture before starting an implementation loop."

Your assistant uses the intake and lifecycle flows before implementing a documented use case.

#### Command reference

If you have no architecture doc, no requirements, no design - **stop**. Don't invoke Al. Use the AIWG intake process first.

```bash
# First: Define what you're building
/intake-wizard
/flow-concept-to-inception
/flow-inception-to-elaboration

# Then: Build it
/ralph "Implement UC-001" --completion "tests pass"
```

### Vague or Subjective Goals

> "Help me replace this subjective goal with an objectively verifiable task."

Your assistant asks for a concrete target before invoking a loop; the following commands illustrate goals to avoid.

#### Command reference

```bash
# BAD - cannot verify, no clear target
/ralph "make the code better" --completion "code is good"
/ralph "improve UX" --completion "users are happy"
/ralph "optimize performance" --completion "app is fast"
```

If you can't write a command that verifies success, Al can't iterate toward it.

### Research or Exploration

> "Explore the authentication design before starting implementation."

Your assistant uses discovery or manual exploration; the command below illustrates an unsuitable implementation loop.

#### Command reference

```bash
# BAD - this isn't an implementation task
/ralph "figure out how authentication should work" --completion "auth design is done"
```

Use `/flow-discovery-track` or manual exploration for research. Al is for implementation.

### Undefined Scope

> "Break the remaining app work into specific documented features before looping."

Your assistant narrows the scope first; the command below illustrates an undefined completion target.

#### Command reference

```bash
# BAD - how many features is "complete"?
/ralph "finish the app" --completion "app is complete"
```

Break this into specific, documented features first.

## Al for Documentation (Carefully Scoped)

> "Generate the missing architecture decisions or use cases from the specified source material with explicit completion checks."

Your assistant keeps documentation loops bounded to the requested artifacts and verifiable criteria.

### Command reference

Al can help with documentation itself - but only with specific, verifiable scope:

```bash
# GOOD - specific, verifiable
/ralph "Generate ADRs for all undocumented technical decisions in src/" \
  --completion ".aiwg/architecture/adr-*.md exists for each major pattern"

# GOOD - specific output
/ralph "Create use cases from the feature list in product-brief.md" \
  --completion "Each feature in product-brief.md has a corresponding .aiwg/requirements/UC-*.md"
```

```bash
# BAD - too vague
/ralph "document the project" --completion "docs are complete"
```

## Warning Signs: Is Al Thrashing?

> "Review this repeating loop failure and stop it if the requirements need repair."

Your assistant checks the warning signs below and uses the abort path before revising the specification.

### Command reference

Watch for these indicators:

| Sign | What It Means |
|------|---------------|
| Same error repeating | Structural problem, not implementation detail |
| Contradictory changes | No clear requirements to guide decisions |
| Growing file count | Hallucinating features not in scope |
| Unrelated files changing | Lost context, working on wrong problem |
| "Refactoring" without tests | No verification, just churning |

**If you see these**: Abort Al, create documentation, then resume.

```bash
/ralph-abort
# Create/update requirements docs
# Define architecture decisions
/ralph "Implement [specific, documented feature]" --completion "tests pass"
```

## The Al Readiness Checklist

> "Check this feature against the loop readiness checklist before implementation."

Your assistant reviews scope, requirements and verification commands before invoking the loop.

### Command reference

Before invoking Al, ask:

- [ ] Is the feature documented in a use case or user story?
- [ ] Is the architecture defined (or simple enough to be implicit)?
- [ ] Can I write a command that verifies success?
- [ ] Is the scope specific enough to complete in <20 iterations?
- [ ] Are tests available to validate correctness?

**If any answer is "no"**: Document first, Al second.

## Summary

| Situation | Action |
|-----------|--------|
| Greenfield, no docs | Use AIWG intake/flows first |
| Vague requirements | Write use cases first |
| No architecture | Create SAD/ADRs first |
| Clear spec, need implementation | **Use Al** |
| Tests failing, need fixes | **Use Al** |
| Migration with clear rules | **Use Al** |
| Coverage gap with clear target | **Use Al** |

**The formula**: AIWG defines WHAT. Al implements HOW. Together they work. Apart, Al thrashes.

## Industry Perspectives and Research

The debate around iterative AI execution isn't unique to Al. Here's what the broader industry has learned.

### The Context Problem

[Augment Code's research](https://www.augmentcode.com/learn/agentic-swarm-vs-spec-driven-coding) found that both agentic swarms and specification-driven development fail for the same reason: they assume the hard problem is coordination or planning, not context understanding.

> "Context understanding trumps coordination strategy... Perfect coordination doesn't help when agents are coordinating around incomplete information. Comprehensive specifications don't help when you can't specify what you don't fully understand."

**AIWG's answer**: Create comprehensive context *first* through documentation. Al then operates in a rich-context environment where iteration actually helps.

### Loop Drift and Thrashing

[Research into agent loops](https://www.fixbrokenaiapps.com/blog/ai-agents-infinite-loops) identified "Loop Drift" as a core failure mode - agents misinterpreting termination signals, generating repetitive actions, or suffering from inconsistent internal state.

**Why this matters for Al**: Clear completion criteria with objective verification commands (exit codes, test results) prevent drift. Subjective criteria like "code is good" invite drift.

### Context Window Degradation

[Token cost research](https://agentsarcade.com/blog/reducing-token-costs-long-running-agent-workflows) confirms that context windows have a quality curve:

> "Early in the window, Claude is sharp. As tokens accumulate, quality degrades. If you try to cram multiple features into one iteration, you're working in the degraded part of the curve."

**Best practice**: Keep iterations focused on single changes. Al's git-based state persistence lets each iteration start with fresh context while inheriting the work from prior iterations.

### The Double-Loop Alternative

[Test Double's "double-loop model"](https://testdouble.com/insights/youre-holding-it-wrong-the-double-loop-model-for-agentic-coding) argues against prescriptive prompts entirely:

> "If you have to be super prescriptive with the AI agent, I might as well write the damn code."

Their approach: First loop for exploration (treat implementation as disposable), second loop for polish (traditional code review).

**AIWG's response**: Both models can work. Double-loop suits exploratory greenfield work where you're discovering requirements. Al + AIWG suits implementation of known requirements. The key is recognizing which phase you're in.

### Security Concerns

[NVIDIA's security research](https://developer.nvidia.com/blog/how-code-execution-drives-key-risks-in-agentic-ai-systems/) warns:

> "AI-generated code is inherently untrusted. Systems that execute LLM-generated code must treat that code with the same caution as user-supplied inputs."

**Al's safeguards**: Auto-commit creates rollback points. Tests verify correctness. Iteration limits prevent runaway execution. But the warning is real - always review final output before production.

### Success Stories

The Al methodology has proven effective for:

- **React v16 to v19 migration**: 14 hours autonomous, no human intervention ([source](https://sidbharath.com/blog/ralph-wiggum-claude-code/))
- **Overnight multi-repo delivery**: "Ship 6 repos overnight. $50k contract for $297 in API costs" ([source](https://venturebeat.com/technology/how-ralph-wiggum-went-from-the-simpsons-to-the-biggest-name-in-ai-right-now))
- **Test coverage improvement**: Iterative test addition until threshold met

The common thread: objectively verifiable goals with clear completion criteria.

### Expert Consensus

Industry practitioners have converged on these principles:

| Principle | Source |
|-----------|--------|
| Verification is mandatory | Anthropic research: "models tend to declare victory without proper verification" |
| Context beats coordination | Augment Code: "context understanding as the prerequisite for everything else" |
| Small iterations work better | Oreate AI: "context windows have a quality curve" |
| Safety limits are non-negotiable | Multiple sources: cap iterations, monitor costs, use sandboxes |
| Boring technologies work better | Oreate AI: stable APIs and mature toolchains outperform trendy alternatives |

### Contrary Views

Not everyone agrees Al is the answer:

**The "double-loop" camp** argues iteration should be exploratory first, not implementation-focused. They embrace disposable code during discovery.

**The "context-first" camp** argues that understanding existing systems matters more than any coordination strategy. They focus on codebase comprehension tools.

**The "human-in-the-loop" camp** argues autonomous execution is inherently risky. They prefer checkpoints and approval gates.

**AIWG's synthesis**: All three camps make valid points. AIWG addresses them by:
1. Supporting exploration during Discovery Track (not Al)
2. Building rich context through documentation before implementation
3. Providing iteration limits, auto-commits, and clear abort paths

Al isn't for every phase of development - it's for the implementation phase after discovery is complete.

## Related

- [Quickstart Guide](quickstart.md) - Getting started with Al
- [Best Practices](best-practices.md) - Writing effective tasks and criteria
- [AIWG SDLC Framework](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/sdlc-complete/docs/orchestrator-architecture.md) - Documentation-first development
- [Production Grade Guide](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/sdlc-complete/docs/production-grade-guide.md) - How to document before you build

## External Resources

- [The Original Breakdown](https://dev.to/ibrahimpima/the-ralf-wiggum-breakdown-3mko) - Original methodology explanation
- [VentureBeat: Iterative AI loops](https://venturebeat.com/technology/how-ralph-wiggum-went-from-the-simpsons-to-the-biggest-name-in-ai-right-now) - Industry adoption
- [Test Double: Double Loop Model](https://testdouble.com/insights/youre-holding-it-wrong-the-double-loop-model-for-agentic-coding) - Alternative approach
- [Augment Code: Spec-Driven vs Agentic](https://www.augmentcode.com/learn/agentic-swarm-vs-spec-driven-coding) - Context-first perspective
- [Reducing Token Costs](https://agentsarcade.com/blog/reducing-token-costs-long-running-agent-workflows) - Cost management strategies
