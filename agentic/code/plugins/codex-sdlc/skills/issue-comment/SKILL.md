---
namespace: aiwg
name: issue-comment
platforms: [all]
description: Add structured comments to issues using templates for progress, feedback, or blockers
commandHint:
  argumentHint: <issue_number> --type <progress|feedback|blocker|custom> [--content <text>]
  allowedTools: Bash(git *, gh *), Read, Write, mcp__gitea__*
  model: haiku
  category: project-management
  modelRole: efficiency
  modelTier: economy
---

# Issue Comment

## Output template

Use the matching issue progress or blocker comment template: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/issue-comments/progress-update.md; @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/issue-comments/blocker-found.md. Fill every required section; explain non-applicable fields and unrun checks.

## Semantic Label Contract (#1789)

When a comment requests human action, resolve the configured
human-interaction role from `.aiwg/aiwg.config` `issues.labels`. If that role
blocks automation, the comment must name the required action and quote its
`resume_when` condition before the resolved provider-native label is applied.
Never provision or invent a label absent from configuration or the tracker;
preserve unrelated labels and emit the documented legacy fallback warning when
the taxonomy is absent.

You are an Issue Communication Specialist responsible for adding clear, structured comments to issues using standardized templates.

## Your Task

Add structured comments to issues for:
1. Progress updates
2. Feedback requests
3. Blocker notifications
4. Custom formatted comments

## Input Modes

### Progress Update
```bash
/issue-comment 17 --type progress
```
Adds a progress update using the `progress-update.md` template with auto-detected context.

### Feedback Request
```bash
/issue-comment 17 --type feedback
```
Adds a feedback request using the `feedback-needed.md` template.

### Blocker Notification
```bash
/issue-comment 17 --type blocker
```
Adds a blocker notification using the `blocker-found.md` template.

### Custom Comment
```bash
/issue-comment 17 --type custom --content "This is a custom formatted comment"
```
Adds a custom comment without using a template.

### Interactive Mode
```bash
/issue-comment 17 --type feedback --interactive
```
Prompts for details to fill in the template interactively.

## Workflow

### Step 1: Validate Issue

**Check Issue Exists and is Open**:

```bash
# GitHub
gh issue view {issue_number}

# Gitea (use MCP)
# Query issue via mcp__gitea__ tools
```

**Validation Checks**:
- [ ] Issue exists
- [ ] Issue is open (warn if closed)
- [ ] User has permission to comment

**If validation fails**:
```markdown
Error: Cannot add comment to issue #{number}
Reason: {validation_failure_reason}

Suggestions:
- Verify issue number is correct
- Check that issue exists
- Ensure you have permission to comment
```

### Step 2: Gather Context

Automatically collect context for template population:

**Git Context**:
```bash
# Current branch
git rev-parse --abbrev-ref HEAD

# Recent commits
git log -5 --oneline

# Changed files since branch point
git diff --name-only main...HEAD

# Current commit info
git log -1 --format="%an|%ae|%cd|%s"
```

**AIWG Context**:
```bash
# Recent artifacts modified
git diff --name-only main...HEAD .aiwg/

# Find artifacts related to this issue
grep -r "#${issue_number}" .aiwg/ --files-with-matches
```

**Test Context** (if available):
```bash
# Check test status
npm test 2>&1 | tail -20

# Coverage if available
npm test -- --coverage --json 2>/dev/null
```

**Build/CI Context**:
```bash
# GitHub Actions status
gh run list --limit 3 --json conclusion,name,createdAt

# Or check local build status
ls -lt dist/ build/ 2>/dev/null | head -5
```

### Step 3: Select and Load Template

Based on `--type`, load appropriate template:

**Template Mapping**:

| Type | Template File | Use Case |
|------|--------------|----------|
| `progress` | `progress-update.md` | Regular work updates |
| `feedback` | `feedback-needed.md` | Request review or input |
| `blocker` | `blocker-found.md` | Report blocking issues |
| `custom` | None | Freeform comment |

`address-issues` cycle comments are not generic `progress` comments. They use
the single canonical `templates/issue-comments/al-cycle.md` contract and
`address-issues/scripts/cycle-comment.mjs` renderer/validator. The exact
rendered payload must validate before any tracker write; native-goal and resumed
cycles may not fall back to `custom` or an abbreviated free-form comment.

**Load Template**:
```bash
# Read template
template_path="agentic/code/frameworks/sdlc-complete/templates/issue-comments/${type}.md"
template_content=$(cat "${template_path}")
```

### Step 4: Populate Template

#### Progress Update Template

**Auto-Fill Fields**:

```markdown
## Progress Report

**Status**: In Progress
**Updated by**: {git_user_name}
**Update date**: {current_timestamp}
**Progress**: {auto_calculate}% complete

## Current Phase

{infer_from_branch_name_or_artifacts}

## Completed Since Last Update

### Accomplishments
{extract_from_recent_commits}
- {commit_message_1}
- {commit_message_2}

### Deliverables Completed
{find_new_artifacts_or_files}
- [x] ✅ {artifact_path} - {description_from_commit}

### Tests Added
{grep_for_new_test_files}
- {test_description} - Coverage: {percentage}%

## Currently Working On

### Active Tasks
{extract_from_uncommitted_changes_or_branch}
- [ ] 🔄 {task_from_todo_or_branch_name}

## Challenges and Issues

{check_for_fixme_or_todo_comments}
### Open
- {challenge_from_comment}: {current_status}

## Timeline Status

- Original estimate: {extract_from_issue_body_if_available}
- Current projection: {estimate_based_on_velocity}
- Status: {on_track|at_risk|delayed}

---

*Regular progress update. Work continues as planned.*
```

**Interactive Prompts** (if `--interactive`):
```
Q: What percentage complete is this task? [0-100]: 60
Q: What have you accomplished since the last update?: Implemented API endpoints, added unit tests
Q: Are there any blockers or challenges? [y/n]: n
Q: When do you expect to complete this? [date or duration]: 2 days
```

#### Feedback Request Template

**Auto-Fill Fields**:

```markdown
## Request for Review

**Status**: Awaiting Feedback
**Requested by**: {git_user_name}
**Request date**: {current_timestamp}
**Priority**: {auto_determine_priority}

## Context

{extract_from_recent_work}

## Work Completed So Far

{summary_of_commits_and_artifacts}

### Deliverables Ready for Review

{find_completed_artifacts}
- [ ] {deliverable_1} - `{path}` - {description}

## Feedback Requested On

### Critical Decisions
{if_applicable}
1. {extract_from_TODO_comments_or_ADRs}

### Areas Needing Validation
{if_applicable}
- {area_from_FIXME_or_comments}

## Specific Questions

{if_provided_via_interactive_or_content}
1. {question_1}
2. {question_2}

## Timeline Impact

{if_applicable}
- Waiting since: {current_date}
- Impact if delayed: {estimate_based_on_dependencies}

## How to Provide Feedback

1. Review the deliverables listed above
2. Comment on this issue with your feedback
3. Indicate approval or request changes

---

*Awaiting your review to proceed.*
```

**Interactive Prompts** (if `--interactive`):
```
Q: What priority level? [low/medium/high/urgent]: high
Q: What specific areas need feedback?: Architecture decision for data storage
Q: What questions do you have?: Should we use PostgreSQL or MongoDB?
Q: What deliverables are ready?: .aiwg/architecture/sad.md, .aiwg/architecture/adr-001.md
Q: Are there any blockers while waiting? [y/n]: n
```

#### Blocker Notification Template

**Auto-Fill Fields**:

```markdown
## Blocker Alert

**Status**: Blocked
**Reported by**: {git_user_name}
**Reported date**: {current_timestamp}
**Severity**: {critical|high|medium|low}
**Impact**: {project-wide|phase|task|minimal}

## Blocker Description

{blocker_description_from_user_or_interactive}

## Root Cause

{if_known}
{description}

{if_unknown}
Under investigation. Initial observations:
- {observation_from_logs_or_errors}

## Impact Assessment

### Immediate Impact
- Work stopped on: {current_branch_or_task}
- Affects: {related_issues_or_components}

### Downstream Impact
{check_for_dependent_issues}
- Blocks: #{issue_numbers_from_dependencies}
- Timeline impact: {estimate_delay}

### Risk Level
- **Technical Risk**: {assess_based_on_severity}
- **Schedule Risk**: {assess_based_on_timeline}
- **Quality Risk**: {assess_based_on_impact}

## Proposed Solutions

### Option 1: {solution_name}
{from_user_or_interactive}
- **Description**: {description}
- **Effort**: {estimate}
- **Risk**: {assessment}

## Recommended Action

{recommended_solution}

## Work Stopped

{list_affected_work}
- Task: {current_work} - Issue: #{issue_number}

---

**ACTION REQUIRED**: This is a blocking issue requiring immediate attention.
```

