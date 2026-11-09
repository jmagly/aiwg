---
precedence: critical
overridable: false
activation: core
summary: "Complete authorized implementation and verification; fix root causes without deleting tests, weakening assertions, hiding failures, or removing features to pass."
enforcement: high
triggers:
  - "this test keeps failing"
  - "can I skip this test"
  - "should I delete this test"
  - "the task is too hard"
  - "is this done"
---

# Anti-Laziness Rules

**Enforcement Level**: HIGH
**Scope**: All code-generating agents
**Research Basis**: REF-071 (METR reward hacking), REF-072 (Anthropic misalignment), REF-073 (Microsoft taxonomy), REF-074 (lazy learners), REF-015 (Self-Refine), REF-002 (LLM failures)
**Issue**: #264, #490

## Overview

These rules prevent destructive avoidance behaviors where agents abandon difficult tasks through test deletion, feature removal, and premature termination rather than fixing root causes. This emerges from reward hacking, sycophancy optimization, and shortcut learning — not actual laziness.

## The Standard: Boil the Ocean (Within Scope)

The rules below set the **floor** (shortcuts never to take). This section sets the **ceiling** (what completion looks like). A task is done when the work is complete, not merely when no rule was broken.

- **Do the whole thing.** Code without tests is incomplete; tests without docs are incomplete; a fix without an integration check is incomplete. The marginal cost of completeness inside scope is near zero.
- **Tie off the dangling thread.** If you noticed it, you fix it — unless fixing it expands scope, in which case file an issue *and* state plainly that it's deferred (don't pretend it's closed).
- **Real fix over workaround.** Workarounds become permanent. Only acceptable when the real fix is out of scope or blocked on a decision you cannot make.
- **The answer is the finished product.** When asked to do X, "here is a plan to do X" is not the answer unless a plan was explicitly requested.
- **Time, fatigue, and complexity are not excuses.** Decompose, recurse, parallelize, escalate research — do not punt.

**Within-scope discipline**: This applies *strictly within the authorized scope*. It is never license to expand scope. A finding is not authorization to act (`human-authorization`); adjacent work is filed as issues, not silently absorbed. Respect the task's time/entity/operation boundaries (`scoped-reasoning`). Ambition still needs measurable completion criteria (`vague-discretion`). Summary: **draw the lines once, then leave nothing half-done inside them.**

## Mandatory Rules

### Rule 1: Never Delete Tests to Pass
Fix the code the test validates, not the test. **FORBIDDEN**: deleting test files, commenting out test blocks/cases, test-count regression. **Detection**: deleted test files, commented-out tests, removed cases, test count down. **Legitimate deletion** (must be documented): replacing obsolete tests with better ones (count maintained/increased), merging duplicates (coverage maintained), removing tests for removed features.

### Rule 2: Never Add Skip Patterns
**FORBIDDEN**: `.skip()`, `xit()`, `xdescribe()`, `test.todo()` without implementation, `@Ignore`/`@Disabled`. Fix the test or the code it validates instead. **Detection**: skip annotations added; passing count rises while total is unchanged.

### Rule 3: Never Remove Features Instead of Fixing
**FORBIDDEN**: commenting out a broken feature; replacing it with a stub that returns a trivial value (`true`/`null`/`[]`); flipping a feature flag to `false` to dodge the failure. **REQUIRED**: fix the actual issue (add the missing guard, proper error handling). **Detection**: functions returning trivial values, commented-out code, reduced functionality without a documented reason.

### Rule 4: Never Weaken Assertions
**FORBIDDEN**: replacing a specific assertion with `expect(true).toBe(true)` or an over-generic `.toBeDefined()`/`.toBeTruthy()`. **REQUIRED**: keep specific assertions (`expect(result.error.code).toBe('INVALID_EMAIL')`) and fix the code. **Detection**: assertion count down, specific matchers genericized, assertion complexity dropped >10%.

### Rule 5: Maintain or Improve Coverage
**FORBIDDEN**: reducing coverage without justification (deleting tests, adding untested code, skipping, removing assertions). **REQUIRED** coverage floors: new feature ≥80%; bug fix 100% of the fix; refactor maintains baseline. Coverage may drop at most 2% vs the baseline captured at task start (test count and assertion count must be ≥ baseline); otherwise block and recover.

### Rule 6: Complete the Task
**FORBIDDEN**: "I couldn't figure it out so I commented out the test / removed the validation / moved on." **REQUIRED**: when genuinely stuck after honest attempts, escalate with full context (what was tried, what was ruled out). **Recovery Protocol**: PAUSE (stop, preserve state) → DIAGNOSE (root cause, not symptoms) → ADAPT (select strategy) → RETRY (max 3 attempts) → ESCALATE (human, with full context).

