---
name: progress-update
description: Post a status update on an issue using this progress update comment template: completed work, current tasks, next steps, blockers, and verification metrics.
---

# Progress Update Comment Template

## Progress Report

**Status**: In Progress
**Updated by**: {agent_or_user}
**Update date**: {timestamp}
**Acceptance criteria**: {met} of {total} met

## Current Phase

{current_phase_or_milestone}

## Completed Since Last Update

### Accomplishments
- {accomplishment_1}
- {accomplishment_2}
- {accomplishment_3}

### Deliverables Completed
{if_applicable}
- [ ] ✅ {deliverable_1} - `{path}`
- [ ] ✅ {deliverable_2} - `{path}`

### Tests Added
{if_applicable}
- {test_description} - Acceptance criteria verified: {criterion_ids}

## Currently Working On

### Active Tasks
- [ ] 🔄 {task_1} - Status: {status_detail}
- [ ] 🔄 {task_2} - Status: {status_detail}

### Acceptance Criteria Pending
- [ ] {criterion_id}: {remaining_work_and_verification}
- Passes completed: {count} - {verification_results}

## Upcoming Work

### Next Sprint/Phase
- [ ] {upcoming_task_1}
- [ ] {upcoming_task_2}
- [ ] {upcoming_task_3}

## Challenges and Issues

{if_applicable}
### Resolved
- {challenge_1}: {how_it_was_resolved}

### Open
- {challenge_2}: {current_status_and_plan}

### Risks
- {risk_1}: Probability: {low|medium|high}, Impact: {low|medium|high}

## Metrics

{if_applicable}
- Acceptance criteria verified: {met}/{total}
- Tests passing: {count}/{total}
- Issues resolved: {count}
- PRs merged: {count}

## Blockers and Dependencies

- Blocked criteria: {criterion_ids_or_none}
- Required inputs: {dependencies_or_none}
- Next verification gate: {check_or_command}

{if_blocked_or_at_risk}
### Blocker Concerns
{explanation_of_blockers_or_risks}

### Mitigation Plan
{plan_to_unblock_remaining_criteria}

## Dependencies

### Completed Dependencies
{if_applicable}
- ✅ {dependency_1} - Unblocked by #{issue_number}

### Waiting On
{if_applicable}
- ⏳ {dependency_1} - Blocked by #{issue_number}
- ⏳ {dependency_2} - Ready when: {observable_condition}

## Resource Needs

{if_applicable}
- {resource_1}: {description_and_justification}
- {resource_2}: {description_and_justification}

## Decisions Made

{if_applicable}
1. **{decision_1}**: {description_and_rationale}
2. **{decision_2}**: {description_and_rationale}

## Questions/Clarifications Needed

{if_applicable}
1. {question_1}
2. {question_2}

## Next Update

Trigger: {acceptance_criterion_met_or_blocker_state_changed}

---

*Regular progress update. Work continues as planned. No action required unless questions/concerns raised above.*
