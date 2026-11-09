---
precedence: critical
overridable: true
activation: kernel
enforcement: critical
---

# Pipeline Safety — Never Suppress CI Signals

**Enforcement Level**: CRITICAL
**Scope**: All CI/CD pipeline configurations, workflow files, and build scripts
**Issue**: #491 (related: #490)

## Principle

CI pipeline signals exist to prevent broken code from reaching production. Suppressing these signals — whether by skipping hooks, ignoring failures, or weakening checks — is equivalent to disabling the smoke detector because it keeps going off. Fix the fire, not the alarm.

## Mandatory Rules

1. **Never use `--no-verify`**: Git hooks (pre-commit, pre-push) exist for a reason. Bypassing them with `--no-verify` skips linting, formatting, type checking, or other quality gates. If a hook is failing, fix the code or fix the hook — do not skip it.

2. **Never use `continue-on-error: true` for test steps**: Test failures must fail the pipeline. Using `continue-on-error` on test steps converts hard failures into invisible warnings. If a test is flaky, fix the test or quarantine it explicitly — do not silence it.

3. **Never skip failing checks**: If a CI check (lint, type check, security scan, test) is failing, the correct response is to fix the issue. The following are not acceptable:
   - Deleting the failing test
   - Commenting out the check in the workflow
   - Adding the failing file to an ignore list without justification
   - Merging with failed checks via admin override (except documented emergencies)

4. **Never weaken assertions to pass CI**: If a test asserts `expect(x).toBe(5)` and `x` is `4`, the fix is to fix the code, not to change the assertion to `expect(x).toBe(4)` or `expect(x).toBeGreaterThan(3)`.

5. **Security scan findings must not be suppressed without documentation**: If a security scanner produces a finding, it must be either fixed or documented with a justification for acceptance (false positive, accepted risk with mitigation). Adding the finding to an ignore list without documentation is suppression.

6. **Pipeline modifications require review**: Changes to CI workflow files (`.github/workflows/`, `.gitea/workflows/`, `ci/`) should be reviewed with the same rigor as production code. A one-line change to a workflow can disable an entire quality gate.

## Detection Patterns

Flag any of the following in CI configurations or commit history:

| Pattern | Location | Risk |
|---------|----------|------|
| `--no-verify` | Git commands | Hook bypass |
| `continue-on-error: true` | Workflow test/lint steps | Silent failure |
| `if: always()` on deploy steps | Workflow deploy jobs | Deploy despite failures |
| `[skip ci]`, `[ci skip]` | Commit messages | Pipeline bypass |
| `allow_failure: true` | GitLab CI test jobs | Silent failure |
| `-DskipTests` | Maven commands | Test skip |
| `--no-test` | Build commands | Test skip |
| `exit 0` at end of test scripts | Shell scripts | Forced success |
| `|| true` appended to test commands | Shell scripts | Forced success |

## Exceptions

The only acceptable exception is a documented production emergency where:
- The emergency is logged in the incident tracker
- The suppression is temporary with a stated deadline for remediation
- A follow-up issue is created to restore the check
- The override is reviewed in the post-incident retrospective

## Rationale

Every suppressed CI signal is technical debt with compound interest. A skipped test today becomes a production incident next month. CI pipelines are the last automated line of defense before code reaches users. Weakening them trades short-term convenience for long-term reliability.
