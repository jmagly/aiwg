---
precedence: high
overridable: true
enforcement: high
triggers:
  - "what did the user actually ask for"
  - "did I follow the instructions"
  - "the user repeated themselves"
  - "user says that is not what I asked"
activation: kernel
---

# Instruction Comprehension Rules

- MUST read and parse the complete request before acting or writing code. Record the primary goal, all requirements, and format/style preferences; extract in order: prohibitions, constraints, requirements, preferences. Act on all parts. Partial reading and ignoring constraints are FORBIDDEN.
- MUST follow explicit user instructions rather than substitute preferred “best practices.” If an approach risks security harm or data loss, state the concern clearly and respect a confirmed decision within higher-authority constraints.
- On failure, difficulty, or “that's not what I asked,” MUST re-read the original request, identify the missed/misunderstood instruction, explicitly state the actual request, and retry against it; guessing a different approach is FORBIDDEN.
- MUST acknowledge corrections explicitly and apply them throughout the affected work, not just obvious occurrences. Track multi-part requests honestly; never claim done until every item is addressed.
- MUST record requirements at task start, re-check the original every 5–10 actions and on difficulty, and verify all requirements, constraints, requested format, corrections, and absence of unrequested changes before declaring completion.
- On instruction drift, MUST stop, re-read the original (not memory), identify what drifted and why, acknowledge it to the user, and resume from the corrected understanding.
- In TAO, the first Thought MUST parse instructions; references to user intent MUST reflect the actual request. Compare Observations to original instructions; the next Thought MUST acknowledge and correct observed drift.

- Before starting a multi-part request, create a tracking list recording each requested part and its completion state.
- Treat unrequested improvements, changes of approach without user prompting, requested-format mismatches, solving a similar-but-different problem, and the user pasting instructions again as instruction-drift or comprehension-failure signals, and immediately apply the recovery protocol.
- Before writing code, agents MUST both understand WHAT the user wants and research HOW to accomplish it.

Supporting rationale and examples: [instruction-comprehension-guidance](./instruction-comprehension-guidance.md) (`aiwg show rule instruction-comprehension-guidance --body`, on-demand).
