# Testing Quality Quickstart

For source-bound conformance assessment, reversible normalization templates, and platform research, see the
[test conformance workflow](conformance-workflow.md). The toolkit retains the six original testing-quality skills.

> **First time using AIWG?** Begin with [Install, Connect, and
Verify](https://github.com/jmagly/aiwg/blob/main/docs/getting-started/install-connect-verify.md). This guide assumes AIWG is connected to the target project
and your provider session can read the deployed context.

Set up a reviewable test-quality check and turn the findings into specific
test work.

## Enable If Needed

```bash
aiwg use testing-quality
```

Skip this when the complete setup path already made the addon available in
your provider session.

## Set Up TDD Enforcement

Run this once when starting a project or when adding testing gates to an existing one:

```text
Set up TDD enforcement for this project
```

Expected result:

- Pre-commit hook that runs `npm test` (or equivalent) before allowing commits
- CI coverage gate at 80% minimum
- `tdd_setup.py` script for non-npm projects
- TDD workflow documentation in `.aiwg/testing/`

After setup, review the generated hook and CI changes before treating them as
blocking policy.

## Check Test Quality with Mutation Testing

To find out whether your tests would actually catch bugs:

```text
Run mutation testing on src/auth/
```

```text
Validate test quality for the payment module
```

```text
What's our mutation score?
```

The skill detects your test framework and runs the appropriate mutation tool:

- JavaScript/TypeScript: Stryker
- Java: PITest
- Python: mutmut

### Python native-extension preflight

Before mutmut uses `mutate_only_covered_lines = true`, the skill runs the
selected pytest nodes in a disposable subprocess and records native extensions
loaded by the test, conftest, plugin, or source import graph:

```bash
python scripts/native_extension_preflight.py \
  --test-selection tests/test_numerical_contracts.py \
  --pytest-arg=--no-cov \
  --mutation-target package/numerical_contracts.py \
  --estimated-mutants 80 --max-children 4 \
  --runtime-budget-seconds 600 --format json
```

If the report classifies `harness_native_extension_reload_risk`, do not start
mutmut covered-line mode. The script allows `mutate_only_covered_lines = false`
only when the mutation target, observed mutant estimate, child count, and runtime
budget are explicit and the conservative estimate fits. Otherwise narrow the
target or select a project-approved harness with subprocess-isolated coverage and
stats phases.

Preserve the preflight JSON with the mutation report. A stats-phase crash or
re-import error is a harness/tool failure; it is not a project test failure and
must not be counted as a killed, survived, timed-out, or no-tests mutant.

Output is a mutation report with:

- Overall score (target: ≥80%)
- Which specific functions/methods have weak test coverage
- For each weak test, what condition or behavior it fails to validate

Example output:

```text
Mutation Score: 73% (target: 80%)

Weak tests identified:
  src/auth/token.ts:validateExpiry()
  - Mutant survived: Changed > to >= on line 47
  - Tests should check boundary: token valid at exactly expiration time
  
  src/auth/token.ts:generateToken()  
  - Mutant survived: Removed userId from payload on line 23
  - Tests should verify userId is present in generated token
```

Fix the identified weak tests and re-run the agreed target. Use the percentage
threshold your project has approved; do not treat the example target as a
universal policy.

## Find and Fix Flaky Tests

When CI is reporting intermittent failures:

```text
Find flaky tests
```

```text
CI is unstable — find the flaky tests
```

The `flaky-detect` skill analyzes CI history to identify tests that fail intermittently and categorizes the root cause.
To fix them:

```text
Fix the flaky tests
```

```text
Make the auth tests reliable
```

The `flaky-fix` skill applies deterministic replacements: proper async/await patterns for timing issues, state isolation
for order-dependency issues, mocking for external dependencies.

## Generate Test Data Factories

When writing tests that require complex model instances:

```text
Generate factory for User model
```

```text
Create test data factory for Order with traits for pending, completed, and cancelled orders
```

Output is a factory file with sensible defaults, Faker.js integration for realistic data, and traits for common test
variants. The factory is placed in the project's existing test/factories/ directory (or created if absent).

## Detect Orphaned Tests

When tests accumulate and fall out of sync with the codebase:

```text
Find orphaned tests
```

```text
Sync tests with the current codebase
```

`test-sync` identifies:

- Test files that reference source files which no longer exist
- Source files that have no corresponding test file
- Test functions that test code paths no longer present in the source

## Run the /setup-tdd Command

For a one-command TDD infrastructure setup:

```text
/setup-tdd
```

This combines `tdd-enforce` setup with test suite configuration and returns a
baseline to review.

## Integrate with SDLC Quality Gates

If using sdlc-complete, the testing-quality addon hooks into the Construction phase:

```text
Run quality gate check before transitioning to Transition
```

The quality gate can run `mutation-test` and `flaky-detect` as blocking checks
when the project has adopted those thresholds.

Success means you have a mutation, flaky-test, factory, or test-sync report
with affected files, verification evidence, and the next test change to make.

## References

- `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/docs/overview.md` — All skills and quality targets
- `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/skills/tdd-enforce/SKILL.md` — TDD enforcement details
- `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/skills/mutation-test/SKILL.md` — Mutation testing details
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/test-engineer.md` — SDLC test engineer agent
