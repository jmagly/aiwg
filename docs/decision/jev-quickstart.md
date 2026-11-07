# Jev Quickstart

### Context and compaction

When the decision-engine addon is explicitly installed and decision ask is
enabled, regenerating provider context adds a short `Compact Instructions`
pointer to the decision-offload rule. The generated pointer is an instruction,
not evidence that a provider loaded it or invoked Jev. Regenerate context after
changing the installation or enablement. The existing Claude SessionStart hook
also emits the pointer for a compact event when its runtime is available and
the same gate is enabled. Providers without that hook, including Codex, receive
the generated instruction only; native loading and behavior require separate
provider evidence. Fallback remains an ordinary local decision and never grants
authorization.

Jev offloads bounded decisions — a yes/no gate, a pick from N known options,
or a 1–N severity or priority score — so the LLM does not spend reasoning on
questions with a fixed answer shape. `aiwg decision ask` sends one question
plus optional context and returns a typed answer with confidence, or a
fallback that means "decide it yourself with the LLM".

Savings vary by workload: offloading helps when you ask many small bounded
questions and decide normally on fallback.

## 1. Install

```bash
npm i -g aiwg@latest
aiwg use decision-engine
```

The `decision-engine` addon is opt-in and excluded from bulk installs
(`aiwg use all`, framework deploys).
New to AIWG? Start with [Install, connect and verify](../getting-started/install-connect-verify.md),
then come back here to add the addon.

## 2. Store the token

`aiwg decision setup jev` counts as the explicit opt-in that enables `ask`.

Setup uses hidden terminal entry or explicit `--token-interactive`, `--token-stdin`,
`--token-file <path>`, `--token-store <name>`, or `--token-env <NAME>`.
Headless setup without a source errors with these options; existing shell tokens
need `--token-env JEV_API_KEY` or `--token-env AIWG_DECISION_JEV_API_KEY`.
See [Supplying sensitive values](../cli/sensitive-values.md) for exposure guidance,
manager pipes, named-store setup and shared private-file requirements.
It stores the credential and records `"enabled": true` in the credential file.
Pipe the token through stdin so it never appears in shell history:

```bash
op read 'op://Engineering/Jev/api-key' | aiwg decision setup jev --token-stdin --verify
```

Token lookup order when running `ask`:

1. env `JEV_API_KEY`,
2. env `AIWG_DECISION_JEV_API_KEY`,
3. an OpenBao reference in project or user `decision.jev.credential` (project wins),
4. the user credential file
   `${XDG_CONFIG_HOME:-~/.config}/aiwg/credentials/jev.json`
   (`{"token":"...","region":"us","endpoint"?:...}`, mode 0600, parent dir
   0700). Runtime uses the shared private-file checks: files owned by another
   user, group/other access, symlinks, nonregular files, and multiple hard links
   are refused. Existing JSON records, including optional `enabled`, remain valid.

For a reference-only setup, add this to project `.aiwg/aiwg.config`, or the
equivalent nested mapping in user `config.yaml`:

```json
{
  "decision": {
    "enabled": true,
    "jev": {
      "credential": {
        "source": "openbao",
        "addr": "https://bao.example.internal:8200",
        "path": "kv_internal/data/typesafe/jev/api-key",
        "field": "token",
        "auth": { "method": "approle", "role": "aiwg-jev-reader" }
      }
    }
  }
}
```

Persist `addr` as the OpenBao HTTPS origin so workers need no OpenBao environment
variables. A host `BAO_ADDR` overrides it. `BAO_CACERT` may name an additional
trusted CA file; TLS verification cannot be disabled. Provision the
AppRole IDs using the host native secret service (the same store API as effect
keys), service `aiwg.openbao`, accounts
`https://bao.example.internal:8200/aiwg-jev-reader:role-id` and
`https://bao.example.internal:8200/aiwg-jev-reader:secret-id`. Account prefixes
use the normalized origin (omit the default HTTPS port 443). Scoping IDs to
the origin prevents a project reference from sending another host's AppRole
IDs to a different server. Values never belong in the project configuration.
The reader role needs exact-path KV v2 read access to the configured secret.

