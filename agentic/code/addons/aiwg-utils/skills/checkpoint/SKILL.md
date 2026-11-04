---
namespace: aiwg
name: checkpoint
platforms: [all]
description: Create, list, or recover mid-workflow checkpoints so interrupted work resumes from a known-good position
---

# Checkpoint

You create, list, or recover lightweight mid-workflow checkpoints that allow a crashed or interrupted workflow to continue from a known-good position rather than restart from scratch.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "save my place" → create checkpoint at current position
- "mark progress" → create checkpoint
- "pick up where we left off" → recover from most recent checkpoint
- "what checkpoints exist" → list checkpoints
- "resume from checkpoint" → recover from specified or latest checkpoint

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Create (named) | "checkpoint this as iteration-3-complete" | Run `aiwg checkpoint create --name iteration-3-complete` |
| Create (anonymous) | "create a checkpoint" | Run `aiwg checkpoint create` |
| List | "show available checkpoints" | Run `aiwg checkpoint list` |
| Recover (latest) | "recover from the last checkpoint" | Run `aiwg checkpoint recover` |
| Recover (specific) | "recover checkpoint ckpt_7b2f1a" | Run `aiwg checkpoint recover ckpt_7b2f1a` |

## Behavior

When triggered:

1. **Extract intent**:
   - Which subcommand: `create`, `list`, or `recover`?
   - Is a name or checkpoint ID provided?
   - For recover, should it use the most recent checkpoint or a specific one?

2. **Run the appropriate subcommand**:

   ```bash
   # Create — anonymous
   aiwg checkpoint create

   # Create — named
   aiwg checkpoint create --name <name>

   # List all checkpoints
   aiwg checkpoint list

   # Recover — most recent checkpoint
   aiwg checkpoint recover

   # Recover — specific checkpoint by ID or name
   aiwg checkpoint recover <id>
   ```

3. **Checkpoints vs. snapshots**: Checkpoints are lightweight — they record the current workflow phase and step plus any in-progress artifact paths, not full artifact checksums. Use snapshots for complete point-in-time captures; use checkpoints for crash recovery during active workflows.

   | | Checkpoint | Snapshot |
   |---|---|---|
   | **Purpose** | Crash recovery | Reproducibility |
   | **Size** | Small (phase + step + artifact refs) | Full (versions + checksums) |
   | **Created by** | Manual or agent loop (auto) | Manual only |
   | **Use for** | Resume interrupted run | Replay from known state |

4. **Automatic creation**: Agent loops create checkpoints automatically between iterations. Manual `create` supplements this for critical workflow milestones.

5. **Storage**: Checkpoints are stored in `.aiwg/checkpoints/` as lightweight JSON files.

6. **Report the result** — on create, confirm the checkpoint ID and position; on recover, confirm which step the workflow will resume from.

## Examples

### Example 1: Create a named checkpoint

**User**: "Create a checkpoint after iteration 3 completes"

**Extraction**: Create subcommand, name `iteration-3-complete`

**Action**:
```bash
aiwg checkpoint create --name iteration-3-complete
```

**Response**: "Checkpoint `iteration-3-complete` created (ID: `ckpt_7b2f1a`). Recorded position: Construction phase, iteration 3, step 12/15. In-progress artifacts: `.aiwg/working/tests/integration-plan-draft.md`. Stored at `.aiwg/checkpoints/ckpt_7b2f1a.json`."

### Example 2: List checkpoints

**User**: "What checkpoints do we have?"

**Extraction**: List subcommand

**Action**:
```bash
aiwg checkpoint list
```

**Response**:
```
ID            Name                     Date                  Phase / Step
ckpt_3a8c12   (auto)                   2026-03-28 10:04:51   Construction / iter 1, step 8
ckpt_9f20de   (auto)                   2026-03-29 14:17:33   Construction / iter 2, step 15
ckpt_7b2f1a   iteration-3-complete     2026-03-30 09:55:02   Construction / iter 3, step 12
```

### Example 3: Recover from the latest checkpoint

**User**: "The workflow crashed — recover from the last checkpoint"

**Extraction**: Recover subcommand, use most recent

**Action**:
```bash
aiwg checkpoint recover
```

**Response**: "Recovering from most recent checkpoint `iteration-3-complete` (ckpt_7b2f1a). Resuming Construction phase, iteration 3, step 12/15. In-progress artifact `.aiwg/working/tests/integration-plan-draft.md` reloaded. Ready to continue."

### Example 4: Recover from a specific checkpoint

**User**: "Recover from checkpoint ckpt_9f20de"

**Extraction**: Recover subcommand, ID `ckpt_9f20de`

**Action**:
```bash
aiwg checkpoint recover ckpt_9f20de
```

**Response**: "Recovering from checkpoint `ckpt_9f20de` (auto, 2026-03-29 14:17:33). Resuming Construction phase, iteration 2, step 15/15. No in-progress artifacts. Ready to continue from this position."

## Clarification Prompts

If the user's intent is ambiguous:

- "Should I create a new checkpoint here, list existing checkpoints, or recover from one?"
- "Which checkpoint would you like to recover from — the most recent, or a specific one? Run `aiwg checkpoint list` to see what's available."

## References

- @$AIWG_ROOT/src/cli/handlers/checkpoint.ts — Checkpoint command handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/snapshot/SKILL.md — Full workflow snapshots (compare to checkpoints)
