---
name: progress-update
description: Post a status update on an issue using this progress update comment template: completed work, current tasks, next steps, blockers, and verification metrics.
---

# Progress Update Comment Template

## Progress Report

**Status**: In Progress
**Updated by**: {agent_or_user}
**Update date**: {timestamp}
**Progress**: {percentage}% complete

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
- {test_description} - Coverage: {percentage}%

## Currently Working On

### Active Tasks
- [ ] 🔄 {task_1} - Status: {status_detail}
- [ ] 🔄 {task_2} - Status: {status_detail}

### Time Spent
- This update period: {hours}
- Total to date: {hours}

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
- Code coverage: {percentage}%
- Tests passing: {count}/{total}
- Issues resolved: {count}
- PRs merged: {count}

## Timeline Status

- Original estimate: {date_or_duration}
- Current projection: {date_or_duration}
- Status: {on_track|at_risk|delayed}
- Variance: {delta_from_original}

{if_delayed_or_at_risk}
### Timeline Concerns
{explanation_of_delays_or_risks}

### Mitigation Plan
{plan_to_get_back_on_track}

## Dependencies

### Completed Dependencies
{if_applicable}
- ✅ {dependency_1} - Unblocked by #{issue_number}

### Waiting On
{if_applicable}
- ⏳ {dependency_1} - Blocked by #{issue_number}
- ⏳ {dependency_2} - Expected: {date}

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

Expected: {date_or_timeline}

---

*Regular progress update. Work continues as planned. No action required unless questions/concerns raised above.*
