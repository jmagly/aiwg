# Cross-Loop Learning Guide

Pattern sharing and knowledge transfer across multiple agent loops.

**Research Foundation**: REF-013 MetaGPT - 159% improvement with shared state

**Issue**: #269

---

## Overview

Cross-loop learning enables agent loops to learn from each other by sharing patterns discovered during task execution. When a loop encounters an error and finds a successful fix, that error→fix pattern is stored in a shared registry. Future loops encountering similar errors can automatically apply proven fixes, dramatically reducing iteration counts.

### Key Benefits

| Benefit | Impact |
|---------|--------|
| **Faster resolution** | Patterns eliminate redundant debugging |
| **Higher success rates** | Proven approaches applied automatically |
| **Accumulated wisdom** | System gets smarter over time |
| **Anti-pattern detection** | Failed approaches are flagged and avoided |

### Research Basis

From REF-013 MetaGPT:
- **159% improvement** with shared state across agents
- **Publish-subscribe pattern** enables decentralized knowledge sharing
- **Structured outputs** from one agent become inputs for others
- **Memory persistence** critical for multi-session learning

---

## Pattern Types

### 1. Error Patterns

**Definition**: Error signature → successful fix mappings

**Example**:
```yaml
pattern_id: "pat-error-null-check-001"
error_signature:
  error_type: "TypeError"
  error_pattern: "Cannot read property '.*' of null"
fix_approach:
  description: "Add null check before property access"
  code_template: |
    if ({{variable}} != null) {
      const value = {{variable}}.{{property}};
    }
success_rate: 0.92
usage_count: 12
```

**When Applied**: Loop encounters error matching signature

### 2. Success Patterns

**Definition**: Task category → successful approach mappings

**Example**:
```yaml
pattern_id: "pat-success-test-generation-001"
task_category: "testing"
approach:
  description: "Test-driven generation approach"
  steps:
    - "Analyze function signature"
    - "Identify edge cases"
    - "Generate tests first"
    - "Implement to pass tests"
success_rate: 0.88
average_iterations: 2.5
```

**When Applied**: Loop starts with task matching category

### 3. Anti-Patterns

**Definition**: Approaches that consistently fail

**Example**:
```yaml
pattern_id: "pat-anti-premature-optimization-001"
approach_description: "Optimizing before tests pass"
failure_mode: "scope_creep"
failure_rate: 0.85
better_alternative:
  description: "Complete primary task first"
  success_pattern_id: "pat-success-refactor-module-002"
```

**When Applied**: Loop attempts approach matching anti-pattern signature

### 4. Code Templates

**Definition**: Reusable code snippets from successful implementations

**Example**:
```yaml
template_id: "tmpl-async-error-handler-001"
language: "typescript"
template_code: |
  try {
    const result = await {{async_function}}({{args}});
    return result;
  } catch (error) {
    logger.error("{{operation}} failed", error);
    throw new {{ErrorClass}}("{{message}}", { cause: error });
  }
success_rate: 0.95
usage_count: 18
```

**When Applied**: Loop generates code matching template use case

---

## Pattern Lifecycle

### 1. Pattern Extraction

**Trigger**: Agent loop completion

**Process**:
1. **Analyze loop history** - Review all iterations
2. **Identify error→fix pairs** - Extract successful resolutions
3. **Identify successful approaches** - Note winning strategies
4. **Identify failure patterns** - Flag repeated dead ends
5. **Check for duplicates** - Merge similar patterns
6. **Compute effectiveness** - Calculate success rates
7. **Store in registry** - Add to shared patterns
8. **Update metrics** - Track cross-loop effectiveness

**Storage**:
```
.aiwg/ralph/shared/patterns/
├── error-patterns.json
├── success-patterns.json
├── anti-patterns.json
└── code-templates.json
```

**Example Extraction**:
```
Loop: ralph-fix-auth-a1b2c3d4
Iteration 2: Error "Cannot read property 'email' of null"
Iteration 3: Applied fix "Add null check for user object"
Result: Tests passed

→ Extract error pattern:
  - Error: "Cannot read property '.*' of null"
  - Fix: "Add null check before property access"
  - Success rate: 1.0 (first occurrence)
  - Source: ralph-fix-auth-a1b2c3d4
```

