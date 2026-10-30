# TaskStore Persistence for RLM

**Version**: 1.0.0
**Status**: Active
**Issue**: #324

## Overview

The RLM (Recursive Language Models) addon integrates with AIWG's TaskStore for persistent state management and crash recovery. This integration enables recursive sub-agent decomposition with durable storage, progress tracking, and automatic recovery from interruptions.

## Core Integration Concepts

### State Persistence Model

RLM task trees map to TaskStore records through a hierarchical persistence strategy:

```
RLM Task Tree          TaskStore Mapping
─────────────────      ─────────────────
Root Node          →   TaskStore record (task-0001)
├─ Child Node 1    →   TaskStore record (task-0002) [metadata.parent_id = task-0001]
├─ Child Node 2    →   TaskStore record (task-0003) [metadata.parent_id = task-0001]
│  ├─ Child 2.1    →   TaskStore record (task-0004) [metadata.parent_id = task-0003]
│  └─ Child 2.2    →   TaskStore record (task-0005) [metadata.parent_id = task-0003]
└─ Child Node 3    →   TaskStore record (task-0006) [metadata.parent_id = task-0001]
```

**Key mapping rules**:

1. **One TaskStore record per tree node** - Each node in the RLM task tree becomes a separate TaskStore task entry
2. **Parent-child via metadata** - `metadata.parent_id` field stores the parent TaskStore task ID
3. **Tree identification** - `metadata.tree_id` field links all nodes to the same RLM tree
4. **Node depth tracking** - `metadata.depth` field stores the depth in the tree (0 = root)
5. **State variable serialization** - RLM state variables (from `rlm-state.yaml`) stored in `metadata.rlm_state`

### TaskStore Schema Extension

RLM extends the standard TaskStore metadata with these fields:

```yaml
# Standard TaskStore fields
task:
  id: "task-0001"
  prompt: "Analyze security risks in authentication module"
  agent: "security-auditor"
  state: "completed"
  result: "Identified 3 security risks..."

  # RLM-specific metadata
  metadata:
    tree_id: "tree-12345678"           # Links to RLM tree
    node_id: "task-a1b2c3d4"           # RLM node identifier
    parent_id: null                    # Parent task ID (null = root)
    depth: 0                           # Tree depth
    decomposition_strategy: "parallel" # How children execute
    merge_strategy: "summarize"        # How to combine results

    # RLM state variables
    rlm_state:
      Final: null                      # Completion signal
      prompt: "Analyze security..."    # Original input
      security_risks:                  # User-defined variable
        name: "security_risks"
        value: "file:.aiwg/rlm/state-xxx/risks.json"
        type: "file_path"
        created_at: "2026-02-09T10:03:00Z"
      risk_count:
        name: "risk_count"
        value: 3
        type: "number"
        created_at: "2026-02-09T10:04:00Z"

    # Execution tracking
    context_reference:
      type: "slice"
      source: "retrieved_documents"
      size_tokens: 5000

    cost_tracking:
      input_tokens: 5000
      output_tokens: 1500
      total_cost_usd: 0.065
```

## Crash Recovery

### Recovery Protocol

When the system restarts after a crash, RLM scans the TaskStore for incomplete trees and resumes from the last checkpoint:

```
1. Scan TaskStore for incomplete RLM tasks
   └─> Filter: metadata.tree_id exists AND state != 'completed'

2. For each incomplete tree:
   a. Load all nodes in tree (by tree_id)
   b. Identify root node (depth = 0)
   c. Build tree structure from parent_id relationships

3. Identify completed vs incomplete branches:
   Completed:   state = 'completed'
   Incomplete:  state = 'queued' OR 'running' OR 'failed'

4. Resume execution:
   - Skip completed nodes (don't re-run)
   - Restart incomplete nodes from last checkpoint
   - Handle partial results (some children done, some not)
```

### Recovery Example

**Scenario**: Tree with 5 nodes crashes after nodes 1-3 complete:

```
Before Crash:
  Root (task-0001)     [completed]
  ├─ Child 1           [completed]
  ├─ Child 2           [completed]
  └─ Child 3           [running] ← CRASH HERE
     ├─ Child 3.1      [queued]
     └─ Child 3.2      [queued]

After Recovery:
  Root (task-0001)     [completed] ← SKIP
  ├─ Child 1           [completed] ← SKIP
  ├─ Child 2           [completed] ← SKIP
  └─ Child 3           [running]   ← RESUME HERE
     ├─ Child 3.1      [queued]    ← PENDING
     └─ Child 3.2      [queued]    ← PENDING
```

**Recovery code pattern**:

```javascript
async function recoverRLMTree(treeId) {
  const taskStore = new TaskStore('.aiwg/daemon/tasks.json');
  await taskStore.initialize();

  // 1. Find all tasks in this tree
  const treeTasks = taskStore.getTasks()
    .filter(t => t.metadata?.tree_id === treeId);

  if (treeTasks.length === 0) {
    throw new Error(`No tasks found for tree ${treeId}`);
  }

  // 2. Identify completed vs incomplete
  const completed = treeTasks.filter(t => t.state === 'completed');
  const incomplete = treeTasks.filter(t =>
    t.state === 'running' || t.state === 'queued' || t.state === 'failed'
  );

  console.log(`Recovery: ${completed.length} done, ${incomplete.length} pending`);

  // 3. Build tree structure
  const tree = buildTreeFromTasks(treeTasks);

  // 4. Resume from last incomplete node
  for (const task of incomplete) {
    if (task.state === 'running') {
      // Was running when crashed - restart
      await restartTask(task);
    } else if (task.state === 'failed') {
      // Failed before crash - retry
      await retryTask(task);
    }
    // 'queued' tasks will execute naturally
  }

  return tree;
}
```

### Handling Partial Results

When some children complete but others don't, RLM preserves partial results:

**Pattern 1: Parallel Decomposition**

```
Root: "Analyze 3 authentication files"
├─ Child 1: "Analyze auth.ts"      [completed] ← result saved
├─ Child 2: "Analyze login.ts"     [completed] ← result saved
└─ Child 3: "Analyze session.ts"   [failed]    ← needs retry

Recovery:
  - Load completed results from task-0002, task-0003
  - Retry only task-0004 (session.ts)
  - Merge all 3 results when complete
```

**Pattern 2: Sequential Decomposition**

```
Root: "Build authentication system"
├─ Child 1: "Design schema"        [completed] ← result saved
├─ Child 2: "Implement handlers"   [running]   ← CRASH HERE
└─ Child 3: "Write tests"          [queued]    ← blocked

Recovery:
  - Load completed result from task-0002
  - Resume task-0003 from checkpoint
  - task-0004 waits for task-0003 completion
```

### State Variable Recovery

RLM state variables are persisted in TaskStore metadata and restored on recovery:

```javascript
async function loadRLMState(taskId) {
  const task = taskStore.getTask(taskId);
  const rlmState = task.metadata?.rlm_state || {};

  // Restore variables
  const variables = {};
  for (const [name, varData] of Object.entries(rlmState)) {
    if (varData.type === 'file_path') {
      // Load large data from file
      const filePath = varData.value.replace('file:', '');
      variables[name] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } else {
      // Use inline value
      variables[name] = varData.value;
    }
  }

  return {
    Final: variables.Final || null,
    prompt: variables.prompt,
    ...variables
  };
}
```

## Progress Tracking

### Real-Time Progress Queries

Query TaskStore for live progress updates:

```javascript
function getTreeProgress(treeId) {
  const tasks = taskStore.getTasks()
    .filter(t => t.metadata?.tree_id === treeId);

  const completed = tasks.filter(t => t.state === 'completed').length;
  const failed = tasks.filter(t => t.state === 'failed').length;
  const running = tasks.filter(t => t.state === 'running').length;
  const queued = tasks.filter(t => t.state === 'queued').length;

  return {
    total: tasks.length,
    completed,
    failed,
    running,
    queued,
    percentage: (completed / tasks.length) * 100
  };
}
```

### ETA Estimation

Calculate ETA based on average node processing time:

```javascript
function estimateTreeETA(treeId) {
  const tasks = taskStore.getTasks()
    .filter(t => t.metadata?.tree_id === treeId);

  // Calculate average duration for completed tasks
  const completedTasks = tasks.filter(t =>
    t.state === 'completed' && t.startedAt && t.completedAt
  );

  const totalDuration = completedTasks.reduce((sum, t) => {
    const start = new Date(t.startedAt);
    const end = new Date(t.completedAt);
    return sum + (end - start);
  }, 0);

  const avgDurationMs = totalDuration / completedTasks.length;

  // Estimate remaining time
  const remaining = tasks.filter(t =>
    t.state === 'queued' || t.state === 'running'
  ).length;

  const etaMs = remaining * avgDurationMs;

  return {
    avgDurationMs,
    remainingTasks: remaining,
    etaMs,
    etaHuman: formatDuration(etaMs)
  };
}
```

### Progress Display

```
╭─────────────────────────────────────────────────────────╮
│ RLM Tree Progress                                       │
│ Tree: tree-12345678                                     │
├─────────────────────────────────────────────────────────┤
│ Total Nodes:     15                                     │
│ Completed:       10 (67%)                               │
│ Running:         2                                      │
│ Queued:          3                                      │
│ Failed:          0                                      │
│                                                         │
│ Progress: [██████████████▒▒▒▒▒▒] 67%                   │
│                                                         │
│ Avg Node Time:   45s                                    │
│ ETA:             ~2m 15s                                │
╰─────────────────────────────────────────────────────────╯
```

## REPL Variable Persistence

### Variable Storage Scoping

RLM state variables (from REF-089) are scoped and stored per the `rlm-state.yaml` schema:

| Scope | Storage Location | Use Case |
|-------|------------------|----------|
| **Global** | `.aiwg/rlm/global-state.json` | Configuration settings, persistent cache |
| **Session** | `.aiwg/rlm/sessions/{session_id}/state.json` | User context, session preferences |
| **Tree** | TaskStore `metadata.rlm_state` + `.aiwg/rlm/trees/{tree_id}/state.json` | Task-specific data, intermediate results |
| **Temporary** | `.aiwg/rlm/temp/{state_id}/state.json` | Transient computations, TTL cache |

### Variable Persistence Patterns

**Pattern 1: Inline Storage (Small Values)**

Variables under 10KB stored directly in TaskStore metadata:

```javascript
function persistVariable(taskId, name, value) {
  const task = taskStore.getTask(taskId);

  if (!task.metadata.rlm_state) {
    task.metadata.rlm_state = {};
  }

  task.metadata.rlm_state[name] = {
    name,
    value,
    type: typeof value,
    created_at: new Date().toISOString()
  };

  taskStore.updateTask(taskId, task);
}
```

**Pattern 2: File Reference (Large Values)**

Variables over 10KB stored in separate files, referenced in metadata:

```javascript
function persistLargeVariable(taskId, name, value) {
  const task = taskStore.getTask(taskId);
  const treeId = task.metadata.tree_id;

  // Write value to file
  const varFilePath = `.aiwg/rlm/trees/${treeId}/variables/${name}.json`;
  fs.writeFileSync(varFilePath, JSON.stringify(value, null, 2));

  // Store file reference in metadata
  task.metadata.rlm_state[name] = {
    name,
    value: `file:${varFilePath}`,
    type: 'file_path',
    created_at: new Date().toISOString()
  };

  taskStore.updateTask(taskId, task);
}
```

**Pattern 3: Cross-Node Variable Access**

Child tasks can read parent variables via TaskStore traversal:

```javascript
function readParentVariable(taskId, varName) {
  const task = taskStore.getTask(taskId);
  const parentId = task.metadata.parent_id;

  if (!parentId) {
    throw new Error('No parent task');
  }

  const parent = taskStore.getTask(parentId);
  const varData = parent.metadata.rlm_state[varName];

  if (!varData) {
    throw new Error(`Variable ${varName} not found in parent`);
  }

  // Load from file if needed
  if (varData.type === 'file_path') {
    const filePath = varData.value.replace('file:', '');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  return varData.value;
}
```

### Checkpoint/Rollback via State Snapshots

Create checkpoints by snapshotting entire RLM state:

```javascript
async function createStateCheckpoint(taskId, checkpointName) {
  const task = taskStore.getTask(taskId);
  const treeId = task.metadata.tree_id;

  const checkpointId = `ckpt-${Date.now()}`;
  const snapshotPath = `.aiwg/rlm/trees/${treeId}/checkpoints/${checkpointId}.json`;

  // Snapshot current state
  const snapshot = {
    checkpoint_id: checkpointId,
    name: checkpointName,
    timestamp: new Date().toISOString(),
    task_id: taskId,
    state: task.metadata.rlm_state
  };

  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  // Record checkpoint in task metadata
  if (!task.metadata.checkpoints) {
    task.metadata.checkpoints = [];
  }

  task.metadata.checkpoints.push({
    checkpoint_id: checkpointId,
    name: checkpointName,
    snapshot_path: snapshotPath
  });

  taskStore.updateTask(taskId, task);

  return checkpointId;
}

async function rollbackToCheckpoint(taskId, checkpointId) {
  const task = taskStore.getTask(taskId);
  const checkpoint = task.metadata.checkpoints.find(c =>
    c.checkpoint_id === checkpointId
  );

  if (!checkpoint) {
    throw new Error(`Checkpoint ${checkpointId} not found`);
  }

  // Load checkpoint snapshot
  const snapshot = JSON.parse(
    fs.readFileSync(checkpoint.snapshot_path, 'utf8')
  );

  // Restore state
  task.metadata.rlm_state = snapshot.state;

  taskStore.updateTask(taskId, task);
}
```

## Storage Layout

### Directory Structure

```
.aiwg/
├── daemon/
│   └── tasks.json                        # TaskStore main file (all tasks)
│
└── rlm/
    ├── global-state.json                 # Global scope variables
    │
    ├── sessions/
    │   └── {session_id}/
    │       └── state.json                # Session-scoped state
    │
    ├── trees/
    │   └── {tree_id}/
    │       ├── state.json                # Tree state summary
    │       ├── tree.json                 # Full tree structure
    │       ├── nodes/
    │       │   └── {node_id}.json        # Individual node snapshots
    │       ├── variables/
    │       │   ├── var1.json             # Large variable files
    │       │   └── var2.json
    │       ├── checkpoints/
    │       │   ├── ckpt-001.json         # State checkpoints
    │       │   └── ckpt-002.json
    │       └── report.md                 # Human-readable tree report
    │
    └── temp/
        └── {state_id}/
            └── state.json                # Temporary variables (TTL)
```

### File Format and Naming Conventions

**TaskStore main file** (`.aiwg/daemon/tasks.json`):

```json
{
  "version": 1,
  "updatedAt": "2026-02-09T10:30:00Z",
  "tasks": [
    {
      "id": "task-0001",
      "prompt": "Analyze security risks",
      "state": "completed",
      "metadata": {
        "tree_id": "tree-12345678",
        "node_id": "task-a1b2c3d4",
        "rlm_state": { ... }
      }
    }
  ]
}
```

**RLM tree file** (`.aiwg/rlm/trees/{tree_id}/tree.json`):

```json
{
  "version": "1.0.0",
  "tree_id": "tree-12345678",
  "root_task": {
    "node_id": "task-a1b2c3d4",
    "prompt": "...",
    "children": [ ... ]
  },
  "metadata": {
    "total_nodes": 5,
    "completed_nodes": 3,
    "total_cost_usd": 0.15
  }
}
```

### Cleanup and Retention Policies

**Default retention**:

| Data Type | Retention | Cleanup Trigger |
|-----------|-----------|-----------------|
| Completed tasks | 7 days | TaskStore.cleanup() |
| Failed tasks | 30 days | Manual review |
| Tree state | Until tree complete + 7 days | Auto-cleanup |
| Checkpoints | Keep last 10 per tree | LRU eviction |
| Temporary variables | TTL (configurable) | TTL expiry |

**Cleanup implementation**:

```javascript
async function cleanupRLMStorage() {
  const taskStore = new TaskStore('.aiwg/daemon/tasks.json');
  await taskStore.initialize();

  // 1. Clean old completed tasks
  const removed = taskStore.cleanup(7 * 24 * 60 * 60 * 1000); // 7 days
  console.log(`Removed ${removed} old tasks`);

  // 2. Clean completed trees
  const rlmDir = '.aiwg/rlm/trees';
  const trees = fs.readdirSync(rlmDir);

  for (const treeId of trees) {
    const treeFile = path.join(rlmDir, treeId, 'tree.json');
    if (!fs.existsSync(treeFile)) continue;

    const tree = JSON.parse(fs.readFileSync(treeFile, 'utf8'));

    // Check if tree is old and complete
    if (tree.metadata?.completed_at) {
      const completedAt = new Date(tree.metadata.completed_at);
      const age = Date.now() - completedAt.getTime();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

      if (age > maxAge) {
        fs.rmSync(path.join(rlmDir, treeId), { recursive: true });
        console.log(`Removed old tree ${treeId}`);
      }
    }
  }

  // 3. Clean temporary variables
  const tempDir = '.aiwg/rlm/temp';
  if (fs.existsSync(tempDir)) {
    const tempStates = fs.readdirSync(tempDir);

    for (const stateId of tempStates) {
      const stateFile = path.join(tempDir, stateId, 'state.json');
      if (!fs.existsSync(stateFile)) continue;

      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

      // Check TTL expiry
      for (const [name, varData] of Object.entries(state.variables)) {
        if (varData.metadata?.ttl_seconds) {
          const created = new Date(varData.created_at);
          const age = (Date.now() - created.getTime()) / 1000;

          if (age > varData.metadata.ttl_seconds) {
            delete state.variables[name];
            console.log(`Expired temp variable ${name}`);
          }
        }
      }

      // Remove state if all variables expired
      if (Object.keys(state.variables).length === 0) {
        fs.rmSync(path.join(tempDir, stateId), { recursive: true });
      }
    }
  }
}
```

## Integration Patterns

### RLM Operation → TaskStore Update Flow

**Sequence diagram** (text-based):

```
User          RLM           TaskStore      Filesystem
 |             |                |              |
 |--execute--->|                |              |
 |             |--createTask--->|              |
 |             |                |--persist---->|
 |             |<--task-id------|              |
 |             |                |              |
 |--decompose->|                |              |
 |             |--createTask--->| (child 1)    |
 |             |--createTask--->| (child 2)    |
 |             |                |--persist---->|
 |             |                |              |
 |--complete-->|                |              |
 |             |--updateTask--->|              |
 |             |  (state='completed')          |
 |             |                |--persist---->|
 |             |                |              |
```

**Code example**:

```javascript
class RLMExecutor {
  constructor(taskStore) {
    this.taskStore = taskStore;
  }

  async execute(prompt, treeId = null) {
    // 1. Create root task in TaskStore
    const rootTask = this.taskStore.createTask({
      prompt,
      agent: 'rlm-executor',
      metadata: {
        tree_id: treeId || `tree-${generateId()}`,
        node_id: `task-${generateId()}`,
        parent_id: null,
        depth: 0,
        rlm_state: {
          Final: { name: 'Final', value: null, type: 'null' },
          prompt: { name: 'prompt', value: prompt, type: 'text' }
        }
      }
    });

    // 2. Start execution
    this.taskStore.startTask(rootTask.id, process.pid);

    // 3. Execute (may spawn children)
    const result = await this.executeNode(rootTask);

    // 4. Mark complete
    this.taskStore.completeTask(rootTask.id, result);

    return result;
  }

  async executeNode(task) {
    // Check if decomposition needed
    if (this.shouldDecompose(task)) {
      const children = await this.decompose(task);

      // Create child tasks in TaskStore
      for (const childPrompt of children) {
        const childTask = this.taskStore.createTask({
          prompt: childPrompt,
          agent: 'rlm-executor',
          metadata: {
            tree_id: task.metadata.tree_id,
            node_id: `task-${generateId()}`,
            parent_id: task.id,
            depth: task.metadata.depth + 1
          }
        });

        // Execute child
        await this.executeNode(childTask);
      }

      // Merge results
      return await this.mergeResults(task);
    }

    // Leaf node - execute directly
    return await this.invokeModel(task.prompt);
  }
}
```

