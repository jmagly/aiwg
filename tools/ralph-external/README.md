# External Agent Loop

Crash-resilient iterative task execution with comprehensive state capture for long-running Claude sessions (6-8 hours).

---

> **SECURITY WARNING**
>
> External Ralph spawns Claude Code sessions with `--dangerously-skip-permissions`, which **bypasses all permission prompts**. This enables unsupervised file system access, arbitrary command execution, and network requests.
>
> **Before using, you MUST read**: [`docs/ralph-external-security.md`](../../docs/ralph-external-security.md)
>
> **Key risks**:
> - All file read/write operations happen without confirmation
> - Shell commands execute without user approval
> - Sessions run for hours without human oversight
> - Mistakes can propagate across multiple iterations
>
> **Minimum requirements**:
> - Clean git state (for rollback)
> - Budget and iteration limits set
> - Ability to monitor and abort
> - Understanding of all risks

---

## Overview

External Ralph wraps Claude Code sessions with an external supervisor that provides:

- **Crash recovery** - Resume interrupted sessions with accumulated context
- **State persistence** - Track progress across session boundaries
- **Comprehensive capture** - Pre/post snapshots, periodic checkpoints, output analysis
- **Two-phase assessment** - Orient (understand what happened) then generate continuation prompts

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       External Agent Loop                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐              │
│  │   Prompt    │───▶│ Claude Code  │───▶│    Output     │              │
│  │  Generator  │    │   Session    │    │   Analyzer    │              │
│  └─────────────┘    └──────────────┘    └───────────────┘              │
│         ▲                  │                    │                       │
│         │                  │                    │                       │
│         │           ┌──────▼──────┐             │                       │
│         │           │  Snapshot   │             │                       │
│         │           │  Manager    │             │                       │
│         │           └──────┬──────┘             │                       │
│         │                  │                    │                       │
│         │           ┌──────▼──────┐             │                       │
│         │           │ Checkpoint  │             │                       │
│         │           │  Manager    │             │                       │
│         │           └──────┬──────┘             │                       │
│         │                  │                    │                       │
│         │           ┌──────▼──────┐             │                       │
│         └───────────│    State    │◀────────────┘                       │
│                     │  Assessor   │                                     │
│                     └──────┬──────┘                                     │
│                            │                                            │
│                     ┌──────▼──────┐                                     │
│                     │ .aiwg/ralph │                                     │
│                     │  -external/ │                                     │
│                     └─────────────┘                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Start external loop
/ralph-external "Fix all failing tests" --completion "npm test passes"

# With enhanced capture
/ralph-external "Implement feature X" \
  --completion "npm test -- --testPathPattern=feature passes" \
  --max-iterations 10 \
  --verbose \
  --checkpoint-interval 15
