---
namespace: aiwg
name: flow-deploy-to-production
platforms: [all]
description: Orchestrate production deployment with strategy selection, validation, automated rollback, and regression gates
commandHint:
  argumentHint: '[project-directory] [--guidance "text"] [--interactive] [--regression-threshold N] [--rollback-on-regression]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: opus
  category: sdlc-orchestration
  orchestration: true
  modelRole: reasoning
  modelTier: premium
  modelRationale: Production release and rollback decisions have high operational impact.
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-deploy-to-production.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Production Deployment Orchestration Flow

**You are the Core Orchestrator** for production deployment workflows.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Deployment Overview

**Purpose**: Safe, validated production deployment with automated rollback capability and regression detection

**Key Activities**:
- Strategy selection (blue-green, canary, rolling)
- Pre-deployment validation and gate checks
- **Regression detection at staging and production gates**
- Progressive deployment with SLO monitoring
- Smoke tests and health validation
- **Automated rollback on regression or failure**

**Expected Duration**: 30-90 minutes (varies by strategy), 10-15 minutes orchestration

## Natural Language Triggers

Users may say:
- "Deploy to production"
- "Production deployment"
- "Release to prod"
- "Start deployment"
- "Deploy version X.Y.Z"
- "Go live with new release"
- "Execute production rollout"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor orchestration priorities

**Examples**:
```
--guidance "Zero-downtime critical, use blue-green strategy"
--guidance "High-risk release, progressive canary with 5% → 25% → 100%"
--guidance "Database migration included, need extended maintenance window"
--guidance "First production deployment, extra validation and monitoring"
```

**How to Apply**:
- Parse guidance for keywords: strategy, risk level, timeline, validation depth
- Adjust strategy selection (blue-green vs. canary vs. rolling)
- Modify validation depth (minimal vs. comprehensive smoke tests)
- Influence monitoring duration (15 min vs. 60 min observation)

### --interactive Parameter

**Purpose**: You ask 6-8 strategic questions to understand deployment context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor the production deployment to your needs:

Q1: What deployment strategy do you prefer?
    (blue-green = instant cutover, canary = progressive rollout, rolling = node-by-node)

Q2: What's the risk level of this release?
    (Low = routine updates, Medium = new features, High = architecture changes)

Q3: What are your SLO targets?
    (e.g., error rate <0.1%, latency p99 <500ms, availability >99.95%)

Q4: Is a database migration or schema change included?
    (Affects rollback complexity and strategy selection)

Q5: What's your rollback tolerance?
    (How quickly must you be able to rollback? Instant vs. 5 min vs. 30 min)

Q6: What's your monitoring observation period?
    (How long to monitor before declaring success? 15 min vs. 30 min vs. 60 min)

Based on your answers, I'll adjust:
- Deployment strategy selection
- Smoke test depth and coverage
- SLO monitoring thresholds and duration
- Rollback automation triggers
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

### --regression-threshold Parameter

**Purpose**: Set acceptable regression rate for deployment gates

**Default**: `0` (zero tolerance - any regression blocks deployment)

**Format**: `--regression-threshold N` where N = percentage (0-100)

**Examples**:
```bash
# Zero tolerance (default)
/flow-deploy-to-production --regression-threshold 0

# Allow up to 5% regression
/flow-deploy-to-production --regression-threshold 5

# Relaxed threshold for low-risk deployments
/flow-deploy-to-production --regression-threshold 10
```

**Application**:
- **Staging Gate**: If regression rate > threshold → BLOCK promotion to production
- **Production Gate**: If regression rate > threshold → TRIGGER automatic rollback
- Threshold applies to both test regression and metric regression

**Typical Thresholds**:
| Risk Level | Recommended Threshold | Rationale |
|------------|----------------------|-----------|
| High | 0% | Zero tolerance for critical releases |
| Medium | 2-5% | Allow minor acceptable regression |
| Low | 5-10% | Relaxed for routine updates |

### --rollback-on-regression Parameter

**Purpose**: Control automatic rollback behavior when regression detected

**Default**: `true` (automatic rollback enabled)

**Format**: `--rollback-on-regression` (boolean flag)

**Examples**:
```bash
# Automatic rollback enabled (default)
/flow-deploy-to-production --rollback-on-regression

# Manual intervention required
/flow-deploy-to-production --no-rollback-on-regression
```

**Behavior**:
- **If true**: Production regression → Immediate automated rollback
- **If false**: Production regression → Alert user, await manual decision
- Recommended: Keep enabled for production safety

## Artifacts to Generate

**Primary Deliverables**:
- **Deployment Readiness Report**: Pre-flight validation → `.aiwg/deployment/deployment-readiness-report.md`
- **Regression Gate Reports**: Staging and production regression checks → `.aiwg/deployment/regression-gate-staging.md`, `.aiwg/deployment/regression-gate-production.md`
- **Deployment Execution Log**: Real-time progress tracking → `.aiwg/deployment/deployment-execution-log.md`
- **SLO Monitoring Report**: Metrics and breach detection → `.aiwg/deployment/slo-monitoring-report.md`
- **Deployment Summary Report**: Final outcome and lessons learned → `.aiwg/reports/deployment-report-{version}.md`
- **Rollback Report** (if needed): Rollback execution and RCA → `.aiwg/deployment/rollback-report-{version}.md`

**Supporting Artifacts**:
- Smoke test results (working doc)
- SLO breach alerts (archived)
- Infrastructure health snapshots (archived)
- Regression analysis reports (archived)

## Regression Gates

**Purpose**: Detect and block regressions before they reach production or impact users

**Two-Gate Model**:

### Staging Regression Gate

**When**: After deployment to staging environment, before production cutover

**What**: Compare staging behavior against production baseline

**Checks**:
1. **Test Regression**: Run full regression suite, compare pass rates
2. **Metric Regression**: Compare error rates, latency, throughput
3. **Smoke Test Regression**: Validate critical paths match production behavior

**Decision**:
- **Pass (regression ≤ threshold)**: Proceed to production deployment
- **Fail (regression > threshold)**: BLOCK promotion, investigate, fix

**Rationale**: Catch regressions in staging before they impact real users

### Production Regression Gate

**When**: After production deployment, during monitoring period

**What**: Compare production behavior against pre-deployment baseline

**Checks**:
1. **Smoke Test Regression**: Validate critical paths still pass
2. **SLO Regression**: Detect degradation in error rate, latency, availability
3. **User Journey Regression**: Validate top user flows still complete successfully

**Decision**:
- **Pass (regression ≤ threshold)**: Deployment successful
- **Fail (regression > threshold)**: TRIGGER automatic rollback (if `--rollback-on-regression`)

**Rationale**: Immediate detection and rollback on production regression

### Regression Detection Methodology

**Test Regression**:
```yaml
baseline: production test suite results
candidate: staging/production test suite results
regression_rate: (baseline_pass_count - candidate_pass_count) / baseline_pass_count * 100

threshold_check: regression_rate > threshold → FAIL
```