Runtime logs in, reads that field, revokes its temporary OpenBao token, and
caches the Jev key only in process memory. It never exports the key into child
environments. CLI ask, MCP ask, and shared flow/mission offload checkpoints use
this lookup. `aiwg doctor --decision-offload` reports `source: openbao` and the
path without resolving the reference or probing either service. An unavailable
reference returns `fallback: llm`, `reason: credential-unavailable`; it does not
silently use a stale credential file. Set `decision.enabled` explicitly for
reference-based use. To retire an existing `jev.json`, verify the reference
first and remove the file yourself; this release provides no automatic migration.

`setup` prints `aiwg-decision-jev-setup/v1` JSON:
`{ configured, credentialSource: "file"|"env", region, verified?, model?,
next: [...] }`. The token is never printed, logged, or written to results or
project files. Region defaults to `"us"`; change it with `--region`. The
endpoint is the official `https://api.typesafe.ai/v1/systemone` unless
`--endpoint` names a custom origin that passes the adapter allowlist rules.

Enable the decision runtime persistently for this project:

```bash
aiwg config set --project decision.enabled true
aiwg decision status
```

Enablement precedence is `AIWG_DECISION_ENABLED=0|1` > project
`.aiwg/aiwg.config` (`decision.enabled`) > user `config.yaml`
(`decision.enabled`) > `false`. Use `aiwg config set decision.enabled true`
for the user setting. Status reports the effective `enabled` value and
`enabledSource` (`env`, `project`, `user`, or `default`) without reading credentials.
This setting allows `evaluate`; Jev still needs a configured token.
The credential file setup opt-in continues to enable `ask` when none of
these layers sets enablement. An explicit `false` overrides that opt-in.

## 3. Verify

The `--verify` flag in step 2 makes one tiny live yes/no call and reports status, model, and
usage. Without `--token-stdin`, `setup` uses the env token if one is present
and otherwise exits 2 with instructions.

## 4. Ask

```
aiwg decision ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5)
                  [--context "<text>" | --context-file <path> | --context-stdin]
                  [--threshold 0.8] [--timeout-ms 15000]
                  [--passes N] [--escalation-passes N] [--json]
```

```bash
# Yes/no gate
aiwg decision ask --question "Is this test failure flaky?" --yes-no \
  --context-file test-output.log --json

# Pick one of N known options
aiwg decision ask --question "Which file owns retry policy?" \
  --choices "cli=src/cli.ts argument parsing,config=src/config.ts settings loading,runtime=src/runtime.ts execution loop,policy=src/policy.ts retry and backoff rules" \
  --json

# 1-5 severity score
aiwg decision ask --question "Severity of: null deref in login handler" \
  --scale 1-5 --context "<triage notes>" --json
```

`--choices` takes 2–255 ids matching `[A-Za-z0-9_.-]{1,64}` with no
duplicates. Write each as `id=what it means` (no commas in the description):
Jev sees only the description, so bare ids produce more low-confidence
fallbacks. `--scale lo-hi` allows at most 10 levels and answers the most
likely level. Context is untrusted
data capped at 32 KiB — larger context exits 2 with
`reason: "context-too-large"`. Completed asks append telemetry to the decision
ledger; question/context text requires `--record-text`.

Without `--json`, output is one line: `answer (confidence 0.93, jev-1.13.0)`
or `FALLBACK to LLM: <reason>`.

### Passes, escalation, and telemetry

Project `.aiwg/aiwg.config` can opt into independent repeated Jev requests:

```json
{
  "decision": {
    "ask": { "passes": 10, "escalation_passes": 20, "min_agreement": 0.9 }
  }
}
```

The product default is 5 initial passes with an escalation total of 10 when
`decision.ask` is unset. `escalation_passes` defaults to twice `passes`, so a
project that sets `passes: 10` escalates to 20 unless it says otherwise. Both must be positive safe integers,
and escalation must be at least the initial count; the config loader validates
this relationship. CLI `--passes N` and `--escalation-passes N` override the
corresponding project values. MCP `decision-ask` accepts `passes` and
`escalation_passes` with the same precedence and validation. Programmatic
`askDecision` callers supply `options.cwd` to load project defaults, or pass
`passes`/`escalationPasses` directly. Setup verification remains a single pass.