```

## Modules

| Module | Purpose | Lines | Tests |
|--------|---------|-------|-------|
| `orchestrator.mjs` | Main loop coordination | ~450 | Integration |
| `session-launcher.mjs` | Claude CLI wrapper with capture | ~535 | 39 |
| `output-analyzer.mjs` | Session output analysis | ~300 | 29 |
| `state-manager.mjs` | Persistent state management | ~280 | 22 |
| `prompt-generator.mjs` | Context-aware prompt building | ~250 | 17 |
| `snapshot-manager.mjs` | Pre/post session snapshots | ~640 | 23 |
| `checkpoint-manager.mjs` | Periodic state checkpoints | ~495 | 22 |
| `state-assessor.mjs` | Two-phase assessment | ~400 | - |
| `recovery-engine.mjs` | Crash detection and recovery | ~200 | 25 |

**Total Tests:** 166 passing

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `objective` | *required* | Task objective |
| `completionCriteria` | *required* | Verifiable completion criteria |
| `maxIterations` | 5 | Maximum external iterations |
| `model` | worker tier policy | Explicit operator model pin; session models are not inherited |
| `workerTier` | role guidance | Requested tier under `defaults.workerSelection` |
| `budgetPerIteration` | 2.0 | Budget per iteration (USD) |
| `timeoutMinutes` | 60 | Timeout per iteration |
| `verbose` | false | Enable verbose Claude output |
| `enableSnapshots` | true | Enable pre/post session snapshots |
| `enableCheckpoints` | true | Enable periodic checkpoints |
| `checkpointIntervalMinutes` | 30 | Checkpoint interval |
| `useClaudeAssessment` | false | Use Claude for state assessment |
| `keyFiles` | [] | Key files to track hashes |

## Iteration Workflow

Each iteration follows this comprehensive capture flow:

### 1. Pre-Session Snapshot

Captures state before Claude session starts:

- Git status (branch, commit, staged/unstaged/untracked)
- `.aiwg/` directory state and file hashes
- Key file hashes (package.json, CLAUDE.md, etc.)
- Internal Ralph state if exists

### 2. Prompt Generation

Generates context-aware continuation prompts:

- **Initial**: Basic objective and criteria
- **Continuation**: Includes learnings, progress, file changes
- **With Assessment**: Two-phase orient + prompt generation

### 3. Checkpoint Manager

Periodic snapshots during long sessions:

- Default 30-minute intervals
- Captures git status, .aiwg state, files modified
- Memory usage tracking
- Enables recovery from mid-session crashes

### 4. Session Launch

Spawns Claude with comprehensive capture:

```bash
claude \
  --dangerously-skip-permissions \  # ⚠️ BYPASSES ALL PERMISSION CHECKS
  --print \
  --output-format stream-json \
  --session-id ${SESSION_UUID} \
  --model opus \
  --verbose  # Optional
  "${PROMPT}"
```

> **⚠️ Security Note**: The `--dangerously-skip-permissions` flag is required for headless/daemon operation but means Claude can read/write any file and execute any command without user confirmation. See [Security Guide](../../docs/ralph-external-security.md).

Captures:
- stdout → `iterations/NNN/stdout.log`
- stderr → `iterations/NNN/stderr.log`
- Session transcript → `iterations/NNN/session-transcript.jsonl`
- Parsed events → `iterations/NNN/parsed-events.json`

### 5. Post-Session Snapshot

Captures state after session completes:

- Updated git status
- All file changes (added/modified/deleted)
- Git commits made during session
- Updated `.aiwg/` state
- Test results if available

### 6. Output Analysis

Determines completion and continuation:

- Pattern matching for completion markers
- Failure classification (context exhausted, budget exceeded, crash)
- Progress estimation
- Modified files extraction
- Learnings capture

### 7. State Update

Records iteration with all capture data:

```json
{
  "number": 1,
  "sessionId": "uuid",
  "duration": 180000,
  "exitCode": 0,
  "preSnapshot": { ... },
  "postSnapshot": { ... },
  "checkpointSummary": { ... },
  "transcriptPath": "...",
  "parsedEventsPath": "...",
  "toolCallCount": 45,
  "errorCount": 2,
  "analysis": { ... }
}
```

## State Directory Structure

```
.aiwg/ralph-external/
├── session-state.json           # Active loop state
├── iterations/
│   └── 001/
│       ├── prompt.md            # Prompt used
│       ├── stdout.log           # Captured stdout
│       ├── stderr.log           # Captured stderr
│       ├── pre-snapshot.json    # State before session
│       ├── post-snapshot.json   # State after session
│       ├── snapshot-diff.json   # Changes detected
│       ├── analysis.json        # Output analysis
│       ├── state-assessment.json # Two-phase assessment
│       ├── session-transcript.jsonl # Claude transcript
│       ├── parsed-events.json   # Stream-JSON events
│       └── checkpoints/
│           ├── 001-checkpoint.json
│           ├── 002-checkpoint.json
│           └── ...
├── prompts/                      # All generated prompts
├── analysis/                     # All analysis results
└── completion-report.md          # Final summary
```

## Two-Phase State Assessment

For long-running sessions, the StateAssessor provides intelligent continuation:

### Phase 1: Orient

Analyzes the session to understand what happened:

- Parse stdout/stderr for key events
- Detect completion markers or failure patterns
- Identify files modified and their purposes
- Extract blockers and errors
- Estimate completion percentage

### Phase 2: Generate Prompt

Creates intelligent continuation prompt:

- Summarizes completed work
- Lists remaining tasks
- Incorporates learnings from failures
- Adjusts approach based on obstacles
- Provides clear next steps

## API Reference

### Orchestrator

```javascript
import { Orchestrator } from './orchestrator.mjs';

