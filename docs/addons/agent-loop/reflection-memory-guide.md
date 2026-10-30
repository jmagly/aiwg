# Reflexion Episodic Memory Guide

Comprehensive guide to Al's episodic memory system based on the Reflexion framework.

## Overview

Al implements **Reflexion's three-model architecture** for verbal reinforcement learning:

1. **Actor (Ma)** - Executes actions and generates code changes
2. **Evaluator (Me)** - Verifies results using external tools (npm test, tsc, eslint)
3. **Self-Reflection (Msr)** - Analyzes failures and generates actionable insights

After each failed iteration, Al generates a **structured reflection** stored in episodic memory. These reflections are injected into retry attempts, enabling learning without model retraining.

## Theoretical Foundation

**Research Basis**: REF-021 Reflexion - Language Agents with Verbal Reinforcement Learning (NeurIPS 2023)

**Key Results**:
- 91% pass@1 on HumanEval (surpasses GPT-4's 80% baseline)
- +24% task success through verbal reinforcement
- Learning occurs at inference time through context injection

**Core Insight**: Natural language reflections provide more actionable guidance than scalar rewards, enabling rapid learning through episodic memory.

See `@$AIWG_ROOT/docs/references/REF-021-reflexion-verbal-reinforcement.md` for complete research documentation.

## Three-Model Architecture

### 1. Actor Model (Ma)

**Role**: Generates text and actions based on current state and episodic memory.

**Policy**: `πθ(at|st)` where `θ = {Ma, mem}`
- `at` = action or text generation at time t
- `st` = current state (task + trajectory history)
- `mem` = episodic memory buffer (sliding window of reflections)

**Implementation in Al**:
```typescript
interface ActorOutput {
  actions: Action[];           // Sequence of actions taken
  rationale: string;           // Reasoning for approach
  strategy: string;            // High-level strategy
  files_modified: string[];    // Files touched
  total_changes: ChangeStats;  // Aggregate statistics
}
```

**Actor Variants**:
- **Chain-of-Thought (CoT)**: Step-by-step reasoning for single-generation tasks
- **ReAct**: Interleaved reasoning and acting for multi-step tasks (Al's default)

### 2. Evaluator Model (Me)

**Role**: Scores generated outputs to produce reward signal.

**Evaluation Strategies by Task Type**:

| Task Type | Evaluation Method | Al Implementation |
|-----------|------------------|---------------------|
| Programming | Unit tests + execution | `npm test`, `npm run test:coverage` |
| Type Safety | Compilation checks | `tsc --noEmit` |
| Code Quality | Linting | `eslint`, `markdownlint` |
| Integration | External API calls | Gitea API responses |
| Combined | Multiple tools | All of the above |

**Implementation in Al**:
```typescript
interface EvaluatorOutput {
  passed: boolean;                    // Overall pass/fail
  verification_type: VerificationType; // Type of verification
  results: VerificationResult[];      // Individual tool results
  errors: StructuredError[];          // Parsed error information
  reward_signal: number;              // Scalar reward [0.0, 1.0]
  metrics: VerificationMetrics;       // Quantitative metrics
}
```

**Reward Signal Calculation**:
```typescript
// Example: Combined verification
reward = (
  (tests_passed / tests_total) * 0.5 +
  (type_errors === 0 ? 0.3 : 0.0) +
  (lint_errors === 0 ? 0.2 : 0.0)
);
```

### 3. Self-Reflection Model (Msr)

**Role**: Converts sparse rewards into detailed verbal feedback.

**Input**: `{trajectory τt, reward rt, episodic memory mem}`

**Output**: Natural language reflection containing:
1. **Credit assignment** - Identification of specific failing actions
2. **Causal reasoning** - Explanation of why actions led to failure
3. **Actionable insights** - Concrete suggestions for improvement

**Implementation in Al**:
```typescript
interface SelfReflection {
  reflection_text: string;           // First-person narrative reflection
  credit_assignment: {
    failing_action_indices: number[]; // Which actions failed
    root_cause: string;                // Identified root cause
    failure_category: FailureCategory; // Error classification
  };
  causal_reasoning: string;          // Why failure occurred
  actionable_insights: string[];     // What to do next
  lessons_learned: string[];         // General lessons
  confidence: number;                // Self-assessed confidence [0.0, 1.0]
  related_reflections: number[];     // Previous relevant reflections
}
```

**Example Reflection** (from schema):
> "In my previous attempt, I added tests for the login function but didn't account for edge cases where the API response might be empty or undefined. The error 'Cannot read property map of undefined' occurred because I tried to call .map() on userData without first checking if it exists. In my next attempt, I will add null checks before accessing userData properties."

## Memory Architecture

### Short-Term Memory

**Current trajectory history**: `τt = [a0, o0, ..., ai, oi]`
- Represents immediate context and recent decisions
- Stored in current iteration state

### Long-Term Memory (Episodic Buffer)

**Reflection storage**: `mem = [sr0, sr1, ..., srt]`
- Maximum capacity **Ω** (omega) respects context limits
- Most recent experiences inform future decisions
- Provides "lessons learned" across trials

**Storage Location**: `.aiwg/ralph/reflections/<loop-id>/`

**Sliding Window Behavior**:
```
Ω=3 example (keep last 3 reflections):

Iteration 0 fails → reflection 001.json (in context)
Iteration 1 fails → reflection 002.json (in context)
Iteration 2 fails → reflection 003.json (in context)
Iteration 3 fails → reflection 004.json (in context)
                     001.json excluded from context
Iteration 4 fails → reflection 005.json (in context)
                     002.json excluded from context
```

**Memory Operations**:
```typescript
// Initialize
let mem: Reflection[] = [];

// After each failed trial
async function afterTrial(iteration: number, trajectory: Trajectory, reward: number) {
  // 1. Generate reflection
  const reflection = await generateReflection(trajectory, reward, mem);

  // 2. Append to memory
  mem.push(reflection);

  // 3. Truncate to Ω capacity
  if (mem.length > OMEGA_CAPACITY) {
    mem = mem.slice(-OMEGA_CAPACITY);
  }

  // 4. Persist to disk
  await saveReflection(reflection);

  // 5. Update metadata
  await updateMemoryMetadata({
    omega_capacity: OMEGA_CAPACITY,
    current_memory_size: mem.length,
    reflections_in_context: mem.map(r => r.iteration),
    total_reflections_generated: iteration + 1
  });
}
```

## When Reflections Are Generated

Reflections are created **after failed verification** only:

| Outcome | Generate Reflection? | Next Action |
|---------|---------------------|-------------|
| All verifications pass | NO | Complete loop successfully |
| Some verifications fail | YES | Generate reflection → retry |
| Max iterations reached | YES | Generate final reflection → abort |
| Critical error | YES | Generate error reflection → abort |

**Verification Flow**:
```
Attempt → Execute actions → Verify results
                               ↓
                          All passed?
                          /         \
                        YES          NO
                         ↓            ↓
                      Success    Generate reflection
                                      ↓
                                 Add to memory
                                      ↓
                                 Inject into next attempt
                                      ↓
                                    Retry
```

## Reflection Prompt Template

**System Prompt for Self-Reflection Model**:

```markdown
You are the Self-Reflection component in a Reflexion-based learning system.

You will be given:
1. Your previous implementation attempt (actions taken)
2. Verification results from external tools (tests, linters, type checker)
3. Your past reflections from similar failures (if any)

Your task is to analyze what went wrong and provide actionable guidance for the next attempt.

## Reflection Structure

Write a first-person narrative reflection that includes:

1. **Credit Assignment**: Which specific actions or code changes caused the failure?
2. **Causal Reasoning**: Why did these actions lead to failure? What was the underlying issue?
3. **Actionable Insights**: What concrete steps should be taken in the next attempt?

Be specific. Avoid generic advice like "be more careful" - instead, identify exact code patterns, missing checks, or logic errors.

## Example Reflection

"In my previous attempt, I tried to map over userData without checking if it exists. The error occurred because the API response was empty in the test case. I should add a null check before the map operation. In the next attempt, I will verify userData exists and return an empty array if it doesn't."

## Previous Reflections

{{#each previous_reflections}}
### Iteration {{this.iteration}}
{{this.reflection_text}}

Lessons learned:
{{#each this.lessons_learned}}
- {{this}}
{{/each}}
{{/each}}

## Current Failure

**Task**: {{task_description}}

**Actions Taken**:
{{#each actions}}
{{@index}}. {{this.description}}
   File: {{this.file_path}}
   Changes: +{{this.changes.additions}} -{{this.changes.deletions}}
{{/each}}

**Verification Results**:
{{#each verification_results}}
- {{this.tool}}: {{this.status}}
  {{#if this.stderr}}
  Error: {{this.stderr}}
  {{/if}}
{{/each}}

**Errors**:
{{#each errors}}
- {{this.type}}: {{this.message}}
  Location: {{this.file}}:{{this.line}}
{{/each}}

Now write your reflection following the structure above.
```

## How to Query Past Reflections

### Loading Reflections for Current Task

```typescript
import { loadReflections } from '@/ralph/memory';

// Load all reflections for a loop
const reflections = await loadReflections('ralph-task-123');

// Get reflections in current window (respects Ω)
const activeReflections = reflections.filter(r =>
  r.memory_metadata.reflections_in_context.includes(r.iteration)
);

// Inject into retry prompt
const context = buildRetryContext({
  task: currentTask,
  previousReflections: activeReflections.map(r => r.self_reflection.reflection_text),
  failedActions: currentFailure.actor_output.actions,
  errors: currentFailure.evaluator_output.errors
});
```

### Cross-Task Learning Patterns

**Find similar failures across loops**:
```typescript
import { searchReflections } from '@/ralph/memory';

// Query by failure category
const similarFailures = await searchReflections({
  failure_category: 'edge_case_miss',
  min_confidence: 0.8,
  limit: 5
});

// Extract lessons learned
const lessons = similarFailures.flatMap(r =>
  r.self_reflection.lessons_learned
);

// Inject as general knowledge
const enhancedContext = {
  ...baseContext,
  prior_knowledge: lessons
};
```

**Analyze improvement patterns**:
```typescript
import { analyzePerformance } from '@/ralph/analytics';

// Track reward progression
const loopHistory = await loadReflections('ralph-task-123');
const rewards = loopHistory.map(r => r.evaluator_output.reward_signal);

// Calculate learning rate
const learningRate = (rewards[rewards.length - 1] - rewards[0]) / rewards.length;

// Identify breakthrough moments
const improvements = loopHistory.filter(r =>
  r.performance_delta?.is_improvement === true
);
```

### Example: Learning from Past API Integration Failures

```typescript
// Scenario: New API integration task
const task = "Integrate Gitea webhook API";

// Step 1: Find past API-related reflections
const apiReflections = await searchReflections({
  task_keywords: ['API', 'integration', 'webhook'],
  failure_category: ['edge_case_miss', 'integration_error'],
  min_confidence: 0.7
});

// Step 2: Extract common lessons
const commonPatterns = extractPatterns(apiReflections, {
  min_frequency: 2, // Lesson appears in ≥2 reflections
  categories: ['actionable_insights', 'lessons_learned']
});

// Step 3: Inject as prior knowledge
const taskContext = {
  task_description: task,
  prior_api_lessons: commonPatterns,
  similar_successes: apiReflections.filter(r =>
    r.evaluator_output.passed === true
  )
};

// Step 4: Execute with enhanced context
const result = await executeWithContext(taskContext);
```

## Memory Capacity Tuning (Ω Parameter)

**Choosing Ω based on task complexity**:

| Task Type | Recommended Ω | Rationale |
|-----------|--------------|-----------|
| Simple programming (single function) | 1 | Clear failure modes, quick fixes |
| Complex programming (multi-file) | 3 | Multiple error types, iterative refinement |
| Decision-making (multi-step) | 3 | Long trajectories, credit assignment needed |
| Reasoning (multi-hop) | 3 | Complex causal chains |
| Research/exploration | 5+ | Experimental, may exceed context limits |

**Empirical Evidence from Reflexion Paper**:
- **HumanEval (programming)**: Ω=1 optimal
- **AlfWorld (decision-making)**: Ω=3 optimal
- **HotPotQA (reasoning)**: Ω=3 optimal

**AIWG Defaults**:
```typescript
const OMEGA_DEFAULTS = {
  'unit_tests': 1,           // Simple test failures
  'integration_tests': 3,    // Complex integration issues
  'type_check': 1,           // Type errors are usually clear
  'lint': 1,                 // Lint errors are specific
  'combined': 3,             // Multiple verification types
  'manual_review': 5         // Subjective feedback needs history
};
```

**Dynamic Tuning**:
```typescript
// Adjust Ω based on failure diversity
function calculateOptimalOmega(reflections: Reflection[]): number {
  const uniqueCategories = new Set(
    reflections.map(r => r.self_reflection.credit_assignment.failure_category)
  );

  // More diverse failures → larger window
  if (uniqueCategories.size >= 5) return 5;
  if (uniqueCategories.size >= 3) return 3;
  return 1;
}
```

## Performance Analysis

### Metrics to Track

**Individual Reflection Quality**:
- `self_reflection.confidence` - Self-assessed accuracy
- `performance_delta.is_improvement` - Did next iteration improve?
- Correlation between confidence and actual improvement

**Loop Performance**:
- Reward progression: `[r0, r1, r2, ..., rn]`
- Error count reduction over iterations
- Time to success (iterations needed)
- Failure category distribution

**Cross-Loop Learning**:
- Reuse rate of lessons learned
- Success rate on tasks similar to past failures
- Time to success improvement on repeated task types

### Example Analysis Script

```typescript
import { loadReflections, analyzeLoopPerformance } from '@/ralph/analytics';

async function analyzeRalphLearning() {
  // Load all completed loops
  const loops = await loadAllLoops();

  // Analyze each loop
  const analyses = await Promise.all(
    loops.map(async loop => {
      const reflections = await loadReflections(loop.id);

      return {
        loop_id: loop.id,
        total_iterations: reflections.length,
        final_success: loop.status === 'completed',
        learning_curve: reflections.map(r => r.evaluator_output.reward_signal),
        failure_categories: reflections.map(r =>
          r.self_reflection.credit_assignment.failure_category
        ),
        lessons_count: reflections.reduce((sum, r) =>
          sum + r.self_reflection.lessons_learned.length, 0
        ),
        avg_confidence: reflections.reduce((sum, r) =>
          sum + (r.self_reflection.confidence || 0), 0
        ) / reflections.length
      };
    })
  );

  // Aggregate insights
  const totalLearningRate = analyses.reduce((sum, a) => {
    const curve = a.learning_curve;
    const rate = curve.length > 1
      ? (curve[curve.length - 1] - curve[0]) / curve.length
      : 0;
    return sum + rate;
  }, 0) / analyses.length;

  console.log('Al Learning Analysis:');
  console.log(`- Total loops: ${analyses.length}`);
  console.log(`- Success rate: ${analyses.filter(a => a.final_success).length / analyses.length}`);
  console.log(`- Avg learning rate: ${totalLearningRate.toFixed(3)}`);
  console.log(`- Avg iterations: ${analyses.reduce((s, a) => s + a.total_iterations, 0) / analyses.length}`);
}
```

## Integration with Al External

Al's external loop implementation (`tools/ralph-external/`) uses episodic memory for recovery:

**Integration Points**:

1. **Initialization** - Load past reflections if resuming
2. **Iteration Start** - Inject active reflections into context
3. **Verification Failure** - Generate and store reflection
4. **Retry Attempt** - Include reflection in next iteration's prompt
5. **Completion** - Analyze reflection quality and learning curve

**File Mapping**:
```
tools/ralph-external/
├── core/
│   ├── memory.ts         # Reflection loading/saving
│   ├── reflection.ts     # Reflection generation
│   └── evaluator.ts      # External verification
├── prompts/
│   ├── actor.hbs         # Includes {{previous_reflections}}
│   └── reflection.hbs    # Self-reflection template
└── state/
    └── <loop-id>/
        └── reflections/  # Symlink to .aiwg/ralph/reflections/<loop-id>/
```

**Reflection Injection Example**:
```typescript
// tools/ralph-external/core/actor.ts
import { loadActiveReflections } from './memory';

async function executeIteration(loopId: string, iteration: number) {
  // Load reflections in window
  const reflections = await loadActiveReflections(loopId);

  // Build context with reflections
  const context = {
    task: currentTask,
    iteration,
    previous_reflections: reflections.map(r => ({
      iteration: r.iteration,
      reflection_text: r.self_reflection.reflection_text,
      lessons_learned: r.self_reflection.lessons_learned,
      actionable_insights: r.self_reflection.actionable_insights
    })),
    previous_errors: reflections.flatMap(r =>
      r.evaluator_output.errors
    )
  };

  // Execute with enhanced context
  const result = await actor.execute(context);

  return result;
}
```

## Best Practices

### Writing Quality Reflections

**DO**:
- ✅ Use first person ("I tried...", "In my next attempt...")
- ✅ Be specific about failing actions (cite line numbers, function names)
- ✅ Explain causal chain (X led to Y because Z)
- ✅ Provide concrete next steps ("Add null check at line 23")
- ✅ Reference previous reflections when applicable
- ✅ Assess confidence honestly

**DON'T**:
- ❌ Write generic advice ("Be more careful", "Test thoroughly")
- ❌ Blame external factors without analysis
- ❌ Repeat previous reflections verbatim
- ❌ Ignore verification errors in output
- ❌ Claim high confidence without evidence

### Optimizing Memory Usage

**Context Length Management**:
```typescript
// Estimate reflection size
function estimateTokens(reflection: Reflection): number {
  const text = reflection.self_reflection.reflection_text;
  const insights = reflection.self_reflection.actionable_insights.join(' ');
  return Math.ceil((text + insights).length / 4); // Rough estimate
}

// Ensure reflections fit in context window
function pruneReflectionsToFit(
  reflections: Reflection[],
  maxTokens: number
): Reflection[] {
  const sorted = reflections.sort((a, b) => b.iteration - a.iteration);
  let totalTokens = 0;
  const result = [];

  for (const r of sorted) {
    const tokens = estimateTokens(r);
    if (totalTokens + tokens > maxTokens) break;
    result.push(r);
    totalTokens += tokens;
  }

  return result.reverse(); // Maintain chronological order
}
```

### Debugging Reflection Quality

**Low-Quality Reflection Indicators**:
- Confidence < 0.5 but is_improvement = false
- No actionable insights provided
- Reflection text < 100 characters
- No credit assignment identified

**Improvement Strategies**:
1. Enhance reflection prompt with more context
2. Include specific error details in prompt
3. Show examples of high-quality reflections
4. Require minimum reflection length
5. Validate reflection structure before saving

## Validation

**Schema Validation**:
```bash
# Validate reflection against schema
npx ajv validate \
  -s agentic/code/addons/agent-loop/schemas/reflection-memory.json \
  -d .aiwg/ralph/reflections/ralph-task-123/001.json
```

**Runtime Validation**:
```typescript
import Ajv from 'ajv';
import schema from '@/agentic/code/addons/agent-loop/schemas/reflection-memory.json';

const ajv = new Ajv();
const validate = ajv.compile(schema);

function validateReflection(reflection: unknown): Reflection {
  if (!validate(reflection)) {
    throw new Error(`Invalid reflection: ${ajv.errorsText(validate.errors)}`);
  }
  return reflection as Reflection;
}
```

## References

### AIWG Documentation

- **@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/reflection-memory.json** - JSON Schema definition
- **@.aiwg/ralph/reflections/.gitkeep** - Directory structure documentation
- **@.aiwg/ralph/reflections/example/001.json** - Example reflection
- **@$AIWG_ROOT/docs/references/REF-021-reflexion-verbal-reinforcement.md** - Research foundation
- **@$AIWG_ROOT/tools/ralph-external/README.md** - External loop implementation

### Research References

- **Reflexion (NeurIPS 2023)** - Shinn et al.
  - 91% HumanEval pass@1 (surpasses GPT-4 baseline)
  - Episodic memory with sliding window (Ω parameter)
  - Three-model architecture: Actor, Evaluator, Self-Reflection
  - arXiv: https://arxiv.org/abs/2303.11366

### Related AIWG Issues

- **#94** - Parent epic: Reflexion Integration
- **#102** - This implementation
- **#103** - Self-reflection prompt optimization
- **#104** - Cross-task learning analytics

---

**Document Version**: 1.0.0
**Last Updated**: 2026-01-25
**Status**: IMPLEMENTED

## Changelog

| Date | Change |
|------|--------|
| 2026-01-25 | Initial implementation following REF-021 specification |