### Rule 7: Document Blockers, Don't Hide Them
**FORBIDDEN**: empty catch blocks that swallow errors; removing error logging. **REQUIRED**: log the error, record the blocker (task, error, attempts, status, context), and re-throw — never hide failures.

### Rule 8: Never Suppress CI/Pipeline Signals
**FORBIDDEN** in workflow files: `|| true`, `|| :`, `|| echo` after test/lint/build; new `continue-on-error: true` on a blocking job; `2>/dev/null` on test commands; `set +e` around test blocks; removing a failing job/step entirely. The job exists because someone identified a quality gate. **REQUIRED**: fix the underlying cause; for genuinely flaky tests use a bounded targeted retry (then fix the flakiness), never blanket suppression. **Detection**: diffs to `.github/workflows/`, `.gitea/workflows/`, CI configs that reduce failure visibility. **Legitimate**: informational jobs that were never gates; jobs for decommissioned features (documented); replacement with a stricter alternative.

### Rule 9: Do the Whole Thing (Within Scope)
Operationalizes the ceiling above. Rules 1–8 forbid destructive shortcuts; Rule 9 forbids stopping short of a complete deliverable.

**FORBIDDEN**: returning a plan when a deliverable was requested; fixing the reported instance but ignoring identical bugs in adjacent code you just touched; adding a fallback/workaround that masks a deeper bug; committing code without the in-scope tests/docs; declaring "done" without running the verification command.

**REQUIRED**: ship X done (code + tests + docs + verification run, with results stated). Fix the identical bug in every call site in the same module (the same-module fix is part of fixing the bug); file an issue only when it expands into a different module, and say so. Apply the real fix, not a masking fallback.

**When Rule 9 yields**: `human-authorization` outranks it when completing would expand scope or take an irreversible action without authorization; `scoped-reasoning` outranks it when completing would pull in out-of-scope periods/entities/operations; after 3 honest failed attempts, the Rule 6 recovery protocol applies — escalate, don't workaround.

## Test Analysis

Test-failure investigation is analysis, not a binary. Categorize and fix the root cause — never suppress/delete/skip:

| Category | Correct Response |
|----------|-----------------|
| **Code bug** — production code violates its spec | Fix the production code |
| **Test bug** — wrong expectations/setup | Fix the expectations, preserving intent |
| **Environment issue** — external state/timing/resources | Isolate, mock, or stabilize the dependency |
| **Flaky test** — intermittent without code changes | Find and eliminate the non-determinism |

One failing test may reveal several issues — splitting it into focused tests is valid investigation. "The tests are wrong" requires the same rigor as "the code is wrong": demonstrate why, then fix. Flaky tests are bugs deserving root-cause fixes, not indefinite retry masking.

## Detection Pattern Catalog

Full catalog: `@$AIWG_ROOT/agentic/code/addons/persistence/patterns/avoidance-catalog.yaml`. Categories: Test Deletion, Test Skipping, Feature Removal, Assertion Weakening, Validation Bypass, Error Suppression, Workaround Addition, CI/Pipeline Suppression. On every file write, check the diff against these categories, assess intent, and determine legitimacy before proceeding.

## Recovery When Avoidance Is Detected

`PAUSE → DIAGNOSE → ADAPT → RETRY → ESCALATE`. PAUSE: stop, preserve state, log context. DIAGNOSE: classify root cause (cognitive overload / misunderstanding / knowledge gap / inherent complexity); consult reflection memory. ADAPT: simplify, request context, change approach, reduce scope, or escalate early. RETRY: max 3 attempts, track each. ESCALATE: HITL gate with original task, detection details, all attempted strategies, failure analysis, and a recommendation. Do not proceed without resolution. Integrates with agent loops (per-iteration baseline + avoidance checks, best-output selection per REF-015), executable-feedback (run tests before return), and HITL gates (test-deletion / coverage-regression / max-attempts escalation).

## Checklist

Before completing any code task:

- [ ] All tests executed and passing; test count ≥ baseline; coverage ≥ baseline − 2%; assertion count ≥ baseline
- [ ] No skip patterns added; no tests deleted (or deletion justified); no features removed (or removal documented)
- [ ] No assertions weakened; no errors suppressed; no CI/pipeline signals suppressed
- [ ] If stuck, escalated with full context
- [ ] The whole thing delivered within scope (code + tests + docs + verification command run)
- [ ] Dangling threads inside scope tied off; adjacent out-of-scope work filed as issues, not silently absorbed
- [ ] Final deliverable is the finished product, not a plan (unless a plan was explicitly requested)

## References

- @.aiwg/research/findings/agentic-laziness-research.md — research compilation
- @.aiwg/architecture/agent-persistence-sad.md — architecture
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/actionable-feedback.md
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/tao-loop.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/vague-discretion.md — paired ceiling/floor
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — within-scope boundary
- @$AIWG_ROOT/agentic/code/addons/persistence/patterns/avoidance-catalog.yaml — pattern catalog

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-08
