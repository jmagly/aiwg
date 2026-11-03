# Turn On Direct Worker Dispatch

Unknown workers count against every group's cap and host capacity. Workers with
workspace/group markers consume their own group's cap; workers attributed to
another workspace consume host capacity only. For inspection and safe recovery,
see [worker attribution and recovery](worker-attribution.md).

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md).

For shared admission, fenced cancellation and recovery, see [Operate managed worker
dispatch](managed-worker-dispatch.md).

## What it does

AIWG can dispatch bounded pieces of work directly to other AI CLIs installed on your machine (for example
Codex or Muse), instead of only delegating inside the single provider session you are talking to. This is
controlled by one setting: `parallelism.worker_dispatch` in `.aiwg/aiwg.config`. It is off by default.

When it is off, AIWG's model-selected delegation rubric still applies — the active provider delegates to
its own native subagents. When it is on, AIWG can also place work directly onto other configured worker
CLIs. See [local-only conductor inputs](../providers/conductor-local-only-inputs.md) before opening classified task files.

## What it costs

Direct dispatch uses your **other accounts' quota**. If AIWG dispatches a task to Codex or Muse, that run
consumes that tool's own API/account usage — not the provider session you started from. Review the
parallelism caps and worker configuration before enabling it on a shared or metered account.

## How AIWG offers it

> "Check which helper CLIs are installed. If two or more are ready, ask me whether to turn on dispatch."

Your assistant runs a fast, local presence-only check — no network call, nothing spawned — and asks one yes/no question naming the detected CLIs. The default answer is no.

`aiwg init` and `aiwg setup project` detect which supported worker CLIs are installed (a fast, local,
presence-only check — no network call and nothing is spawned). When two or more are detected and dispatch
is off, the setup step asks one yes/no question naming the detected CLIs. The default answer is **no**:
nothing is enabled without an explicit yes at a terminal, or an explicit config command. After enabling
and configuring workers, the next step is `aiwg doctor --probe-workers --qualify`.

