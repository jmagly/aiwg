# AIWG Hook Patterns

**Issues:** #284, #289
**Version:** 2026.2.0
**Status:** Active

## Prompt-time discovery (#3858)

> Review the authentication code for security issues.

On Claude Code, Muse, and Codex 0.165, each substantive prompt gives the assistant up to three
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
| Hermes | Explicit gap: the bridge returns an exit code without forwarding prompt JSON or injecting additionalContext |

The canonical source declares these gaps with `degrade-on`; bridge deployment
reports a skip reason instead of installing an ineffective prompt hook. Copilot,
Grok Build, and Factory are also excluded pending a verified delivery path for
this hook. A native event mapping alone does not establish context delivery.

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

## Cross-Platform Notes

Hook patterns are Claude Code-specific. For other platforms:

| Platform | Equivalent | Notes |
|----------|-----------|-------|
| Claude Code | `.claude/settings.json` hooks | Full support |
| GitHub Copilot | GitHub Actions | CI/CD based |
| Cursor | `.cursor/` rules | No hook equivalent |
| Warp | Warp workflows | Different mechanism |

See @docs/context-management-patterns.md for cross-platform context strategies.

## References

- @agentic/code/frameworks/sdlc-complete/agents/agent-template.md - Agent template hook section
- @.claude/rules/executable-feedback.md - Executable feedback integration
- @.claude/rules/hitl-gates.md - Quality gate rules
- @docs/context-management-patterns.md - Cross-platform context