Agreement acceptance is opt-in: omit `min_agreement` to keep confidence-only
acceptance. With it set, an ask can also answer after at least `passes`
successful samples when agreement reaches `min_agreement` and mean confidence
reaches `agreement_confidence_floor` (default 0.55). Both settings accept numbers
from 0 to 1 and can be written with `aiwg config set --project`, for example
`aiwg config set --project decision.ask.min_agreement 0.9`. Programmatic inputs
use `minAgreement` and `agreementConfidenceFloor`. Setting the floor alone does
not enable the agreement rule. JSON and ledger `answeredBy` identify the rule:
`confidence`, `agreement`, or null on fallback; confidence takes precedence if
both qualify. Unanimous votes with mean confidence 0.59 can therefore answer
under this example policy without lowering the normal threshold of 0.8.

Each pass is a separate request with no retries. Up to four requests run at
once, in bounded waves. One `--timeout-ms` budget covers credential lookup and
all waves, including escalation; pending requests are aborted and no further
wave starts at the deadline. Provider rate-limit errors cause fallback through
the normal error path, without a retry burst.

Aggregation reuses the ensemble modal-vote calculation (`majority-v1`): yes/no
passes vote for their most likely boolean, choices vote for the selected id,
and scales vote for the most likely integer level (a **modal bucket**, rather
than averaging adjacent levels). Ties select the lowest canonical string
value, as in ensemble aggregation. Agreement is the largest vote count divided
by passes run; errors and abstentions have no vote but remain in the denominator.
Per-pass confidence follows the single-pass rules above. Reported answered
`confidence = agreementRatio × mean(per-pass confidence)`; this is a stability
signal, not calibrated evidence of correctness. For yes/no, `probability` is
the mean raw true probability across successful passes.

A round is problematic if agreement or mean confidence is below `--threshold`
(default 0.8), confidence is missing, or any pass abstains or errors. Escalation
adds requests **up to the total**, retaining the first round's observations.
A persistently problematic ask returns `status: "fallback"` with
`reason: "low-agreement"`, `low-confidence`, or the existing error/abstention
reason. Under confidence-only acceptance, an error or abstention cannot be
repaired by later successful passes. Agreement acceptance can recover if enough
successful samples remain; every successful sample must have confidence.
The two threshold checks use agreement and mean confidence separately, so an
answered result's agreement-weighted confidence can be below the threshold.

Calls stop early when neither acceptance rule can succeed even if every remaining
pass votes for the leading answer with confidence 1, considering both the initial
round and escalation total. This can stop a problematic initial round before its
full count. `escalated` is true only when at least one pass beyond the initial
budget actually starts. Successful asks run the entire initial or escalated
round. `earlyStop` records `certain-failure`, `timeout`, or null; `passesRun`
counts started passes, including interrupted ones.

`--json` includes `aggregate`: requested/total/run counts, escalation and early
stop, votes, modal answer, agreement, confidence summary, and each pass's status,
answer, confidence, probability (yes/no), model, token usage, and latency. Top-level
usage sums known token counts across all passes; latency covers the whole ask.
The ledger stores the agreement policy, answer rule, compact pass/confidence summaries, counts, agreement, escalation,
early stop, total usage, and total latency. Individual pass answers stay in JSON
output, keeping the ledger's existing record-size and redaction limits.

```bash
aiwg decision ask --question "Proceed?" --yes-no --passes 10 --escalation-passes 20 --json
aiwg decision stats --group-by passes --json
aiwg decision stats --group-by escalation --json
```

Stats report `hitRate = answered / totalCalls`, mean agreement, escalation count,
passes run, and token usage. `tokensPerAnsweredDecision` divides all recorded
input and output tokens, including fallback costs, by answered calls; it is null
when no calls answered (shown as `-` in text). `passes` groups by initial/escalation policy (e.g.
`10/20`), while `escalation` groups by whether the extended budget was considered.
Legacy ledger entries count as policy `1/1`, with no agreement observation. Use
these measurements to compare hit rates, latency in history, and token costs
before reducing sampling counts.

## 5. How agents use it