### 2. Pattern Injection

**Trigger**: Agent loop start

**Process**:
1. **Analyze task description** - Extract key terms
2. **Search error patterns** - Find relevant error→fix pairs
3. **Search success patterns** - Find approaches for task category
4. **Filter by effectiveness** - Min success rate 0.6
5. **Sort by relevance** - Highest success rate first
6. **Inject top-k patterns** - Add to loop context (k=5 default)
7. **Track pattern usage** - Log which patterns were injected

**Injection Context**:
```markdown
## Cross-Loop Learning Context

The following patterns were learned from previous loops:

### Error Patterns (from similar tasks)
1. **TypeError: null property access** (92% success rate, used 12 times)
   - Fix: Add null checks before property access
   - Template: if (obj != null) { ... }
   - Source loops: ralph-fix-auth-a1b2c3d4, ralph-fix-validation-b2c3d4e5

2. **AssertionError: expected true got false** (85% success rate, used 8 times)
   - Fix: Check async timing - add await
   - Source loops: ralph-fix-tests-c3d4e5f6

### Success Patterns (for testing tasks)
1. **Test-driven generation** (88% success rate, avg 2.5 iterations)
   - Generate tests first, then implement
   - Typical steps: analyze signature → edge cases → happy path → errors
   - Source loops: 8 successful completions

### Anti-Patterns to Avoid
1. **Premature optimization** (85% failure rate)
   - Complete primary task before optimizing
   - Symptoms: scope creep, increasing iterations without progress
```

**Configuration**:
```yaml
pattern_injection:
  top_k_patterns: 5
  min_success_rate: 0.6
  max_patterns_injected: 10
  include_anti_patterns: true
```

### 3. Pattern Evolution

Patterns improve over time through continuous use:

**Success Rate Updates**:
```
Pattern: pat-error-null-check-001
Initial: 1.0 (1/1 applications)
After 5 uses: 0.80 (4/5 applications)
After 12 uses: 0.92 (11/12 applications)

→ Pattern stabilizes around 0.92 success rate
```

**Effectiveness Trending**:
```yaml
effectiveness_trend:
  - timestamp: "2026-02-01T10:00:00Z"
    success_rate_snapshot: 1.0
    sample_size: 1
  - timestamp: "2026-02-01T14:00:00Z"
    success_rate_snapshot: 0.80
    sample_size: 5
  - timestamp: "2026-02-02T15:00:00Z"
    success_rate_snapshot: 0.92
    sample_size: 12
```

**Pattern Pruning**:

Patterns are automatically pruned when:
- Success rate < 0.5 after ≥3 uses
- Unused for >90 days
- Superseded by better pattern

Pruned patterns are archived, not deleted:
```
.aiwg/ralph/shared/archive/
├── 2026-01-patterns.json
└── 2026-02-patterns.json
```

---

## Pattern Effectiveness Measurement

### Metrics Tracked

| Metric | Purpose |
|--------|---------|
| `total_patterns` | Size of pattern registry |
| `total_applications` | How often patterns are used |
| `successful_applications` | How often they help |
| `overall_success_rate` | Average effectiveness |
| `loops_with_pattern_injection` | Loops using patterns |
| `loops_without_pattern_injection` | Baseline loops |
| `average_iterations_with` | Iterations with patterns |
| `average_iterations_without` | Iterations without patterns |
| `improvement_percentage` | % reduction in iterations |

### Expected Impact

Based on REF-013 MetaGPT research:

| Condition | Expected Iterations | Expected Success Rate |
|-----------|---------------------|----------------------|
| No pattern injection | Baseline | Baseline |
| With pattern injection | **-40% iterations** | **+159% quality** |

**Example**:
```
Task: Fix TypeScript errors in module

Without patterns:
- Iterations: 8
- Time: 45 minutes
- Success: Partial (some errors remain)

With patterns:
- Iterations: 5 (-37.5%)
- Time: 28 minutes (-38%)
- Success: Complete (all errors fixed)
- Applied patterns:
  - pat-error-type-mismatch-003 (3 times)
  - pat-error-missing-import-007 (2 times)
```