**Metric Regression**:
```yaml
baseline: production metrics (pre-deployment)
candidate: staging/production metrics (post-deployment)

regressions_to_detect:
  - error_rate_increase > threshold
  - latency_p99_increase > threshold
  - throughput_decrease > threshold

threshold_check: any_regression > threshold → FAIL
```

**Scope Options**:
- **full**: All tests and metrics (comprehensive)
- **critical**: Only P0/P1 tests and critical metrics (faster)
- **targeted**: Tests/metrics related to changed components

### Integration with /regression-check

The regression gates use the `/regression-check` command:

**Staging Gate**:
```bash
/regression-check --baseline production --candidate staging --scope full --threshold {threshold}
```

**Production Gate**:
```bash
/regression-check --baseline production-pre-deploy --candidate production-post-deploy --scope critical --threshold {threshold}
```

### Rollback Trigger on Regression

If production regression detected and `--rollback-on-regression` enabled:

```yaml
regression_detected:
  trigger: regression_rate > threshold
  action: automated_rollback
  strategy: {blue-green | canary | rolling}
  notification:
    - alert_team
    - declare_incident
    - start_rca_process
```

## Multi-Agent Orchestration Workflow

### Step 1: Deployment Strategy Selection

**Purpose**: Choose deployment strategy based on risk, infrastructure, and requirements

**Your Actions**:

1. **Analyze Context**:
   ```
   Read:
   - .aiwg/intake/project-intake.md (understand project constraints)
   - .aiwg/deployment/deployment-plan-*.md (existing deployment plans)
   - .aiwg/architecture/software-architecture-doc.md (infrastructure capabilities)
   - User guidance (--guidance parameter or interactive answers)
   ```

