---
name: feedback-needed
description: Request feedback on an issue with context, completed work, review questions, blocking items, and requested reviewers.
---

# Feedback Needed Comment Template

## Request for Review

**Status**: Awaiting Feedback
**Requested by**: {agent_or_user}
**Request date**: {timestamp}
**Priority**: {low|medium|high|urgent}

## Context

{brief_description_of_current_state}

## Work Completed So Far

{summary_of_progress}

### Deliverables Ready for Review

- [ ] {deliverable_1} - `{path}` - {description}
- [ ] {deliverable_2} - `{path}` - {description}
- [ ] {deliverable_3} - `{path}` - {description}

## Feedback Requested On

### Critical Decisions
{if_applicable}
1. {decision_point_1}
   - Option A: {description}
   - Option B: {description}
   - Recommendation: {recommendation}

### Areas Needing Validation
{if_applicable}
- {area_1}: {specific_question}
- {area_2}: {specific_question}

### Review Focus Areas
{if_applicable}
- {focus_1}: {why_this_needs_attention}
- {focus_2}: {why_this_needs_attention}

## Specific Questions

1. {question_1}
2. {question_2}
3. {question_3}

## Label State

Apply the configured human-interaction semantic label while any specific
question above is unanswered. If `issues.labels` is absent, warn before using an
existing legacy `question` label and never provision it implicitly. Remove or
transition the label only after all tracked questions in this comment satisfy
the configured resume condition.

## Blocking Items

{if_applicable}
- {blocker_1}: {description_and_impact}
- {blocker_2}: {description_and_impact}

## Scope Impact

{if_applicable}
- Acceptance criteria awaiting feedback: {criterion_ids}
- Work that can proceed independently: {scope_units_or_none}
- Work blocked pending feedback: {blocked_scope_and_dependencies}

## Requested Reviewers

{if_applicable}
@{reviewer_1} - {expertise_area}
@{reviewer_2} - {expertise_area}

## How to Provide Feedback

1. Review the deliverables listed above
2. Comment on this issue with your feedback
3. Indicate approval or request changes
4. Tag specific items if providing targeted feedback

---

*Awaiting your review to proceed. Please prioritize if marked as high/urgent priority.*