**Interactive Prompts** (if `--interactive`):
```
Q: Describe the blocker: External API rate limit reached, blocking integration tests
Q: Severity? [critical/high/medium/low]: high
Q: Impact scope? [project-wide/phase/task/minimal]: phase
Q: Root cause known? [y/n]: y
Q: Root cause description: Third-party API limits to 100 req/hour, need 500+
Q: Proposed solution: Use paid tier or implement request queuing
Q: Recommended action: Upgrade to paid tier ($99/mo)
Q: Does this block other issues? [issue numbers or n]: 18, 19
```

#### Custom Comment

**If `--content` provided**:
```markdown
{content_exactly_as_provided}
```

**If interactive**:
```
Q: Enter your comment (multiline, end with Ctrl+D):
{user_types_content}
```

### Step 5: Review and Confirm

**Show Preview**:

```markdown
## Comment Preview

Issue: #{issue_number} - {title}
Type: {comment_type}

---

{rendered_template}

---

Post this comment? [y/n]:
```

**Auto-post if non-interactive**:
Skip preview and post immediately unless `--dry-run`.

### Step 6: Post Comment

**GitHub**:

```bash
# Post comment
gh issue comment {issue_number} --body "{comment_body}"

# Optionally add label
gh issue edit {issue_number} --add-label "{label_based_on_type}"
```

**Gitea**:

```bash
# Post comment using MCP
mcp__gitea__create_issue_comment \
  --owner {owner} \
  --repo {repo} \
  --issue_number {number} \
  --body "{comment_body}"

# Optionally update issue state or labels
```

**Label Mapping**:

| Comment Type | Suggested Label |
|--------------|----------------|
| `progress` | `in-progress` |
| `feedback` | `needs-review` |
| `blocker` | `blocked` |
| `custom` | None |

### Step 7: Update Related Systems

**If blocker notification**:

```bash
# Find dependent issues
gh issue list --search "depends on #{issue_number}" --json number

# Notify dependent issues
for dep_issue in ${dependent_issues}; do
  gh issue comment ${dep_issue} --body "⚠️ Dependency blocked: Issue #{issue_number} is currently blocked. See #{issue_number} for details."
done
```

**If feedback request**:

```bash
# Assign reviewers if specified
gh issue edit {issue_number} --add-assignee {reviewers}

# Add to project board "Needs Review" column (if applicable)
gh project item-add --owner {owner} --project {project} --issue {issue_number}
```

### Step 8: Generate Report

```markdown
## Comment Posted

**Issue**: #{issue_number} - {title}
**Type**: {comment_type}
**Posted by**: {user}
**Posted at**: {timestamp}

### Summary

{brief_summary_of_comment}

### Actions Taken

- [x] Comment posted to issue #{issue_number}
- [x] Label added: {label}
{if_applicable}
- [x] Dependent issues notified: #{numbers}
- [x] Reviewers assigned: @{usernames}

### Next Steps

{based_on_comment_type}
- For progress: Continue work, post next update in {timeframe}
- For feedback: Await review from {reviewers}
- For blocker: {recommended_action}

### Links

- Issue: {issue_url}
- Comment: {comment_url}

---

Comment successfully posted.
```

## Comment Type Details

### Progress Update

**When to use**:
- Regular status updates (weekly, bi-weekly)
- After completing significant milestones
- When asked for status
- Before phase transitions

**What to include**:
- Work completed since last update
- Current work in progress
- Upcoming work
- Challenges or risks
- Timeline status

**Auto-detection**:
- Parse recent commits for accomplishments
- Check for new test files
- Identify new AIWG artifacts
- Calculate progress from subtasks

### Feedback Request

**When to use**:
- Need architectural review
- Seeking input on design decisions
- Requesting code review
- Validating approach before proceeding

**What to include**:
- Clear description of what needs feedback
- Specific questions or decision points
- Deliverables ready for review
- Timeline constraints
- Recommended reviewers

**Auto-detection**:
- Find uncommitted architectural docs
- Locate ADRs awaiting decision
- Identify branches awaiting PR

### Blocker Notification

**When to use**:
- External dependency unavailable
- Technical blocker preventing progress
- Resource constraint (access, permissions)
- Waiting on decision or approval

**What to include**:
- Clear blocker description
- Impact assessment
- Proposed solutions
- Required actions
- Escalation path

**Auto-detection**:
- Check for error logs
- Identify failed CI runs
- Find commented-out code with explanations
- Detect dependency issues

### Custom Comment

**When to use**:
- Template doesn't fit the situation
- Quick informal update
- Linking external resources
- Administrative notes

**What to include**:
- Whatever the user specifies

## Configuration

### `.aiwg/config.yaml`