2. **Launch Strategy Selection Agent**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Recommend deployment strategy",
       prompt="""
       Read project context and architecture documentation

       Recommend deployment strategy based on:

       **Blue-Green Strategy**:
       - When: Zero-downtime critical, instant rollback required
       - Requires: 2x infrastructure capacity (temporary)
       - Pros: Instant cutover, instant rollback, low risk
       - Cons: Higher cost, requires duplicate environments

       **Canary Strategy**:
       - When: Progressive validation needed, high-risk release
       - Requires: Traffic routing capability (Argo Rollouts, Flagger)
       - Pros: Gradual rollout, SLO-driven automation, cost-efficient
       - Cons: Slower rollout, complex automation setup

       **Rolling Strategy**:
       - When: Legacy systems, stateful services, simpler deployments
       - Requires: Basic orchestration (Kubernetes rollout)
       - Pros: No additional infrastructure, simple setup
       - Cons: Slower rollout, manual validation, harder rollback

       Analyze project requirements:
       - Risk level: {from guidance or interactive}
       - Infrastructure: {cloud provider, orchestration platform}
       - Downtime tolerance: {zero vs. minimal vs. acceptable}
       - Rollback requirements: {instant vs. fast vs. manual}

       Recommend strategy with rationale
       Save to: .aiwg/working/deployment/strategy-recommendation.md
       """
   )
   ```

3. **Confirm Strategy with User**:
   ```
   Read .aiwg/working/deployment/strategy-recommendation.md

   Present to user:
   ─────────────────────────────────────────────
   Deployment Strategy Recommendation
   ─────────────────────────────────────────────

   **Recommended**: {Blue-Green | Canary | Rolling}

   **Rationale**: {why this strategy fits project needs}

   **Trade-offs**:
   - Pros: {list benefits}
   - Cons: {list drawbacks}

   **Requirements**:
   - Infrastructure: {what's needed}
   - Duration: {expected deployment time}
   - Monitoring: {observation period}

   Proceed with this strategy? (yes/no)
   ─────────────────────────────────────────────
   ```

**Communicate Progress**:
```
✓ Analyzed deployment context
✓ Strategy recommendation: {Blue-Green | Canary | Rolling}
⏳ Awaiting user confirmation...
```

### Step 2: Pre-Deployment Validation

**Purpose**: Verify all quality gates passed and environment is ready

**Your Actions**:

1. **Launch Parallel Validation Agents**:
   ```
   # Agent 1: Quality Gate Validation
   Task(
       subagent_type="project-manager",
       description="Validate all quality gates passed",
       prompt="""
       Check quality gate status for Transition phase

       Read gate criteria: $AIWG_ROOT/.../flows/gate-criteria-by-phase.md (Transition section)

       Validate gates:
       - [ ] Security Gate: No High/Critical vulnerabilities
       - [ ] Reliability Gate: SLOs met in staging
       - [ ] Test Gate: Integration tests 100% passing
       - [ ] Approval Gate: Release Manager signoff obtained

       Generate gate validation report:
       - Status: PASS | FAIL
       - Gate checklist with results
       - Decision: GO | NO-GO
       - Gaps (if NO-GO): List missing approvals or failures

       Save to: .aiwg/working/deployment/gate-validation-report.md
       """
   )

   # Agent 2: Environment Health Check
   Task(
       subagent_type="devops-engineer",
       description="Validate production environment health",
       prompt="""
       Check production environment readiness

       Validate infrastructure health:
       - [ ] All nodes healthy (Kubernetes cluster)
       - [ ] No pods in crash loop or pending state
       - [ ] Database connections healthy
       - [ ] External integrations operational
       - [ ] Monitoring and alerting functional
       - [ ] No active P0/P1 incidents

       Check deployment artifacts:
       - [ ] Container images available and tagged
       - [ ] Checksums verified
       - [ ] Container signatures validated (if required)
       - [ ] Database migrations prepared (if applicable)

       Generate environment health report:
       - Infrastructure status: HEALTHY | DEGRADED | UNHEALTHY
       - Artifacts status: READY | MISSING | INVALID
       - Decision: GO | NO-GO
       - Issues (if NO-GO): List blockers

       Save to: .aiwg/working/deployment/environment-health-report.md
       """
   )

   # Agent 3: Rollback Plan Validation
   Task(
       subagent_type="reliability-engineer",
       description="Validate rollback plan tested and ready",
       prompt="""
       Read rollback plan: .aiwg/deployment/rollback-plan-*.md

       Validate rollback readiness:
       - [ ] Rollback plan documented
       - [ ] Rollback tested in staging (within last 7 days)
       - [ ] Rollback automation configured (scripts, runbooks)
       - [ ] Rollback SLOs defined (how fast can we rollback?)
       - [ ] Communication plan for rollback scenario

       If database migration included:
       - [ ] Migration rollback script tested
       - [ ] Data backup verified
       - [ ] Backup restoration tested

       Generate rollback validation report:
       - Rollback readiness: READY | NOT_READY
       - Rollback strategy: {blue-green instant | canary abort | rolling undo}
       - Rollback SLO: {duration to full rollback}
       - Issues (if NOT_READY): List gaps

       Save to: .aiwg/working/deployment/rollback-validation-report.md
       """
   )
   ```

2. **Synthesize Pre-Deployment Readiness**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Synthesize deployment readiness report",
       prompt="""
       Read all validation reports:
       - .aiwg/working/deployment/gate-validation-report.md
       - .aiwg/working/deployment/environment-health-report.md
       - .aiwg/working/deployment/rollback-validation-report.md

       Synthesize Deployment Readiness Report:

       1. Overall Status: GO | CONDITIONAL_GO | NO-GO
       2. Gate Validation: {status and details}
       3. Environment Health: {status and details}
       4. Rollback Readiness: {status and details}
       5. Pre-Flight Checklist: {comprehensive checklist}
       6. Decision Rationale: {why GO or NO-GO}
       7. Conditions (if CONDITIONAL_GO): {what must be addressed}

       Use template: agentic/code/frameworks/sdlc-complete/templates/deployment/deployment-plan-template.md

       Output: .aiwg/deployment/deployment-readiness-report.md
       """
   )
   ```

3. **Decision Point**:
   ```
   Read .aiwg/deployment/deployment-readiness-report.md

   If GO → Continue to Step 3
   If CONDITIONAL_GO → Present conditions to user, wait for confirmation
   If NO-GO → Report gaps, recommend remediation, STOP deployment
   ```

**Communicate Progress**:
```
⏳ Validating deployment readiness...
  ✓ Quality gates validated: {PASS | FAIL}
  ✓ Environment health checked: {HEALTHY | DEGRADED}
  ✓ Rollback plan validated: {READY | NOT_READY}
✓ Pre-deployment validation: {GO | CONDITIONAL_GO | NO-GO}
```

### Step 2.5: Staging Regression Gate

**Purpose**: Detect regressions in staging before production deployment

**Your Actions**:

1. **Deploy to Staging**:
   ```
   Task(
       subagent_type="devops-engineer",
       description="Deploy new version to staging environment",
       prompt="""
       Execute deployment to staging environment

       Actions:
       1. Deploy new version to staging
       2. Wait for all pods running and healthy
       3. Validate health checks passing

       Report:
       - Staging deployment status: SUCCESS | FAILED
       - Pods running: {count}/{total}
       - Health checks: {PASS | FAIL}

       Save to: .aiwg/working/deployment/staging-deployment-log.md

       If FAILED: Stop deployment, do NOT proceed to regression check
       """
   )
   ```

2. **Execute Staging Regression Check**:
   ```
   Task(
       subagent_type="regression-analyst",
       description="Run regression analysis on staging deployment",
       prompt="""
       Execute comprehensive regression check: staging vs. production baseline

       Command: /regression-check --baseline production --candidate staging --scope full --threshold {threshold}

       This checks:
       1. Test Regression: Full regression suite comparison
       2. Metric Regression: Error rate, latency, throughput comparison
       3. Smoke Test Regression: Critical path validation

       Parameters:
       - baseline: Production (current live version)
       - candidate: Staging (new version under test)
       - scope: full (comprehensive check)
       - threshold: {from --regression-threshold parameter, default 0}

       Generate regression gate report:
       - Regression rate: {percentage}
       - Test failures: {new failures not in baseline}
       - Metric degradations: {error rate, latency, throughput}
       - Decision: PASS | FAIL
       - Blockers (if FAIL): {list regression details}

       Use schema: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/regression-gate.yaml

       Output: .aiwg/deployment/regression-gate-staging.md

       If FAIL (regression > threshold): BLOCK promotion to production
       """
   )
   ```

3. **Staging Gate Decision Point**:
   ```
   Read .aiwg/deployment/regression-gate-staging.md

   Check regression_rate vs. threshold:

   If regression_rate <= threshold:
     ✓ Staging regression gate PASSED
     → Continue to Step 3 (Production Deployment)

   If regression_rate > threshold:
     ❌ Staging regression gate FAILED
     → BLOCK promotion to production
     → Report regression details to user
     → Recommend investigation and fixes
     → STOP deployment

   Decision logged in deployment execution log
   ```

4. **Launch Regression Impact Assessment** (if regression detected):
   ```
   # Only if staging gate fails

   Task(
       subagent_type="regression-analyst",
       description="Assess regression impact and root cause",
       prompt="""
       Staging regression detected: {regression_rate}% > threshold {threshold}%

       Analyze regression impact:

       1. Categorize Regressions:
          - Test regressions: {which tests now failing}
          - Metric regressions: {which metrics degraded}
          - Functional regressions: {which features broken}

       2. Assess Root Cause:
          - Code changes: {which commits introduced regression}
          - Configuration changes: {any config differences}
          - Dependency changes: {any library/service updates}

       3. Estimate Impact:
          - Severity: {CRITICAL | HIGH | MEDIUM | LOW}
          - User impact: {which user journeys affected}
          - Scope: {percentage of users affected}

       4. Recommend Remediation:
          - Immediate fix: {what to change}
          - Rollback option: {can we revert specific changes}
          - Validation: {how to verify fix}

       Use regression analysis agent tools and documentation

       Output: .aiwg/deployment/regression-impact-assessment-staging.md

       See: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/regression-analyst.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Staging Regression Gate...
  ✓ Deployed to staging: {SUCCESS | FAILED}
  ✓ Regression check: {PASS | FAIL}
  {If PASS}
  ✓ Staging gate PASSED: Regression {rate}% ≤ threshold {threshold}%
  {If FAIL}
  ❌ Staging gate FAILED: Regression {rate}% > threshold {threshold}%
  ⏳ Analyzing regression impact...
  ✓ Impact assessment: .aiwg/deployment/regression-impact-assessment-staging.md
  ⚠️ Deployment BLOCKED until regressions fixed
```

### Step 3: Execute Deployment (Strategy-Specific)

**Purpose**: Deploy new version using selected strategy with continuous monitoring

#### Blue-Green Deployment

**Your Actions**:

1. **Deploy to Green Environment**:
   ```
   Task(
       subagent_type="devops-engineer",
       description="Deploy new version to green environment",
       prompt="""
       Execute blue-green deployment to green environment

       Actions:
       1. Deploy new version to green environment (while blue serves production)
       2. Wait for all green pods to be running and ready
       3. Validate green environment health checks passing

       Log all actions with timestamps to: .aiwg/working/deployment/execution-log-green.md

       Report:
       - Green deployment status: SUCCESS | FAILED
       - Pods running: {count}/{total}
       - Health checks: {PASS | FAIL}
       - Duration: {minutes}

       If FAILED: Stop deployment, do NOT cutover traffic
       """
   )
   ```

2. **Run Smoke Tests on Green**:
   ```
   Task(
       subagent_type="qa-engineer",
       description="Execute smoke tests on green environment",
       prompt="""
       Read smoke test plan: agentic/code/frameworks/sdlc-complete/templates/test/test-suite-card.md

       Execute critical path smoke tests:
       - [ ] API health endpoints (200 OK)
       - [ ] User authentication flow
       - [ ] Critical business operations (top 5-10 journeys)
       - [ ] Database connectivity
       - [ ] External integrations (payment gateway, email, etc.)
       - [ ] Monitoring and logging operational

       Test against green environment URL (not production)

       Generate smoke test report:
       - Tests passed: {count}/{total}
       - Tests failed: {list failures with details}
       - Status: PASS | FAIL
       - Duration: {minutes}

       Save to: .aiwg/working/deployment/smoke-test-results-green.md

       If FAIL: Stop deployment, do NOT cutover traffic
       """
   )
   ```

3. **Cutover Traffic to Green**:
   ```
   # Only proceed if green deployment and smoke tests passed

   Task(
       subagent_type="devops-engineer",
       description="Cutover production traffic to green environment",
       prompt="""
       Execute traffic cutover from blue to green

       Actions:
       1. Update load balancer or service selector to point to green
       2. Verify traffic is flowing to green (0% blue → 100% green)
       3. Confirm blue environment still running (for instant rollback)

       Log cutover actions with timestamps

       Report:
       - Cutover status: SUCCESS | FAILED
       - Traffic distribution: {blue-percentage}% blue, {green-percentage}% green
       - Timestamp: {cutover-time}

       Save to: .aiwg/working/deployment/execution-log-cutover.md
       """
   )
   ```

4. **Monitor SLOs Post-Cutover** (Step 4 will handle this)

#### Canary Deployment

**Your Actions**:

1. **Deploy Canary (1-5% Traffic)**:
   ```
   Task(
       subagent_type="devops-engineer",
       description="Deploy canary version with 1-5% traffic",
       prompt="""
       Execute canary deployment with progressive rollout

       Stage 1: Deploy canary receiving 1-5% of production traffic

       Actions:
       1. Deploy canary version alongside stable baseline
       2. Configure traffic routing (1-5% to canary, 95-99% to baseline)
       3. Verify canary pods running and healthy

       Log all actions with timestamps

       Report:
       - Canary deployment status: SUCCESS | FAILED
       - Traffic distribution: {canary-percentage}% canary, {baseline-percentage}% baseline
       - Pods running: {count}/{total}
       - Health checks: {PASS | FAIL}

       Save to: .aiwg/working/deployment/execution-log-canary-stage1.md

       If FAILED: Stop deployment, scale down canary
       """
   )
   ```

2. **Launch SLO Monitoring Agent** (runs continuously):
   ```
   Task(
       subagent_type="reliability-engineer",
       description="Monitor canary SLOs at 1-5% stage",
       prompt="""
       Monitor SLOs for canary vs. baseline for 10-15 minutes

       Compare metrics:
       - Error rate: canary should not exceed baseline by >2%
       - Latency p99: canary should not exceed baseline by >20%
       - Throughput: canary should be proportional to traffic share

       SLO breach detection:
       - If error rate breach: ABORT deployment, trigger rollback
       - If latency breach: ABORT deployment, trigger rollback
       - If infrastructure failure: ABORT deployment, trigger rollback

       Generate monitoring report every 5 minutes:
       - Status: PASS | BREACH
       - Metrics comparison: {baseline vs. canary}
       - Decision: CONTINUE | ABORT

       Save to: .aiwg/working/deployment/slo-monitoring-canary-stage1.md

       If BREACH: Immediately notify orchestrator to trigger rollback
       """
   )
   ```

3. **Progressive Rollout** (if SLOs pass):
   ```
   # If Stage 1 SLOs pass, promote to 25%, then 50%, then 100%
   # Repeat monitoring at each stage

   Task(
       subagent_type="devops-engineer",
       description="Promote canary to 25% traffic",
       prompt="""
       Stage 2: Promote canary to 25% traffic

       Actions:
       1. Update traffic routing (25% canary, 75% baseline)
       2. Verify traffic distribution
       3. Monitor SLOs for 10-15 minutes (launch new monitoring agent)

       Report and save to: .aiwg/working/deployment/execution-log-canary-stage2.md

       If SLO breach at any stage: ABORT, trigger rollback
       """
   )

   # Repeat for 50% and 100% stages
   ```

#### Rolling Deployment

**Your Actions**:

1. **Rolling Update Execution**:
   ```
   Task(
       subagent_type="devops-engineer",
       description="Execute rolling deployment node-by-node",
       prompt="""
       Execute rolling deployment strategy

       Actions:
       1. Update 1 instance/node at a time
       2. Wait for new instance to pass health checks
       3. Monitor for 5 minutes before proceeding to next instance
       4. Continue until all instances updated

       Pause conditions:
       - If health check fails: STOP, evaluate, rollback if needed
       - If error rate increases: STOP, evaluate, rollback if needed

       Log all actions with timestamps

       Report:
       - Instances updated: {count}/{total}
       - Current instance status: {status}
       - Health checks: {PASS | FAIL}
       - Error rate: {current vs. baseline}

       Save to: .aiwg/working/deployment/execution-log-rolling.md
       """
   )
   ```

**Communicate Progress** (all strategies):
```
⏳ Executing {Blue-Green | Canary | Rolling} deployment...
  ✓ {Strategy-specific milestone 1}: {status}
  ✓ {Strategy-specific milestone 2}: {status}
  ⏳ {Strategy-specific milestone 3}: In progress...
```

### Step 4: Monitor SLOs and Production Regression Gate

**Purpose**: Continuous validation that deployment is meeting reliability targets and no regressions introduced

**Your Actions**:

1. **Capture Production Baseline (Pre-Deployment)**:
   ```
   Task(
       subagent_type="reliability-engineer",
       description="Capture production baseline metrics before deployment",
       prompt="""
       Capture production baseline for regression comparison

       Metrics to capture:
       - Error rate (last 1 hour average)
       - Latency p50, p95, p99 (last 1 hour)
       - Throughput (requests/sec, last 1 hour)
       - Availability (uptime percentage)
       - Critical user journey completion rates

       Test suite state:
       - Smoke test pass rate (current)
       - Integration test pass rate (current)
       - Critical path test results

       Save baseline snapshot:
       - Timestamp: {pre-deployment time}
       - Version: {current production version}
       - Metrics: {captured values}

       Output: .aiwg/working/deployment/production-baseline-snapshot.md

       This baseline used for post-deployment regression comparison
       """
   )
   ```

2. **Launch Parallel Monitoring Agents**:
   ```
   # Agent 1: SLO Monitoring
   Task(
       subagent_type="reliability-engineer",
       description="Monitor production SLOs post-deployment",
       prompt="""
       Monitor SLOs for 15-30 minutes post-deployment (or as specified in guidance)

       Key SLOs to track:
       - Error rate: {target <0.1% or custom}
       - Latency p99: {target <500ms or custom}
       - Throughput: {baseline ±10% or custom}
       - Availability: {target >99.95% or custom}

       Compare current metrics vs. baseline (pre-deployment)

       Automated breach detection:
       - Error rate >2% above baseline → TRIGGER ROLLBACK
       - Latency p99 >20% above baseline → TRIGGER ROLLBACK
       - Throughput drop >30% below baseline → TRIGGER ROLLBACK
       - Infrastructure alarms triggered → TRIGGER ROLLBACK

       Generate SLO monitoring report every 5 minutes:
       - Status: PASS | BREACH
       - Metrics: {current vs. baseline vs. target}
       - Alerts triggered: {count and details}
       - Decision: CONTINUE | ROLLBACK

       Save to: .aiwg/deployment/slo-monitoring-report.md

       If BREACH: Immediately notify orchestrator to trigger rollback (Step 5)
       """
   )

   # Agent 2: Smoke Tests (Production)
   Task(
       subagent_type="qa-engineer",
       description="Execute smoke tests against production",
       prompt="""
       Run smoke tests against production environment post-deployment

       Execute critical path tests:
       - [ ] API health endpoints
       - [ ] User authentication and authorization
       - [ ] Top 5-10 business operations
       - [ ] Database read/write operations
       - [ ] External integrations
       - [ ] Monitoring and logging functional

       Test against production URL (real traffic)

       Generate smoke test report:
       - Tests passed: {count}/{total}
       - Tests failed: {list failures with details}
       - Status: PASS | FAIL
       - Duration: {minutes}

       Save to: .aiwg/working/deployment/smoke-test-results-production.md

       If FAIL: Immediately notify orchestrator to trigger rollback
       """
   )

   # Agent 3: Infrastructure Health Monitoring
   Task(
       subagent_type="devops-engineer",
       description="Monitor infrastructure health continuously",
       prompt="""
       Monitor infrastructure health for 15-30 minutes post-deployment

       Track infrastructure metrics:
       - Pod restarts: >3 restarts in 5 minutes → ALERT
       - OOM kills: Any OOM kill → TRIGGER ROLLBACK
       - Node health: Any unhealthy nodes → ALERT
       - Network errors: Elevated error rates → ALERT

       Generate infrastructure health report every 5 minutes:
       - Status: HEALTHY | DEGRADED | UNHEALTHY
       - Pods: {running}/{total}, restarts: {count}
       - Nodes: {healthy}/{total}
       - Alerts: {list active alerts}

       Save to: .aiwg/working/deployment/infrastructure-health-report.md

       If UNHEALTHY: Immediately notify orchestrator to trigger rollback
       """
   )

   # Agent 4: Production Regression Gate
   Task(
       subagent_type="regression-analyst",
       description="Execute production regression check",
       prompt="""
       Execute production regression gate check

       Command: /regression-check --baseline production-pre-deploy --candidate production-post-deploy --scope critical --threshold {threshold}

       This checks:
       1. Smoke Test Regression: Critical path validation
       2. SLO Regression: Error rate, latency, availability
       3. User Journey Regression: Top user flows completion

       Parameters:
       - baseline: Production snapshot (pre-deployment)
       - candidate: Production current (post-deployment)
       - scope: critical (P0/P1 tests and critical metrics only)
       - threshold: {from --regression-threshold parameter, default 0}

       Compare against baseline from .aiwg/working/deployment/production-baseline-snapshot.md

       Generate regression gate report:
       - Regression rate: {percentage}
       - New failures: {tests now failing}
       - Metric degradations: {SLO breaches}
       - Decision: PASS | FAIL
       - Severity: {CRITICAL | HIGH | MEDIUM | LOW}

       Use schema: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/regression-gate.yaml

       Output: .aiwg/deployment/regression-gate-production.md

       If FAIL (regression > threshold):
         - Check --rollback-on-regression flag
         - If enabled: Trigger automatic rollback
         - If disabled: Alert user, await manual decision
       """
   )
   ```

3. **Production Regression Gate Decision Point**:
   ```
   Read .aiwg/deployment/regression-gate-production.md

   Check regression_rate vs. threshold:

   If regression_rate <= threshold:
     ✓ Production regression gate PASSED
     → Continue monitoring, deployment successful

   If regression_rate > threshold:
     ❌ Production regression gate FAILED
     → Check --rollback-on-regression flag:

       If --rollback-on-regression enabled (default):
         ⚠️ Automatic rollback TRIGGERED
         → Execute Step 5 (Rollback)

       If --rollback-on-regression disabled:
         ⚠️ Regression detected, awaiting manual decision
         → Alert user with regression details
         → User must decide: [rollback | accept risk | investigate]

   Decision logged in deployment execution log
   ```

4. **Aggregate Monitoring Results**:
   ```
   # You monitor all 4 agents continuously
   # If ANY agent reports BREACH, FAIL, or UNHEALTHY → Trigger Step 5 (Rollback)
   # If production regression gate FAILS and --rollback-on-regression → Trigger Step 5 (Rollback)
   # If ALL agents report success for monitoring duration → Proceed to Step 6 (Success)
   ```

**Communicate Progress**:
```
⏳ Monitoring deployment health (15-30 min observation)...
  ✓ Production baseline captured: .aiwg/working/deployment/production-baseline-snapshot.md
  ✓ SLO monitoring: {PASS | BREACH} (updated every 5 min)
  ✓ Smoke tests: {PASS | FAIL}
  ✓ Infrastructure health: {HEALTHY | DEGRADED}
  ✓ Production regression gate: {PASS | FAIL} (regression {rate}% vs. threshold {threshold}%)
  {If regression detected}
  ⚠️ Regression detected: {rate}% > threshold {threshold}%
  {If --rollback-on-regression enabled}
  ⏳ Automatic rollback triggered...
  {If --rollback-on-regression disabled}
  ⚠️ Awaiting manual decision: [rollback | accept | investigate]
[If all passing for full duration]
✓ Deployment validation complete: All checks passed, no regressions
```

### Step 5: Rollback (If Failure or Regression Detected)

**Purpose**: Automated rollback execution if SLO breach, regression, or failure detected

**Trigger Conditions**:
- SLO breach detected (error rate, latency, throughput)
- Smoke test failure
- Infrastructure health degraded or unhealthy
- **Regression detected at production gate** (if `--rollback-on-regression` enabled)
- Manual abort by user

**Your Actions**:

1. **Execute Strategy-Specific Rollback**:
   ```
   Task(
       subagent_type="devops-engineer",
       description="Execute automated rollback",
       prompt="""
       ROLLBACK TRIGGERED: {reason - SLO breach | smoke test failure | infrastructure failure | regression detected}

       Execute rollback strategy: {Blue-Green | Canary | Rolling}

       **Blue-Green Rollback**:
       1. Switch traffic back to blue environment (instant cutover)
       2. Verify traffic flowing to blue (100% blue, 0% green)
       3. Confirm SLOs return to baseline
       4. Scale down green environment (optional, for cost)

       **Canary Rollback**:
       1. Abort canary rollout (stop progressive promotion)
       2. Scale down canary pods to 0
       3. Verify baseline serving 100% traffic
       4. Confirm SLOs return to baseline

       **Rolling Rollback**:
       1. Trigger rollout undo (revert to previous version)
       2. Wait for all pods to rollback to previous version
       3. Verify all pods running previous version
       4. Confirm SLOs return to baseline

       Log all rollback actions with timestamps

       Report:
       - Rollback trigger: {reason}
       - Rollback strategy: {strategy}
       - Rollback status: SUCCESS | FAILED
       - Duration: {minutes}
       - Traffic distribution: {current}
       - SLOs post-rollback: {status}

       Save to: .aiwg/deployment/rollback-execution-log.md

       If rollback FAILED: CRITICAL ESCALATION to Incident Commander
       """
   )
   ```

2. **Verify Rollback Success**:
   ```
   Task(
       subagent_type="reliability-engineer",
       description="Validate rollback successful",
       prompt="""
       Verify rollback restored stable state

       Validate:
       - [ ] Old version serving 100% traffic
       - [ ] SLOs returned to baseline (error rate, latency)
       - [ ] Smoke tests passing on rolled-back version
       - [ ] No active alerts or incidents
       - [ ] Infrastructure health restored

       Generate rollback validation report:
       - Status: SUCCESS | PARTIAL | FAILED
       - SLOs: {current vs. baseline}
       - Smoke tests: {PASS | FAIL}
       - Stability: {STABLE | UNSTABLE}

       Save to: .aiwg/working/deployment/rollback-validation-report.md

       If rollback FAILED or PARTIAL: CRITICAL ESCALATION
       """
   )
   ```

3. **Post-Rollback Regression Verification**:
   ```
   # Only if rollback triggered by regression

   Task(
       subagent_type="regression-analyst",
       description="Verify rollback eliminated regression",
       prompt="""
       Rollback complete, verify regression eliminated

       Execute regression check post-rollback:
       - Baseline: Production (pre-deployment snapshot)
       - Candidate: Production (post-rollback)

       Command: /regression-check --baseline production-pre-deploy --candidate production-post-rollback --scope critical

       Validate:
       - [ ] Regression eliminated (rate back to 0%)
       - [ ] All tests back to passing
       - [ ] Metrics returned to baseline

       Generate post-rollback regression report:
       - Regression eliminated: YES | NO
       - Tests restored: {count}/{total}
       - Metrics restored: {error rate, latency, throughput}

       Output: .aiwg/deployment/regression-verification-post-rollback.md

       If regression NOT eliminated: Deeper issue, escalate
       """
   )
   ```

4. **Declare Incident and Initiate RCA**:
   ```
   Task(
       subagent_type="incident-commander",
       description="Declare incident and start root cause analysis",
       prompt="""
       Deployment failed, rollback executed

       Declare incident:
       - Severity: P0 (if production impact) | P1 (if rollback successful)
       - Summary: Deployment rollback - {reason}
       - Impact: {describe user/business impact}
       - Timeline: {deployment start → failure detected → rollback completed}

       Include regression details if applicable:
       - Regression rate: {percentage}
       - Regression threshold: {threshold}
       - Specific regressions: {test failures, metric degradations}

       Initiate root cause analysis:
       - Assemble incident response team
       - Preserve all logs and metrics (deployment logs, SLO data, infrastructure snapshots, regression reports)
       - Schedule incident review meeting

       Use template: agentic/code/frameworks/ops-complete/templates/incident.md

       Output incident report: .aiwg/deployment/rollback-report-{version}.md
       """
   )
   ```

**Communicate Progress**:
```
❌ Deployment failure detected: {reason}
{If regression triggered}
⚠️ Regression detected: {rate}% > threshold {threshold}%
⏳ Executing automated rollback...
  ✓ Rollback execution: {SUCCESS | FAILED}
  ✓ Rollback validation: {SUCCESS | PARTIAL | FAILED}
  ✓ Regression verification: {ELIMINATED | PERSISTS}
  ✓ Incident declared: {incident-id}
✓ Rollback complete: Production restored to previous version
```

### Step 6: Generate Deployment Report (Success Path)

**Purpose**: Document successful deployment with metrics and lessons learned

**Your Actions**:

1. **Synthesize Deployment Summary**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Generate comprehensive deployment report",
       prompt="""
       Read all deployment artifacts:
       - .aiwg/deployment/deployment-readiness-report.md (pre-flight)
       - .aiwg/deployment/regression-gate-staging.md (staging regression check)
       - .aiwg/working/deployment/execution-log-*.md (deployment actions)
       - .aiwg/deployment/slo-monitoring-report.md (SLO validation)
       - .aiwg/deployment/regression-gate-production.md (production regression check)
       - .aiwg/working/deployment/smoke-test-results-*.md (test results)
       - .aiwg/working/deployment/infrastructure-health-report.md (health checks)

       Generate Deployment Summary Report:

       1. Overview
          - Status: SUCCESS | ROLLBACK
          - Version: {version}
          - Strategy: {Blue-Green | Canary | Rolling}
          - Duration: {total deployment time}

       2. Deployment Timeline
          - Pre-deployment validation: {timestamp, duration}
          - Staging regression gate: {timestamp, result}
          - Deployment execution: {timestamp, duration, strategy milestones}
          - Smoke tests: {timestamp, duration}
          - SLO monitoring: {timestamp, duration}
          - Production regression gate: {timestamp, result}
          - Completion: {timestamp}

       3. Pre-Deployment Validation Results
          - Quality gates: {status}
          - Environment health: {status}
          - Rollback readiness: {status}

       4. Regression Gate Results
          - Staging gate: {PASS | FAIL, regression rate: {rate}%}
          - Production gate: {PASS | FAIL, regression rate: {rate}%}
          - Threshold: {threshold}%
          - Rollback triggered: {YES | NO}

       5. Deployment Execution Details (strategy-specific)
          - {Blue-Green: green deployment, cutover, blue retirement}
          - {Canary: 1-5%, 25%, 50%, 100% progression}
          - {Rolling: node-by-node updates}

       6. SLO Metrics
          - Error rate: {baseline vs. post-deployment vs. target}
          - Latency p99: {baseline vs. post-deployment vs. target}
          - Throughput: {baseline vs. post-deployment}
          - Availability: {uptime percentage}

       7. Smoke Test Results
          - Critical path tests: {passed/total}
          - API tests: {passed/total}
          - Database tests: {passed/total}
          - Integration tests: {passed/total}

       8. Infrastructure Health
          - Pods: {running/total, restarts}
          - Nodes: {healthy/total}
          - Alerts triggered: {count, resolved}

       9. Issues and Resolutions
          - {list any issues encountered and how resolved}

       10. Lessons Learned
          - What went well: {list successes}
          - What could improve: {list improvement opportunities}
          - Action items: {concrete actions for future deployments}

       11. Approvals and Sign-offs
          - Deployment Manager: {name, timestamp}
          - Reliability Engineer: {name, timestamp}
          - Operations Lead: {name, timestamp}

       Use the deployment report fields listed above

       Output: .aiwg/reports/deployment-report-{version}.md
       """
   )
   ```

2. **Archive Workflow Artifacts**:
   ```
   # You handle archiving directly

   Archive complete deployment workflow:
   - Move .aiwg/working/deployment/ to .aiwg/archive/{date}/deployment-{version}/
   - Create audit trail: .aiwg/archive/{date}/deployment-{version}/audit-trail.md

   Audit trail includes:
   - Timeline of all agent actions
   - Decision points and outcomes
   - Regression gate results
   - SLO metrics snapshots
   - Final deployment report location
   ```

**Communicate Progress**:
```
⏳ Generating deployment report...
✓ Deployment report complete: .aiwg/reports/deployment-report-{version}.md
✓ Workflow archived: .aiwg/archive/{date}/deployment-{version}/
```

### Step 7: Notify Stakeholders and Update Documentation

**Purpose**: Communicate deployment outcome and update operational documentation

**Your Actions**:

1. **Generate Stakeholder Notification**:
   ```
   Task(
       subagent_type="support-lead",
       description="Draft stakeholder notification",
       prompt="""
       Read deployment report: .aiwg/reports/deployment-report-{version}.md

       Draft stakeholder notification email:

       Subject: Production Deployment {SUCCESS | COMPLETED WITH ROLLBACK} - Version {version}

       Body:
       - Deployment status: {SUCCESS | ROLLBACK}
       - Version deployed: {version}
       - Strategy used: {Blue-Green | Canary | Rolling}
       - Duration: {total time}
       - Regression gates: {PASSED | FAILED}
       - SLO metrics: {error rate, latency, availability}
       - User impact: {None | Minimal | Moderate}
       - Next steps: {monitoring, support readiness, known issues}

       Audience:
       - Executive stakeholders
       - Product team
       - Customer support team
       - Engineering team

       Save notification draft to: .aiwg/working/deployment/stakeholder-notification-{version}.md

       Note: User must review and send notification
       """
   )
   ```

2. **Update Operational Runbooks**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Update deployment runbooks with lessons learned",
       prompt="""
       Read lessons learned from deployment report

       Update deployment runbooks with improvements:
       - Process improvements identified
       - New smoke tests to add
       - SLO threshold adjustments
       - Regression gate threshold tuning
       - Monitoring improvements
       - Rollback procedure refinements

       Document updates to: .aiwg/deployment/deployment-runbook-updates-{version}.md

       Note: User should review and apply to operational documentation
       """
   )
   ```

