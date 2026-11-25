# Grok Build native agents and automation (#2577)

The profile supports exactly **1.0.77 and 1.0.92**. Live evidence of
**2026-11-21..24 is 1.0.92** (`grok 1.0.92 (b06756fd6256) [stable]`):
titan auto-updated at 2026-11-21 09:05. Historical November 9–10 evidence
remains 1.0.77; captured bytes are unchanged.
[The latest capture README](../../test/fixtures/providers/grok-build/captured-20261124/README.md)
records the commands and sanitization. [Capability replay tests](../../test/unit/providers/grok-build-capabilities.test.ts)
bind the native tool inventory and observed results to each matrix surface.
The provider stays experimental; the conductor passed managed ACP dispatch on 1.0.92.

| Matrix claim | Evidence and disposition (1.0.77 historical; 1.0.92 November 21–24) |
|---|---|
| Headless transport | [Captured shape fixtures](https://github.com/jmagly/aiwg/blob/main/test/fixtures/providers/grok-build/headless-1.0.77/README.md), replayed by [headless tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-headless.test.ts): successful streaming-json; cancelled JSON and message stream; synthetic plain, success, truncation, error, timeout, abort and background-process vectors. No new model runs. |
| `agent_teams: false` | `spawn_subagent` completes two overlapping calls (`sub-on-run.jsonl`), but the captured tool list has no shared team membership, messaging or teardown contract. Fan-out alone does not prove teams. |
| `tasks: true` | The matrix means focused subtask/subagent dispatch: `spawn_subagent` defines it and `sub-on-run.jsonl` completes two overlapping calls. `todo_write` also defines editable task IDs/status; that task list alone would not prove delegation. Execution of `todo_write` remains unverified. |
| `cron: true` / loops | `scheduler_create/list/delete` define repeating prompts, minimum 60s interval, seven-day expiry and optional durability. Runs occur only with the session open; an overdue durable task runs once after reopening. Task creation succeeds in `sched-run.jsonl`; scheduled execution itself remains unverified. AIWG removes the scheduler in dispatched sessions so native background subagents cannot bypass its cap; interactive scheduling remains native and uncapped. |
| `mission_control: false` | `workflow` runs subagents as a background script with pause/stop/resume, and `monitor` watches script stdout. The inventory and captures do not establish a mission inventory/status/watch lifecycle or a completed workflow run; that broader routing stays deferred. |
| `daemon: false`, unsupported tier | Deferred: resident lifecycle is unverified. [ACP tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-acp.test.ts) replay initialize/authMethods, logged-in session creation amid `_x.ai/*` notifications, prompt completion with `_meta` usage, cancellation and compact/summary notifications. The [2026-11-21 live capture](../../test/fixtures/providers/grok-build/captured-20261121/README.md) satisfies criterion 5's ACP protocol check; the conductor separately passed managed dispatch on 1.0.92; resident lifecycle remains unverified live. |
| `mcp: true` | `mcp-user-doctor.json` records start, handshake and 19 tools; `mcp-session.jsonl` completes `search_tool` then `use_tool` (`aiwg__discover`, final `top=Bug Report`). Config rendering/ownership remains covered by native integration tests. |
| `behaviors: false` | Tool inventory offers no persistent behavior registration/trigger/execution contract. `monitor` watches process output; it does not establish behavior rules. |
| Agent paths and role compilation | [Writer tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-provider.test.ts) replay [set-b excerpts](https://github.com/jmagly/aiwg/blob/main/test/fixtures/providers/grok-build/captured-20261110/native-agents.json): `grok inspect` lists `.grok/agents/*.md` as `source.type: project`; valid and invalid frontmatter model pins leave the session on its default model. AIWG emits only `name`, `description` and a body prompt. [Use integration](https://github.com/jmagly/aiwg/blob/main/test/integration/grok-build-use.test.ts) tests full deployment and `$GROK_HOME/agents/` mirroring offline; native user-agent discovery remains unverified. |
| Context, rules and skills paths | Writer and [inspect tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-inspect.test.ts) cover AIWG files. Supplied trusted/untrusted inspect captures establish AGENTS.md and rules loading; nested precedence and cross-agent mirrors remain unverified here. |
| Parallelism | [Headless tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-headless.test.ts) replay default permission cancellations and the `workflow` bypass with two child ownership records. [Dispatch tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-dispatch.test.ts) test cap-one headless/ACP argv and shared admission slots. [Direct profile tests](https://github.com/jmagly/aiwg/blob/main/test/conformance/orchestration-v1/grok-build-direct.test.ts) assert both guards in profile and rendered argv. The 2026-11-24 scheduler-inclusive tool diff removes `spawn_subagent`, `workflow` and all three scheduler tools; `sched-banned.jsonl` advertises none of them. |
| Native worktrees | [Dispatch tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-dispatch.test.ts) parse captured `grok worktree list --json` ownership/recovery metadata and compare unchanged Git worktree listings. Native `-w` creates standalone copies, distinct from AIWG's tested detached Git worktrees. Native dispatch/recovery automation is deferred. |
| Headless permissions | [Headless tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-headless.test.ts) assert captured cancellations of `spawn_subagent` and `workflow`: “a headless run cannot ask for approval”. `--allow spawn_subagent` did not cover them; `--permission-mode auto` ran them. AIWG retains its permission defaults. |
| Other row fields | Experimental status, mixed deployment, full-inject hook fallback, no hook file, no @ links and no aggregated output are AIWG configuration choices covered by writer tests; native equivalents are unverified. The compiled `code-reviewer` run reports exactly CLI `-m grok-4.7-build-fast` in `modelUsage`; effort enforcement remains unverified. |

`aiwg use all --provider grok-build` deploys ordinary AIWG agents and all five
model wrappers to `.grok/agents/`. Framework, addon and direct-bundle sources
use the existing collectors and respect agent filters. `--scope user` also
mirrors them to `$GROK_HOME/agents/`; that mirror is tested offline.
Bulk mode limits skills to the kernel without suppressing native agents; an
explicit `--skills-only` still skips agents.

Role/tier intent and the complete prompt are preserved in the body.
Grok Build 1.0.77 ignores frontmatter `model:` even for an invalid value.
AIWG therefore emits no agent model pins, tools or effort controls. Exact
source pins, `model-override`, and configured role-model pins fail with guidance
to use CLI `-m` in worker invocations. Portable aliases such as `sonnet` retain
role intent only. [Worker matrix tests](https://github.com/jmagly/aiwg/blob/main/test/integration/model-worker-provider-matrix.test.ts)
cover Grok's inherited degradation; [direct profile tests](https://github.com/jmagly/aiwg/blob/main/test/conformance/orchestration-v1/grok-build-direct.test.ts)
keep explicit model selection on worker argv.
Prompt instructions, including explorer/verifier read-only boundaries, do not
enforce native tool permissions. Native tool allowlists remain unverified.

The AIWG headless transport invokes `grok --no-auto-update -p <prompt>
--output-format streaming-json` by default. It also parses `plain`, `json`, and
`streaming-messages-json`. Only `end_turn` is successful. Cancelled, refused or
limited runs fail with a `GrokHeadlessError` retaining a redacted `result`,
including partial raw stdout, parsed events, stop reason, usage and cost fields.
Terminal totals supersede per-turn accounting without double counting.
It bounds runtime and output size, propagates exit and provider errors, redacts
credential material, and terminates an attached process group after a terminal
stream event, including one without a trailing newline, so background work cannot
hang the caller. Complete single JSON results also start a bounded drain; plain
output requires process exit or the hard timeout. Cleanup escalates TERM to KILL.
The separate ACP client uses `grok --no-auto-update agent stdio`. The
[2026-11-10 fixtures](https://github.com/jmagly/aiwg/blob/main/test/fixtures/providers/grok-build/captured-20261110/README.md)
advertise `cached_token` and `grok.com`; an already logged-in session proceeds
straight to `session/new` when `_meta.defaultAuthMethodId` is `cached_token`.
Explicit `xai.api_key` selection remains synthetic: it requires `XAI_API_KEY`
and an offered method, then sends `authenticate`. Other cached-token states also
send `authenticate`. Interactive `grok.com` remains unsupported. The client
tolerates setup/model/settings notifications, exposes compact/summary updates,
and retains redacted completion `_meta` usage and `cancellationCategory`.
`session/cancel` returns `stopReason: cancelled` and `MidTurnAbort`; AbortSignal
cancellation still rejects with AbortError. Synthetic tests cover timeouts and
stderr limits/redaction, finite bounds, split UTF-8 updates, foreign-session filtering, malformed frames and callback failures.
Criterion 5 now also cites the [2026-11-21 live capture](../../test/fixtures/providers/grok-build/captured-20261121/README.md):
all 72 frames replay initialize/auth selection, the exact session id, command,
thought and message chunks, `end_turn` usage (`modelId: grok-4.7`, modelUsage
key `grok-4.7-build`) and `cancelled` with `MidTurnAbort` after session/cancel.
The conductor corrected the CLI version to 1.0.92 on titan with grok.com
login and exit 0; initialize advertises agentVersion 1.0.92. Three
command inventories are reduced to generic commands; other protocol fields
are retained. The conductor also passed live managed ACP dispatch on 1.0.92 on 2026-11-24
using `tools/providers/grok-build-acp-live.mjs` with `AIWG_GROK_BUILD_AUTH=login`.
Neither transport auto-approves tool use.

A sanitized ACP initialize observation from the Linux 1.0.40 released binary
is in `test/fixtures/providers/grok-build-acp-init-1.0.40.json`; the pinned
Linux 1.0.38 observation is in
`test/fixtures/providers/grok-build-acp-init-1.0.38.json`. Each tested binary
advertised only `grok.com` authentication in its isolated account state. AIWG
fails closed because that interactive ACP flow has not been qualified;
the live cached-token success above applies to a different logged-in state.

`GrokBuildDispatcher.forProject(root)` resolves the project's
`parallelism.max_parallel_subagents` (default 4; Ralph loops 2; missions 4) and admits no more than that many
AIWG-controlled headless workers and managed ACP sessions across independent
AIWG processes using atomic, private slots in Git's common directory (or a per-user runtime
directory for non-Git projects). Dispatchers for worktrees of the same Git
repository share those slots. `openAcp()` holds its slot until the ACP process
actually exits; a failed initialization releases it. Every managed launch
requires caller-provided authorization and remaining-budget checks. Stale slots fail closed and need
operator review before explicit removal. Changing the cap while workers run
requires those workers to finish before new dispatch. Both managed transports
pass `--no-subagents` together with
`--disallowed-tools workflow,scheduler_create,scheduler_list,scheduler_delete`;
headless also sets `GROK_SUBAGENTS=0`. The direct-worker profile carries the
same guards. `--disallowed-tools` accepts a comma-separated tool list.
The captures show two bypasses of `--no-subagents`: `workflow` starts children,
and `scheduler_create` succeeds under the old workflow-only ban. Its contract
says each scheduled run starts a background subagent. The one-shot capture ends
in about five seconds without firing a run; a long-lived ACP session could
otherwise create background subagents outside dispatcher admission.
The new captured tool inventory has 20 tools and removes exactly `spawn_subagent`,
`workflow`, `scheduler_create`, `scheduler_list` and `scheduler_delete`.
`sched-banned.jsonl` confirms their absence from the session inventory.
AIWG therefore removes the native scheduler in dispatched sessions so the
project cap holds. `cron: true` describes the native capability, not scheduler
availability inside a dispatched worker.

Both low-level `runGrokHeadless` and `GrokAcpClient` always pass these guards;
the legacy `disableSubagents` option is accepted but cannot turn them off.
Direct low-level sessions are not counted in dispatcher slots. Interactive
Grok sessions remain uncapped, including native scheduled fan-out, and must be
counted by their operator. This is a documented limitation. The reviewed defaults
are conservative AIWG ceilings, not measured provider limits.
Default headless permissions cancelled the original subagent/workflow calls;
AIWG does not switch to `--permission-mode auto`.

Native `grok -w <name>` creates a standalone copy under
`~/.grok/worktrees/<slug>/<name>`, not a Git worktree: the captured
`git worktree list` was unchanged. `grok worktree list --json` supplies `id`,
`path`, `source_repo`, `kind`, `creation_mode: standalone`, `git_ref`,
`head_commit`, `session_id`, `creator_pid`, timestamps and `status` for ownership
and recovery. Its `session_id` is a `pager-*` ownership handle, not the Grok
conversation UUID. The parser only validates metadata; it never touches the
user's tree or executes recovery. The 2026-11-24 registry and removal captures show that a dirty copy is kept
with “unsaved work: dirty”; explicit `worktree rm -f` removes it and empties the
registry. Native copy dispatch/removal automation is deferred.

AIWG's existing isolated dispatch creates a detached Git worktree from a clean source HEAD,
leaves the user's checkout alone, and writes `aiwg-grok-owner.json` in Git's
per-worktree metadata directory. The record includes owner, source, path, base
commit, creation time, and a recovery command. The caller is responsible for
reviewing and applying worktree changes; AIWG does not merge or delete them
automatically. A dirty source is rejected so uncommitted state is never silently
omitted from the worker's view.

Headless live smoke is a manual operator command:
`node tools/providers/grok-build-native-smoke.mjs`, with
`AIWG_GROK_BUILD_LIVE_SMOKE=1`, a provisioned Grok binary (optionally selected
by `AIWG_GROK_BUILD_BIN`), its exact `AIWG_GROK_BUILD_EXPECTED_SHA256`, and
`XAI_API_KEY`. Since #4371, CI has no credential gate or provisioning step;
CI contract tests assert the absence of paid live commands. Missing opt-in,
binary or credentials skips cleanly before binary execution. Hash mismatch,
malformed responses and unsuccessful termination fail. Headless smoke uses the
bounded parser with the subagent and scheduler-inclusive tool bans and prints status/counts only.

For manual managed ACP dispatch, run
`node tools/providers/grok-build-acp-live.mjs` with the same environment.
Set `AIWG_GROK_BUILD_AUTH=login` to declare an existing cached login instead
of supplying `XAI_API_KEY`; the runner never reads auth/token files.
It refuses CI even with opt-in, opens one authorized, budget-checked managed
ACP session in a temporary Git project with cap one, sends
“Reply with exactly: acp-dispatch-ok”, then prints stop reason, redacted final
text, actual slot acquisition/release and project cleanup. It closes the session
before deleting the project. Offline tests exercise skips and fake JSON-RPC
success/failure; the conductor runs the real binary. The conductor reports a passing 1.0.92 live managed ACP dispatch on
2026-11-24; this worker performed offline checks only. Cross-platform stable promotion remains separately governed.

In the latest MCP capture, headless execution could not start the project-scoped
server in an untrusted folder. 1.0.92 suggests `--trust`, but that flag does not
exist in this release; do not use the hint as a command. The live user-scoped
server connect/tool-call result applies only to that tested scope and account
state. These captures do not establish a headless project-trust workaround.

Source contracts: [Subagents](https://docs.x.ai/build/features/subagents),
[Worktrees](https://docs.x.ai/build/features/worktrees), and
[Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting).
