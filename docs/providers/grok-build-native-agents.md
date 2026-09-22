# Grok Build native agents and automation (#2577)

AIWG deploys three qualified model-worker roles to `.grok/agents/`: reasoning,
coding, and efficiency. Grok Build discovers these Markdown agents natively.
Other AIWG roles stay available through `aiwg discover` and `aiwg show agent`
until their tool and frontmatter mappings are qualified. The writer preserves
AIWG role intent in the agent body. Without a discovered, explicitly configured
Grok model for a role, it omits `model` and the agent inherits the parent model.
An exact foreign model pin or unsupported tool mapping fails with a diagnostic
instead of silently broadening the agent's permissions.

The AIWG headless transport invokes `grok --no-auto-update -p <prompt>
--output-format streaming-json` by default. It also parses `plain` and `json`.
It bounds runtime and output size, propagates exit and provider errors, redacts
credential material, and terminates an attached process group after a terminal
stream event so background work cannot hang the caller. The separate ACP client
uses `grok --no-auto-update agent stdio`, initializes JSON-RPC, chooses
`xai.api_key` only when `XAI_API_KEY` is present and offered, otherwise chooses
`cached_token`, and handles session updates, cancellation, stderr, and timeouts.
Neither transport auto-approves tool use.

A sanitized ACP initialize observation from the Linux 1.0.40 released binary
is in `test/fixtures/providers/grok-build-acp-init-1.0.40.json`; the pinned
Linux 1.0.38 observation is in
`test/fixtures/providers/grok-build-acp-init-1.0.38.json`. Each tested binary
advertised only `grok.com` authentication in its isolated account state. AIWG
fails closed because that interactive ACP flow has not been qualified; a
fixture-backed `cached_token` contract does not prove it works.

`GrokBuildDispatcher.forProject(root)` resolves the project's
`parallelism.max_parallel_subagents` and admits no more than that many
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
cap. The native host can still spawn subagents in an interactive session; AIWG
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
