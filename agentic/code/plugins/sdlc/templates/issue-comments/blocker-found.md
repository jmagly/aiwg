---
name: blocker-found
description: Post a blocker found comment on an issue with cause, impact, attempted resolutions, recommended action, and escalation.
---

# Blocker Found Comment Template

## Blocker Alert

**Status**: Blocked
**Reported by**: {agent_or_user}
**Reported date**: {timestamp}
**Severity**: {critical|high|medium|low}
**Impact**: {project-wide|phase|task|minimal}

## Blocker Description

{clear_description_of_blocker}

## Root Cause

{if_known}
{description_of_root_cause}

{if_unknown}
Under investigation. Initial observations:
- {observation_1}
- {observation_2}

## Impact Assessment

### Immediate Impact
- {impact_1}
- {impact_2}

### Downstream Impact
{if_applicable}
- Blocks: #{issue_numbers}
- Affects: {phases_or_components}
- Timeline impact: {delay_estimate}

### Risk Level
- **Technical Risk**: {low|medium|high|critical}
- **Schedule Risk**: {low|medium|high|critical}
- **Quality Risk**: {low|medium|high|critical}

## Attempted Resolutions

{if_applicable}
1. {attempt_1} - Result: {outcome}
2. {attempt_2} - Result: {outcome}

## Proposed Solutions

### Option 1: {solution_name}
- **Description**: {detailed_description}
- **Effort**: {time_estimate}
- **Risk**: {risk_assessment}
- **Trade-offs**: {pros_and_cons}

### Option 2: {solution_name}
{if_applicable}
- **Description**: {detailed_description}
- **Effort**: {time_estimate}
- **Risk**: {risk_assessment}
- **Trade-offs**: {pros_and_cons}

## Recommended Action

{recommended_solution_with_rationale}

## Dependencies for Resolution

{if_applicable}
- External: {external_dependencies}
- Internal: {internal_dependencies}
- Resources needed: {resources}

## Escalation Path

{if_applicable}
- Level 1: {contact_or_team}
- Level 2: {contact_or_team}
- Escalate if not resolved by: {date_or_timeline}

## Work Stopped

{list_of_work_items_blocked}
- Task: {task_name} - Issue: #{issue_number}
- Task: {task_name} - Issue: #{issue_number}

## Workarounds

{if_applicable}
Temporary workaround available:
{description_of_workaround}

Limitations:
- {limitation_1}
- {limitation_2}

## Required Decision Makers

{if_applicable}
@{decision_maker_1} - {role}
@{decision_maker_2} - {role}

---

**ACTION REQUIRED**: This is a blocking issue that requires immediate attention. Please review and provide direction on resolution approach.
