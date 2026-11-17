# Cursor Agent direct-worker profile (B-OG-38, #2903)

This is the lightweight CLI profile for dispatching `cursor-agent` as a
direct worker.

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`cursor-agent 2026.11.13-eacade1`. Help, the live account model list and
manual smoke runs were observed on 2026-11-17. Earlier `H`/`D` evidence
includes help and an installed-module bundle read on `noodle` for
2026.10.01-e373342. The profile stays `unqualified` for dispatch until a
human qualifier reviews a live run. The adapter
(`tools/ralph-external/lib/cursor-adapter.mjs`) renders:

```
cursor-agent -p --output-format stream-json --trust --sandbox enabled \
  [--mode ask] --workspace <workspace> --model <catalog-model-id> < <brief>
```

The brief always travels on stdin (no prompt argument is ever emitted); the
installed-module bundle's prompt-building code reads stdin to EOF only when
no positional prompt argument is given. Effort is expressed by selecting
an exact model ID from `cursor-agent --list-models`, such as
`gpt-5.3-codex-high`; the adapter passes it unchanged. The 2026.11.13 help
still advertises bracket overrides for “parameterized models”, but a live
`--model 'claude-sonnet-5-thinking-high[effort=low]'` was rejected with
`Cannot use this model`, exit 1 and no JSON. The profile therefore never
appends brackets to listed IDs. `composer-2.5` offers no separate effort
selector; requested effort is validated metadata, not an independent CLI
control. Generic aliases and automatic selectors (`auto`, `default`)
remain forbidden for direct workers, even though the live list offers
`auto`. The captured help documents only `--model`, with no `-m` alias.
`--sandbox enabled` is
always emitted (never `--sandbox disabled`); `--mode ask` (the CLI's own
documented "(read-only)" mode) is additionally emitted only for the
`read-only` sandbox contract. `--trust` is always emitted so the one
remaining documented prompt (workspace trust) cannot block a
non-interactive run. `-f/--force`, `--yolo`, `--auto-review` and
`--approve-mcps` are never emitted.

**`--approve-mcps` is a bypass, not a convenience.** An installed-module
bundle read on noodle (`8192.index.js`) shows it sets `ignoreApprovals:
true` on the MCP approval source, which replaces the normal
`mcp-approvals.json`-backed check with a stub that always resolves
approved — folded upstream with `--force`/`--yolo` into one bypass flag.
Without it (this profile's choice), an MCP server that is not already
recorded as approved for that project fails to load and is skipped; the
run continues without that server's tools. It does not hang and does not
silently execute anything. The captured `--help` documents no flag to
disable MCP outright, and a fresh conductor workdir has no project-scoped
MCP config to begin with.

This CLI version's non-interactive path has **no** standalone
`type:"error"` terminal event: a thrown error writes a plain-text line
(not JSON) and exits non-zero, with no JSON result line at all. A missing
terminal plus a non-zero exit is the failure signal here. Defensively, the
adapter also fails closed on ANY `type:"error"` event, any event carrying
a non-null top-level `error` field, or a `type:"interaction_query"` line —
in any position in the stream, including strictly after an earlier
affirmative success, since a later clean-looking event must never repair
an earlier failure and vice versa.

## Live observations (2026-11-17)

The conductor supplied `help.txt`, `models.txt`, `smoke-bracket-err.txt`,
`smoke-plain.jsonl` and `smoke-mcp.jsonl` for CLI
`2026.11.13-eacade1`. This worker read those captures without invoking the
live CLI. They establish these bounded observations:

- The account list offers the catalog role models: reasoning
  `claude-opus-5-thinking-high`, coding `gpt-5.3-codex-high`, and efficiency
  `composer-2.5`. These entries are observed with `verifiedAt: 2026-11-17`;
  model-list presence does not establish resolved-model or effort fidelity.
- The bracket invocation above failed with exit 1 and no JSON.
- The plain `composer-2.5` invocation, with `-p --output-format stream-json
  --trust --sandbox enabled` and its brief on stdin, exited 0. Exactly one
  terminal had `type: result`, `subtype: success`, `is_error: false` and
  `result: cursor-smoke-ok`; no error or `interaction_query` events appeared.
- With an unapproved project `.cursor/mcp.json` server, the server never
  ran and the smoke exited 0, with the same success shape and
  `result: cursor-mcp-ok` (the separate MCP prompt's requested reply).
  No error or `interaction_query` events appeared. This supports the
  profile's omission of `--approve-mcps` for an unapproved server.

These smoke observations do not cover a full writing worker or qualify
unobserved permission, fallback or child-process behavior. Human review
of a live dispatch remains pending.

### Host AppArmor prerequisite

On hosts with `kernel.apparmor_restrict_unprivileged_userns=1`, the
`cursorsandbox` executable needs a host AppArmor profile allowing its user
namespace sandbox. Titan needed this profile before the successful smoke
runs; it is now installed there. Without the required host support, the
CLI fails with plain text beginning `Sandbox mode is enabled but not
available…` and a non-zero exit, with no successful JSON terminal. Arrange
the host profile before retrying; retain `--sandbox enabled`.

## Manual smoke run

The conductor runs this once, by hand, after `cursor-agent` is installed
and authenticated (existing login or `CURSOR_API_KEY`), to record a pass/fail
and the observed CLI version on the tracking issue. It is not part of
default CI and performs exactly one live, billable call.

```sh
d=$(mktemp -d) && cd "$d" || exit 1
MODEL="composer-2.5"
echo 'Reply with exactly: cursor-smoke-ok' \
  | cursor-agent -p --output-format stream-json --trust \
    --sandbox enabled --workspace "$d" --model "$MODEL" \
    > out.jsonl ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is
  a fail.
- **Reject the whole stream on any malformed line or error/approval
  event, not just a terminal-line grep.** Each line of `out.jsonl` must be
  valid JSON, and none may be `"type":"error"`, carry a non-null top-level
  `error` field, or be `"type":"interaction_query"`:

  ```sh
  jq -e -s '
    length >= 1
    and all(.[]; type == "object")
    and (all(.[]; .type != "error"))
    and (all(.[]; has("error") | not) or all(.[]; .error == null))
    and (all(.[]; .type != "interaction_query"))
  ' out.jsonl
  ```

  A non-zero `jq` exit (parse failure on any line, or any line matching
  one of the rejected shapes) is a fail by itself, independent of the
  affirmative terminal check below.
- **The affirmative terminal `result` line, with the same rule the
  adapter's `observeHealthEvent`/`parseDirectFinal` enforce**: exactly one
  line parses as JSON with `"type":"result"`, `"subtype"` exactly
  `"success"` (an `"interrupted"` or missing/unknown subtype is a fail
  even if other fields look clean), `"is_error"` exactly `false` (not
  merely absent or non-`true`), and `"result"` present and non-empty. A
  clean exit code and a clean `jq` pass above are never sufficient on
  their own; a missing terminal line is also a fail (this version never
  omits the terminal line on a true success).
- **`"result"` text**: the terminal line's `result` field should contain
  `cursor-smoke-ok`.

Record the installed `cursor-agent --version` output, the command above,
and the pass/fail outcome (exit code + whole-stream `jq` check + terminal
`result` line contents) on the tracking issue. This manual run is evidence
only; it never marks the registry profile as qualified for automated
dispatch.
