# DeepSeek Harness (`dsh`) direct-worker profile

Status: **unqualified, and not yet dispatchable** (offline S1 profile work,
roctinam/aiwg#2909, fix round 1). No live qualification has been performed.
Everything below is help/source-evidenced (grades `H`/`R`) plus no-model
probes (no credential in the throwaway `DSH_HOME`, so the run fails at the
local credential check before any network call) — never a completed model
response.

The shared launcher now writes the pure `buildWorkerArtifacts(invocation)`
patch declaration into its private run directory, substitutes
`${artifact:dsh-patch}` in argv, and removes the patch after execution.
Resolution and preview perform no writes. The declaration is
`[{name: 'dsh-patch', location: 'run-directory', content: <YAML>}]`;
workspace-relative locations remain deferred. Controls stay unqualified
pending an authenticated smoke run.

## Command

```
dsh --profile headless --patch <patchPath> --json -
```

- `<patchPath>` is a launcher-written YAML file that sets the
  `agent-default-model` plugin entry (`provider: deepseek-official` by default,
  `model`, `reasoningEffort`), the `sandbox-policy` entry
  (`mode: read-only|workspace-write`) and the `approval` entry
  (`policy: never`). The `permission` entry defines
  `headless-read-only` or `headless-workspace-write` with that exact
  sandbox/approval pair and sets `defaultPreset` to its name, so
  `dsh-permission-presets` can activate. It never contains the brief or a credential. The launcher writes it exclusively with mode 0600 and cleans it up.
- The brief travels on stdin via the `-` task argument ("`-` reads stdin",
  `dsh --profile headless --help`), never on argv.
- The default `direct-shell` profile allowlists `DEEPSEEK_API_KEY` and
  `PATH`. The opt-in OpenRouter profile below allowlists its own key instead.

## What is and is not verified

Reaching `MISSING_CREDENTIAL` on a no-model probe proves that a `--patch`
file is **read and parsed** before any model call. It proves **neither**
that `sandbox-policy.mode` confines file/exec access, **nor** what
`approval.policy: "never"` actually permits — no probe without a real
model call can exercise a tool call, so sandbox confinement and approval
semantics are **unverified**. Before #4313, the stock
`dsh-permission-presets` plugin failed to mount for `read-only`+`never`
and `workspace-write`+`never`, because neither matched a built-in preset.
The generated overlay now supplies a named preset and explicit default
for both accepted pairs. Offline patch tests cover the entire accepted
matrix; mounting a preset still does not establish enforcement. No analogy to how any other
CLI's sandbox/approval flags behave is drawn here — `dsh`'s own behavior
for this overlay is simply unverified. The overlay shape itself (which
plugin ids take which config fields) comes only from `--dump-config-schema`/
`--dump-default-config`, never from a run that exercised a tool call. With
`DSH_HOME` unset (see Known gaps), the operator's own profiles and plugins
load and could alter behavior in ways this document cannot characterize.

## Evidence

- `dsh --profile headless --help` (captured
  `.aiwg/working/s1-scratch/cli-help/dsh-0.2.0-rc.2.txt`): no `--model`,
  `--effort` or `--sandbox` flag exists; the task positional is `-` for
  stdin.
- `dsh --profile headless --dump-config-schema` / `--dump-default-config`
  (read on noodle, throwaway `DSH_HOME`, 2026-10-11): the `agent-default-model`
  plugin config (`provider`, `model`, `reasoningEffort`), the
  `sandbox-policy` config (`mode`), and the `approval` config (`policy`,
  enum `ask|never`).
- A no-model probe (`echo task | DSH_HOME=$(mktemp -d) dsh --profile
  headless --json -`) confirmed stdin arity, the credential env var name,
  and the exact `--json` event grammar for the error path.
- A no-model probe with `--patch /nonexistent/patch.yml` confirmed `dsh`
  fails closed (hard, uncaught exception, exit 1) before mounting any
  plugin or reading the task when the patch file is missing — quoted
  verbatim:

  ```
  $ echo x | DSH_HOME=$(mktemp -d) dsh --profile headless --patch /nonexistent/patch.yml --json -
  Error: dsh: failed to read overlay /nonexistent/patch.yml: Error: ENOENT: no such file or directory, open '/nonexistent/patch.yml'
      at loadOverlayPatches (.../dsh-app-boot/lib/index.js:3532:9)
      ...
  EXIT=1
  ```

  `dsh` itself fails closed here; this profile does not need a defensive
  check of its own for a missing patch.
- `danger-full-access` is the only shipped preset pairing `approval: never`
  and is a full bypass; this profile never emits it. The overlay now defines
  the narrower headless preset explicitly instead of relying on inference.

## Opt-in OpenRouter route

Use the existing installation binding's `profile: direct-shell-openrouter`
with a catalog/discovery model row whose `llmProvider` is `openrouter` and
`apiModelId` is an exact model in pi-ai's bundled OpenRouter catalog, such as
`deepseek/deepseek-v4.1-flash`. Select that row through the existing group
member model setting. The resolver carries it as
`selected.inferenceProvider: openrouter`; the adapter rejects a route/profile
mismatch. The official route accepts `deepseek` or `deepseek-official` and
continues to use `direct-shell`.

The OpenRouter profile allowlists only `OPENROUTER_API_KEY` and `PATH`.
The installation-level union permits either route's key, while each profile
restricts it to its selected route. Configure the existing installation
environment with the selected key; key values never enter argv, patches or
rendered plans. The patch adds:

```yaml
- id: llm-pi-ai
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
- id: agent-default-model
  config:
    provider: "openrouter"
    model: "deepseek/deepseek-v4.1-flash"
    reasoningEffort: "low"
```

For a standalone patch, pass `inferenceProvider: "openrouter"` and
`model: "deepseek/deepseek-v4.1-flash"` to `buildDeepSeekHarnessPatch()` in
the manual example below, and export `OPENROUTER_API_KEY` in the calling
environment. The generated patch also includes the permission preset.
The command remains `dsh --profile headless --patch <patchPath> --json -`.

The direct profiles accept versions `0.2.0-rc.2` and `0.2.2-rc.1`. The
issue's 2026-11-18 UAT reports this route working on `0.2.2-rc.1`; this fix
uses synthetic fixtures and performs no paid model calls. Both profiles
remain **unqualified**. Requalify the chosen model, effort, permissions,
version and route before dispatch; the reported UAT does not automatically
qualify this generated patch or installation.

## Known gaps (reported, not invented around)

- **`DSH_HOME` isolation**: `getEnvOverrides()` is called with no
  invocation context, so a per-run isolated `DSH_HOME` cannot be
  synthesized without either sharing one `DSH_HOME` across concurrent runs
  (an isolation risk) or passing invocation context (e.g. `runDir`) into
  `getEnvOverrides()`. This profile leaves `DSH_HOME` unset, so the
  operator's own profiles/plugins/sessions load and could alter behavior.
- **Children control**: the subagent/fork tools are bundled by default; a
  disabling patch exists in principle (`disabled: true` on
  `tool-subagent`/`tool-subagent-fork`/...) but is not live-verified, so
  `children` stays `unqualified`.

## Manual smoke run

Requires an installed `dsh` and a real `DEEPSEEK_API_KEY` (or an
OpenRouter route as described above — not yet qualified).
This manual command writes the patch exclusively with mode 0600 using
`buildDeepSeekHarnessPatch()`. Normal one-shot execution uses the shared
launcher artifact hook.

```sh
d=$(mktemp -d)
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { buildDeepSeekHarnessPatch } from "./tools/ralph-external/lib/deepseek-harness-adapter.mjs";
const patch = buildDeepSeekHarnessPatch({ model: "deepseek-flash", effort: "low", sandbox: "read-only", approval: "never" });
writeFileSync(process.argv[1], patch, { flag: "wx", mode: 0o600 });
' "$d/patch.yml"
echo "Reply with exactly: smoke-ok" | DSH_HOME="$d/home" DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  dsh --profile headless --patch "$d/patch.yml" --json -
```

Read pass/fail from the event stream: pass requires the **last** line to be
`{"type":"final","text":"smoke-ok"}` (or text containing it) and the
preceding `{"type":"status","phase":"turn_end",...}` line to carry
`"reason":{"kind":"completed"}`. Any `{"type":"error",...}` line, any
`tool_result` with `"status":"error"`, or a `turn_end` whose
`reason.kind` is not `"completed"` is a fail — even if the process exits 0
and `final.text` is non-empty (an error path can still carry partial
assistant text from before the failure).
