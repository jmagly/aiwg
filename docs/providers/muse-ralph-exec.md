# Muse Code headless Ralph adapter (`muse exec`)

Optional / post-experimental Ralph-external provider adapter for Muse Code
(`#230`, parent `#223`). It drives Meta's documented headless surface —
`muse exec` — for the external agent loop (`tools/ralph-external/index.mjs
--provider muse`), with session resume (`--session-id`) and the
transcript/export path (`muse export`). CI runs recorded fixtures only, with
no live Meta auth; the contract below was verified by hand against an
installed Muse Code 1.4.0 on 2026-09-25.

## Status

### S1 direct profile (#2898)

The separate `buildWorkerArgs` path preserves the resolved model and effort,
uses closed stdin and a prompt file, binds `--workspace`,
`--approval-mode never --approval-judge off`, a positive `--max-model-steps`,
and a host-bound `--output-schema` file. Approval judge is explicitly off
for the frozen unattended approval posture; it cannot introduce extra model
approval decisions. A read-only request adds both `--disable-write` (non-shell
writes only) and `--disable-shell`. Workspace trust is bound on via
`controls.trust.mapping: "[\"--trust-workspace\"]"` because Tier 0 workspaces
are conductor-prepared worker trees the conductor owns (#3685: untrusted Muse
loads `project_sources=0` with user skills only; trusted loads
`project_sources=1` with project skills and hooks). Only the host profile may
change that mapping; requalification binds the change. Neither the brief nor
a CLI default supplies that authority. The operator native-argv gate refuses a
Muse worker argv without exactly one `--trust-workspace`.
Trust loads workspace instructions; it never emits `--disable-sandbox` or
`--yolo`. The existing shared policy requires a qualified external sandbox
boundary for Muse, denies contributor models and denied efforts, and rejects
stale model observations. Contributor processing/improvement/retention policy
must be explicit; a CLI/catalog default is never a selection authority.
Legacy Ralph sessions retain their existing behavior when groups are disabled.

The offline direct profile is pinned to **1.4.4-R5419.1**, inspected with
`muse --version` and `muse exec --help` on 2026-10-09. This supersedes only
the direct syntax candidate, not the historical 1.4.0 observations below.
Every invocation control and health qualification remains **unqualified**.
The help-declared efforts are `none|minimal|low|medium|high|xhigh|max|ultra`;
the builder validates this set and the shared selection predicate denies `ultra`.
`run.model.configured` can describe runtime configuration; it never attests
backend identity. MSP is not MCP, and echo is a separate free mechanics
fixture that cannot qualify meta inference, schema enforcement or sandboxing.

The host sets `controls.structuredOutput.mapping` to the JSON argv pair
`["--output-schema", "<absolute schema file>"]` and includes the schema in
`installation.runtimeFiles` so changing its bytes invalidates the existing
installation scope. Project/worker text cannot choose this path. The structured
output control projects `#/$defs/workerClaims` from the existing
`schemas/mission-v1.schema.json`; it introduces no schema family. A missing
mapping blocks the direct driver.

Muse's recorded `run.lifecycle.started` binds session/run setup;
`run.output.delta` is activity, and a terminal is only an execution candidate.
Missing run IDs, unrelated session logs and configured-model events cannot
refresh progress. Semantic completed-step grammar and a portable session-log
locator are unavailable, so the profile declares degraded process-only startup
and no semantic progress. The shared observer keeps activity, progress and
observation clocks separate, including fractional quiet/stall scaling.

429 candidates retain provider-reported `quota_scope`, `reset_at` (or an ISO
reset in the reason), Retry-After and prior partial text/events. Unknown scope
and reset remain null. These fields are untrusted observations; they do not
establish the host's account/quota domain. Direct fallback consumes the
conductor's existing self-counted attempt/time/parallel allowance, requires a
fresh output/worktree and confirmed owned stop, and never blindly replays
partial work. Persisted cooldown belongs to B-OG-11 in S2+.

### Manual smoke run