The `decision-offload` rule (with the `decision-offload` skill) says: before
spending reasoning on a bounded decision, call `aiwg decision ask ... --json`.
Use the answer when `status` is `answered`; on `fallback`, decide normally.
A bounded choice between the current session and a worker remains eligible
when it is part of a larger investigation; the multi-step plan itself is not.
Never use it for open-ended generation, code writing, multi-step plans, or
anything that authorizes destructive or outward actions. Jev output is
advisory data; it is never authorization.

## 6. Fallback semantics

`fallback: "llm"` (still exit 0) happens when Jev is not configured or not
enabled (`reason: "not-configured"`), the token is missing, Jev abstained or
errored or was unavailable, the call timed out, or confidence fell below
`--threshold` (default 0.8; yes-no confidence = max(p, 1-p)). Exit 2 is only
for usage errors.

## 7. Privacy

The question and context are sent to Jev. Never send secrets: no tokens,
passwords, private keys, or credentials in `--question` or `--context`.

## 8. Disabling

```bash
aiwg decision setup jev --remove   # deletes the credential file
```

`AIWG_DECISION_ENABLED=1` also enables `ask`; `AIWG_DECISION_ENABLED=0`
force-disables it.

## 9. Ledger, history and stats

Every **completed** `ask` call (CLI and MCP) appends exactly one record to a
decision ledger — `.aiwg/decision/ledger.jsonl` under the project AIWG
artifact root, resolved the same way as `aiwg artifacts path`. This covers
`fallback` and `not-configured` outcomes, not just `answered` ones. CLI/MCP
**usage errors** — a bad flag, an oversized context, an invalid
`--session`/`--caller` — never reach a completed call and are **never
recorded**; those are rejected with exit 2 (CLI) before any Jev call.

**Trust boundary.** The ledger defends against accidental hazards — a stray
symlink, a pre-planted hard link, loose permissions, a previous crash's
partial write — under the assumption that the artifact root is owned and
written by the *same local user* running `aiwg`, or by its workspace group in
a setgid directory that grants others no access. It is not a defense against
a hostile process already running as that user. An existing file or directory
that fails a safety check is **never modified** (no chmod, no truncation) —
recording is skipped and reported once. Appenders, rotation and readers share
a cross-process lock. CLI `ask --json` includes `ledgerRecorded: true` after a
successful append and `null` when recording could not be confirmed (including
timeout). MCP output is unchanged. `doctor --decision-offload` and `status --probe`
report journal permissions. `aiwg doctor --decision-offload --fix` explicitly
repairs unsafe journal modes and collapsed group masks on known non-secret config,
baseline, receipt, transcript and journal outputs; credential/key stores stay private.
Use `decision rotate` to archive older records;
`history`/`stats` tolerate a missing file (empty result).

A ledger write failure, a slow/unavailable attribution lookup, or anything
else inside the recording step never changes the `ask` result or exit code:
recording is bounded by a short deadline (250 ms by default) and prints at
most one warning to stderr. On timeout, that warning says exactly
**"completion unknown"** — the in-flight attempt is not and cannot be
cancelled (Node has no way to abort an in-flight filesystem call), so the
record may or may not eventually land. A slow attribution lookup cannot start
a new append after the deadline; an append already waiting for the lock can
still complete afterward.

Records carry the resolved provider (`--provider` to override; otherwise
the same runtime detection `aiwg steward` uses, degrading to `unknown` if
detection itself fails), a session id and `sessionSource`. Resolution order is
`--session`, `AIWG_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`,
`CODEX_SESSION_ID`, `HERMES_SESSION_ID`, `OPENCODE_SESSION_ID`, `MUSE_SESSION_ID`,
`GROK_SESSION_ID`, `WARP_SESSION_ID`, then the literal `unknown`. Empty or
malformed environment values are skipped. `sessionSource` records the winning
flag/environment name (or `unknown`). Records also carry the decision kind and choice ids (at most 10
recorded, regardless of how many the `ask` call itself allowed —
`choiceCount` and `choiceIdsTruncated` say how many there really were),
`answerIndex` (the selected option's position in the original list — this
survives redaction even when two different secret-shaped choice ids redact
to the same display marker), SHA-256 digests of the question and context,
the outcome, model, Jev usage, latency, and v2 savings telemetry described below.
Both CLI and MCP calls use the same attribution and estimation code.

