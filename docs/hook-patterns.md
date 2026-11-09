# AIWG Hook Patterns

**Issues:** #284, #289
**Version:** 2026.11.4
**Status:** Active

## Prompt-time discovery (#3858)

> Review the authentication code for security issues.

On Claude Code, Muse, Codex 0.165, Hermes, and interactive Factory, each substantive prompt gives the assistant up to three
AIWG candidates: type, name, a short capability, and relevance score. For example,
its additional context can contain `skill security-review (0.92): Review code for
security issues`, followed by the steps to inspect the candidate with
`aiwg show <type> <name>`, fetch required rule bodies with
`--rules --with-rule-bodies` / `--body`, and apply the instructions. Candidates are
hints; the assistant still checks their instructions before acting.

`aiwg use` installs the shared `aiwg-prompt-discovery.cjs` hook into Claude's
`.claude/hooks/` and registers `UserPromptSubmit` in `.claude/settings.json`.
Muse uses `.muse/hooks/` and its existing hooks.json/sidecar owner. Repeating
installation updates managed entries while preserving your own hooks. Codex
uses `.codex/hooks/` and `.codex/hooks.json` through the existing hook bridge,
including the kernel-only deployment used by `aiwg use all --provider codex`.
It does not edit the user’s global Codex configuration.

Acknowledgements such as “yes”, “ok”, “go”, and “1”, short replies without an
identified imperative, slash-command-only prompts (including command arguments),
empty prompts, and harness notifications/system turns (including task notifications,
system reminders and tool-result echoes) skip discovery. Candidates still use the
0.20 floor, but at least one must score 0.70 to inject the top three. This threshold
excludes the unrelated 0.60/0.40 results observed in #3889 while retaining the
existing strong 0.70–0.92 fixtures; it is a routing cutoff, not a probability.
With no strong candidate, context contains only an instruction to run
`aiwg discover "<need>"` (with `--type` for a named artifact type) before any
other tool call or answer. Strong candidate context makes `aiwg show` for the best fit
the first call, and also says:
“If none fit, run aiwg discover; never decline without it.”
The wording is directive because Muse ignored advisory wording in the 2026-11-06
UAT and followed first-call wording.
Injected text stays under 600 characters, allowing up to 100 characters per
capability. Discovery uses the validated shipped relationship package and search
metadata read-only, falling back to existing local metadata. It never rebuilds
indexes, writes digest receipts, or assembles rule bodies at prompt time.
Errors, missing runtimes, and timeouts exit successfully without output;
the hook never edits or blocks your prompt. Normal installs use shipped prebuilt
metadata without a per-root index; missing or invalid packages fall back to existing
local metadata. Missing indexes produce the discover instruction and stay untouched.

Set `AIWG_PROMPT_DISCOVERY=0` (also `false` or `off`) in the harness environment to
disable it. `AIWG_PROMPT_DISCOVERY_TIMEOUT_MS` adjusts the total budget (default
1500 ms, maximum 10000 ms), including stdin and index work. Existing `--no-hooks`
deployment controls continue to apply; the environment switch also disables
already-installed hooks.

| Provider | Prompt discovery delivery |
|---|---|
| Claude Code | UserPromptSubmit additionalContext |
| Muse | UserPromptSubmit additionalContext via project hook owner |
| Codex 0.165 | UserPromptSubmit additionalContext via project `.codex/hooks.json` |
| Factory | UserPromptSubmit plain stdout context via project `.factory/hooks.json`; requires folder trust and a git commit |
| Hermes | Opt-in `pre_llm_call` shell hook in `$HERMES_HOME/config.yaml`, returning native `{context}`; requires command consent |
| Copilot | Discover-first bootstrap rule in `.github/copilot-instructions.md` |
| Grok Build | Discover-first bootstrap rule in `AGENTS.md` |