const orchestrator = new Orchestrator('/path/to/project');

// Start new loop
const result = await orchestrator.execute({
  objective: 'Fix all failing tests',
  completionCriteria: 'npm test passes',
  maxIterations: 10,
  enableSnapshots: true,
  enableCheckpoints: true,
  checkpointIntervalMinutes: 15,
  verbose: true,
});

// Resume interrupted loop
const resumed = await orchestrator.resume();

// Abort running loop
orchestrator.abort();

// Check status
const status = orchestrator.getStatus();
```

### SnapshotManager

```javascript
import { SnapshotManager } from './snapshot-manager.mjs';

const snapshots = new SnapshotManager({ projectRoot: '/path/to/project' });

// Capture pre-session state
const pre = await snapshots.capturePreSnapshot({
  sessionId: 'uuid',
  iteration: 1,
  objective: 'Task description',
  keyFiles: ['package.json', 'CLAUDE.md'],
});

// Capture post-session state
const post = await snapshots.capturePostSnapshot(pre);

// Calculate diff
const diff = snapshots.calculateDiff(pre, post);
console.log(`Changes: ${diff.summary.totalChanges}`);
```

### CheckpointManager

```javascript
import { CheckpointManager } from './checkpoint-manager.mjs';

const checkpoints = new CheckpointManager({
  stateDir: '.aiwg/ralph-external/iterations/001',
  projectRoot: '/path/to/project',
  interval: 15 * 60 * 1000, // 15 minutes
  sessionId: 'uuid',
});

// Start periodic checkpoints
checkpoints.start();

// ... session runs ...

// Stop and get summary
const summary = checkpoints.stop();
console.log(`Checkpoints: ${summary.total}`);
```

### StateAssessor

```javascript
import { StateAssessor } from './state-assessor.mjs';

const assessor = new StateAssessor({ projectRoot: '/path/to/project' });

// Full two-phase assessment
const assessment = await assessor.assess({
  stdoutPath: 'iterations/001/stdout.log',
  stderrPath: 'iterations/001/stderr.log',
  exitCode: 0,
  preSnapshot: pre,
  postSnapshot: post,
  objective: 'Task description',
  completionCriteria: 'Success criteria',
  iteration: 2,
  maxIterations: 10,
});

// Generated prompt for next iteration
console.log(assessment.prompt);
```

## Testing

```bash
# Run all external ralph tests
npm test -- "ralph-external"

# Run specific module tests
npm test -- "snapshot-manager"
npm test -- "checkpoint-manager"
npm test -- "session-launcher"

# With coverage
npm run test:coverage -- "ralph-external"
```

## Documentation

| Document | Purpose |
|----------|---------|
| `README.md` | This overview |
| `README-snapshot-manager.md` | Pre/post session snapshot details |
| `README-checkpoint-manager.md` | Periodic checkpoint capture |
| `README-state-assessor.md` | Two-phase assessment system |
| `docs/snapshot-manager-api.md` | Snapshot manager API reference |
| `docs/snapshot-manager-usage.md` | Snapshot manager examples |

## Related Commands

| Command | Purpose |
|---------|---------|
| `/ralph-external` | Start external loop |
| `/ralph-external-status` | Check loop status |
| `/ralph-external-abort` | Abort and cleanup |

## References

- @.aiwg/requirements/design-ralph-loop-addon.md - Ralph methodology
- @.claude/commands/ralph-external.md - Command specification
- @.claude/agents/ralph-output-analyzer.md - Output analyzer agent

---

**Status:** Production Ready
**Tests:** 166 passing
**Version:** 1.0.0