An optional `--caller <tag>` names the decision point for later attribution,
for example `--caller "address-issues:worker-pick"`. `--session` and
`--caller` must match `^[A-Za-z0-9_.:/@-]{1,96}$`; the CLI rejects a value
outside that shape with exit 2, and the MCP tool silently drops one instead
(there is no CLI exit code to report through MCP).

**Every persisted field is redacted**, not only the two opt-in text fields:
provider, session id, project root, caller, choice ids, model and a string
answer all pass through the same governance redaction
`aiwg activity-log append` uses before being written, and each is capped to
a bounded length. Question and context text are **never** written to the
ledger at all unless `--record-text` is passed, and even then the redacted
text is truncated to a documented cap (marked `textTruncated: true` when it
is). A whole record is capped below the conservative single-write atomicity
boundary most platforms honor for `PIPE_BUF` (4096 bytes). Appenders hold
the same cross-process lock as retention from opening the ledger through
closing it, including short-write retries and trailing-newline repair.
`history`/`stats` count malformed lines as skipped; rotation preserves them.

`questionDigest`/`contextDigest` are plain, deterministic SHA-256 over the
raw text. That is **not** a confidentiality guarantee: a short or guessable
question (or context) can still be identified by hashing candidate strings
and comparing digests. Treat the digest as a correlation key, not a secret.

```bash
aiwg decision ask --question "Is this test failure flaky?" --yes-no --json \
  --caller "address-issues:worker-pick"

aiwg decision history --since 2026-10-01 --provider claude --status fallback --json
aiwg decision stats --provider claude --group-by caller --json
aiwg decision history --caller 'address-issues:*' --json
aiwg decision stats --caller address-issues:worker-pick --group-by caller --json
aiwg decision history --no-caller --json
```

`history` and `stats` read the ledger offline — no network, no Jev call.
`history` supports `--since`, `--provider`, `--session`, `--kind`,
`--status`, `--caller`, `--no-caller`, `--include-archives` and `--json`; `--since` is strict ISO-8601 — a bare date or an
offsetless timestamp is interpreted as UTC, and an invalid calendar date
(e.g. `2026-02-30`) is rejected with exit 2, including when an explicit
offset is present (the local calendar/time components are validated before
the offset is applied). `stats` supports the *same* filters as `history`,
plus `--group-by provider|session|kind|caller`: a record with no `--caller`
tag groups under a distinct `null` key, never conflated with a caller
literally named `unattributed`. `--caller <tag>` matches that tag exactly;
`--caller '<prefix>*'` matches every tag starting with `<prefix>` (a trailing
`*` is the only wildcard — `--caller ''`, an interior `*`, or a tag outside
the attribution shape is a usage error, exit 2). `--no-caller` selects only
records with no tag (`none` stays a valid tag, so it gets its own flag), and
`--caller` with `--no-caller` is a usage error. Unknown flags and positional
arguments on either command are usage errors (exit 2) naming the offender.
`--json` output carries the applied filters under a `filters` key, and
human-readable output prints one `Caller filter:` header line when a caller
filter is set. It reports answered/fallback counts, a
fallback rate (and a per-reason rate) as a fraction of the group's total
calls, the confidence distribution, and three separate savings quantities in
both text and JSON. Both
commands report how many stored lines failed validation as `skipped`.

### Retaining recent calls

`aiwg decision rotate` follows the activity-log retention convention:
`--keep-last <Nd|N>` selects a duration in days or a count of the most recent
valid records. It is a subcommand of the existing `decision` owner because
it manages the same completed-call ledger as `history` and `stats`.

```bash
aiwg decision rotate                       # keep the last 90 days
aiwg decision rotate --keep-last 1000       # keep the newest 1000 valid calls
aiwg decision rotate --keep-last 30d --json
aiwg decision rotate --all                  # explicitly archive everything
aiwg decision rotate --all --to archive/decision/manual.jsonl
aiwg decision history --include-archives --json
aiwg decision stats --include-archives --group-by caller --json
```