**Communicate Progress**:
```
✓ Stakeholder notification drafted: .aiwg/working/deployment/stakeholder-notification-{version}.md
✓ Runbook updates documented: .aiwg/deployment/deployment-runbook-updates-{version}.md
```

## Final Summary Report

**Present to User**:

```
─────────────────────────────────────────────
Production Deployment Complete
─────────────────────────────────────────────

**Status**: {SUCCESS | ROLLBACK}
**Version**: {version}
**Strategy**: {Blue-Green | Canary | Rolling}
**Duration**: {total deployment time}

**Timeline**:
- Pre-deployment validation: {duration}
- Staging regression gate: {PASS | FAIL, regression {rate}%}
- Deployment execution: {duration}
- SLO monitoring: {duration}
- Production regression gate: {PASS | FAIL, regression {rate}%}
- Total: {total duration}

**Regression Gates**:
✓ Staging gate: {PASS | FAIL} (threshold: {threshold}%)
✓ Production gate: {PASS | FAIL} (threshold: {threshold}%)
{If regression detected}
⚠️ Regression: {rate}% {≤ | >} threshold {threshold}%
{If rollback triggered}
✓ Automatic rollback: {SUCCESS | FAILED}

**SLO Metrics**:
✓ Error rate: {current}% (target: <{target}%)
✓ Latency p99: {current}ms (target: <{target}ms)
✓ Throughput: {current} req/s (baseline: {baseline} req/s)
✓ Availability: {percentage}%

**Smoke Tests**: {passed}/{total} passed

**Infrastructure**: {pods} pods running, {nodes} nodes healthy

**Artifacts Generated**:
- Deployment Readiness Report: .aiwg/deployment/deployment-readiness-report.md
- Staging Regression Gate: .aiwg/deployment/regression-gate-staging.md
- Production Regression Gate: .aiwg/deployment/regression-gate-production.md
- SLO Monitoring Report: .aiwg/deployment/slo-monitoring-report.md
- Deployment Summary Report: .aiwg/reports/deployment-report-{version}.md
{If rollback}
- Rollback Report: .aiwg/deployment/rollback-report-{version}.md
- Regression Impact Assessment: .aiwg/deployment/regression-impact-assessment-*.md
- Incident Report: {link to incident}

**Next Steps**:
- Review deployment report for lessons learned
- Send stakeholder notification (draft ready)
- Update operational runbooks with improvements
- Continue monitoring SLOs for 24-48 hours
{If rollback}
- Conduct incident review meeting
- Perform root cause analysis on regression
- Fix issues identified
- Plan re-deployment

─────────────────────────────────────────────
```