The canonical source retains `degrade-on` for Copilot and Grok Build: their
bootstrap rules require `aiwg discover --stdin` before any other tool call or
answer, then `aiwg show` with rule bodies and application. These rules obtain
candidates through discovery; they do not inject ranked candidates automatically.

## Offline delivery evidence (#3996)

Installed help/docs were inspected offline on 2026-11-08; no prompt runs were made:

- Copilot 1.0.105: `copilot --help`, `copilot help hooks` (unknown topic), and
  the installed `@github/copilot/README.md` document no prompt-context injection
  contract. `--no-custom-instructions` explicitly disables instruction loading;
  the fallback requires custom instructions to remain enabled.
- Grok 1.0.77: installed binary's bundled Hooks documentation, extracted with
  `strings`, says allowing `UserPromptSubmit` stdout is discarded, with no
  `additionalContext`. Tool-event context is too late for prompt discovery.
- Hermes checkout `dce1e9b375`: installed `website/docs/user-guide/features/hooks.md`, “Shell Hooks”
  and “JSON wire protocol”, documents `pre_llm_call`, stdin `extra.user_message`,
  and stdout `{context}`. The existing bridge copies the shared bounded script
  to `$HERMES_HOME/agent-hooks/aiwg-prompt-discovery.cjs` and merges that event
  into `config.yaml`. Use `aiwg use all --provider hermes --enable-cross-provider-hooks`;
  the existing bridge stays opt-in and `--no-hooks` suppresses it. Commands, comments and consent
  settings are preserved. Approve the command in Hermes; AIWG does not set
  `hooks_auto_accept`. Safe mode and denied/unapproved hooks prevent delivery.
  Hermes help failed because its dependency environment needs repair; installed
  docs establish this contract, with runtime UAT deferred.

`context.promptDiscovery` in the provider registry records delivery files,
the Hermes event and opt-in; the isolated harness audit checks the deployed bytes.

## Factory project hooks (#3976)

Trust this folder in droid; project hooks load only in a git repository with at
least one commit. After deploying, open interactive droid from the project root
and trust the folder. If the project has no git history, initialize the repository
and create its first commit before expecting project hooks to load.

Factory registers AIWG hooks in `.factory/hooks.json` as a top-level event map.
`UserPromptSubmit` delivers plain stdout context through the shared discovery
script; `SessionStart` checks for updates. `aiwg use --provider factory` prints
the next step when either prerequisite is missing or unverified, and `aiwg doctor`
reports the same advisory. AIWG reads `~/.factory/settings.json` without changing
it: `trustedFolders` is an object keyed by absolute folder path, and the exact
project key establishes trust. A bounded `git rev-parse --verify HEAD` in the
project checks for an existing commit. AIWG never grants trust or creates commits.
These prerequisites apply to interactive project hooks; they do not establish
prompt-hook support for `droid exec`.

## Codex 0.165 schema verification (#3888)

Trust the project in Codex, then approve the AIWG hook when Codex asks; AIWG reads project trust from `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) without changing it, and reports hook review as unknown because no documented offline approval signal is available.

The installed `codex-cli 0.165.0` reports `hooks stable true` from
`codex features list`. Offline probes used an empty temporary `CODEX_HOME` and
HOME, no credentials, a synthetic trusted project, and network calls denied by
`strace -f -e inject=connect:error=ENETUNREACH -e inject=sendto:error=ENETUNREACH`.
The binary's stdio app server (`initialize`, then `hooks/list` with
`{"cwds":["<temporary-project>"]}`) established the following:

- Both `<project>/.codex/hooks.json` and `$CODEX_HOME/hooks.json` are read.
- JSON is `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node /path/to/hook.cjs","timeout":2}]}]}}`.
- TOML uses `[[hooks.UserPromptSubmit]]`, followed by
  `[[hooks.UserPromptSubmit.hooks]]`, `type = "command"`, and a shell `command`
  string. Separate `args` on the matcher group are ineffective.