```yaml
issue_comment:
  default_type: progress
  auto_add_labels: true
  label_mapping:
    progress: "in-progress"
    feedback: "needs-review"
    blocker: "blocked"
  notify_dependencies: true
  auto_assign_reviewers: false
  templates:
    progress: "templates/issue-comments/progress-update.md"
    feedback: "templates/issue-comments/feedback-needed.md"
    blocker: "templates/issue-comments/blocker-found.md"
```

## Best Practices

### Progress Updates

**Frequency**:
- Daily for active sprint work
- Weekly for longer-term projects
- After each significant milestone

**Content**:
```markdown
✅ What's done (concrete deliverables)
🔄 What's in progress (current focus)
📅 What's next (upcoming work)
⚠️  Risks or blockers (if any)
```

**Example**:
```markdown
## Progress Update

Week of Jan 8-12, 2025

✅ Completed:
- Implemented issue sync detection logic
- Added 15 unit tests (coverage now 85%)
- Created issue comment templates

🔄 In Progress:
- Writing integration tests
- Documenting CLI usage

📅 Next:
- E2E testing with live repos
- Update README and docs

⚠️  No blockers. On track for Jan 15 completion.
```

### Feedback Requests

**Be Specific**:
```markdown
❌ Bad: "Please review this"
✅ Good: "Please review the architectural decision in .aiwg/architecture/adr-017.md. Specifically, should we use polling or webhooks for issue updates?"
```

**Provide Context**:
```markdown
Context: We need real-time issue updates but GitHub has rate limits.

Options:
1. Polling every 5 minutes (simple, might hit rate limits)
2. Webhooks (complex setup, requires server)

Recommendation: Start with polling, add webhooks later if needed.

Question: Does this trade-off make sense for v1?
```

### Blocker Notifications

**Urgency Levels**:

| Severity | Response Time | Escalation |
|----------|--------------|------------|
| Critical | Immediate | Escalate after 1 hour |
| High | Same day | Escalate after 1 day |
| Medium | 1-2 days | Escalate after 1 week |
| Low | Best effort | No escalation |

**Example**:
```markdown
## Blocker: GitHub API Rate Limit

Severity: High
Impact: Phase-level (blocks all integration tests)

Root Cause: Exceeded 5000 req/hour limit during test runs.

Proposed Solutions:
1. Use authenticated requests (10x higher limit) - 2 hours effort
2. Implement request caching - 4 hours effort
3. Reduce test frequency - 30 min effort (temporary)

Recommendation: #1 (authenticated requests) for permanent fix, #3 as immediate workaround.

Work Stopped:
- Integration test development
- CI pipeline testing

Escalate if: Not resolved by EOD (blocks sprint completion)
```

## Advanced Features

### Template Customization

**Project-Specific Templates**:

Create custom templates in `.aiwg/templates/issue-comments/`:

```markdown
# custom-deployment-update.md

## Deployment Progress

**Environment**: {environment}
**Release**: {version}
**Status**: {status}

### Deployment Steps

- [x] Build completed
- [x] Tests passing
- [ ] Deployed to staging
- [ ] Smoke tests passed
- [ ] Deployed to production

### Rollback Plan

{rollback_instructions}
```

Use with:
```bash
/issue-comment 17 --template custom-deployment-update
```

### Mention Notifications

Automatically @-mention relevant people:

```markdown
## Feedback Needed

@architect - Please review the database schema design
@security-team - Please validate the auth approach
@product-manager - Please confirm this meets requirements

{rest_of_feedback_request}
```

Configure in `.aiwg/config.yaml`:
```yaml
issue_comment:
  auto_mention:
    feedback:
      - "@architect"
      - "@security-team"
    blocker:
      - "@tech-lead"
      - "@project-manager"
```

### Rich Formatting

**Include Diagrams**:
```markdown
## Architecture Update

Current flow:
\`\`\`mermaid
graph LR
  A[Client] --> B[API]
  B --> C[Database]
\`\`\`

{rest_of_comment}
```

**Include Code Snippets**:
```markdown
## Implementation Update

Added authentication middleware:

\`\`\`typescript
export const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization;
  // ... implementation
};
\`\`\`

{rest_of_comment}
```

## References

- Templates: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/issue-comments/
- Related: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-sync.md, @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-close.md
- MCP tools: Gitea issue management
- GitHub CLI: `gh issue comment`

## Success Criteria

This command succeeds when:

- [x] Comment successfully posted to issue
- [x] Template correctly populated with context
- [x] Appropriate labels added
- [x] Related issues notified (if applicable)
- [x] Reviewers assigned (if feedback request)
- [x] Clear report generated
- [x] Interactive prompts work correctly
- [x] Auto-detection gathers relevant context
