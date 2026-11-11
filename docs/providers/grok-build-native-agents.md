# Grok Build native agents and automation (#2577)

The 2026-11-09 and 2026-11-10 Grok Build 1.0.77 captures establish project-agent
discovery, ignored model frontmatter, headless, ACP frame and standalone-copy contracts below. Tests replay sanitized captures
offline. The provider stays experimental; live ACP dispatch qualification and
combined fan-out flag enforcement remain deferred.

| Matrix claim | Evidence and disposition for 1.0.77 |
|---|---|
| Headless transport | [Captured shape fixtures](https://github.com/jmagly/aiwg/blob/main/test/fixtures/providers/grok-build/headless-1.0.77/README.md), replayed by [headless tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-headless.test.ts): successful streaming-json; cancelled JSON and message stream; synthetic plain, success, truncation, error, timeout, abort and background-process vectors. No new model runs. |
| `agent_teams: false` | Unverified: needs native team creation, communication and teardown capture. Independent tools/subagents do not establish teams. |
| `tasks: false` | Unverified: needs native background task submission, status, completion and cancellation capture. Regression test “does not advertise native background tasks from headless tool events” keeps routing conservative. |
| `cron: false` / loops | Unverified: needs recurring execution and cancellation capture; neither follows from background tasks. |
| `mission_control: false` | Unverified: needs native mission lifecycle capture. `aiwg-mc` emulation names AIWG orchestration, not a Grok native capability. |
| `daemon: false`, unsupported tier | Deferred: resident lifecycle is unverified. [ACP tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-acp.test.ts) replay initialize/authMethods, logged-in session creation amid `_x.ai/*` notifications, prompt completion with `_meta` usage, cancellation and compact/summary notifications. Frame replay does not qualify live ACP dispatch. |
| `mcp: true` | [Native integration tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-native-integration.test.ts) cover AIWG TOML rendering, ownership and fake inspect/doctor behavior. Live server connection and tool execution remain unverified by these captures. |
| `behaviors: false` | Unverified: needs native registration, trigger and execution capture. |
| Agent paths and role compilation | [Writer tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-provider.test.ts) replay [set-b excerpts](https://github.com/jmagly/aiwg/blob/main/test/fixtures/providers/grok-build/captured-20261110/native-agents.json): `grok inspect` lists `.grok/agents/*.md` as `source.type: project`; valid and invalid frontmatter model pins leave the session on its default model. AIWG emits only `name`, `description` and a body prompt. [Use integration](https://github.com/jmagly/aiwg/blob/main/test/integration/grok-build-use.test.ts) tests full deployment and `$GROK_HOME/agents/` mirroring offline; native user-agent discovery remains unverified. |
| Context, rules and skills paths | Writer and [inspect tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-inspect.test.ts) cover AIWG files. Supplied trusted/untrusted inspect captures establish AGENTS.md and rules loading; nested precedence and cross-agent mirrors remain unverified here. |
| Parallelism | [Headless tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-headless.test.ts) replay default permission cancellations and the `workflow` bypass with two child ownership records. [Dispatch tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-dispatch.test.ts) test cap-one headless/ACP argv and shared admission slots. [Direct profile tests](https://github.com/jmagly/aiwg/blob/main/test/conformance/orchestration-v1/grok-build-direct.test.ts) assert both guards in profile and rendered argv. Combined live enforcement is unverified. |
| Native worktrees | [Dispatch tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-dispatch.test.ts) parse captured `grok worktree list --json` ownership/recovery metadata and compare unchanged Git worktree listings. Native `-w` creates standalone copies, distinct from AIWG's tested detached Git worktrees. Native dispatch/recovery automation is deferred. |
| Headless permissions | [Headless tests](https://github.com/jmagly/aiwg/blob/main/test/unit/providers/grok-build-headless.test.ts) assert captured cancellations of `spawn_subagent` and `workflow`: “a headless run cannot ask for approval”. `--allow spawn_subagent` did not cover them; `--permission-mode auto` ran them. AIWG retains its permission defaults. |
| Other row fields | Experimental status, mixed deployment, full-inject hook fallback, no hook file, no @ links and no aggregated output are AIWG configuration choices covered by writer tests; native equivalents are unverified. Model/effort pinning in route feasibility remains unverified by these captures. |

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
stderr limits/redaction. Live ACP dispatch qualification remains deferred.
Neither transport auto-approves tool use.

A sanitized ACP initialize observation from the Linux 1.0.40 released binary
is in `test/fixtures/providers/grok-build-acp-init-1.0.40.json`; the pinned
Linux 1.0.38 observation is in
`test/fixtures/providers/grok-build-acp-init-1.0.38.json`. Each tested binary
advertised only `grok.com` authentication in its isolated account state. AIWG
fails closed because that interactive ACP flow has not been qualified; a
fixture-backed `cached_token` contract does not prove it works.

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
pass `--no-subagents --disallowed-tools workflow`; headless also sets
`GROK_SUBAGENTS=0`. Direct-worker profile argv carries the same pair.
The capture shows `--no-subagents` removes `spawn_subagent` but leaves `workflow`,
which started two child agents under auto permissions. The deny flag closes
that known invocation gap. A live 1.0.77 run with both flags (2026-11-10) made
no `spawn_subagent` or `workflow` call and left no subagent records.
Default headless permissions cancelled both tools, and `--allow spawn_subagent`
did not cover them. AIWG does not switch to `--permission-mode auto`.
The reviewed defaults are conservative AIWG ceilings, not measured provider limits.
The native host can still spawn subagents in an interactive session; AIWG
cannot presently prove a hard cap over that external path. This is a
qualification limitation, not a claim that Grok's native subagents lack value.
Grok sessions started outside AIWG's dispatcher, including direct low-level
`GrokAcpClient` use, remain outside this cap.

Native `grok -w <name>` creates a standalone copy under
`~/.grok/worktrees/<slug>/<name>`, not a Git worktree: the captured
`git worktree list` was unchanged. `grok worktree list --json` supplies `id`,
`path`, `source_repo`, `kind`, `creation_mode: standalone`, `git_ref`,
`head_commit`, `session_id`, `creator_pid`, timestamps and `status` for ownership
and recovery. Its `session_id` is a `pager-*` ownership handle, not the Grok
conversation UUID. The parser only validates metadata; it never touches the
user's tree or executes recovery. Native copy dispatch/removal is deferred.

AIWG's existing isolated dispatch creates a detached Git worktree from a clean source HEAD,
leaves the user's checkout alone, and writes `aiwg-grok-owner.json` in Git's
per-worktree metadata directory. The record includes owner, source, path, base
commit, creation time, and a recovery command. The caller is responsible for
reviewing and applying worktree changes; AIWG does not merge or delete them
automatically. A dirty source is rejected so uncommitted state is never silently
omitted from the worker's view.

Live smoke is opt-in: run `node tools/providers/grok-build-native-smoke.mjs` with
`AIWG_GROK_BUILD_LIVE_SMOKE=1`, a provisioned Grok binary, its exact
`AIWG_GROK_BUILD_EXPECTED_SHA256`, and `XAI_API_KEY`. The CI qualification
workflow uses the same explicit gate on scheduled or manual runs. It reads the
credential through the Vault CI bootstrap and configured
`XAI_API_KEY_VAULT_PATH`/`XAI_API_KEY_VAULT_FIELD` variables; the opt-in gate,
binary path, and expected hash are repository variables. The script skips cleanly when the gate,
binary, or credential is unavailable; it fails on a binary hash mismatch or a
malformed/incomplete provider response. It emits only status and counts. Fixture
tests do not substitute for a credentialed run on Linux, Windows, and WSL;
stable promotion remains governed by the cross-platform qualification contract.

Source contracts: [Subagents](https://docs.x.ai/build/features/subagents),
[Worktrees](https://docs.x.ai/build/features/worktrees), and
[Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting).