### Effectiveness Report

Generated after each loop completion:

```markdown
## Pattern Effectiveness Report
**Loop**: ralph-fix-ts-errors-f7g8h9i0
**Task**: Fix TypeScript errors

### Patterns Injected
- pat-error-type-mismatch-003 (applied 3 times, 100% success)
- pat-error-missing-import-007 (applied 2 times, 100% success)
- pat-success-type-fixing-002 (used as guidance, effective)

### Impact
- Iterations: 5 (baseline estimate: 8)
- Time saved: ~17 minutes
- Errors fixed: 12/12 (100%)

### New Patterns Discovered
1. **pat-error-interface-mismatch-015** (new)
   - Error: "Property 'x' does not exist on type 'Y'"
   - Fix: Add property to interface definition
   - Success: 1/1 applications

### Updated Patterns
- pat-error-type-mismatch-003:
  - Usage: 15 → 18 (+3)
  - Success rate: 0.93 → 0.94 (+0.01)
```

---

## Integration with Cross-Task Memory

Patterns are stored alongside cross-task memory for semantic retrieval:

```
.aiwg/ralph/memory/
├── task-index.json           # Semantic index of all tasks
├── embeddings/               # Task embeddings for similarity
├── reflections/              # Reflexion-style reflections
└── patterns/
    ├── error-patterns.json
    ├── success-patterns.json
    ├── anti-patterns.json
    └── code-templates.json
```

### Semantic Pattern Retrieval

When starting a loop, patterns are retrieved using:

1. **Task embedding similarity** - Find tasks similar to current task
2. **Error signature matching** - Find patterns for expected error types
3. **Category matching** - Find patterns for task category (testing, refactoring, etc.)

**Example**:
```
Current task: "Add authentication to user module"

Semantic retrieval:
1. Similar tasks:
   - "Implement auth for admin panel" (similarity: 0.87)
   - "Add login validation" (similarity: 0.82)

2. Retrieved patterns:
   - pat-success-auth-implementation-004 (from similar task)
   - pat-error-jwt-validation-009 (common in auth tasks)
   - tmpl-password-hashing-003 (code template)

3. Injected into context with relevance scores
```

---

## CLI Usage

### List Patterns

```bash
# List all patterns
aiwg ralph-patterns list

# Filter by type
aiwg ralph-patterns list --type error
aiwg ralph-patterns list --type success
aiwg ralph-patterns list --type anti

# Filter by success rate
aiwg ralph-patterns list --min-success-rate 0.8

# Filter by tags
aiwg ralph-patterns list --tag typescript --tag null-safety
```

**Output**:
```
Error Patterns (12 total):
1. pat-error-null-check-001 (92% success, 12 uses)
   TypeError: Cannot read property of null
   → Add null check before access

2. pat-error-type-mismatch-003 (94% success, 18 uses)
   TypeError: Type 'X' not assignable to 'Y'
   → Update interface definition or cast

Success Patterns (8 total):
1. pat-success-test-generation-001 (88% success, avg 2.5 iter)
   Task: Testing
   → Test-driven generation approach

Anti-Patterns (4 total):
1. pat-anti-premature-optimization-001 (85% failure)
   Optimizing before tests pass
   → Complete primary task first
```

### Show Pattern Details

```bash
aiwg ralph-patterns show pat-error-null-check-001
```

**Output**:
```yaml
Pattern: pat-error-null-check-001
Type: Error Pattern
Created: 2026-02-01T10:00:00Z
Last Used: 2026-02-02T15:00:00Z

Error Signature:
  Type: TypeError
  Pattern: "Cannot read property '.*' of null"
  Common Locations:
    - *.ts:validateInput
    - *.ts:processData

Fix Approach:
  Description: Add null check before property access
  Category: add_null_check
  Template: |
    if ({{variable}} != null) {
      const value = {{variable}}.{{property}};
    }

Effectiveness:
  Success Rate: 92% (11/12 applications)
  Usage Count: 12
  Average Impact: -2.3 iterations

Source Loops:
  - ralph-fix-auth-a1b2c3d4 (2026-02-01)
  - ralph-fix-validation-b2c3d4e5 (2026-02-02)
  - [+ 10 more]

Tags: typescript, null-safety, defensive-programming
```