### rlm-status Command Integration

The `rlm-status` command queries TaskStore for display:

```javascript
async function rlmStatus(treeId) {
  const taskStore = new TaskStore('.aiwg/daemon/tasks.json');
  await taskStore.initialize();

  // Query all tasks in tree
  const tasks = taskStore.getTasks()
    .filter(t => t.metadata?.tree_id === treeId);

  if (tasks.length === 0) {
    console.log(`No tasks found for tree ${treeId}`);
    return;
  }

  // Calculate stats
  const stats = {
    total: tasks.length,
    completed: tasks.filter(t => t.state === 'completed').length,
    running: tasks.filter(t => t.state === 'running').length,
    queued: tasks.filter(t => t.state === 'queued').length,
    failed: tasks.filter(t => t.state === 'failed').length
  };

  // Calculate cost
  const totalCost = tasks.reduce((sum, t) =>
    sum + (t.metadata?.cost_tracking?.total_cost_usd || 0), 0
  );

  // Display
  console.log(`
╭─────────────────────────────────────────────────────────╮
│ RLM Tree Status: ${treeId}                     │
├─────────────────────────────────────────────────────────┤
│ Total Nodes:     ${stats.total}                         │
│ Completed:       ${stats.completed} (${Math.round(stats.completed/stats.total*100)}%)  │
│ Running:         ${stats.running}                       │
│ Queued:          ${stats.queued}                        │
│ Failed:          ${stats.failed}                        │
│                                                         │
│ Total Cost:      $${totalCost.toFixed(4)}              │
╰─────────────────────────────────────────────────────────╯
  `);

  // Show active tasks
  const activeTasks = tasks.filter(t => t.state === 'running');
  if (activeTasks.length > 0) {
    console.log('\nActive Tasks:');
    for (const task of activeTasks) {
      console.log(`  - ${task.id}: ${task.prompt.slice(0, 60)}...`);
    }
  }
}
```

### Event Flow: Operation → Update → Status

```
RLM Operation          Event              TaskStore          Status Display
──────────────        ──────            ──────────           ──────────────
execute()       →  task.created   →  createTask()      →  rlm-status shows "queued"
                                       |
                                       ├─ persist to disk
                                       └─ emit 'task:created'

start()         →  task.started   →  startTask()       →  rlm-status shows "running"
                                       |
                                       ├─ persist to disk
                                       └─ emit 'task:started'

spawn_child()   →  task.created   →  createTask()      →  rlm-status shows child
                                       |
                                       └─ metadata.parent_id set

complete()      →  task.completed →  completeTask()    →  rlm-status shows progress++
                                       |
                                       ├─ persist to disk
                                       └─ emit 'task:completed'

fail()          →  task.failed    →  failTask()        →  rlm-status shows "failed"
                                       |
                                       └─ error stored
```

## Limitations and Considerations

### JSON File Store Limitations

**Problem**: TaskStore uses a single JSON file (`.aiwg/daemon/tasks.json`) for all tasks.

| Limitation | Impact | Threshold |
|------------|--------|-----------|
| File size growth | Slower read/write with many tasks | >1000 tasks |
| Parse time | JSON.parse() blocks event loop | >10MB file |
| Memory usage | Entire file loaded into memory | Limited by available RAM |
| Atomic writes | File corruption risk on crash during write | Any size |

**Mitigations**:

1. **Regular cleanup**: Run `taskStore.cleanup()` to remove old completed tasks
2. **Tree separation**: Store completed trees separately (`.aiwg/rlm/trees/{tree_id}/`)
3. **Incremental writes**: Batch updates to reduce write frequency
4. **Backup strategy**: Keep `.aiwg/daemon/tasks.json.bak` on each write

**Future considerations**:

- Migrate to SQLite for large deployments (>1000 concurrent tasks)
- Implement indexed storage for faster queries
- Add streaming JSON parser for very large files

### Concurrent Access Considerations

**Problem**: Multiple RLM operations may access TaskStore simultaneously.

**Current behavior**:
- TaskStore uses in-memory Map + periodic file sync
- No file locking mechanism
- Last write wins on persist

