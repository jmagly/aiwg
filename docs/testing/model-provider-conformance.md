# Model Provider Conformance

Normal CI is fixture-first and cost-free. The shared fixture at
`test/fixtures/models/provider-conformance.v1.json` covers premium/reasoning,
standard/coding, economy/efficiency, an unknown exact ID, and an invalid
blocked pin. Its golden provider matrix asserts the configured target, artifact
format, native or degraded outcome, field names, and omission of unsupported
model and effort keys for all thirteen providers.

## Test matrix

| Surface | Coverage |
| --- | --- |
| Registry and golden compilation | `test/unit/models/provider-conformance.test.ts` |
| Precedence and invalid no-write behavior | `test/unit/models/resolver.test.ts`, `test/unit/cli/handlers/models.test.ts` |
| `--target`, framework, addon, extension, project-local, bulk, filters | `test/integration/provider-file-locations.test.ts`, `test/integration/deployment-completeness.test.ts`, `test/unit/cli/handlers/use*.test.ts` |
| Use/refresh parity and saved config | `test/unit/cli/handlers/refresh.test.ts`, `test/unit/agents/model-override.test.ts` |
| Skill native/degraded behavior | `test/unit/providers/claude-skill-model-policy.test.ts`, `test/integration/codex-deployment.test.ts` |
| Corpus distribution and rationale | `test/unit/models/corpus-policy.test.ts` |
| Dry-run mutation equivalence | `test/unit/cli/handlers/models.test.ts` |
| Live gate safety | `test/unit/models/live-smoke.test.ts` |
| Provider inventory | `test/unit/providers/provider-inventory.test.ts` |
| Dynamic source/cache provenance | `test/unit/models/model-discovery.test.ts` |
| Model-worker output across all providers | `test/integration/model-worker-provider-matrix.test.ts` |

Provider inventory separates configured, deployed, detected, available, and
active evidence, including project/user scope and configured-only failure
guidance. Dynamic discovery records offline static behavior, public-feed
refresh, available-provider-only native probes, cache freshness, and
provenance.

Codex native discovery uses app-server `model/list` and does not start an agent
turn. Claude local enumeration is explicitly unsupported until Claude Code
exposes a stable machine-readable interface.

The model-worker provider matrix deploys only generated files into temporary
workspaces. It validates exact native model fields for Claude, Codex, Copilot,
Cursor, Factory, and OpenCode; semantic OpenHuman hints; and honest
inherited/global/unsupported degradation for OpenClaw, Pi, Warp, Windsurf, and
Hermes. It never launches a provider or spends model tokens. Pi is an AIWG
deployment provider here; Pi's own `--provider` flag selects an LLM backend
and is outside this compiler contract.