## Regression-Blocked Deployment Example

**Scenario**: Staging regression gate detects 8% test failure rate (threshold: 5%)

```
─────────────────────────────────────────────
Deployment BLOCKED: Staging Regression Gate Failed
─────────────────────────────────────────────

**Status**: BLOCKED
**Version**: v2026.1.5
**Strategy**: Blue-Green
**Regression Detected**: 8.0% > threshold 5.0%

**Staging Regression Gate**:
❌ FAILED: 8.0% regression rate exceeds threshold
- Test failures: 12 new failures (150 total, 138 baseline)
- Metric degradations:
  • Error rate: 0.15% (+0.12% from baseline)
  • Latency p99: 580ms (+18% from baseline)
- Critical path: 2/10 user journeys failing

**Impact Assessment**:
- Severity: HIGH
- Affected areas: Authentication, Payment processing
- Root cause: New rate limiting logic breaking retry logic
- User impact: 15-20% of login attempts would fail

**Remediation Required**:
1. Revert rate limiting changes (commit abc123)
2. Add retry backoff logic to authentication client
3. Update tests to cover rate limiting scenarios
4. Re-deploy to staging and re-run regression check

**Artifacts**:
- Regression gate report: .aiwg/deployment/regression-gate-staging.md
- Impact assessment: .aiwg/deployment/regression-impact-assessment-staging.md

**Decision**: Deployment BLOCKED until regressions resolved

─────────────────────────────────────────────
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Pre-deployment validation passed (quality gates, environment health, rollback plan)
- [ ] Staging regression gate passed (or deployment blocked if failed)
- [ ] Deployment executed successfully (strategy-specific milestones)
- [ ] Smoke tests passed (production validation)
- [ ] SLOs met for monitoring duration (15-30 minutes)
- [ ] Production regression gate passed (or rollback triggered if failed)
- [ ] Deployment report generated with metrics and lessons learned
- [ ] Regression gate results documented
- [ ] Artifacts saved to .aiwg/deployment/ and .aiwg/reports/
- [ ] Working drafts archived to .aiwg/archive/
- [ ] Stakeholder notification drafted

## User Communication

**At start**: Confirm understanding and strategy

```
Understood. I'll orchestrate the production deployment.

