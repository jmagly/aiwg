# Manual Provider Testing — External Agent Loop LFD Controls

## Purpose

Manually verify the external agent loop's LFD controls (budget stops, exploration
quota, stall rule, hypothesis-before-change records) end-to-end against a **real
provider CLI**, not just the stubbed UAT. The automated UAT
(`npm run uat`) exercises every code path with a deterministic stub; this runbook
covers what the stub cannot: that the controls behave correctly when a real
provider (codex, claude, opencode, factory) drives the loop.

**Operator warning**: live runs invoke a real provider CLI and consume real
tokens/budget. Use the bounded default task and tight iteration caps. Per the
current setup, **codex is the primary live-testable provider on this
workstation**; other providers run only where their CLI is installed and
authenticated.

## System Topology

- Harness script: `tools/ralph-external/manual-provider-test.sh`
- Loop entry point: `tools/ralph-external/index.mjs`
- Runtime providers: `claude`, `codex`, `opencode`, `factory`, `pi`, `omp`,
  `deepseek-harness`, `muse` (registered in `tools/ralph-external/lib/*-adapter.mjs`)
- Pi runs headless as `--provider pi` (`pi --mode json --no-approve`, Node
  22.19+ preflight, qualified-version preflight, `--model`/`--thinking`/`--tools`
  propagation, stdin closed, cancellation by bounded TERM/KILL). It never loads
  project-local Pi resources, so do not describe a Pi loop run as a test of
  deployed prompts or skills. Pi reads stdin commands only in `--mode rpc`; in
  `--mode json` it drains a piped stdin to EOF before the prompt runs
  (verified on 0.85.0, #2550), so the adapter offers no stdin `abort` frame
  and the launcher must not open the child's stdin. `isAvailable()` fails
  closed when `pi --version` is outside `PI_SUPPORTED_VERSIONS` in
  `tools/ralph-external/lib/pi-adapter.mjs`.
- **Pi status: experimental.** Required for experimental status: the adapter
  contract tests in `test/unit/ralph/pi-adapter.test.mjs` (`npm run test:node`)
  and the vitest Pi suites (`test/unit/providers/pi-*.test.ts`,
  `test/unit/sessions/pi-adapter.test.ts`) green in CI. Required for stable:
  the above plus a passing `npm run smoke:pi:live` against the pinned Pi
  version recorded per release.
- **Muse status: experimental (optional, #230).** Headless `muse exec --json`
  with resume via `--session-id` and transcripts via `muse export`; contract
  tests in `test/unit/ralph/muse-adapter.test.mjs` (`npm run test:node`) run
  against the recorded fixture stub only — no live Meta auth in CI. Disable
  with `AIWG_MUSE_RALPH_ENABLED=0` (does not affect `aiwg use --provider
  muse`). Live runs need an authenticated `muse` CLI; Linux runners need
  bubblewrap + unprivileged user namespaces for muse's default OS sandbox.
  Never pass `--yolo` (disables approval *and* sandboxing). The `--json`
  envelope schema is unevidenced, so settlement is read from exit codes, not
  parsed events. See [the muse Ralph adapter reference](../providers/muse-ralph-exec.md).
- The `stub` provider is UAT-only (registered by the test fixture, not the runtime)
- Each run executes in an isolated scratch workspace (`mktemp -d` by default), so
  the loop's `.aiwg/ralph-external/` output never touches the AIWG repo.

## Procedure

All commands run from the AIWG repo root.

### 1. Preview the command without running it

```bash
tools/ralph-external/manual-provider-test.sh --provider codex --scenario budget --dry-run
```
Expected: prints the resolved `node tools/ralph-external/index.mjs …` command and exits 0 without invoking the provider.

### 2. Run the plain scenario (no LFD controls) against codex

```bash
tools/ralph-external/manual-provider-test.sh --provider codex --scenario plain --keep
```
Expected: the loop runs up to 3 iterations, the trivial task (`DONE.txt` containing `READY`) completes, and the harness prints the paths to `completion-report.md` and `iteration-analytics-report.md`. `--keep` preserves the scratch workspace for inspection.

### 3. Exercise a specific LFD control

```bash
# Hard wall-clock budget stop (tiny ceiling → budget_exhausted or, on the
# completing iteration, completion-wins with the crossing annotated)
tools/ralph-external/manual-provider-test.sh --provider codex --scenario budget --keep

# Declared exploration quota (k=1 → structural-variant directive after one flat cycle)
tools/ralph-external/manual-provider-test.sh --provider codex --scenario quota --keep

# Stall rule (directive forbidding the prior adjustment after a non-improving cycle)
tools/ralph-external/manual-provider-test.sh --provider codex --scenario stall --max-iterations 4 --keep
```

### 4. Inspect the injected LFD directives

With `--keep`, read the per-iteration prompts to confirm the directives were injected (they apply to every command-injection provider):

```bash
# The harness prints the prompt paths; grep them for the LFD directives:
grep -l "LFD CONTROL" <scratch>/.aiwg/ralph-external/loops/*/prompts/*.txt
```
Expected: iteration prompts contain `LFD CONTROL — hypothesis before change`; after a non-improving cycle, `LFD CONTROL — stall rule`; under the quota scenario, `LFD CONTROL: The prior cycles are flat`.

## Verification

Confirm the run produced the expected artifacts:

```bash
# (with --keep) list the LFD artifacts
find <scratch>/.aiwg/ralph-external -name 'budget-stop-report.json' \
  -o -name 'completion-report.md' -o -name 'iteration-analytics-report.md'
```
Expected for the `budget` scenario: `budget-stop-report.json` exists and its `stop_reason` is `wall_clock_exhausted` (or, if the task completed on the crossing iteration, the completion report notes the budget crossing under completion-wins).

Offline sanity check (no provider needed) — the stubbed UAT covers the same controls deterministically:
```bash
npm run uat
```
Expected: all tests pass (includes the resume, stop-semantics, unknown-budget, stall, and hypothesis suites).

## Troubleshooting

- **`Unknown provider '<name>'`** — the provider CLI adapter isn't registered; valid runtime providers are `claude`, `codex`, `opencode`, `factory`, `pi`, `omp`, `deepseek-harness`, `muse` (unless `AIWG_MUSE_RALPH_ENABLED=0`). `stub` is UAT-only.
- **Pi adapter reports unavailable** — the Pi adapter preflights Node 22.19+
  and a `pi` executable (`AIWG_PI_BIN` overrides the binary). Fix the runtime
  first; see [the Pi provider reference](../agents/providers/pi.md) for direct
  bounded Pi testing outside the loop.
- **Loop aborts at iteration 1 with a cost/auth error** — the provider CLI isn't authenticated on this workstation. Authenticate the CLI directly (e.g. `codex login`) and retry.
- **`budget-stop-report.json` missing under the `budget` scenario** — the task completed before the ceiling was crossed; raise `--max-iterations` or lower the ceiling, or use `--scenario plain` to confirm the loop runs at all first.
- **Token/spend ceilings never fire on a non-claude provider** — expected and now surfaced: providers that report no usage make token/spend ceilings *unobservable* (a one-time warning is printed). Use `--scenario budget` (wall-clock) for a provider-independent hard stop.

## House Rules for Agents

- DO run `--dry-run` first to confirm the resolved command before any live invocation.
- DO use the bounded default task and small `--max-iterations` to cap live cost.
- DON'T run live-provider scenarios in a loop or unattended — this is a manual diagnostic.
- DON'T point `--provider` at an unauthenticated CLI expecting it to self-authenticate.
- STOP and report if a live run's cost or iteration count exceeds expectation.

## What NOT to Fix

- The `stub` provider erroring at runtime is **intentional** — it exists only for the UAT fixture, never as a runtime provider.
- Token/spend ceilings reading as *unobservable* on codex/opencode/factory is **expected** (those adapters emit no usage events); wall-clock is the provider-independent hard stop.
- The scratch workspace being deleted after a run is intentional; pass `--keep` to retain it.

## Audit Trail

- Added: 2026-07-11 (LFD remediation, operator manual-testing directive)
- Applies to: `tools/ralph-external/` external agent loop, all runtime providers
- Related issues: #1585 (LFD controls), #1765–#1770 (remediation), #1774 (CI/test coverage)
- Companion: `npm run uat` (offline, stubbed) is the automated counterpart
