# Codex direct-worker profile (B-OG-07, #2897)

This is the lightweight CLI profile for dispatching `codex` as a direct
worker (not the Ralph-loop session driver documented in
[`codex-sessions.md`](./codex-sessions.md), which covers transcript import).

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`codex-cli 0.161.0` and documentation/help-evidenced only
(`H:` evidence grade). It stays `unqualified` for dispatch until a human
qualifier reviews a live run. The adapter
(`tools/ralph-external/lib/codex-adapter.mjs`) renders:

```
codex --no-daemon exec --ignore-user-config -m <model> \
  -c model_reasoning_effort="<effort>" -s <sandbox> -C <workspace> \
  -c approval_policy="<approval>" --skip-git-repo-check \
  -o <final>.last-message --json - < <brief>
```

The brief always travels on stdin (the trailing `-` prompt argument); it
never appears in argv. Effort and approval travel only as `-c` config
overrides — there is no `--effort` flag, and `approval_policy` is restricted
to `"never"` (non-prompting execution only).

The worker writes schema-valid `workerClaims` JSON to the exact `--final-output`
path (`output.resultPath` in the brief). Codex writes its last response to the
separate `<final>.last-message` capture. The launcher validates the worker-written
structured final; prose in the capture cannot satisfy that contract.

## Project hooks in Codex 0.167 (#4035, #4036)

The operator's 2026-11-09 harness audit reports that `codex exec` runs AIWG's
project hook only with **saved folder and hook trust**. The per-run override
`-c 'projects."<absolute-worktree>".trust_level="trusted"'` no longer enables
project hooks, even together with `--dangerously-bypass-hook-trust`. Sandbox
and approval flags do not establish hook trust. This differs from the
[0.165 probes](../hook-patterns.md#codex-0165-schema-verification-3888).

For an operator-approved automation run, open the exact worker worktree in
interactive Codex, review the folder, save its trust, and approve the reviewed
AIWG hook when prompted. Then use that same Codex home and worktree for exec.
Repeat this review for each fresh worktree; trusting the parent checkout does
not establish trust for a new worktree. AIWG deploy and doctor only advise;
they never persist trust or approve hooks.

**Worker limitation:** `aiwg models resolve` emits no hook-enabling trust
flags. The bundled direct-worker profile shown above uses `--ignore-user-config`,
which skips the saved config, so that profile cannot promise project hooks even
after interactive review. Do not change its reviewed launch flags ad hoc or
rely on hooks in unattended fresh worktrees. The deployed `AGENTS.md` therefore
requires discovery as the first tool call, followed by `WORKSPACE.md`, `AIWG.md`
and the per-harness rule index. This fallback also applies when hooks are absent.

### Supplied harness audit: 2026-11-09

The #4035 audit of `codex-cli 0.167.0` reported **0** session-log context items
with `"hook":true` for per-run trust plus bypass; all context items had
`"hook":false`. After interactive folder and hook approval, the same exec
reported **1** item with `"hook":true`. The #4036 no-hook p1/p2 runs discovered
at calls 1–4 across four runs, after bootstrap reads in the failing cases.
These are operator-supplied observations, not a new live verification of this fix;
raw session logs and a post-fix p1/p2 rerun remain with the conductor.

For a reviewed live rerun, record the exact CLI version, command, trust setup,
session identifier and the count of context items whose `hook` field is `true`
from that run's Codex session JSONL. Count `false` items too and record the first
tool call for p1/p2. `codex exec --json` stdout alone does not prove hook context
was delivered. Do not select an unrelated session by its latest timestamp.

## Manual smoke run

The conductor runs this once, by hand, after `codex` is installed, to record
a pass/fail and the observed CLI version on the tracking issue. It is not
part of default CI and performs exactly one live, billable call.

```sh
mkdir -p /tmp/codex-smoke && cd /tmp/codex-smoke
echo 'Reply with exactly: codex-smoke-ok' | codex --no-daemon exec \
  --ignore-user-config -m gpt-6-luna -c model_reasoning_effort="low" \
  -s read-only -C "$PWD" -c approval_policy="never" \
  --skip-git-repo-check -o smoke.last-message --json - ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is a
  fail, even if a final file was written.
- **`turn.completed` on stdout**: the `--json` stream is JSONL on stdout.
  Grep it for a terminal event: `codex ... --json - < prompt.txt | grep
  '"type":"turn.completed"'`. A run that exits 0 without a `turn.completed`
  (or that emits a standalone `"type":"error"` event anywhere in the stream)
  is a fail — a clean exit code alone is not sufficient.
- **`-o smoke.last-message`**: must exist and contain the final response text. An
  empty or truncated `smoke.last-message` alongside exit 0 is still a fail.

Record the installed `codex --version` output, the command above, and the
pass/fail outcome (exit code + `turn.completed` + `smoke.last-message` contents) on
the tracking issue. This manual run is evidence only; it never marks the
registry profile as qualified for automated dispatch.