Strategy: {Blue-Green | Canary | Rolling}
Version: {version}
Duration: {expected deployment time}
Regression Threshold: {threshold}%
Rollback on Regression: {enabled | disabled}

This will:
- Validate deployment readiness (quality gates, environment, rollback)
- Staging regression gate (block if regression > {threshold}%)
- Execute {strategy} deployment with continuous monitoring
- Production regression gate (rollback if regression > {threshold}%)
- Run smoke tests and SLO validation
- Automated rollback on failure or regression
- Generate comprehensive deployment report

Expected duration: {30-90 minutes for deployment, 10-15 minutes orchestration}

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Error/blocked
⚠️ = Warning/attention needed
```

**At end**: Summary report with status and artifacts (see Final Summary Report above)

## Error Handling

**Quality Gate Failure**:
```
❌ Pre-deployment validation failed: {gate-name}

Gaps identified:
- {list missing approvals or failures}

Recommendation: Resolve gate failures before proceeding
- Command: /gate-check transition
- Fix: {specific actions to resolve each gap}

Deployment BLOCKED until all gates pass.
```

**Staging Regression Gate Failure**:
```
❌ Staging regression gate failed: {regression-rate}% > threshold {threshold}%

Regressions detected:
- Test failures: {count new failures}
- Metric degradations: {error rate, latency, throughput}
- Critical paths affected: {list user journeys}

