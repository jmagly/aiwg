# Muse Code headless Ralph adapter (`muse exec`)

Optional / post-experimental Ralph-external provider adapter for Muse Code
(`#230`, parent `#223`). It drives Meta's documented headless surface —
`muse exec` — for the external agent loop (`tools/ralph-external/index.mjs
--provider muse`), with session resume (`--session-id`) and the
transcript/export path (`muse export`). Adapter plus recorded fixtures only;
no live Meta auth anywhere in CI.

## Status

Experimental and **disabled-safe**: set `AIWG_MUSE_RALPH_ENABLED=0` (also
`false`, `no`, `off`) to keep `muse` out of the Ralph provider registry
entirely. The flag is consulted only by
`tools/ralph-external/lib/provider-adapter.mjs` during built-in registration —
it is unknown to `src/providers/` and to the writer/deploy path, so disabling
the adapter never affects `aiwg use --provider muse`.

Per `docs/architecture/adr-muse-provider-target.md` ("Headless Ralph"), this
adapter is optional and post-experimental: it does not block the experimental
cut (`#225`–`#229`) or stable promotion (`#231`), and no `muse exec` contract
is assumed until evidenced against the installed CLI surface.

## Evidenced flags (Meta docs, dev.meta.ai/docs/muse-code/)

| Flag | Evidence |
| --- | --- |
| `muse exec [OPTIONS] [PROMPT]` | Headless entrypoint; "takes one prompt, runs it to completion, and exits" ([extending](https://dev.meta.ai/docs/muse-code/extending)). Prompt is positional and must come last; options are parsed by `exec`, not the `muse` root, so adapter argv always starts with `exec`. |
| `--json` | "Emit JSONL events"; headless-only ([extending](https://dev.meta.ai/docs/muse-code/extending), [configuration](https://dev.meta.ai/docs/muse-code/configuration)). |
| `--session-id <uuid>` | "To continue an interrupted job non-interactively, use `exec` with the session id" ([extending](https://dev.meta.ai/docs/muse-code/extending)). There is no headless resume flag; re-passing the id continues the session. `muse resume` is interactive-only. |
| `--prompt-file <path>` | Headless-only ([configuration](https://dev.meta.ai/docs/muse-code/configuration)). |
| `--max-model-steps <n>` | Headless-only, "cap the run" ([configuration](https://dev.meta.ai/docs/muse-code/configuration)). The adapter maps the `maxTurns` capability to this flag; it never emits `--max-turns`, which `muse` would reject with exit code 2. |
| `--model <id>`, `--reasoning-effort <level>` | Common to both launch surfaces ([configuration](https://dev.meta.ai/docs/muse-code/configuration)). The CLI enumerates no model ids; the documented default is `muse-spark-1.2`, so `mapModel()` passes names through. |
| `--approval-mode <mode>` | Common to both; "`muse exec` accepts both approval flags" ([configuration](https://dev.meta.ai/docs/muse-code/configuration)). **Opt-in only** — the adapter sets no approval posture by default. |
| `muse export --session <uuid> --out <path>` | Offline, byte-deterministic transcript projection; "never modifies the log" ([audit-agent-sessions](https://dev.meta.ai/docs/cookbook/audit-agent-sessions)). `--last` and `--redacted` are also documented there. |
| Exit codes `0` / `1` / `2` / `130` / `143` | 0 = turn completes, 1 = fails or is cancelled (including a `--max-model-steps` limit), 2 = usage error, 130/143 on SIGINT/SIGTERM ([extending](https://dev.meta.ai/docs/muse-code/extending)). |

## Assumed nowhere (fail-closed)

- **The `muse exec --json` JSONL envelope schema.** `parseOutput()` validates
  JSONL framing only and reports settlement as indeterminate (`settled: null`);
  no text is extracted from the unevidenced envelope. The loop treats the
  documented exit codes as the completion signal until the envelope is
  evidenced against an installed CLI.
- **A native session-log root.** Per the ADR fail-closed path policy the
  adapter assumes no `$XDG_DATA_HOME/muse/sessions` root, so
  `getTranscriptPath()` returns `null`. Transcripts are produced through the
  adapter's `buildExportArgs()` (`muse export`); the session-catalog track
  ingests only operator-supplied export documents
  (`src/sessions/adapters/muse.ts`, `#232`).
- **A pinned CLI version.** Unlike pi (`PI_SUPPORTED_VERSIONS`),
  `isAvailable()` checks only that `muse --version` exits 0 — no
  qualified-version list exists yet.
- **Third-party-only flags** (`--resume-id`, `--user-input-auto-resolve`,
  …) are not emitted. `--yolo` is never emitted either (`#230` out of scope);
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
  `AIWG_MUSE_BIN=<stub>`); there is no live smoke lane for muse. A future
  evidence-gated live smoke (`npm run smoke:muse:live`) would require an
  authenticated `muse` install and an operator-run sandbox — it must never
  become a required CI job.

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
- [ ] Live envelope schema still unevidenced — needs an installed `muse` CLI
      and operator review (future work, not CI).