The default keeps records from the last **90 days**, including the cutoff.
Zero/negative windows are refused; rotating without a keep window requires
`--all`, which cannot be combined with `--keep-last`. Count retention orders
by timestamp, preserving original line order within each output file.
Malformed lines (including invalid UTF-8 and partial final lines) retain their
original bytes in the live file; `--all` moves them to the archive. Nothing is
pruned or deleted by retention.

Archives default to `archive/decision/<UTC-timestamp>-<unique-id>.jsonl`
beneath the artifact root resolved by `aiwg artifacts path`. `--to` accepts
an artifact-relative or absolute `.jsonl` filename **within that same archive
subtree**. Paths outside the resolved root or archive subtree, symlinked directories,
and existing destination files are refused. New archive directories use
`0700`, files use `0600` in private workspaces. In a setgid workspace closed to
others, new non-secret directories/files request `0770`/`0660`, letting the default
ACL and umask restrict them; replacement files retain the original mode via chmod.
Group access is accepted only when the gid matches the workspace. Detection uses
filesystem stat calls only. The shared `archive/` parent may be readable; group
writes require this same shared-workspace policy. Ledger file safety checks also apply when reading
archives. External artifact roots remain external; there is no local fallback.

Appenders, rotation, and readers share `decision/ledger.lock` using the
existing cross-process directory lock. Rotation writes and syncs the archive
before atomically replacing the live file under that lock, so concurrent
completed appends remain in one of the files. Reads hold the lock across both
live and archive scans to avoid observing half a rotation. Lock acquisition
waits at most 30 seconds and reclaims only owners proven dead on this host.
The existing short recording deadline still reports completion as unknown
if an append continues in the background while waiting for the lock. All
writers must use the updated ledger API; manually editing files bypasses it.
An interruption between archive creation and live replacement can leave
copies in both files; preserve both and reconcile before relying on totals.

`history` and `stats` scan only the live ledger by default. With
`--include-archives`, they also scan `.jsonl` files recursively under
`archive/decision/`, apply their existing filters, and report invalid lines
as `skipped`. These commands remain offline and tolerate a missing ledger.


### Reading savings and setting weights

New ledger records use `aiwg-decision-ledger-record/v2`:

- `llm_tokens_avoided`: estimated caller input + reasoning + output tokens for
  an answered call; zero for a fallback. Input uses the D06 canonical JSON
  UTF-8 estimator on question and context, not Jev's prompt overhead.
- `jev_tokens`: recorded Jev input + output tokens across **all** passes,
  including escalation and fallbacks. Missing usage components count as zero;
  check the original `usage` for unknown measurements.
- `cost_weighted_net_usd`: `(llm_tokens_avoided * llm_per_mtok - jev_tokens *
  jev_per_mtok) / 1,000,000` with blended rates. With split rates, subtract
  `(usage.inputTokens * jev_input_per_mtok + usage.outputTokens *
  jev_output_per_mtok) / 1,000,000` instead. Positive means estimated dollars saved; negative
  means estimated added cost. A fallback charges Jev once and credits no
  frontier avoidance. These are estimates, not billing measurements.

`estimationMethod` is an object with `version: aiwg-decision-savings/v2`,
`input_tokens`, `caller_model_class`, `reasoning_tokens`, `output_tokens`,
`llm_per_mtok`, and `jev_per_mtok`. Weights are captured when recording, so
later config changes do not rewrite a v2 record's economics.

Project config sets the caller class explicitly; it is not inferred from the
Jev model or harness. Default class `reasoning` assumes 1,024 reasoning tokens;
`standard` assumes 256. Both assume 128 output tokens, separate from reasoning.
These are adjustable planning allowances, not empirically calibrated savings
claims. Calibrate them against representative caller usage for your workload.
Defaults are **$15 per million frontier tokens** and **$0.20 per million Jev
tokens**. These are planning weights, not current vendor price quotes; use
blended input/output rates appropriate to your models and cache usage.

```bash
aiwg config set --project decision.ask.cost.llm_per_mtok 15
aiwg config set --project decision.ask.cost.jev_per_mtok 0.2
aiwg config set --project decision.ask.savings.caller_model_class reasoning
aiwg config set --project decision.ask.savings.reasoning_tokens 1024
aiwg config set --project decision.ask.savings.output_tokens 128
aiwg decision stats --group-by session
aiwg decision stats --group-by caller --json
```