Until you answer, or whenever the question can't be asked (non-interactive runs, CI, dry runs), `aiwg
regenerate`, `aiwg refresh`, and `aiwg doctor --probe-workers` print a single reminder line instead
(naming the enable command) when dispatch is still off and two or more worker CLIs are detected.

### Answering headlessly

> "Answer the dispatch question without a terminal: decline it for this script."

Your assistant passes the headless answer directly, so the question is never asked and nothing waits on a terminal.

`aiwg init` and `aiwg setup project` both accept `--worker-dispatch enable|decline` directly, so a script
or agent running either command without a terminal can answer the question without waiting for the
interactive prompt or leaving it unanswered:

#### Command reference: answering headlessly

```bash
aiwg init --non-interactive --worker-dispatch enable
aiwg setup project --yes --worker-dispatch decline
```

- `enable` writes `parallelism.worker_dispatch: true` and nothing else;
  `decline` writes `setup.worker_dispatch_offer: "declined"` and nothing else.
- With a terminal attached, passing the argument still answers the question
  directly — it is never asked.
- The argument is honored even when fewer than two worker CLIs are detected: an
  explicit choice always overrides the presence-only detection gate above.
- `--dry-run` never writes, even with the argument — it reports what would be
  written instead (`aiwg setup project --json --dry-run` reports it under
  `worker_dispatch_offer.applied_choice`). This holds for the whole command, not
  just the worker-dispatch increment: `aiwg init --dry-run` on a brand-new project
  writes nothing at all — not `.aiwg/aiwg.config`, not `AIWG.md`, not
  `WORKSPACE.md` (#3062 review item 18; previously it wrote the baseline config
  unconditionally even under `--dry-run`).
- An unrecognized value (anything other than `enable`/`decline`) exits non-zero
  naming the accepted values.
- Without a terminal and without the argument, behavior is unchanged (the
  one-line reminder above) except that the reminder now also names
  `--worker-dispatch` as the direct, headless way to answer it.

If you say no, AIWG remembers the decline (`setup.worker_dispatch_offer: "declined"` — a setup
preference, kept separate from the worker-policy settings above) and stops offering it entirely: the
question is not asked again, and none of the reminder lines above print anymore either. The generated
project context also reflects the decline so agents don't keep re-offering it. To change your mind later,
just run the enable command below directly — turning dispatch on always takes priority over a recorded
decline, so there is no separate "undo the decline" step.

## How to turn it on

> "Turn on worker dispatch and check the helpers are actually launchable."

Your assistant enables `parallelism.worker_dispatch`, then probes the configured CLIs and qualifies them before any dispatch.

### Command reference: turning it on

```bash
aiwg config set --project parallelism.worker_dispatch true
```

Then confirm the CLIs AIWG would dispatch to are actually installed and launchable:

```bash
aiwg doctor --probe-workers
```

For machine-readable output (one record per CLI with `cli`, `installed`, `version`, `inRange`, `ready`,
`reason`, plus top-level `probeWorkers`/`workerDispatch`/`workersConfigured` fields), add `--json` —
stdout holds exactly that JSON document and nothing else:

```bash
aiwg doctor --probe-workers --json
```

With no worker CLIs configured, the text run prints one `Direct Worker` line saying so and how to
configure them; the JSON run reports `"workersConfigured": false` with the same guidance in `message`.
Add a complete entry with the required adapter and account/quota scopes, for example:

```bash
aiwg config set --project parallelism.clis.codex '{"adapter":"providers:codex","accountScope":"local-account","quotaScope":"local-quota"}'
```

When dispatch is disabled, JSON still includes every configured CLI with reason `WORKER_DIRECT_DISABLED`
and a message explaining that no probes ran. Unknown `aiwg doctor` flags exit non-zero naming the flag.

## Configure a worker group

> "Set up a harness group with Codex for coding and Muse as fallback. Keep credentials out of both files."

Your assistant writes the group and role guidance, then resolves a trial brief to check coverage before any real dispatch.

Two files work together: **`.aiwg/aiwg.config`** declares the CLI installations and worker groups;
**`models.json` at the project root** supplies role guidance. It is not `.aiwg/models.json`. Model
settings merge in this order, highest precedence first: project-root `models.json`,
`$AIWG_CONFIG/models.json` (normally `~/.config/aiwg/models.json`), then bundled defaults. `aiwg config
set --project` only edits `.aiwg/aiwg.config`; edit `models.json` directly, including in headless setup
scripts. There is currently no role-guidance setter.

Qualification and `models resolve` report `OG_CONFIG_REFERENCE` at
`/defaults/workerSelection/roleGuidance/<role>/initialEffort` when role guidance or a required explicit
effort is missing. Set that role's `initialEffort` in `models.json` before qualifying; a fresh worktree
may lack local-only settings. Null effort is reserved for models with qualified evidence that effort does
not apply. When no installation approval is recorded, `models resolve` still reports
`OG_ADAPTER_UNQUALIFIED`; run qualification to diagnose missing role effort.

Qualify each worktree from its own project root. The host installation store retains up to 128 approvals
keyed by CLI and canonical workspace path; requalifying one workspace replaces only its approval. Each
record retains its own policy, installation digests, and input/output roots. Approval does not extend to
siblings, descendants, or other worktrees sharing a Git common directory. An unapproved workdir still
fails with `qualified_workspace_mismatch`; run qualification there explicitly. Concurrent qualification
writes are serialized. A full store refuses a new approval without evicting existing ones. A crashed
writer can leave a `worker-installations.json.lock` beside the host store; after verifying no
qualification process is running, remove that lock and retry. Changes to the host store invalidate
previously saved invocation bindings; resolve again before launching them.

Qualification records are signed with the existing Ed25519 effect-ledger key configured by
`effects.keyProvider` in `aiwg.config`, using the default `delivery` ledger's public keyring. Initialize
that keyring with `aiwg effect keys init` before qualifying; no separate worker key is created. Keep the
key and keyring outside worker-writable paths. Loading checks the signature against that keyring,
including key IDs and validity windows, before importing a worker adapter. Missing keys prevent new
qualifications; invalid or missing signatures disable the affected installation and produce a scoped
doctor diagnostic.

Existing unsigned approvals deliberately require **one-time requalification**: re-run `aiwg doctor
--probe-workers --qualify` in each approved workspace. They are treated as unqualified until the negative
suite runs again and the result is signed; existing unsigned evidence is never silently signed or
upgraded. Projects without `parallelism.worker_dispatch` keep their existing behavior.

Run commands from the project root. For a new project, the following is a complete minimal
`.aiwg/aiwg.config`. For an existing project, merge its `parallelism` keys into your existing
configuration, preserving providers, scripts and other settings. The account/quota scope names identify
your local bindings; replace them if these CLIs use different accounts or share a quota.

**`.aiwg/aiwg.config`:**

```json
{
  "version": "1",
  "parallelism": {
    "worker_dispatch": true,
    "max_parallel_subagents": 4,
    "clis": {
      "codex": {
        "adapter": "providers:codex",
        "accountScope": "local-codex-account",
        "quotaScope": "local-codex-quota"
      },
      "muse": {
        "adapter": "providers:muse",
        "accountScope": "local-muse-account",
        "quotaScope": "local-muse-quota"
      }
    },
    "groups": {
      "harness": {
        "maxParallel": 2,
        "requiredRoles": ["efficiency", "coding", "reasoning"],
        "members": [
          { "id": "fast", "cli": "codex", "model": "gpt-5.6-luna", "roles": ["efficiency"], "priority": 10, "enabled": true },
          { "id": "coder", "cli": "codex", "model": "gpt-5.6-terra", "roles": ["coding"], "priority": 10, "enabled": true },
          { "id": "reviewer", "cli": "codex", "model": "gpt-5.6-sol", "roles": ["reasoning"], "priority": 10, "enabled": true },
          { "id": "alternate", "cli": "muse", "model": "muse-spark-1.3", "roles": ["efficiency", "coding", "reasoning"], "priority": 20, "enabled": true }
        ],
        "fallback": ["alternate"],
        "execution": {
          "isolation": "worktree",
          "sandbox": "workspace-write",
          "approval": "never",
          "network": "deny",
          "transport": "shell",
          "receipts": "optional"
        }
      }
    }
  }
}
```

**`models.json` (project root):**

```json
{
  "defaults": {
    "workerSelection": {
      "roleGuidance": {
        "efficiency": {
          "groups": ["harness"],
          "tier": "economy",
          "initialEffort": "medium",
          "effortLadder": ["medium", "high"]
        },
        "coding": {
          "groups": ["harness"],
          "tier": "standard",
          "initialEffort": "medium",
          "effortLadder": ["medium", "high"]
        },
        "reasoning": {
          "groups": ["harness"],
          "tier": "standard",
          "initialEffort": "high",
          "effortLadder": ["high", "xhigh"]
        }
      }
    }
  }
}
```

`models.json` is not automatically ignored by Git. If these are machine-local choices, add `/models.json`
to `.git/info/exclude` (local only) or your project's `.gitignore`. Commit it only when you intend to
share project policy. Keep credentials out of both files.

### What the fields mean

- A member's `id` is unique within its group; `cli` names a configured
  `parallelism.clis` entry, and `model` is the exact catalog model ID, not an alias.
  `roles` lists its permitted roles: `efficiency`, `coding`, and/or `reasoning`.
  `enabled: false` disables a member; disabling its CLI disables all its members.
- Lower `priority` values are preferred. Ties preserve declaration order.
  `fallback` lists existing member IDs for alternate routes. The current direct
  resolver iterates members by priority/declaration order; the fallback list does
  not override that order, so give alternatives a higher numeric priority.
- `requiredRoles` requires enabled coverage for each listed role. Qualification
  must also cover those roles before dispatch. `maxParallel` caps group
  concurrency alongside the project/provider and admission caps.
- `execution` declares the required controls, not proof that a CLI enforces them.
  `isolation` accepts `worktree`, `snapshot`, or `isolated-copy`; `sandbox` accepts
  `read-only`, `workspace-write`, or `external`; `approval` accepts `never` or
  `on-request`; `network` accepts `deny` or `allowlisted`; `transport` accepts
  `shell` or `mcp`; `receipts` accepts `off`, `optional`, or `required`.
  The example spells out the defaults. Optional `runnerRef` and
  `verifierRunnerRef` identify runners when required by your setup. Unsupported
  controls block dispatch; qualification does not make them enforceable.
- Each requested role needs `defaults.workerSelection.roleGuidance`. Its
  `groups` is an ordered list of eligible group names. A requested `--group`
  must belong to that list. Missing guidance produces
  `OG_CONFIG_REFERENCE /defaults/workerSelection/roleGuidance`.
- `tier` sets role selection guidance (`economy`, `standard`, `premium`, or
  `max-quality`); it does not replace a member's exact model pin or authorize
  premium use. `initialEffort` is tried first; `effortLadder` lists permitted
  efforts in order. The initial effort must occur in the ladder. Use only
  efforts discovered for that model; `ultra` is denied by default because it
  can self-delegate. Models with explicit `none` need `initialEffort: "none"`
  and an empty ladder. For effort that is not applicable, use
  `initialEffort: null`, an empty ladder, and `allowNotApplicableEffort: true`.

### Choose models by role, then qualify

> "Use the economy helper for inventory and the standard one for implementation. Check what my accounts actually support."

Your assistant maps each task class to its role, checks current discovery for models and efforts, and only then qualifies.

Use `efficiency` for inventory and bounded simple tasks, `coding` for implementation, and `reasoning` for
architecture and review. The example uses the bundled catalog's Luna/Terra/Sol role mapping and Muse
Spark as an alternate. Check the models and supported efforts actually available to your accounts with
`aiwg models sources --json`; use `aiwg models refresh --json` when you intend to refresh discovery.
Catalog presence alone is not dispatch approval.

Astra-class (and Fable-class) models are **flagship, user-elected only** under
#2643's tier policy. Keep them out of
automatically selected group members and fallback routes. `--authorize-premium` authorizes a premium
escalation for one resolution after explicit human approval; it does not authorize automatic flagship
selection.

With both files in place, the built-in task classes are `inventory` → `efficiency`, `implementation` →
`coding`, and `architecture`/`review` → `reasoning`. Additional mappings belong in
`defaults.workerSelection.taskClasses`. A minimal check is:

### Command reference: checking role coverage

```bash
printf '%s\n' 'Inspect this project and report a bounded implementation plan.' > brief.txt
aiwg models resolve --role coding --task implementation --group harness \
  --brief "$PWD/brief.txt" --workdir "$PWD" --final-output "$PWD/result.json" --format json
