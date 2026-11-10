# Grok Build native agents and automation (#2577)

The 2026-11-09 Grok Build 1.0.77 capture review establishes the headless formats
below. Existing native-agent, dispatch and ACP code has synthetic tests; these
captures do not qualify those native contracts. The provider stays experimental.

| Matrix claim | Evidence and disposition for 1.0.77 |
|---|---|
| Headless transport | [Captured shape fixtures](../../test/fixtures/providers/grok-build/headless-1.0.77/README.md), replayed by [headless tests](../../test/unit/providers/grok-build-headless.test.ts): successful streaming-json; cancelled JSON and message stream; synthetic plain, success, truncation, error, timeout, abort and background-process vectors. No new model runs. |
| `agent_teams: false` | Unverified: needs native team creation, communication and teardown capture. Independent tools/subagents do not establish teams. |
| `tasks: false` | Unverified: needs native background task submission, status, completion and cancellation capture. Regression test “does not advertise native background tasks from headless tool events” keeps routing conservative. |
| `cron: false` / loops | Unverified: needs recurring execution and cancellation capture; neither follows from background tasks. |
| `mission_control: false` | Unverified: needs native mission lifecycle capture. `aiwg-mc` emulation names AIWG orchestration, not a Grok native capability. |
| `daemon: false`, unsupported tier | Unverified: needs resident lifecycle evidence. ACP is a separate embedded tier; no agent-stdio capture is supplied. |
| `mcp: true` | [Native integration tests](../../test/unit/providers/grok-build-native-integration.test.ts) cover AIWG TOML rendering, ownership and fake inspect/doctor behavior. Live server connection and tool execution remain unverified by these captures. |
| `behaviors: false` | Unverified: needs native registration, trigger and execution capture. |
| Agent paths and role compilation | [Writer tests](../../test/unit/providers/grok-build-provider.test.ts) cover local role/body/tool mapping and rejected foreign pins. Native `.grok/agents/` and `$GROK_HOME/agents/` loading/frontmatter need an inspect plus execution capture before qualification. |
| Context, rules and skills paths | Writer and [inspect tests](../../test/unit/providers/grok-build-inspect.test.ts) cover AIWG files. Supplied trusted/untrusted inspect captures establish AGENTS.md and rules loading; nested precedence and cross-agent mirrors remain unverified here. |
| Parallelism and worktrees | [Dispatch tests](../../test/unit/providers/grok-build-dispatch.test.ts) cover synthetic admission, authorization, budget, shared slots and Git ownership records. Native hard caps, `--no-subagents` enforcement and worktree dispatch need captures. |
| Other row fields | Experimental status, mixed deployment, full-inject hook fallback, no hook file, no @ links and no aggregated output are AIWG configuration choices covered by writer tests; native equivalents are unverified. Model/effort pinning in route feasibility remains unverified by these captures. |

AIWG's existing writer deploys three model-worker roles to `.grok/agents/`: reasoning,
coding, and efficiency. Native discovery of this mapping is unverified here.
Other AIWG roles stay available through `aiwg discover` and `aiwg show agent`
until their tool and frontmatter mappings are qualified. The writer preserves
AIWG role intent in the agent body. Without a discovered, explicitly configured
Grok model for a role, it omits `model` and the agent inherits the parent model.
An exact foreign model pin or unsupported tool mapping fails with a diagnostic
instead of silently broadening the agent's permissions.

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
The separate, previously implemented ACP client
uses `grok --no-auto-update agent stdio`, initializes JSON-RPC, chooses
`xai.api_key` only when `XAI_API_KEY` is present and offered, otherwise chooses
`cached_token`, and handles session updates, cancellation, stderr, and timeouts.
Neither transport auto-approves tool use. ACP initialization/authentication,
updates, cancellation, timeouts and stderr have pre-existing synthetic contracts;
qualification against 1.0.77 is deferred pending an `agent stdio` capture.

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
pass the released CLI's `--no-subagents` switch; headless also sets
`GROK_SUBAGENTS=0`. This prevents unaccounted internal fan-out because
Grok Build's internal autonomous subagent fan-out has no documented hard project
cap in the synthetic contract. Actual flag enforcement needs a 1.0.77 capture;
the reviewed defaults are conservative AIWG ceilings, not measured provider limits.
The native host can still spawn subagents in an interactive session; AIWG
cannot presently prove a hard cap over that external path. This is a
qualification limitation, not a claim that Grok's native subagents lack value.
Grok sessions started outside AIWG's dispatcher, including direct low-level
`GrokAcpClient` use, remain outside this cap.

An isolated dispatch creates a detached Git worktree from a clean source HEAD,
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
