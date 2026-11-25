# Cursor Agent direct-worker profile (B-OG-38, #2903)

This is the lightweight CLI profile for dispatching `cursor-agent` as a
direct worker alongside Codex and Muse.

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` admits Cursor builds from
`2026.11.13` onward (`supportedVersions: >=2026.11.13`). Build hashes are
ignored only for range comparison; approval still binds the exact build.
Older builds and unknown build formats block. The tested build remains
`cursor-agent 2026.11.13-eacade1`. Help, the live account model list and
manual smoke runs were observed on 2026-11-17. Earlier `H`/`D` evidence
includes help and an installed-module bundle read on `noodle` for
2026.10.01-e373342. The bundled profile stays `unqualified`. After operator
approval with `aiwg doctor --probe-workers --qualify --cli cursor`, its process
invocation uses the trusted native renderer on the same terms as Codex, Muse
and Factory. Default direct-shell resolution adds no required controls;
explicit extra controls still need qualified mappings. No capability or
per-control qualification is inferred from that approval. The adapter
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

Operator-qualified Cursor passes the shared `native-sandbox` renderer gate
only for `read-only` or `workspace-write` shell invocations, subject to the
host prerequisite below. Group configuration still limits
`launchMode: "native-sandbox"` to Codex; Cursor groups use the default launch
mode. External sandbox and MCP transport remain excluded from the shared
native launch-mode gate. Cursor's renderer also rejects external sandbox
with the default launch mode. The existing child-agent guard still applies:
where child control is unavailable, dispatch requires the same explicit
`defaults.workerSelection.guards.denySelfDelegation: false` policy as Codex;
that policy permits uncontrolled children without qualifying their behavior.

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

## Authentication

Desktop account login uses the OS keyring. On Linux, the worker needs the
operator's `DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` to
read that login. The Cursor profile passes through those three variables
only when set, alongside the existing `HOME`, `PATH` and `CURSOR_API_KEY`
allowlist. All other conductor variables stay outside the worker. Values
are read at launch and are not printed in the rendered command or plan.

For headless hosts without a desktop keyring session, use key-based login
with `CURSOR_API_KEY` set in the conductor environment. Do not put the key
in the brief, command arguments or project configuration.

Qualification runs the configured executable's `status` command with the
same allowlisted environment and working directory as the rendered worker.
It requires an affirmative login/API-key status; an unavailable login,
failed probe or unrecognized response fails qualification without recording
approval. Probe output is never included in the report. If it fails, restore
the desktop session variables and unlock/sign into the keyring, or configure
`CURSOR_API_KEY` on the headless host, then qualify again. This model-free
check confirms authentication visibility at qualification time; it does not
establish model entitlement or guarantee that a later login remains valid.

## Live observations (2026-11-17)

### Model discovery and approval

`aiwg models refresh` observes `cursor-agent --list-models` through the
bounded discovery runner (15-second timeout) and stores observations in
the shared model catalog cache. When one Cursor installation is configured,
refresh uses its executable and accountScope label. Qualification also
reads the current list directly for each Cursor installation, unless
`localModels` is configured. An absent selector or a failed list command
cannot be approved from an older cache.

If qualification reports no exact current observations, it reports `partial`
for that CLI, including when no model invocation checks ran. Check the native
list using the executable configured at `parallelism.clis.cursor.executable`
(a pinned executable may differ from `cursor-agent` on PATH). Match enabled
group members to exact listed selectors, then record fresh observations and
approval with:

```bash
aiwg doctor --probe-workers --qualify --cli cursor --yes
aiwg models resolve --role coding --task implementation --group cursor \
  --brief brief.md --workdir "$PWD" --final-output out.md --transport shell --format json
```

Qualification reads the configured executable's list again; a separate
`aiwg models refresh` is optional. Old observations or a different installed
build cannot substitute for the current list. A failed list command is
reported with its redacted diagnostic; correct that failure before retrying
the qualification command. These checks build an invocation without calling
a model; the manual smoke below remains the conductor's live check.

The parser accepts `id - name` rows, removes zero-width characters and
trailing parenthetical notes from display names, and ignores the header,
blank lines and CLI usage tip. Malformed rows produce diagnostics without
echoing their contents. Command failures produce redacted diagnostics.
`auto` (and `default`, if listed) remains observable but unavailable for
worker approval.

Observations retain the exact listed selector as both `id` and `apiModelId`.
`llmProvider: cursor` identifies the Cursor gateway; upstream vendor and
family are not attested by this text list. Family, pricing and data-use facts stay unknown. A named effort suffix such as
`-high` or `-xhigh-fast` supplies only that selector's effort; unsuffixed
models do not gain an invented effort. Self-delegation remains unknown.
Model discovery does not itself qualify a worker or establish model fidelity.

A standalone, case-sensitive `1M` token in a display name supplies
`contextTokens: 1000000`, with provenance `/contextTokens:display-name-1M`.
No other name-derived sizes are inferred. Cursor exposes no structured context
or output limits; its stream init event reports only the display name.
Operators can declare exact-selector limits in `.aiwg/aiwg.config`:

```json
{
  "parallelism": {
    "clis": {
      "cursor": {
        "adapter": "providers:cursor",
        "accountScope": "local-account",
        "quotaScope": "cursor-account",
        "modelLimits": {
          "gpt-5.3-codex-high": {
            "contextTokens": 200000,
            "maxOutputTokens": 16000
          }
        }
      }
    }
  }
}
```

The example limits illustrate operator declarations; they are not verified
Cursor limits. Use limits confirmed for your account and selector. Each entry
requires a positive safe-integer `contextTokens`; `maxOutputTokens` is optional.
Operator limits override the display-name value and carry provenance
`/parallelism/clis/cursor/modelLimits`. Refresh discovery and requalify after
changing them. With neither source, context remains null and resolution refuses,
naming `parallelism.clis.cursor.modelLimits["<model id>"].contextTokens`.
An unreported output limit remains null; the resolver still checks the full
request against the context window.

### Captured smoke observations

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

After a self-update, doctor warns when the build is newer than tested while
keeping installation readiness. Run the smoke below; after a pass, return
to the project and run `aiwg doctor --probe-workers --qualify --cli cursor --yes`
to refresh approval for the exact installed build. Qualification checks the
version, worker authentication, catalog and invocation; it does not perform
the live smoke. The
range already admits newer builds, so each update needs no catalog edit.
If a smoke fails, report the version and failure so the supported range can
be narrowed.

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