No live-qualification runner, evidence file, or account-scope attestation
exists for Muse — per the baseline-simplification decision
(`.aiwg/planning/multi-cli-orchestration/17-baseline-simplification-decision.md`),
provider profiles are a lightweight CLI mapping, not a live-qualification
suite. The conductor instead runs **one documented command, once, by hand**
on a host with an installed, authenticated `muse`. This is essentially the
`direct-shell` profile's rendered argv (`buildWorkerArgs()` in
`tools/ralph-external/lib/muse-adapter.mjs`) for a tiny synthetic brief:

```bash
printf 'Reply with exactly: OK. Use no tools.' > /tmp/muse-smoke-brief.txt
muse exec --json --provider meta --model muse-spark-1.3 --reasoning-effort minimal \
  --workspace "$(mktemp -d)" --approval-mode never --approval-judge off \
  --max-model-steps 2 --prompt-file /tmp/muse-smoke-brief.txt \
  > /tmp/muse-smoke-output.jsonl
echo "exit: $?"
```

Read pass/fail from the captured output:

1. **Exit code** — `0` for a completed turn; `1` (failed/cancelled), `2`
   (usage error), or a signal number are a fail.
2. **Terminal event** — the last line of `/tmp/muse-smoke-output.jsonl` must
   have `"payload_type":"run.terminal.completed"`; `run.terminal.failed` or no
   terminal line at all is a fail.