```

Before qualification this exits with a blocked plan naming `OG_ADAPTER_UNQUALIFIED`, rather than a
missing group or role-guidance error. `aiwg models validate` validates artifact policies, so it is not a
substitute for this worker configuration check. Repeat with `--role efficiency --task inventory` and
`--role reasoning --task review` to check the other roles. Next follow [Qualify the installed
CLIs](#qualify-the-installed-clis); actual dispatch still requires discovered models/efforts, approved
installations and supported controls.

## Supported CLI versions

Both the adapter and its invocation profile declare `supportedVersions`; the installed version must
satisfy both. These are semver ranges: space-separated comparators are ANDed, so Codex's `>=0.161.0
<0.200.0` includes patch and minor updates from 0.161.0 up to, but excluding, 0.200.0. Muse uses
`>=1.4.4-R5419.1 <2.0.0`, retaining the originally evidenced build and accepting subsequent stable 1.x
releases.

The shared matcher uses standard semver prerelease ordering: `1.4.4-R5419.1` precedes `1.4.4`;
prereleases are admitted only when a comparator explicitly names a prerelease with the same
major/minor/patch. Build metadata (`+build.1`) does not affect precedence. Registered banner patterns
extract the version before matching; for example, `Muse Code 1.4.10 (1.4.10-R6427.1)` yields `1.4.10`.

Versions below the minimum or at/above an exclusive upper bound remain not-ready with
`WORKER_DIRECT_VERSION_OUT_OF_RANGE`. A matching version establishes installation readiness; dispatch
still requires the existing qualification checks.

## Reusable group templates and project rubrics

> "Give me two worker groups sharing one template, plus a maintenance role based on coding."

Your assistant merges the template, validates that everything only narrows, and resolves a trial brief against the new role.

Templates live in the same `parallelism` family. Groups and templates may reference one named
`groupTemplates` entry with `template`; references may nest. Missing references and cycles fail
validation. These two CLI profiles use the Codex and Muse installations from the example above; model
names and supported efforts still require current discovery and installation approval.

Merge this into `.aiwg/aiwg.config.parallelism`, replacing its groups:

```json
{
  "groupTemplates": {
    "bounded-code": {
      "maxParallel": 2,
      "efforts": ["medium", "high"],
      "dataPolicy": { "allowedProcessing": ["local", "remote"], "allowUnknown": false },
      "members": [
        { "id": "coder", "cli": "codex", "model": "gpt-5.6-terra", "roles": ["coding"], "priority": 10 },
        { "id": "alternate", "cli": "muse", "model": "muse-spark-1.3", "roles": ["coding"], "priority": 20 }
      ]
    },
    "focused-code": { "template": "bounded-code", "maxParallel": 1, "efforts": ["medium"] }
  },
  "groups": {
    "implementation": { "template": "bounded-code" },
    "maintenance": { "template": "focused-code" }
  }
}
```

Members inherit when omitted. An explicit member list may reorder or remove members, narrow their roles,
or disable them; it cannot add/rebind identities or re-enable inherited disabled members. Concurrency,
effort and data ceilings may only narrow. Required roles accumulate; inherited execution controls must
agree exactly. Existing project, admission, CLI, model, quota and request ceilings still intersect. Group
`dataPolicy` uses the existing restriction-aware model-policy merge. For example, a user `models.json`
containing the following conflicts with the template above, which explicitly allows remote processing:

```json
{ "defaults": { "workerSelection": { "dataPolicy": { "allowedProcessing": ["local"] } } } }
```

Loading fails with `OG_POLICY_RELAXATION`; narrow the template to `["local"]` and use only local,
qualified observations. Similarly, changing `maintenance.maxParallel` to 3 or its `efforts` to
`["medium", "ultra"]` fails. Failed candidates never replace the loader's validated cache.
`workerPolicyOrigins` retains every referenced template's source, pointer, digest and original
contribution; generated guidance displays the expansion chain and digests. Edit the referenced source and
resolve again after changes.

A project rubric belongs in project-root `models.json.defaults.workerSelection`, alongside the existing
base roles:

```json
{
  "roleGuidance": {
    "coding": {
      "groups": ["implementation", "maintenance"], "tier": "standard",
      "initialEffort": "medium", "effortLadder": ["medium", "high"]
    },
    "maintenance": {
      "baseRole": "coding", "groups": ["maintenance", "implementation"], "tier": "standard",
      "initialEffort": "medium", "effortLadder": ["medium"]
    }
  },
  "taskClasses": { "maintenance": "maintenance" }
}
```

Additional roles must declare an existing `baseRole`: `efficiency`, `coding` or `reasoning`. Only project
layers may declare aliases. Aliases cannot chain, change tier authority, expand the base's
groups/efforts, enable unsupported null/none effort, or weaken escalation controls. Existing
efficiency/reasoning guidance must reference groups retained in your configuration. Base-role
qualification and wrapper pins apply through either CLI profile; denied, stale, unqualified or
data-ineligible candidates stay excluded even if reordered. Direct health scaling uses the base role.
Structured direct briefs retain that base role in `intent.role`; the request selects the alias and must
match its configured task class.

### Command reference: rubric check

```bash
aiwg models resolve --role maintenance --task maintenance --group maintenance \
  --brief "$PWD/brief.txt" --workdir "$PWD" --final-output "$PWD/result.json" --format json