- **Configuration keys are PascalCase**, matching Claude Code. A snake_case
  `user_prompt_submit` key silently loads zero hooks in both JSON and TOML.
  `hooks/list` reports the loaded hook's internal key with `user_prompt_submit`
  and its API event name as `userPromptSubmit`. These are different namespaces.
- All eleven canonical events were enumerated successfully, including distinct
  `Stop` and `SessionEnd`, with no warnings or errors.
- Project hooks require a trusted project; hook commands separately require
  Codex hook trust/review. Deployment never grants that trust. The probe used
  `--dangerously-bypass-hook-trust` only for its synthetic command.

An unauthenticated `codex exec --ephemeral --skip-git-repo-check
--dangerously-bypass-hook-trust --json` executed the project command and delivered
`hook_event_name: "UserPromptSubmit"`, `prompt`, and `cwd` on stdin. Its JSON
output used `hookSpecificOutput.hookEventName: "UserPromptSubmit"` and
`hookSpecificOutput.additionalContext`; the same wire shape is embedded in the
binary's `user-prompt-submit.command.output` schema. The embedded
`pre-tool-use.command.output` schema declares `permissionDecision` and
`permissionDecisionReason` inside `hookSpecificOutput`.
A second run executed the deployed shared discovery script with a synthetic local
discovery runtime and captured its candidate `additionalContext` JSON. Both runs
were terminated after observing hook execution; no authenticated model turn or
model-visible context was tested.
A complete model turn requires the operator's authenticated session.

The round-two cwd probe used the installed `codex-cli 0.165.0` binary with
temporary HOME and CODEX_HOME directories, no auth.json, and the same strace
network denial above. It launched from a separate directory with `--no-daemon
-C "<fixture>/project with spaces" exec --ephemeral --skip-git-repo-check
--dangerously-bypass-hook-trust --json`. A synthetic UserPromptSubmit script
recorded `process.cwd()`, stdin `cwd`, and CODEX/CLAUDE environment variables.
Both cwd values equalled the `-C` directory; `node .codex/hooks/probe.cjs` ran
successfully. With `-C "<fixture>/project with spaces/nested"` inside a trusted
Git fixture, the parent project's hook still loaded, but both cwd values were
the nested directory. Only the explicitly supplied CODEX_HOME was present among
CODEX/CLAUDE variables: there was no injected project-root variable.

Consequently, the generated discovery command uses `node -e` to find
`.codex/hooks/aiwg-prompt-discovery.cjs` from the session cwd or its nearest
ancestor, then requires it while preserving stdin and cwd. It embeds no project
or package absolute path and works when a project is moved or opened below its
root. The same offline probe executed this generated command successfully from
both the fixture root and its nested directory on 2026-11-06.
The default installer reads the canonical source and script from AIWG's
own package, independently of an external or synthetic bundle's source root.
The lightweight CLI stages and allowlists that source and the shared hook
scripts even when the framework corpus is absent.

The bridge keeps `Stop` distinct from `SessionEnd`. Its legacy TOML block helper
rescues `[desktop]`, marketplace, plugin, and other user tables when a misplaced
AIWG end marker encloses them. Project deployment leaves existing global TOML
untouched; the helper is available for explicit managed-block replacement.

## Overview

Claude Code hooks enable AIWG to inject context dynamically and enforce quality gates without bloating CLAUDE.md. This guide covers PreToolUse context injection (#284) and extended timeout quality gates (#289).

## PreToolUse Context Injection (#284)

### Problem

AIWG loads all conventions via CLAUDE.md and path-scoped rules, consuming context window regardless of relevance. PreToolUse hooks can inject context only when a relevant tool is actually being used.

### Pattern: Dynamic Context Loading

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "command": "cat .aiwg/conventions/coding-standards.md 2>/dev/null || true",
        "additionalContext": true
      },
      {
        "matcher": "Bash",
        "command": "cat .aiwg/conventions/safety-checks.md 2>/dev/null || true",
        "additionalContext": true
      }
    ]
  }
}
```

### How It Works

1. When Claude Code is about to use a tool (Write, Edit, Bash, etc.), the PreToolUse hook fires
2. The hook's `command` runs and its stdout becomes `additionalContext`
3. This context is injected into the model's next turn - targeted and temporary
4. No permanent context window cost - only loaded when relevant

### AIWG Context Injection Examples

**Coding conventions on Write/Edit**:
```bash
# .aiwg/hooks/inject-coding-context.sh
#!/bin/bash
# Only inject if modifying source files
if echo "$TOOL_INPUT" | grep -q '"file_path".*"src/'; then
  cat .aiwg/conventions/typescript-standards.md