Impact assessment: .aiwg/deployment/regression-impact-assessment-staging.md

Recommendation: Fix regressions before production deployment
- Root cause: {likely causes}
- Fix: {specific remediation actions}
- Re-test: Run /regression-check after fixes

Deployment BLOCKED until regressions resolved.
```

**Environment Health Degraded**:
```
❌ Production environment unhealthy: {issue-description}

Issues:
- {list infrastructure problems}

Recommendation: Resolve environment issues before deploying
- Check: {kubectl commands to diagnose}
- Fix: {specific remediation actions}

Deployment BLOCKED until environment healthy.
```

**Deployment Execution Failure**:
```
❌ Deployment failed during execution: {error-message}

Error: {description}

Recommended Actions:
1. Review deployment logs: {path}
2. Check {specific components}: {diagnostic commands}
3. Fix identified issue
4. Re-run deployment

No rollback needed (failure before cutover to new version).
```

**SLO Breach Detected**:
```
❌ SLO breach detected: {slo-name}
- Current: {current-value}
- Target: {target-value}
- Threshold: {threshold-value}

Automated rollback TRIGGERED

⏳ Executing rollback...
✓ Rollback complete: Production restored to version {previous-version}
✓ SLOs returned to baseline

Incident declared: {incident-id}
Root cause analysis initiated.

