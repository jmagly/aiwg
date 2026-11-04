# AIWG Hook Patterns

**Issues:** #284, #289
**Version:** 2026.2.0
**Status:** Active

## Prompt-time discovery (#3858)

> Review the authentication code for security issues.

On Claude Code and Muse, each substantive prompt gives the assistant up to three
AIWG candidates: type, name, a short capability, and relevance score. For example,
its additional context can contain `skill security-review (0.92): Review code for
security issues`, followed by the steps to inspect the candidate with
`aiwg show <type> <name>`, fetch required rule bodies with
`--rules --with-rule-bodies` / `--body`, and apply the instructions. Candidates are
hints; the assistant still checks their instructions before acting.

`aiwg use` installs the shared `aiwg-prompt-discovery.cjs` hook into Claude's
`.claude/hooks/` and registers `UserPromptSubmit` in `.claude/settings.json`.
Muse uses `.muse/hooks/` and its existing hooks.json/sidecar owner. Repeating
installation updates managed entries while preserving your own hooks.

Acknowledgements such as “yes”, “ok”, “go”, and “1”, short replies without an
identified imperative, slash-command-only prompts (including command arguments),
and empty prompts skip discovery. Matches below 0.20 produce no context.
Injected text stays under 600 characters, allowing up to 100 characters per
capability. Discovery uses the validated shipped relationship package and search
metadata read-only, falling back to existing local metadata. It never rebuilds
indexes, writes digest receipts, or assembles rule bodies at prompt time.
Errors, missing runtimes/indexes, and timeouts exit successfully without output;
the hook never edits or blocks your prompt. Normal installs use shipped prebuilt
metadata without a per-root index; missing or invalid packages fall back to existing
local metadata, leaving missing indexes untouched.

Set `AIWG_PROMPT_DISCOVERY=0` (also `false` or `off`) in the harness environment to
disable it. `AIWG_PROMPT_DISCOVERY_TIMEOUT_MS` adjusts the total budget (default
1500 ms, maximum 10000 ms), including stdin and index work. Existing `--no-hooks`
deployment controls continue to apply; the environment switch also disables
already-installed hooks.

| Provider | Prompt discovery delivery |
|---|---|
| Claude Code | UserPromptSubmit additionalContext |
| Muse | UserPromptSubmit additionalContext via project hook owner |
| Codex | Explicit gap: the bridge maps before_prompt but has no verified additionalContext injection contract |
| Hermes | Explicit gap: the bridge returns an exit code without forwarding prompt JSON or injecting additionalContext |

The canonical source declares these gaps with `degrade-on`; bridge deployment
reports a skip reason instead of installing an ineffective prompt hook. Copilot,
Grok Build, and Factory are also excluded pending a verified delivery path for
this hook. A native event mapping alone does not establish context delivery.

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