fi
```

**Security checks on Bash**:
```bash
# .aiwg/hooks/inject-safety-context.sh
#!/bin/bash
cat <<'CTX'
SAFETY REMINDER: Before executing commands:
- Never run destructive commands without confirmation
- Validate all file paths are within project scope
- Check for sensitive data exposure in output
CTX
```

**Agent-specific context**:
```bash
# .aiwg/hooks/inject-agent-context.sh
#!/bin/bash
AGENT=$(cat .aiwg/current-agent.txt 2>/dev/null)
if [ -f ".aiwg/conventions/${AGENT}.md" ]; then
  cat ".aiwg/conventions/${AGENT}.md"
fi
```

### Benefits vs Static Loading

| Approach | Context Cost | Relevance | Maintenance |
|----------|-------------|-----------|-------------|
| CLAUDE.md (static) | Always loaded | May be irrelevant | Single file |
| Path-scoped rules | Per-file-type | Good | Multiple files |
| PreToolUse hooks | On-demand | Excellent | Hook scripts |

## Quality Gate Hooks (#289)

### Problem

Previously, hooks timed out at 60 seconds - too short for running full test suites or security scans. Claude Code v2.1.3 extended timeouts to 10 minutes.

### Pattern: Test Suite as Quality Gate

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "command": ".aiwg/hooks/run-affected-tests.sh",
        "timeout": 300000,
        "blocking": true
      }
    ]
  }
}
```

**Hook script**:
```bash
#!/bin/bash
# .aiwg/hooks/run-affected-tests.sh
# Run tests related to the file being modified

FILE=$(echo "$TOOL_INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null)

if [[ "$FILE" == src/* ]]; then
  # Map source to test file
  TEST_FILE="${FILE/src\//test\/}"
  TEST_FILE="${TEST_FILE/.ts/.test.ts}"

  if [ -f "$TEST_FILE" ]; then
    npm test -- --testPathPattern="$TEST_FILE" --bail 2>&1
    exit $?
  fi
fi

exit 0  # No tests to run
```

### Gate Types by Hook Phase

| Gate | Hook Phase | Timeout | Purpose |
|------|-----------|---------|---------|
| Unit tests | PreToolUse(Write) | 5 min | Validate before accepting changes |
| Security scan | PreToolUse(Bash) | 10 min | Check commands before execution |
| Lint/format | PostToolUse(Write) | 2 min | Auto-fix after writes |
| Coverage check | PostToolUse(Bash) | 5 min | Verify coverage after test runs |
| SDLC gate | PreToolUse(Write) | 5 min | Enforce phase requirements |

### SDLC Phase Gate Hook

```bash
#!/bin/bash
# .aiwg/hooks/sdlc-phase-gate.sh
# Enforce that required artifacts exist before construction phase

PHASE=$(cat .aiwg/planning/current-phase.txt 2>/dev/null || echo "unknown")

if [ "$PHASE" = "construction" ]; then
  MISSING=""
  [ ! -f .aiwg/architecture/sad.md ] && MISSING="$MISSING SAD"
  [ ! -f .aiwg/testing/test-strategy.md ] && MISSING="$MISSING TestStrategy"

  if [ -n "$MISSING" ]; then
    echo "GATE BLOCKED: Missing artifacts for construction:$MISSING"
    echo "Complete elaboration phase first."
    exit 1
  fi
fi

exit 0
```

