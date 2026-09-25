# Muse Code headless Ralph adapter (`muse exec`)

Optional / post-experimental Ralph-external provider adapter for Muse Code
(`#230`, parent `#223`). It drives Meta's documented headless surface —
`muse exec` — for the external agent loop (`tools/ralph-external/index.mjs
--provider muse`), with session resume (`--session-id`) and the
transcript/export path (`muse export`). CI runs recorded fixtures only, with
no live Meta auth; the contract below was verified by hand against an
installed Muse Code 1.4.0 on 2026-09-25.

## Status

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