3. **Final file** — that same terminal line's `payload.text` is the answer
   (`parseOutput()`'s `text`); an otherwise-zero exit with an empty or missing
   `text` is still a fail.

Record the installed `muse --version` banner and pass/fail on the tracking
issue. This is a one-shot manual check, not an automated qualification lane —
it establishes nothing about sandbox enforcement, account scope, or data use.

### Shared owner follow-ups required for S1 closure

These changes are outside #2898's authorized shared-file edit scope:

1. `provider-adapter.mjs`: expose the existing strict RFC 8259 scanner or add
   a provider normalization hook inside it, so Muse envelopes and terminal
   text can be validated without losing duplicate keys or copying a parser.
2. `src/mcp/tools/worker-invoke.mjs`: use the selected provider's strict parser
   for shell output. It currently instantiates the generic base parser, which
   rejects native Muse envelopes. Until both changes land, strict Muse finals
   and the bridge remain blocked; a zero exit cannot qualify them.
3. `src/models/worker-installation.mjs`: approve the bundled Muse factory and
   dependency closure through the existing digest-bound installed loader.
   Current built-in registration and the descriptive source-path driver are
   not an approved `installed:` module. Do not bypass that boundary.

4. `src/models/worker-installation.mjs` and `provider-policy.ts`: the former
   compares `cliVersion` to raw trimmed probe stdout, namely
   `Muse Code 1.4.4 (1.4.4-R5419.1)`; the latter passes that same field to
   `semver.satisfies` against `1.4.4-R5419.1`. No normalization occurs. The
   shared owner must bind both the raw banner and a provider-normalized semver
   in installation evidence, recheck the raw banner against the same binary
   digest, and use only the normalized value for profile/catalog matching.
   Alternatively, an approved digest-bound version probe wrapper must emit
   that exact semver. A profile-only change cannot make the current raw banner
   satisfy semver, including `*`; synthetic semver fixtures do not qualify an
   installation. This shared gate also affects OpenHuman (#2911).

After these shared changes, conduct authorized version/account/profile-scoped
negative/control and health qualification before activating Muse. T-OG-20/21/23
live health and observed descendant stop remain open S1 gates, independent of
Mission/MC or S2 managed runtime.

### #2898 round 1 fixes and validation (2026-10-09)

The pack registry now asserts the exact two T-OG-06 partial files; both negative
fixtures explicitly clear that list. Read-only disables non-shell writes and
shell execution. Host-owned workspace trust defaults off, approval judge is
pinned off, and argv rejects undeclared efforts. (This round also built a live
qualification runner that recorded process startup and streaming health,
validated through the strict parser, and emitted failed/blocked status with
nonzero exit classification and explicit binary digest; per the
baseline-simplification decision, that runner and its tests were dropped in
favor of the Manual smoke run above.)

- Typecheck, schema lint (two existing warnings), orchestration pack lint,
  synchronous test-process timeout lint and diff whitespace checks passed.
- All 17 pure direct tests passed; the new policy/lifecycle regressions were
  observed failing before the fixes.
- Four bounded temporary shell fixtures exercised the full runner with source
  resolution via `node --import tsx`: native-final rejection, nonzero exit,
  missing terminal and version drift each blocked without host proof, then
  wrote failed, unqualified evidence after synthetic proof. No real inference.
- The shared predicate was checked against `ultra`: `OG_EFFORT_DENIED`.
- Existing legacy pure Muse tests remain eight passed/four failed because
  sandboxed Node child launches return empty stdout (also reproduced separately).
- Vitest is deferred to the conductor's host; the dependency symlink was not
  modified. New TypeScript conformance cases cover the raw version banner and
  complete synthetic runner. No auth/settings files were read.

### Original #2898 validation record (2026-10-09)

- `npm run typecheck`: passed (zero errors).
- `npm run lint:schemas`: 236 strictly compiled, zero errors, two existing warnings.
- `npm run lint:orchestration-packs`: 21 packs wired, qualification unqualified.
- `npm run lint:test-process-timeouts`: passed, zero unbounded synchronous calls.
- `node test/unit/ralph/muse-direct.test.mjs`: nine passed, zero failed.
- `node --test test/unit/ralph/muse-direct.test.mjs`: one file passed.
- `node --test test/unit/ralph/muse-adapter.test.mjs test/unit/ralph/pi-adapter.test.mjs test/unit/ralph/deepseek-harness-adapter.test.mjs`:
  one file passed, two failed. Direct `node test/unit/ralph/muse-adapter.test.mjs`
  diagnostic: eight passed, four failed, with empty subprocess stdout and a null
  parsed launcher result, matching the environmental failures already recorded
  by the adjacent worker-contract fixture README. No subprocess bypass was added.

Both required Vitest lanes were attempted with these exact commands:

```bash
npx vitest run --config config/vitest.config.js test/unit/{models/{provider-policy,worker-installation-metadata},ralph-external/{worker-invocation,worker-installation,worker-finals},mcp/{worker-invoke,worker-qualification}}.test.ts
npx vitest run --config config/vitest.conformance.config.js test/conformance/orchestration-v1/{muse-direct,openhuman-direct,worker-fixtures,worker-resolution,worker-health-*,provider-coverage,pack-registry}.test.ts
```

Both were blocked before collection by `EROFS` creating
`node_modules/.vite-temp/vitest*.timestamp-*.mjs`; the dependency directory is a
read-only symlink. Zero Vitest assertions ran. No cache or dependency changes
were made. The new conformance file passes TypeScript syntax transpilation;
this does not replace runtime conformance. The new adapter, fixture and runner
pass `node --check`, and `git diff --check` passes. No live qualification or
auth/token-file access occurred.

Experimental and **disabled-safe**: set `AIWG_MUSE_RALPH_ENABLED=0` (also
`false`, `no`, `off`) to keep `muse` out of the Ralph provider registry
entirely. The flag is consulted only by
`tools/ralph-external/lib/provider-adapter.mjs` during built-in registration —
it is unknown to `src/providers/` and to the writer/deploy path, so disabling
the adapter never affects `aiwg use --provider muse`.

Per `docs/architecture/adr-muse-provider-target.md` ("Headless Ralph"), this
adapter is optional and post-experimental: it does not block the experimental
cut (`#225`–`#229`) or stable promotion (`#231`).

## Evidenced flags (Meta docs, dev.meta.ai/docs/muse-code/)

| Flag | Evidence |
| --- | --- |
| `muse exec [OPTIONS] [PROMPT]` | Headless entrypoint; "takes one prompt, runs it to completion, and exits" ([extending](https://dev.meta.ai/docs/muse-code/extending)). Prompt is positional and must come last; options are parsed by `exec`, not the `muse` root, so adapter argv always starts with `exec`. |
| `--json` | "Emit JSONL events"; headless-only ([extending](https://dev.meta.ai/docs/muse-code/extending), [configuration](https://dev.meta.ai/docs/muse-code/configuration)). |
| `--session-id <uuid>` | "To continue an interrupted job non-interactively, use `exec` with the session id" ([extending](https://dev.meta.ai/docs/muse-code/extending)). Verified on 1.4.0: a new id pins the new session's id (the native log lands in `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<uuid>/`), and re-passing it continues that session with its context. `muse resume` is interactive-only. |
| `--prompt-file <path>` | Headless-only ([configuration](https://dev.meta.ai/docs/muse-code/configuration)). |
| `--max-model-steps <n>` | Headless-only, "cap the run" ([configuration](https://dev.meta.ai/docs/muse-code/configuration)). The adapter maps the `maxTurns` capability to this flag; it never emits `--max-turns`, which `muse` would reject with exit code 2. |
| `--model <id>`, `--reasoning-effort <level>` | Common to both launch surfaces ([configuration](https://dev.meta.ai/docs/muse-code/configuration)). Ids come from the Meta provider catalog; on 1.4.0 that is `muse-spark-1.3` (current), `muse-spark-1.3-contributor` (catalog default), `muse-spark-1.2`, and `muse-spark-1.2-contributor`. `mapModel()` passes `muse-*` ids through and drops any other name, so Ralph's Claude defaults never reach `muse`. An unknown id exits 1 with `run.terminal.failed`. |
| `--approval-mode <mode>` | Common to both; "`muse exec` accepts both approval flags" ([configuration](https://dev.meta.ai/docs/muse-code/configuration)). **Opt-in only** — the adapter sets no approval posture by default. |
| `muse export --session <uuid> --out <path>` | Offline, byte-deterministic transcript projection; "never modifies the log" ([audit-agent-sessions](https://dev.meta.ai/docs/cookbook/audit-agent-sessions)). `--last` and `--redacted` are also documented there. |
| Exit codes `0` / `1` / `2` / `130` / `143` | 0 = turn completes, 1 = fails or is cancelled (including a `--max-model-steps` limit), 2 = usage error, 130/143 on SIGINT/SIGTERM ([extending](https://dev.meta.ai/docs/muse-code/extending)). 0, 1, and 2 verified on 1.4.0. |
| `--` before the prompt | Verified on 1.4.0: a prompt that starts with `-` fails with `unknown option` (exit 2) unless `--` ends option parsing, so the adapter always emits `-- <prompt>`. |

## `--json` event envelope (verified on 1.4.0)

Each line is one record: `{schema_version, id, stream: {kind, id}, sequence,
recorded_at, record_type, durability, causation_id, payload_type,
payload_schema_version, payload}` — the same envelope as the native session
log. `recorded_at` is epoch microseconds. The records `parseOutput()` reads:

| `payload_type` | Payload fields used |
| --- | --- |
| `run.output.delta` | `text` (streamed answer text) |
| `run.terminal.completed` / `run.terminal.failed` | `terminal`, final `text`, `reason` (failure message) |

`parseOutput()` returns `{events, text, settled, terminal, reason}`: `settled`
is `true` only for `completed`, `false` for any other terminal state, and
`null` when the stream ends without a terminal record. Analysis calls run in
plain mode (no `--json`), where stdout is only the final answer text.

## Not assumed

- **Native transcript paths.** The native log root is evidenced
  (`$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`), but
  its line format is internal (retained transaction frames, omission
  markers), so `getTranscriptPath()` returns `null`. Transcripts come from
  `buildExportArgs()` (`muse export`), and the session catalog ingests only
  export documents (`src/sessions/adapters/muse.ts`, `#232`).
- **A pinned CLI version.** Unlike pi (`PI_SUPPORTED_VERSIONS`),
  `isAvailable()` checks only that `muse --version` exits 0 — no
  qualified-version list exists yet.
- **Other flags** such as `--user-input-auto-resolve` or
  `--no-foreign-personal-context` are not emitted. `--yolo` is never emitted either (`#230` out of scope);
  it disables approval **and** sandboxing (see below).

## Model discovery and worker approval

`aiwg models refresh --provider muse` reads Muse's local
`~/.local/share/muse/model-catalog/*.json` catalog and probes the configured
Muse executable with `--version`. With one enabled native Muse installation,
refresh binds rows to its configured account label and normalized runtime version,
using the same version parser as worker qualification. No inference call is made.

Qualification accepts exact model rows such as `muse-spark-1.3` when the catalog
reports `is_current: true`, an inference provider (`provider_id`), and matching
runtime/account evidence. Catalog visibility alone does not prove accessibility.
Missing evidence produces a Muse-specific `partial` warning: open the configured
Muse executable, sign in to the intended account, select the exact model, and
inspect its native catalog row. Then rerun
`aiwg doctor --probe-workers --qualify --cli muse --yes`.
If Muse omits `is_current: true`, use a Muse version that supplies this evidence;
repeated AIWG refreshes cannot create it. Approval records operator trust and
catalog observations, not a successful paid model call.

## CI sandbox / bubblewrap requirements

Muse Code ships a real OS-enforced sandbox (bubblewrap/seccomp + namespaces
on Linux, seatbelt on macOS) that is **on by default**. Consequences for CI:

- Linux runners need **bubblewrap installed and unprivileged user namespaces
  enabled** for `muse exec` to run under its default sandbox. A runner without
  them fails at spawn time — that is a host prerequisite, not an adapter bug.
- Never pass `--yolo` in CI: Meta documents it as disabling approval *and*
  the sandbox, "use it only on trusted code in a disposable, isolated
  container". The adapter has no code path that emits it.
- `--disable-approval` keeps the sandbox on (Meta docs) and is the
  unattended-safe posture — but the adapter does not default it; the operator
  opts in via the `approvalMode` session option.
- **No live Meta auth in CI.** All adapter tests run against the recorded
  fixture stub (`test/fixtures/providers/muse/muse-stub.mjs`,
  `AIWG_MUSE_BIN=<stub>`). The opt-in, evidence-gated live smoke
  (`npm run smoke:muse:live` with `AIWG_MUSE_LIVE_SMOKE=1`) needs an
  authenticated `muse` install and runs in a sandbox; it must never become a
  required CI job.

## Files

| Path | Role |
| --- | --- |
| `tools/ralph-external/lib/muse-adapter.mjs` | `MuseAdapter` (self-registers as `muse` when `AIWG_MUSE_RALPH_ENABLED` is not disabling) |
| `tools/ralph-external/lib/provider-adapter.mjs` | `isMuseRalphEnabled()` gate in `registerBuiltinProviders()` |
| `test/fixtures/providers/muse/muse-stub.mjs` | Offline CLI stand-in (exec/export/version scenarios) |
| `test/fixtures/providers/muse/manifest.json` | Fixture contract: evidenced flags, assumptions, disable flag |
| `test/unit/ralph/muse-adapter.test.mjs` | Contract tests — run with `npm run test:node` |

## Acceptance checklist

- [x] Adapter builds argv for exec, resume (`--session-id`), and export
      (`muse export`) with no live network.
- [x] `AIWG_MUSE_RALPH_ENABLED=0` disables the adapter; sibling providers and
      `aiwg use --provider muse` are unaffected (covered by tests).
- [x] Only documented flags are emitted; anything unevidenced is marked as
      such above and in the adapter header.
- [x] CI sandbox/bubblewrap requirements are called out above.
- [x] `--json` envelope, exit codes, `--session-id` semantics, `--`, and
      model ids verified against an installed Muse Code 1.4.0 (2026-09-25).