**Risks**:

```
Process A                          Process B
─────────                          ─────────
taskStore.createTask(...)
  → tasks.set('task-0001', ...)
                                  taskStore.createTask(...)
                                    → tasks.set('task-0002', ...)
taskStore._persist()
  → writes tasks.json
                                  taskStore._persist()
                                    → OVERWRITES tasks.json
                                    → task-0001 LOST
```

**Mitigations**:

1. **Single daemon process**: Run all RLM operations through one daemon
2. **IPC coordination**: Use IPC server to serialize TaskStore access
3. **Optimistic locking**: Add version field to detect concurrent writes
4. **File locking**: Implement flock() for exclusive access

**Recommended pattern** (daemon mode):

```
RLM Executor 1                   Daemon                TaskStore
──────────────                   ──────                ─────────
execute() ──────IPC request─────>│
                                 │──createTask()─────>│
                                 │<─────task─────────│
<───────────IPC response────────│

RLM Executor 2
──────────────
execute() ──────IPC request─────>│
                                 │──createTask()─────>│
                                 │<─────task─────────│
<───────────IPC response────────│

All TaskStore operations serialized through daemon
```

### Storage Size Growth with Deep Recursion

**Problem**: Deep trees generate many TaskStore records.

**Storage calculation**:

```
Tree depth: 5 levels
Branching factor: 3 children per node
Total nodes: 1 + 3 + 9 + 27 + 81 = 121 nodes

TaskStore size per node: ~1-2KB
Total TaskStore size: 121 * 1.5KB = ~180KB

With RLM state (large variables):
State per node: ~10-50KB (if file references)
Total state: 121 * 30KB = ~3.6MB
```

**Growth patterns**:

| Tree Type | Nodes | TaskStore Size | State Size | Total |
|-----------|-------|----------------|------------|-------|
| Shallow (depth 2, fan 3) | 13 | ~20KB | ~400KB | ~420KB |
| Moderate (depth 3, fan 3) | 40 | ~60KB | ~1.2MB | ~1.3MB |
| Deep (depth 5, fan 3) | 121 | ~180KB | ~3.6MB | ~3.8MB |
| Wide (depth 2, fan 10) | 111 | ~165KB | ~3.3MB | ~3.5MB |

**Limits**:

- **Soft limit**: 100 nodes per tree (configurable via `rlm-task-tree.yaml`)
- **Hard limit**: 1000 tasks total in TaskStore
- **Cleanup**: Auto-delete trees older than 7 days

**Best practices**:

1. **Limit tree depth**: Keep depth ≤ 5 levels
2. **Limit branching**: Keep children per node ≤ 10
3. **Use file references**: Store large data outside TaskStore metadata
4. **Regular cleanup**: Remove old completed trees

## Summary

The RLM-TaskStore integration provides:

✓ **Persistent storage** for recursive task trees
✓ **Crash recovery** by resuming from last checkpoint
✓ **Progress tracking** via real-time TaskStore queries
✓ **REPL variable persistence** with scoped storage
✓ **Event-driven updates** for status monitoring

**Key patterns**:

1. **One TaskStore record per tree node** - hierarchical via `parent_id`
2. **State in metadata** - RLM variables serialized in `metadata.rlm_state`
3. **Recovery from incomplete trees** - skip completed, resume incomplete
4. **File references for large data** - avoid bloating TaskStore JSON
5. **Cleanup for long-term stability** - remove old completed trees

## References

- @$AIWG_ROOT/tools/daemon/task-store.mjs - TaskStore implementation
- @$AIWG_ROOT/agentic/code/addons/rlm/schemas/rlm-state.yaml - RLM state schema
- @$AIWG_ROOT/agentic/code/addons/rlm/schemas/rlm-task-tree.yaml - Task tree schema
- @.aiwg/requirements/use-cases/UC-IPC-002.md - TaskStore requirements
- @.aiwg/research/findings/REF-089-rlm.md - RLM research foundation
- @test/unit/daemon/task-store.test.js - TaskStore test suite
- @$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/checkpoint.yaml - Checkpoint patterns
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/error-handling.yaml - Error recovery