Prices must be finite numbers from 0 to 1,000,000; allowances must be integers
in the same range. Zero is supported. The schema, loader, and `config set`
validate these settings. Omitted keys use the defaults above.

Refresh sourced Jev input/output rates into **the same config** explicitly:

```bash
aiwg decision pricing
aiwg decision pricing --refresh --model jev-1.13.0 --dry-run
aiwg decision pricing --refresh --model jev-1.13.0
# Explicit offline fallback, dated 2026-10-18:
aiwg decision pricing --refresh --model jev-1.13.0 --offline
# Permit that snapshot only if the live refresh fails:
aiwg decision pricing --refresh --model jev-1.13.0 --allow-snapshot
```

Refresh reads public TypeSafe documentation without credentials. It writes
`decision.ask.cost.jev_input_per_mtok`, `jev_output_per_mtok`, `source`,
`checked_at` (YYYY-MM-DD), and `jev_model` through the existing project config
writer. It preserves blended weights and other settings. Later refreshes may
omit `--model` to reuse the selected version. There is no separate price cache.
Normal `ask` never refreshes prices; only the explicit pricing refresh fetches
pricing documentation. Plain `pricing`, `stats`, and `history` read offline.

A complete split pair takes precedence when recorded input/output usage is
available. Unknown output usage is acceptable when its rate is zero. If either
split rate or required usage is missing, the existing `jev_per_mtok` blended
weight applies; missing usage components still count as zero as above. A single
split rate does not override the blended weight. Remove both split keys with
`aiwg config reset --project decision.ask.cost.jev_input_per_mtok` and the
corresponding output key to return to blended pricing. Manual split rates use
`aiwg config set --project` with these same keys; set `source` to `manual` and
supply the applicable `checked_at` and versioned `jev_model`.

New records capture these rates and provenance in `estimationMethod`, plus
`jev_rate_basis` (`split` or `blended`). `decision stats` adds `ratesUsed` in
JSON and prints rates/source/checked date alongside the existing figures.
Mixed rate histories list each method and its call count. Old records are never
rewritten. The selected `jev_model` identifies what the configured rates apply
to; choose rates matching the backend model used for your calls. These remain
planning estimates using configured rates, not historical invoices or measured
caller savings. See [pricing details](pricing-and-benchmark.md).

The original `estimatedLlmTokensAvoided` and `estimationMethodV1` remain on new
records for comparison. Stats retains `estimatedLlmTokensAvoidedTotal` and
`netSavingsTokens` as **v1 comparison only**, explicitly labeled in text.
Do not interpret that subtraction of unlike tokens as monetary savings.
Old v1 ledgers remain readable without migration. For their v2 stats estimates,
answered input tokens are recovered by removing the old per-kind allowance
(50 yes/no, 120 choices, 80 scale), then applying the current class/allowances.
Fallbacks have zero avoided tokens. `legacyReestimatedCalls` counts these rows;
`legacyEstimationWeights` reports their current weights. No ledger is rewritten.
Session ids missing in old records cannot be recovered retroactively.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `FALLBACK to LLM: not-configured` | Run `aiwg decision setup jev` (or set `AIWG_DECISION_ENABLED=1` with a token in env). |
| `setup` exits 2 without `--token-stdin` | No env token found; it prints instructions — pipe the token via `--token-stdin`. |
| `reason: "context-too-large"` (exit 2) | Trim context to 32 KiB or less. |
| Credential file refused | Fix permissions: parent dir 0700, file 0600; group/world-readable files are refused. |
| Frequent timeouts | Raise `--timeout-ms` (default 15000); timeouts fall back to the LLM. |
| Low-confidence fallbacks | Give each choice a description (`id=meaning`) and add context. Lower `--threshold` only if wrong answers are cheap. Fallback is the normal path, not an error. |

See also the [CLI/MCP driver guide](cli-mcp-driver.md), the
[transport contract](jev-transport.md), and the
[decision-engine operator guide](../../agentic/code/addons/decision-engine/docs/operations.md).