Pi-specific fixture coverage lives in
`test/fixtures/providers/pi/`, `test/fixtures/sessions/pi/`, and
`test/unit/providers/pi-conformance-fixtures.test.ts`. Those fixtures pin the
audited upstream version and exercise session-tree, compaction, retry,
unknown-entry, malformed-JSONL, and redaction cases without installing or
invoking Pi. The production Pi runtime adapter
(`tools/ralph-external/lib/pi-adapter.mjs`) and session adapter
(`src/sessions/adapters/pi.ts`) are delivered and covered by adapter contract
tests (`test/unit/ralph/pi-adapter.test.mjs`,
`test/unit/sessions/pi-adapter.test.ts`): settlement, closed-stdin launch and
bounded TERM/KILL teardown, tool restrictions, stdout/stderr separation, strict
JSONL framing, qualified-version fail-closed, and branch/compaction/retry/
unknown-entry/redaction import. That offline coverage is the **experimental**
gate and must not be reported as live conformance. **Stable** additionally
requires the opt-in smoke below with the Pi version captured in its evidence.
Pi `--mode json` has no stdin command channel and blocks on an open stdin
pipe until EOF (verified on 0.85.0, #2550), so the adapter sends no `abort`
frame; cancellation is the TERM/KILL path only.

## Opt-in live smoke

First verify the zero-cost gate:

```bash
node tools/models/live-smoke.mjs --check
```

Live execution requires `AIWG_MODEL_LIVE_SMOKE=1`, a budget no greater than
`$0.25`, and an operator-supplied provider command. The command should perform
at most one bounded delegation for the selected tier and expose observed data
through `AIWG_MODEL_SMOKE_RESOLVED_MODEL`,
`AIWG_MODEL_SMOKE_RESOLVED_EFFORT`, `AIWG_MODEL_SMOKE_FALLBACK`, and
`AIWG_MODEL_SMOKE_ACCOUNT_CONSTRAINTS`. Use a unique output path: evidence is
created with no-overwrite semantics.

```bash
AIWG_MODEL_LIVE_SMOKE=1 \
AIWG_MODEL_SMOKE_RESOLVED_MODEL=gpt-5.4-mini \
node tools/models/live-smoke.mjs \
  --provider codex \
  --budget-usd 0.05 \
  --command 'your bounded provider invocation' \
  --output .aiwg/reports/model-live-codex-YYYY-MM-DD.json
```

If a model is unavailable, record the observed fallback and account/admin
constraint rather than treating the configured ID as the resolved model.

For an opt-in Pi/OpenRouter smoke, install
`@earendil-works/pi-coding-agent`, source `OPENROUTER_API_KEY` from an
approved secret manager, and run the gated harness:

```bash
node tools/providers/pi-live-smoke.mjs --check

AIWG_PI_LIVE_SMOKE=1 \
OPENROUTER_API_KEY="$(your-secret-command)" \
npm run smoke:pi:live -- --model <openrouter-model-id>
```

The default live path uses a pinned, ephemeral `npx` package rather than a
global Pi installation. For a reviewed source build, pass `--pi-bin` with the
path to that build's `dist/bundle/cli.js`. The harness creates temporary
`HOME`, `PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR` values,
uses `--no-approve`, validates discovery, RPC controls, strict JSONL, and
`agent_settled`, and deletes raw output. It emits only summary evidence and
never writes the credential. Pi's current flags are documented in the
[upstream coding-agent README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#cli-reference)
(last verified 2026-09-04).

### Muse Code live smoke (evidence-gated)

Unlike the Pi/OpenRouter harness, the Muse smoke performs no model
inference: Muse is a CLI (`muse` / `muse exec`), so the harness exercises
the real AIWG deploy/doctor/status surface against the ADR-verified Muse
roots. Default CI never runs it. First verify the zero-cost gate:

```bash
node tools/providers/muse-live-smoke.mjs --check
```

A live run requires a built CLI, the explicit gate, and a real `muse`
executable on `PATH`:

```bash
npm run build:cli
AIWG_MUSE_LIVE_SMOKE=1 npm run smoke:muse:live
```

When the gate is unset, or when `muse` is absent from `PATH`, the harness
skips cleanly (exit 0) with a clear message instead of failing. When
enabled it runs, inside an isolated sandbox with `HOME` and
`XDG_CONFIG_HOME` redirected into a temp dir:

- `use all --provider muse --dry-run` and a real project deploy into
  `<project>/.agents/skills` (dry-run performs zero writes)
- `use all --provider muse --scope user` dry-run and deploy into
  `$XDG_CONFIG_HOME/muse/skills`
- `doctor --provider muse` and `status --probe --provider muse`
- an optional, non-destructive `muse --version` probe (evidence only)

After every run it audits the sandbox for forbidden writes and fails on
any `.cursor/` tree, an invented `~/.muse` home, a `~/.agents` tree, or
`$XDG_CONFIG_HOME` content outside `muse/skills`. The report contains only
booleans, counts, and the CLI version string; no credentials or model
output are involved. See
[adr-muse-provider-target.md](../architecture/adr-muse-provider-target.md)
for the locked roots.