Recommended Actions:
1. Review SLO monitoring report: {path}
2. Analyze failure reason: {likely causes}
3. Fix issues identified
4. Validate in staging
5. Plan re-deployment
```

**Production Regression Gate Failure**:
```
❌ Production regression gate failed: {regression-rate}% > threshold {threshold}%

Regressions detected:
- Test failures: {count new failures}
- Metric degradations: {error rate, latency, availability}
- User journeys affected: {list critical paths}

{If --rollback-on-regression enabled}
Automated rollback TRIGGERED

⏳ Executing rollback...
✓ Rollback complete: Production restored to version {previous-version}
✓ Regression verification: {ELIMINATED | PERSISTS}

{If --rollback-on-regression disabled}
⚠️ Manual decision required:
- [rollback] Rollback to previous version
- [accept] Accept regression risk, continue monitoring
- [investigate] Keep deployed, investigate root cause

Regression details: .aiwg/deployment/regression-gate-production.md

Incident declared: {incident-id}
Root cause analysis initiated.

Recommended Actions:
1. Review regression gate report: {path}
2. Analyze regression root cause: {likely causes}
3. Fix issues identified
4. Validate in staging with /regression-check
5. Plan re-deployment or accept risk
```

**Rollback Failure (CRITICAL)**:
```
❌ CRITICAL: Rollback failed - {error-message}

This is a P0 production incident.

IMMEDIATE ACTIONS:
1. Escalate to Incident Commander
2. Assemble incident response team
3. Manual intervention required: {specific actions}
4. Notify all stakeholders of service disruption

Incident declared: {incident-id}
Incident Commander: {contact info}

Do NOT attempt re-deployment until incident resolved.
```

**Smoke Test Failure**:
```
❌ Smoke tests failed: {test-name}

Failed tests:
- {list failures with details}

If deployed to production: Automated rollback TRIGGERED
If not yet cutover: Deployment STOPPED (no rollback needed)

Recommended Actions:
1. Review smoke test logs: {path}
2. Diagnose failure: {likely causes}
3. Fix issues identified
4. Re-run smoke tests in staging
5. Plan re-deployment
```

## Success Criteria

This orchestration succeeds when:
- [ ] Pre-deployment validation passed (all quality gates GO)
- [ ] Deployment strategy selected and confirmed
- [ ] Staging regression gate passed (regression ≤ threshold)
- [ ] Deployment executed successfully (strategy-specific milestones)
- [ ] Smoke tests passed (production validation)
- [ ] SLOs met for monitoring duration (15-30 minutes)
- [ ] Production regression gate passed (regression ≤ threshold)
- [ ] No rollback triggered (or rollback successful if triggered)
- [ ] Deployment report generated with metrics and lessons learned
- [ ] Regression analysis documented
- [ ] Stakeholder notification drafted
- [ ] Operational runbooks updated with improvements
- [ ] Complete audit trails archived

## Metrics to Track

**During orchestration, track**:
- Deployment duration: {total time from start to completion}
- Regression rates: {staging and production}
- SLO metrics: {error rate, latency, throughput, availability}
- Smoke test pass rate: {passed/total}
- Infrastructure health: {pods running, nodes healthy, alerts triggered}
- Rollback count: {number of rollbacks triggered}
- Regression-triggered rollbacks: {count}
- Mean time to rollback (MTTR): {time from failure detection to rollback completion}

## References

**Templates** (via $AIWG_ROOT):
- Deployment Plan: `agentic/code/frameworks/sdlc-complete/templates/deployment/deployment-plan-template.md`
- Rollback Plan: rollback steps in this skill
- SLO Definition: `agentic/code/frameworks/sdlc-complete/templates/reliability/slo-sli-template.md`
- Smoke Test Checklist: `agentic/code/frameworks/sdlc-complete/templates/test/test-suite-card.md`
- Deployment Report: deployment report fields in this skill
- Incident Report: `agentic/code/frameworks/ops-complete/templates/incident.md`

**Gate Criteria**:
- `flows/gate-criteria-by-phase.md` (Transition section)

**Schemas**:
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/regression-gate.yaml - Regression gate format

**Commands**:
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/regression-check.md - Regression detection command

**Agents**:
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/regression-analyst.md - Regression analysis agent

**Multi-Agent Pattern**:
- `docs/multi-agent-documentation-pattern.md`

**Orchestrator Architecture**:
- `docs/orchestrator-architecture.md`

**Natural Language Translations**:
- `docs/simple-language-translations.md`