### Prune Patterns

```bash
# Dry run to see what would be pruned
aiwg ralph-patterns prune --dry-run

# Prune patterns below threshold
aiwg ralph-patterns prune --min-success-rate 0.6

# Prune patterns unused for 90 days
aiwg ralph-patterns prune --max-age-days 90
```

### Export/Import Patterns

```bash
# Export all patterns
aiwg ralph-patterns export --output patterns-backup.json

# Import patterns from file
aiwg ralph-patterns import --input patterns-backup.json

# Share patterns across teams
aiwg ralph-patterns export --team-shared patterns-team.json
```

---

## Configuration

### Pattern Extraction Config

```yaml
# In aiwg.yml or .aiwg/config.yml
ralph:
  cross_loop_learning:
    enabled: true
    extraction:
      min_success_rate_threshold: 0.6
      min_usage_count_for_evaluation: 3
      auto_extract_on_completion: true
      extract_code_templates: true
```

### Pattern Injection Config

```yaml
ralph:
  cross_loop_learning:
    injection:
      enabled: true
      top_k_patterns: 5
      min_success_rate: 0.6
      max_patterns_injected: 10
      include_error_patterns: true
      include_success_patterns: true
      include_anti_patterns: true
      include_code_templates: true
```

### Pruning Config

```yaml
ralph:
  cross_loop_learning:
    pruning:
      auto_prune: true
      prune_interval_days: 7
      min_success_rate: 0.5
      max_age_days: 90
      archive_instead_of_delete: true
```

---

## Best Practices

### 1. Let Patterns Stabilize

Don't prune patterns too early. Allow at least 5-10 uses before evaluating effectiveness.

**Good**:
```
Pattern with 1 use at 100%: Keep, needs more data
Pattern with 10 uses at 45%: Consider pruning
```

### 2. Tag Patterns Thoughtfully

Use consistent, searchable tags:

**Good tags**:
- Language: `typescript`, `python`, `go`
- Domain: `auth`, `validation`, `testing`
- Pattern type: `null-safety`, `async-handling`, `error-recovery`

**Poor tags**:
- Too vague: `good`, `important`, `common`
- Too specific: `fixed-in-ralph-loop-123`

### 3. Update Templates with Context

When creating code templates, include usage notes:

```yaml
template_id: "tmpl-async-error-handler-001"
template_code: |
  try {
    const result = await {{async_function}}({{args}});
    return result;
  } catch (error) {
    logger.error("{{operation}} failed", error);
    throw new {{ErrorClass}}("{{message}}", { cause: error });
  }
use_case: "Wrapping async operations with proper error handling"
placeholders:
  async_function: "The async function to call"
  args: "Arguments to pass"
  operation: "Human-readable operation name for logging"
  ErrorClass: "Custom error class (e.g., ValidationError)"
  message: "User-facing error message"
```

### 4. Monitor Anti-Pattern Growth

If anti-patterns accumulate, it indicates systematic issues:

**Warning signs**:
- Same anti-pattern occurring in multiple loops
- Anti-patterns with high occurrence counts
- Patterns with very high failure rates (>90%)

**Action**: Investigate root cause and update documentation/training.

### 5. Export Patterns Periodically

Patterns are valuable knowledge - back them up:

```bash
# Weekly backup
aiwg ralph-patterns export --output backups/patterns-$(date +%Y-%m-%d).json

# Team sharing
aiwg ralph-patterns export --team-shared team-patterns.json
```

---

## Troubleshooting

### Pattern Not Injected

**Symptom**: Loop doesn't receive relevant patterns

**Causes**:
1. Pattern below success rate threshold (default 0.6)
2. Task description doesn't match pattern semantically
3. Pattern injection disabled in config
4. Pattern recently pruned