### Timeout Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "command": ".aiwg/hooks/quick-lint.sh",
        "timeout": 30000
      },
      {
        "matcher": "Bash",
        "command": ".aiwg/hooks/full-security-scan.sh",
        "timeout": 600000
      }
    ]
  }
}
```

**Timeout guidelines**:

| Check Type | Recommended Timeout | Rationale |
|-----------|-------------------|-----------|
| Lint/format | 30s | Fast, single-file |
| Unit tests (affected) | 2-5 min | Subset of tests |
| Full test suite | 5-10 min | Complete validation |
| Security scan | 5-10 min | Deep analysis |
| Build verification | 3-5 min | Compilation check |

## Offline harness audit (#3935, 2026.11.3)

Inventory date: 2026-11-07. This audit covers the issue's 18 named providers and
the generic fallback. The registry also contains Flue, added separately; it is
outside this issue's inventory. Sources: [provider registry](../src/providers/provider-definitions.ts),
its `provider-seeds-{1,2,3}.ts` and `provider-context-contracts.ts` owners,
the runtime [MCP registry](../src/providers/provider-definitions.mjs), and
the existing [deployment adapters](../tools/agents/providers/).
The MCP registry is not an alternative deployment inventory.
Seed ownership: `provider-seeds-1.ts` owns antigravity, claude, codex, copilot,
cursor, factory and grokbot; `provider-seeds-2.ts` owns deepseek-harness,
grok-build, hermes, muse, opencode, openclaw, openhuman and omp;
`provider-seeds-3.ts` owns pi, warp, windsurf and generic.

Paths below are project relative unless prefixed with `~/`. K = native kernel
skills, B = bulk skill inventory; `use all` defaults to kernel deployment,
so a B path can be absent until `--copy-all`. Rule files on non-native loaders
are reached through the bootstrap's mandatory `RULES-INDEX` read.
Pi and OMP retain their existing full-surface `use all` default; this audit uses
each provider's public default without changing its deployment flags.

| Provider | Bootstrap | Rules | Skills (K; B) | Deployment owner (`tools/agents/providers/`) |
|---|---|---|---|---|
| antigravity | `AGENTS.md` | `.antigravity/rules` | `.agents/skills`; `.agents/.aiwg/skills` | `antigravity.mjs` |
| claude | `CLAUDE.md` | `.claude/rules` | `.claude/skills`; `.claude/.aiwg/skills` | `claude.mjs` |
| codex | `AGENTS.md` | `.codex/rules` | `.agents/skills`; `.codex/.aiwg/skills` | `codex.mjs` |
| copilot | `.github/copilot-instructions.md`, `AGENTS.md` | `.github/instructions` | `.github/skills`; `.github/.aiwg/skills` | `copilot.mjs` |
| cursor | `AGENTS.md` | `.cursor/rules` | `.cursor/skills`; `.cursor/.aiwg/skills` | `cursor.mjs` |
| deepseek-harness | `AGENTS.md` | `.deepseek-harness/rules` (projection fallback) | `.agents/skills` (K/B) | `deepseek-harness.mjs` |
| factory | `AGENTS.md` | `.factory/rules` | `.factory/skills`; `.factory/.aiwg/skills` | `factory.mjs` |
| grokbot | `AGENTS.md` (host dependent) | `.grokbot/rules` (projection fallback) | None by default; user copies require `AIWG_GROKBOT_SKILLS_DIR` | `grokbot.mjs` |
| grok-build | `AGENTS.md` | `.grok/rules` | `.grok/skills`; `.grok/.aiwg/skills` | `grok-build.mjs` |
| hermes | `.hermes.md`, `AGENTS.md` | `.hermes/rules` | `~/.hermes/skills`; `~/.hermes/skills/.aiwg` (`HERMES_HOME` overrides) | `hermes.mjs` |
| muse | `AGENTS.md` | `.muse/rules` | `.agents/skills`; `.agents/.aiwg/skills` | `muse.mjs` |
| opencode | `AGENTS.md` + `opencode.json` instructions | `.opencode/rule` | `.opencode/skill`; `.opencode/.aiwg/skill` | `opencode.mjs` |
| openclaw | Registry declares `~/.openclaw/workspace/AGENTS.md` + `~/.openclaw/workspace/SOUL.md` (default active workspace); adapter resolves profile/config overrides | `~/.openclaw/rules` | `~/.openclaw/skills/aiwg`; `~/.openclaw/.aiwg/skills` | `openclaw.mjs` |
| openhuman | `AGENTS.md` (host dependent) | `~/.openhuman/.aiwg/rules` | `~/.openhuman/skills`; `~/.openhuman/.aiwg/skills` | `openhuman.mjs` |
| pi | `AGENTS.md` | `.pi/rules` | `.agents/skills`; `.pi/.aiwg/skills` | `pi.mjs` |
| omp | `.omp/AGENTS.md` | `.omp/rules` | `.agents/skills` (K/B) | `omp.mjs` |
| warp | `WARP.md`, `AGENTS.md` | `.warp/rules` | `.warp/skills`; `.warp/.aiwg/skills` | `warp.mjs` |
| windsurf | `AGENTS.md` | `.windsurf/rules` | `.windsurf/skills`; `.windsurf/.aiwg/skills` | `windsurf.mjs` |
| generic | `AGENTS.md` (host must load explicitly) | `rules` | `.agents/skills` (host loaded); `skills` | `generic.mjs` (#3997) |

Hook support below means **AIWG prompt discovery delivery**, not merely an
upstream event. Native = existing provider hook installer; bridge = existing
canonical hook translator; none = no deployed prompt/context transport.
Headless availability comes from repository adapters and provider docs, without
executing any harness. Exec hook behavior stays unverified unless supplied UAT
establishes it; interactive support does not establish exec support.

| Provider | Prompt hook support / config | Exec/headless surface | Exec-mode prompt hooks | Static check | Live UAT status (operator supplied) |
|---|---|---|---|---|---|
| antigravity | None | `agy --print` | Unverified | Pass | Static only |
| claude | Native: `.claude/settings.json` | `claude --print` | Unverified separately | Pass | p1/p2/p4 discover-first; p3 not supplied |
| codex | Bridge: `.codex/hooks.json`; trust + review required | `codex exec` | Unverified separately | Pass | Discover at calls 2–8, after bootstrap reads; per-prompt scores not supplied |
| copilot | Bootstrap rule: `.github/copilot-instructions.md` | `copilot` noninteractive | Bootstrap directive; runtime unverified | Pass | Static only |
| cursor | None | `cursor-agent --print` | Unverified | Pass | Static only |
| deepseek-harness | None | `dsh --profile headless` | Unverified | Pass | Static only |
| factory | Bridge: `.factory/hooks.json`; trusted committed project | `droid exec` | **No prompt hooks** | Pass | Interactive hooks fire after #3971; exec relies on discovery/template rule |
| grokbot | None | No evidenced CLI worker surface | N/A | Pass | Static only |
| grok-build | Bootstrap rule: `AGENTS.md` | `grok --print` | Submit stdout discarded; bootstrap directive | Pass | Static only |
| hermes | Opt-in bridge: `$HERMES_HOME/config.yaml` `pre_llm_call` shell hook | `hermes` noninteractive | Documented CLI + gateway; consent required; runtime unverified | Pass | Static only |
| muse | Native project owner: `.muse/hooks.json` + sidecar | `muse exec` | Unverified separately | Pass | p2 discover-first; p1/p4 mixed; p3 not supplied |
| opencode | None | `opencode run` | Unverified | Pass | Static only |
| openclaw | None | `openclaw agent exec` | Unverified | Pass | Static only |
| openhuman | None | `openhuman-core call` (one-shot RPC) | Unverified | Pass | Static only |
| pi | None | `pi --print` | Unverified | Pass | Static only |
| omp | None: extension bridge is not prompt-context delivery | `omp --print` | Unverified | Pass | Static only |
| warp | None | `warp-terminal agent run` (Oz) | Unverified | Pass | Static only |
| windsurf | None | Desktop provider; Devin CLI is a separate future target | N/A | Pass | Static only |
| generic | None | N/A (host defined) | N/A | Pass (#3997) | Portable adapter; no harness |

Result: **18/18 named harnesses pass** the offline deployment/refresh check;
the generic adapter also passes deployment/refresh and direct deployment checks
(#3997), along with two bulk routing checks. Generic uses the shared Markdown rule
projection and kernel skill router; its host must explicitly load `AGENTS.md` and
skills. No automatic context loading, prompt hooks, or headless CLI is claimed.
Muse and Grok Build share bulk-root constants between their registries and
adapters (#3994); synthetic skills verify the opt-in mirror matches registry
metadata while kernel skills remain in the native roots.

Reproduce offline with the built CLI using
[`harness-bootstrap-audit.test.ts`](../test/integration/harness-bootstrap-audit.test.ts)
in the required deployment lane. Each case creates an `os.tmpdir()` project and
isolated HOME/XDG tree, deploys `use all --provider <p>`, checks startup, the four
requested rules (`skill-discovery` and `artifact-output-policy` kernel files;
`anti-laziness` and `no-attribution` compact core bodies), skill paths and prompt hook config, then runs
`refresh --dry-run --skip-update --provider <p>` and compares filesystem bytes
and mtimes to check that the dry run is read-only. This does not run hooks or
prove runtime discovery, template loading, or provider trust.

Copilot rule checks use the registry path directly and assert agreement with
context-discovery, behavior and smith rule paths at `.github/instructions` (#3993).

OpenClaw's default active-workspace bootstrap targets are declared in the registry
and compared with the deployed Markdown files (#3995). The audit checks the
`AGENTS.md` project-context bridge and the `SOUL.md` steward identity/discovery
guidance. Both files deploy in the default kernel-only mode as well as full
deployment. Profile/config workspace overrides remain owned by the deployment
adapter; this audit uses the isolated HOME default.

The #3935 audit deferred CLI/version collection; #3996 inspected installed help
and docs offline as recorded above. New live UAT remains deferred. Supplied UAT above is
historical input, not a fresh run or a complete per-prompt score. No tracker
writes were made; the conductor owns issue filing and publication on #3935.

Audit gaps retained for the conductor (fixes and issue filing are outside this
worker's steps 1/2/5 scope):

| Provider | File | Symptom |
|---|---|---|
| copilot, grok-build | `tools/agents/providers/rule-startup.mjs` | #3996 delivers a discover-first bootstrap rule; automatic prompt-context injection is not documented. |
| codex | `src/smiths/hook-bridge/codex-translator.ts` | Supplied UAT discovers at calls 2–8 after bootstrap; discover-first is not established. Trust/review remain runtime prerequisites. |
| muse | `tools/agents/providers/muse-prompt-discovery.mjs` | Supplied p1/p4 discover-first results remain mixed. |
| factory | `tools/agents/providers/factory-hooks.mjs` | Interactive registration does not run in `droid exec`; the bootstrap rule carries discovery/template use. |

Providers with no AIWG prompt installer are recorded as **none** in the matrix;
that classification is not a claim that their upstream harness lacks all hooks.
All exec-hook cells marked unverified and all missing per-prompt/template scores
remain deferred to authorized live UAT. A current fresh deployment does not
establish complete drift detection for arbitrary damaged deployments.

## References

- @agentic/code/frameworks/sdlc-complete/agents/agent-template.md - Agent template hook section
- @.claude/rules/executable-feedback.md - Executable feedback integration
- @.claude/rules/hitl-gates.md - Quality gate rules
- @docs/context-management-patterns.md - Cross-platform context
