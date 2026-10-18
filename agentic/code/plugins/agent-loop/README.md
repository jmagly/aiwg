# Agent Loop

Classify work with the [autonomy and human operating roles framework](https://github.com/jmagly/aiwg/blob/main/docs/autonomy-and-human-roles.md). A loop cannot override human-owned actions, checkpoints, or failed verification.

Iterative AI task execution with automatic recovery - **iteration beats perfection**.

## Overview

Al transforms single-pass AI execution into iterative completion loops. Instead of hoping a task succeeds on the first try, Al keeps iterating until verifiable completion criteria are met.

```
┌──────────────────────────────────────────┐
│            RALPH LOOP                    │
│                                          │
│   Execute → Verify → Learn → Iterate     │
│      ↑                          │        │
│      └──────────────────────────┘        │
│                                          │
│   Until: criteria met OR limits reached  │
└──────────────────────────────────────────┘
```

## Installation

```bash
# Via AIWG CLI
aiwg use ralph

# Or install plugin
aiwg install-plugin ralph
```

## Quick Start

### Fix All Tests

```bash
/ralph "Fix all failing tests" --completion "npm test passes"
```

### TypeScript Migration

```bash
/ralph "Convert src/ to TypeScript" --completion "npx tsc --noEmit passes" --max-iterations 20
```

### Coverage Target

```bash
/ralph "Add tests until 80% coverage" --completion "npm run coverage shows >= 80%"
```

## Commands

| Command | Description |
|---------|-------------|
| `/ralph` | Start iterative task loop |
| `/ralph-status` | Check current loop status |
| `/ralph-abort` | Abort running loop |
| `/ralph-resume` | Resume interrupted loop |

## Natural Language

Al also responds to:
- "ralph this: [task]"
- "keep trying until [condition]"
- "loop until [criteria]"
- "iterate on [task] until [done]"

## Parameters

```
/ralph "<task>" --completion "<criteria>" [options]

Options:
  --max-iterations N    Safety limit (default: 10)
  --timeout M           Minutes before timeout (default: 60)
  --interactive         Ask setup questions first
  --no-commit           Disable auto-commits
  --branch <name>       Create feature branch
```

## Provider Routing

On Codex and Claude Code, in-session Al/agent-loop requests delegate to the native `/goal` primitive instead of running a parallel AIWG emulation loop. AIWG still owns completion inference, safety gates, and audit output, then maps the work to:

```text
/goal "<task>; completion: <criteria>"
```

External Al remains AIWG-native because it is detached and crash-resilient; `/goal` is an in-session primitive.

## How It Works

### 1. Define Task
Provide a clear, actionable task description.

### 2. Set Completion Criteria
Specify how to verify success (must be objectively checkable).

### 3. Execute Loop
Al attempts the task, verifies criteria, learns from failures, and iterates.

### 4. Track Progress
Each iteration is committed to git, creating clear history.

### 5. Report Results
Generates completion report with full iteration history.

## Completion Criteria Examples

**Good** (verifiable):
- `"npm test passes"`
- `"npx tsc --noEmit exits with code 0"`
- `"npm run lint passes"`
- `"coverage report shows >= 80%"`

**Poor** (subjective):
- `"code is good"`
- `"feature is complete"`

## State & Artifacts

Al stores state in `.aiwg/ralph/`:

```
.aiwg/ralph/
├── current-loop.json       # Loop state (for resume)
├── iterations/             # Iteration history
│   ├── iteration-1.md
│   ├── iteration-2.md
│   └── ...
└── completion-*.md         # Final reports
```

## Best Practices

1. **Be specific** - "Fix auth tests" > "Fix tests"
2. **Use verifiable criteria** - Commands with exit codes work best
3. **Set reasonable limits** - 10-20 iterations for most tasks
4. **Enable auto-commit** - Track progress via git history
5. **Learn from iterations** - Each failure teaches the next attempt

## Examples

See `docs/examples/` for detailed walkthroughs:
- [Test Fixes](docs/examples/test-fix.md)
- [Migrations](docs/examples/migration.md)
- [Coverage](docs/examples/coverage.md)
- [Greenfield](docs/examples/greenfield.md)

## Philosophy

> "Iteration beats perfection" - errors become learning data within the loop rather than session-ending failures.

Al inverts traditional AI optimization from "unpredictable success" to "predictable failure with automatic recovery."

## Important: When to Use Al

**Al is a power tool.** Used correctly, it delivers overnight. Used incorrectly, it burns tokens producing junk.

| Situation | Use Al? | Instead |
|-----------|------------|---------|
| Greenfield with no docs | **NO** | Use AIWG intake/flows first |
| Vague requirements | **NO** | Write use cases first |
| Clear spec, need implementation | **YES** | - |
| Tests failing, need fixes | **YES** | - |
| Migration with clear rules | **YES** | - |

**The key insight**: Al excels at HOW to build, but thrashes on WHAT to build. Define your requirements first, then let Al implement.

See [When to Use Al](docs/when-to-use-agent-loop.md) for detailed guidance on avoiding the token-burning trap.

## External Al

For long-running tasks (6-8 hours) that need crash recovery and cross-session persistence, see **External Al**:

```bash
/ralph-external "Migrate codebase to TypeScript" \
  --completion "npx tsc --noEmit exits 0" \
  --max-iterations 20 \
  --checkpoint-interval 20
```

External Al provides:
- Pre/post session snapshots
- Periodic checkpoints during execution
- Two-phase state assessment
- Crash recovery and resume

See [Al Guide](https://github.com/jmagly/aiwg/blob/main/docs/agent-loop-guide.md) for full documentation on both internal and external Al.

## Related

- [Al Guide](https://github.com/jmagly/aiwg/blob/main/docs/agent-loop-guide.md) - **Complete documentation** for both internal and external Al
- [When to Use Al](docs/when-to-use-agent-loop.md) - Understanding Al's sweet spot
- [Quickstart Guide](docs/quickstart.md) - Getting started
- [Best Practices](docs/best-practices.md) - Writing effective tasks
- [Troubleshooting](docs/troubleshooting.md) - Common issues

## Credits

Based on the [iterative agent loop methodology](https://dev.to/ibrahimpima/the-ralf-wiggum-breakdown-3mko).