**Fix**:
```bash
# Check pattern details
aiwg ralph-patterns show {pattern_id}

# Lower threshold temporarily
aiwg ralph "task" --min-pattern-success-rate 0.5

# Re-enable injection
# In aiwg.yml:
ralph:
  cross_loop_learning:
    injection:
      enabled: true
```

### Pattern Over-Application

**Symptom**: Same pattern applied too often, causing repetitive fixes

**Causes**:
1. Pattern too broad (matches many scenarios)
2. Success rate artificially high from small sample
3. Loop not detecting when pattern doesn't apply

**Fix**:
- Refine pattern signature to be more specific
- Increase min usage count before trusting pattern
- Add preconditions to pattern

### Patterns Not Extracting

**Symptom**: Loops complete but no new patterns added

**Causes**:
1. Auto-extraction disabled
2. Loop didn't succeed (patterns only extracted from successful loops)
3. Patterns duplicate existing ones

**Fix**:
```yaml
# Enable auto-extraction
ralph:
  cross_loop_learning:
    extraction:
      auto_extract_on_completion: true

# Check loop outcome
aiwg ralph-status {loop_id}
```

---

## Examples

### Example 1: Error Pattern Prevents Re-Work

**Scenario**: Two loops fixing similar TypeScript errors

**Loop 1** (without pattern):
```
ralph-fix-types-a1b2c3d4
Iteration 1: Error "Type 'string | undefined' not assignable to 'string'"
Iteration 2: Applied fix "Added ? operator to interface"
Iteration 3: Tests pass
Result: Success, 3 iterations

→ Pattern extracted:
   pat-error-optional-types-008
   Error: "Type 'X | undefined' not assignable to 'X'"
   Fix: "Add ? to interface property or use non-null assertion"
```

**Loop 2** (with pattern):
```
ralph-fix-types-b2c3d4e5
Iteration 1: Error "Type 'number | undefined' not assignable to 'number'"
→ Pattern matched: pat-error-optional-types-008
→ Auto-applied fix: "Add ? to interface property"
Iteration 2: Tests pass
Result: Success, 2 iterations (33% faster)
```

### Example 2: Success Pattern Guides Approach

**Scenario**: Test generation task

**Loop** (with success pattern):
```
ralph-add-tests-c3d4e5f6

Injected pattern: pat-success-test-generation-001
  - Approach: Test-driven (generate tests first)
  - Avg iterations: 2.5
  - Success rate: 88%

Iteration 1: Generate test cases for validateEmail()
  - Happy path: valid email formats
  - Error cases: invalid formats, null, undefined
  Tests written, currently failing (expected)

Iteration 2: Implement validateEmail() to pass tests
  Tests pass: 8/8
Result: Success, 2 iterations (aligned with pattern average)
```

### Example 3: Anti-Pattern Avoided

**Scenario**: Refactoring task

**Loop** (with anti-pattern warning):
```
ralph-refactor-auth-d4e5f6a7

Injected anti-pattern: pat-anti-premature-optimization-001
  Warning: Avoid optimizing before tests pass
  Better alternative: pat-success-refactor-module-002

Iteration 1: Refactor auth module structure
Iteration 2: Tests pass
→ Check: Should I optimize now?
→ Anti-pattern reminder: Complete primary task first
→ Decision: Mark complete, optimization not requested

Result: Success, 2 iterations (anti-pattern prevented scope creep)
```

---

## Related Documentation

- `/ralph` - Main agent loop command
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/shared-patterns.yaml` - Pattern schema
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/cross-task-memory.yaml` - Cross-task memory
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/docs/best-practices.md` - General Al best practices
- `.aiwg/research/paper-analysis/REF-013-aiwg-analysis.md` - MetaGPT research analysis

---

## Research Foundation

**REF-013 MetaGPT: Meta Programming for Multi-Agent Collaborative Framework**

Key findings applied:
- **Publish-subscribe pattern** for shared state
- **159% improvement** with structured shared outputs
- **Role specialization** with shared memory
- **Debug memory** persistence across sessions

**Implementation**:
- Patterns = structured outputs from completed loops
- Registry = publish-subscribe message broker
- Pattern injection = subscription to relevant patterns
- Effectiveness tracking = measuring improvement over baseline
