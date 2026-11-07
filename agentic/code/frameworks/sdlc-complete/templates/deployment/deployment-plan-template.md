# Deployment Plan Template

## Purpose

Describe how the solution will be deployed, verified, and supported in target environments during the Transition phase.

## Ownership & Collaboration

- Document Owner: Deployment Manager
- Contributor Roles: Integrator, Configuration Manager, Test Architect
- Automation Inputs: Release candidate designation, environment matrix, rollout constraints
- Automation Outputs: `deployment-plan.md` covering sections 1–12

## Completion Checklist

- Deployment steps sequenced with owners and timing
- Environment prerequisites, data migration, and rollback strategies defined
- Verification activities and success metrics established

## Document Sections

1. **Introduction**
   - Purpose, scope, release identifiers, and references.
2. **Deployments Table (12-Factor I — One Codebase, Many Deploys)**
   - Enumerate every environment the codebase targets. One row per deployed environment. Columns: environment name, purpose, URL (if applicable), deployed artifact (image tag pattern), scaling profile, owner.
   - The table makes explicit what 12-factor calls "many deploys from one codebase." If rows differ in more than environment name and scale, flag the divergence — same codebase should mean structurally equivalent deployments.
3. **Deployment Strategy**
   - Deployment model (big bang, phased, blue/green, canary) and rationale.
4. **Environments and Prerequisites**
   - List target environments, configurations, access requirements, and readiness checks.
5. **Rolling Restart Strategy (12-Factor IX — Disposability)**
   - Grace period for SIGTERM before SIGKILL (typical: 30s for web, 60s for workers).
   - Load balancer readiness probe grace (connection draining window).
   - Per-process-type restart concurrency (`maxUnavailable`, `maxSurge` for k8s).
   - Verification that startup time measurement passes the < 10s NFR from the SAD.
6. **Deployment Gates**
   - Ordered rollout gates, responsible roles, and observable communication checkpoints. Record operator-supplied freeze windows separately with their source; do not generate work-duration estimates.
7. **Deployment Steps**
   - Detailed step-by-step procedure with responsible parties, prerequisites, scope units, and completion checks. Record measured service timings as observations, separate from planning.
8. **Admin Tasks for This Release (12-Factor XII — Admin Processes)**
   - List every admin task required for this release (migrations, backfills, key rotations). Reference `templates/deployment/admin-processes-template.md`.
   - For each task: ADM-ID, category, ordering (pre-deploy / during / post-deploy), approval status, rollback procedure.
   - Ad-hoc scripts or manual data fixes are NOT permitted — everything traces to a documented ADM-XXX entry.
9. **Data Migration Plan**
   - Describe data preparation, migration scripts, validation, and backout steps.
10. **Verification and Validation**
    - Outline smoke tests, health checks, and monitoring to confirm success.
11. **Rollback and Contingency**
    - Provide rollback triggers, procedures, and decision authorities.
12. **Communication Plan**
    - Define stakeholder notifications before, during, and after deployment.
13. **Support Handover**
    - Document training, documentation, SLAs, and on-call rotation updates.
14. **Risk Management**
    - Identify deployment risks and mitigation/responsible owners.
15. **Approvals**
    - Capture sign-offs required before proceeding.

## Agent Notes

- Use tables for steps, linking to scripts or playbooks stored in the repo or external automation.
- Coordinate with Release Notes, Product Acceptance Plan, and Support Runbook for consistency.
- Update the plan after each rehearsal or dry run to reflect lessons learned.
- Verify the Automation Outputs entry is satisfied before signaling completion.