```

No Mission/MC state, daemon, scheduler or activation marker is needed for this direct handoff.

## Qualify the installed CLIs

> "Qualify the installed helpers in this worktree."

Your assistant probes the configured CLIs, confirms the approvals, and records signed installation approval. Full procedure: [Worker dispatch runtime](worker-dispatch-runtime.md#qualify-the-installed-clis).

## Worker health windows and supervision

> "The helper has gone quiet. Check whether it is stuck before stopping anything."

Your assistant supervises by observer state, never by suspicion: quiet is not a stop, and only a hung worker this conductor owns is stopped, with the stop confirmed.

The generated `AIWG.md` carries only a one-line summary of the configured worker health windows. The full
explanation lives here (moved out of the startup context,
#3451).

Configured health windows each carry an origin, `default` or `project config`. Defaults: check every 15s,
confirm startup within 60s, quiet limit 90s, stall limit 300s, hard stop 1800s. Per-attempt windows scale
quiet and stall by the single largest applicable role/effort/model factor, never their product (for
example, reasoning at `xhigh` effort resolves 180s/600s from the 90s/300s defaults; an effective 1.25
scale gives 112.5s/375s). Only the hard deadline and its diagnostic/termination grace periods are capped
by the remaining wall-clock and transport ceilings; startup, quiet, and stall keep their configured or
scaled values, and `truncatedWindows` instead records when one of them would exceed that capped deadline
(`resolveWorkerEffectiveHealth()` in `src/serve/worker-invocation.ts`). Resolved values win over the
configured values. `aiwg models resolve --format json` shows the resolved windows in `invocation.health`
with per-field `origins`.

Supervise by observer state, never by suspicion. `quiet` (no observed activity for the quiet window,
reported with confidence `suspected`) is not a stop: read the status (`aiwg ralph-external --status
--workers --runs-root <dir> --json` is read-only and never kills or retries), check owned-worktree
progress, and keep waiting; the observer's `shouldStop()` stays false. `stalled` (no progress for the
stall window) opens diagnosis through the diagnostic grace period; only `hung` (still no progress after
grace, with the process live and connected) authorizes a no-progress stop, and only a worker this
conductor owns. The launcher also stops independently of progress state on `failed-to-start`, the hard
wall-clock deadline (`HARD_DEADLINE`), the step-count limit (`STEP_LIMIT`), and a fatal observer-record
failure (`tools/ralph-external/session-launcher.mjs`). Confirm the stop (a sent signal, lease expiry, or
final-file presence is not proof; only a confirmed exit is), preserve partial work for independent
verification, then re-resolve within remaining attempts and budgets. Observer loss (`OBSERVER_GAP`,
`DISCONNECTED`, degraded or unobserved coverage, opaque MCP output) is unknown, never worker failure:
keep polling owned run files and processes from the shell at the same cadence. Heartbeats and log bytes
are not progress. On correlated failure across workers sharing one account, quota, or host, pause further
launches there and report cause and scope.

## Direct-path recovery evidence and status

> "The worker failed. Check whether it is a real provider or quota outage, and show me what is safe to retry."

Your assistant treats worker output as untrusted outage claims, checks the trusted upstream observation, and reads status that never launches probes or retries work.

Direct recovery reuses the scoped breaker in the launcher and MCP worker owner. For both shell and MCP
transports, stdout, stderr, structured worker errors, and worker-writable files are untrusted outage
claims. They can request a diagnostic, but never establish a provider, quota, or host outage by
themselves.

The trusted upstream observation is one conductor-owned HEAD request per failed attempt to the first
endpoint already authorized by installation qualification. It sends no task, credentials, or inference
body and refuses redirects. A trusted HTTP 5xx implicates only the resolved inference provider; HTTP 429
implicates only the qualified account's quota scope. Missing identities stay invocation-local. Connection
errors and HTTP 401/403/404 do not establish an upstream outage. Launcher-observed native resource errors
(`ENOMEM`, `ENOSPC`, `EAGAIN`, `EMFILE`, `ENFILE`) and unit results (`oom-kill`, `resources`) require at
least two distinct resolved backends before implicating `host:local`.

A shared scope opens after three distinct failed invocations within 120 seconds, or when every member of
a frozen cohort of at least two outstanding invocations fails with trusted evidence. Replays do not count
as distinct invocations. The initial cooldown is 120 seconds. Each failed probe/canary doubles it, capped
at 900 seconds, with at most 1000ms jitter. Trusted retry/reset headers can extend eligibility by at most
24 hours. The diagnostic and subsequent recovery probes each consume an existing task attempt and have a
10-second/64-KiB limit; an unexpected response body is cancelled without being read. An expired or
cancelled task cannot send another request. A successful probe admits one task canary, bounded by the
remaining task deadline and 300 seconds. Only its verified success closes the scope. Unknown termination
blocks overlapping retries; unavailable qualified probes require operator intervention. No recovery path
grants more attempts, budget, or permissions.

### Command reference: recovery status

Read status with the existing command:

```bash
aiwg ralph-external --status --workers --runs-root <dir> --json
```

Text and JSON show scopes, fixed reason codes, next eligibility, canary activity, and recent transitions,
including successful canary closure. Each snapshot holds at most 32 scopes and 32 transitions and reports
omitted scopes. MCP worker `status` exposes the same projection from its live owner. CLI status reads the
latest recorded launcher snapshot with its observation time; it cannot query a separate conductor's live
memory. Status reads never launch probes, expire reservations, reset scopes, kill workers, or retry work.
These records are diagnostic snapshots, not persisted breaker authority: a conductor restart still starts
with closed scopes and retains the separate stop-before-retry checks.

Before launching, the launcher checks existing captures in the run directory's parent (and the configured capture root) for an open predecessor in the same workspace, role and task. Changing the brief or group does not bypass this check. For an intentional correction, pass `--retry-of-run-dir DIR --retry-correction`; add `--check-descendants` to reconcile uncertain termination from owned process evidence. Only a confirmed stop permits the correction. The new invocation preserves `previousAttemptId` and the chain's task digest and records both old/new brief and group digests in `retryCorrection`.

Automatic correction supports one narrow mechanical action: refresh the executable binding after
launcher-observed `ENOENT`, with no process started and a confirmed predecessor stop. The owner reloads
trusted installation inputs and re-resolves the same task. It retries only when the qualified absolute
executable changes while the effective selection, policy, controls, limits, health windows, stdin,
environment, workspace and brief stay identical. Fresh installation proof digests may change. The retry
uses fresh plan, run and output paths and preserves the failed attempt's evidence.

The existing atomic ledger permits one correction per task chain, consuming one remaining attempt under
the original deadline and cancellation guard. The owner verifies the predecessor's launcher-written exit
evidence again before retrying. Unchanged executables, qualification or control drift, failed correction,
cancellation, deadline expiry, unconfirmed stop and exhausted allowances stop automation. Output paths
must occur as exact argv tokens; changed artifact contents require operator resolution. The owner does
not install executables, refresh logins, change permissions, create working directories, switch models,
or act on worker-authored remediation text. Fixed `startupCorrection` action, state and stop codes appear
in the existing process record, result and worker status.

## How to turn it off

> "Turn worker dispatch off but keep my group setup for later."

Your assistant flips the one setting off; per-CLI enablement and group configuration keep their values.

### Command reference: turning it off

```bash
aiwg config set --project parallelism.worker_dispatch false
```

Turning it off only changes this one setting — any per-CLI enablement (`parallelism.clis`) and group
configuration keep their existing values, so turning dispatch back on later restores the same setup.

## Worker launch boundary on Linux

Codex and Muse sandbox checks probe system `bwrap` inside a transient user unit.
See [Worker dispatch runtime](worker-dispatch-runtime.md#worker-launch-boundary-on-linux)
for probe details, diagnostics, and launch boundaries.
