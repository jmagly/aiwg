---
namespace: aiwg
name: issue-update
platforms: [all]
description: Update existing ticket/issue with status changes, comments, or field updates
commandHint:
  argumentHint: <ticket-id> [--status STATUS --comment "text" --assignee USER --labels "label1,label2" --priority LEVEL]
  allowedTools: Read, Write, Glob, Bash, mcp__gitea__edit_issue, mcp__gitea__create_issue_comment
  model: haiku
  category: project-management
  modelRole: efficiency
  modelTier: economy
---

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills, **not slash commands**. Most are not kernel-listed and cannot be invoked as `/skill-name` by the platform. Reach them via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name>
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `steward`) are directly invokable as slash commands. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# Issue Update

## Semantic Label Contract (#1789)

Resolve label mutations through `.aiwg/aiwg.config` `issues.labels` for the
provider selected by `remotes.issue_tracker`. Add a role only when its declared
condition is true. When `resume_when` is satisfied, remove the transient role
or replace it with `transition_to` in one read-modify-write operation that
preserves unrelated labels. Never provision missing configured labels
implicitly; report them as diagnostics. Warn explicitly before legacy name
fallback.

## Purpose

Update an existing ticket/issue with status transitions, progress comments, assignee changes, or metadata updates. Automatically uses the configured ticketing provider (Gitea, GitHub, Jira, Linear) or local file-based tracking.

## Task

Given a ticket ID and update parameters:

1. **Load configuration** from `.aiwg/config.yaml` or project `CLAUDE.md`
2. **Validate ticket exists** on provider or in local files
3. **Apply updates** (status, comment, assignee, labels, priority)
4. **Return confirmation** with updated ticket details

## Parameters

- **`<ticket-id>`** (required): Issue identifier (e.g., `ISSUE-001`, `#42`, `PROJECT-123`, `ENG-456`)
- **`--status STATE`** (optional): Update ticket status
  - Valid states: `open`, `in_progress`, `closed`, `blocked`, `review`
  - Provider-specific mappings applied automatically
- **`--comment "text"`** (optional): Add progress comment or note
- **`--assignee USER`** (optional): Assign to user (or `unassigned` to clear)
- **`--labels "label1,label2"`** (optional): Replace labels (comma-separated)
- **`--add-labels "label1,label2"`** (optional): Add labels without replacing existing
- **`--remove-labels "label1,label2"`** (optional): Remove specific labels
- **`--priority LEVEL`** (optional): Update priority (low|medium|high|critical)
- **`--milestone NAME`** (optional): Associate with milestone (provider-dependent)
- **`--provider NAME`** (optional): Override configured provider

## Inputs

**Configuration sources** (same as `issue-create`):
1. `.aiwg/config.yaml` - Project-level configuration
2. `CLAUDE.md` - User-level configuration
3. Default: `local` provider

## Outputs

**All Providers**:
- Confirmation of update
- Updated ticket details
- URL or file path to view changes

## Workflow

### Step 1: Parse Parameters

Extract from command invocation:

```bash
# Update status
/issue-update ISSUE-001 --status in_progress

# Add comment
/issue-update ISSUE-001 --comment "Completed authentication module, working on authorization next"

# Update status with comment
/issue-update ISSUE-001 --status closed --comment "Fixed in commit abc123"

# Assign ticket
/issue-update ISSUE-001 --assignee johndoe

# Update multiple fields
/issue-update ISSUE-001 --status in_progress --assignee johndoe --priority high --comment "Started implementation"

# Add labels without replacing
/issue-update ISSUE-001 --add-labels "urgent,needs-review"

# Remove labels
/issue-update ISSUE-001 --remove-labels "wip,blocked"

# Replace all labels
/issue-update ISSUE-001 --labels "completed,tested"
```

**Parameter extraction**:
- Issue ID: First argument (required)
- Flags: Parse `--flag value` pairs
- At least one update flag required (status, comment, assignee, labels, priority)

### Step 2: Load Configuration

Same as `issue-create` command:

1. Check `.aiwg/config.yaml`
2. Fallback to `CLAUDE.md`
3. Default to `local` provider

Override with `--provider` if specified.

### Step 3: Validate Issue Exists

**Gitea**:
```bash
# Fetch issue to verify existence
curl -s -H "Authorization: token $(cat ~/.config/gitea/token)" \
  "${URL}/api/v1/repos/${OWNER}/${REPO}/issues/${TICKET_NUM}"

# Check HTTP status: 200 = exists, 404 = not found
```

**GitHub**:
```bash
# Fetch issue via gh CLI
gh issue view "${TICKET_NUM}" --repo "${OWNER}/${REPO}"

# Exit code 0 = exists, non-zero = not found
```

**Jira**:
```bash
# Fetch issue via REST API
curl -s -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  "${JIRA_URL}/rest/api/3/issue/${ISSUE_KEY}"

# Check HTTP status: 200 = exists, 404 = not found
```

**Linear**:
```bash
# Fetch issue via GraphQL
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_TOKEN}" \
  -d '{"query": "query { issue(id: \"'${ISSUE_ID}'\") { id identifier title } }"}'

# Check if issue returned in response
```

**Local**:
```bash
# Check if file exists
if [ -f ".aiwg/issues/${TICKET_ID}.md" ]; then
  echo "Issue exists"
else
  echo "Issue not found"
fi
```

**Error if not found**:
```
❌ Issue not found: ISSUE-001

Available tickets:
- ISSUE-002: Add dark mode
- ISSUE-003: Fix navigation bug

List all tickets: /issue-list
```

### Step 4: Map Status to Provider-Specific Values

**Status mapping table**:

| Generic | Gitea | GitHub | Jira | Linear | Local |
|---------|-------|--------|------|--------|-------|
| `open` | open | open | To Do | Backlog | open |
| `in_progress` | open | open | In Progress | In Progress | in_progress |
| `closed` | closed | closed | Done | Done | closed |
| `blocked` | open | open | Blocked | Blocked | blocked |
| `review` | open | open | In Review | In Review | review |

**Implementation**:
```bash
case "${PROVIDER}" in
  gitea|github)
    case "${STATUS}" in
      closed) PROVIDER_STATUS="closed" ;;
      *) PROVIDER_STATUS="open" ;;
    esac
    ;;
  jira)
    case "${STATUS}" in
      open) PROVIDER_STATUS="To Do" ;;
      in_progress) PROVIDER_STATUS="In Progress" ;;
      closed) PROVIDER_STATUS="Done" ;;
      blocked) PROVIDER_STATUS="Blocked" ;;
      review) PROVIDER_STATUS="In Review" ;;
    esac
    ;;
  linear)
    case "${STATUS}" in
      open) PROVIDER_STATUS="Backlog" ;;
      in_progress) PROVIDER_STATUS="In Progress" ;;
      closed) PROVIDER_STATUS="Done" ;;
      blocked) PROVIDER_STATUS="Blocked" ;;
      review) PROVIDER_STATUS="In Review" ;;
    esac
    ;;
  local)
    PROVIDER_STATUS="${STATUS}"
    ;;
esac
```

**Note**: Gitea and GitHub don't have separate "in_progress" state - use labels instead (e.g., add "in-progress" label when status changes to `in_progress`)

### Step 5: Update Issue (Provider-Specific)

#### Gitea

Use MCP tools `mcp__gitea__edit_issue` and `mcp__gitea__create_issue_comment`:

**Edit issue metadata**:
```bash
# Update status (state)
# Use mcp__gitea__edit_issue
# Parameters:
#   owner: ${OWNER}
#   repo: ${REPO}
#   issue_number: ${TICKET_NUM}
#   state: "open" | "closed"
#   assignee: ${ASSIGNEE} (optional)
#   labels: [${LABELS}] (optional)
```

**Add comment**:
```bash
# Use mcp__gitea__create_issue_comment
# Parameters:
#   owner: ${OWNER}
#   repo: ${REPO}
#   issue_number: ${TICKET_NUM}
#   body: ${COMMENT}
```

**Combined workflow**:
1. If status/assignee/labels specified → use `mcp__gitea__edit_issue`
2. If comment specified → use `mcp__gitea__create_issue_comment`
3. Both can be called in sequence if needed

#### GitHub

Use `gh` CLI:

**Update status**:
```bash
# Open issue
gh issue reopen "${TICKET_NUM}" --repo "${OWNER}/${REPO}"

# Close issue
gh issue close "${TICKET_NUM}" --repo "${OWNER}/${REPO}"
```

**Add comment**:
```bash
gh issue comment "${TICKET_NUM}" \
  --repo "${OWNER}/${REPO}" \
  --body "${COMMENT}"
```

**Update assignee**:
```bash
# Assign
gh issue edit "${TICKET_NUM}" \
  --repo "${OWNER}/${REPO}" \
  --add-assignee "${ASSIGNEE}"

# Unassign
gh issue edit "${TICKET_NUM}" \
  --repo "${OWNER}/${REPO}" \
  --remove-assignee "${ASSIGNEE}"
```

**Update labels**:
```bash
# Add labels
gh issue edit "${TICKET_NUM}" \
  --repo "${OWNER}/${REPO}" \
  --add-label "label1,label2"

# Remove labels
gh issue edit "${TICKET_NUM}" \
  --repo "${OWNER}/${REPO}" \
  --remove-label "label1,label2"
```

#### Jira

Use Jira REST API v3:

**Update issue fields**:
```bash
cat > /tmp/jira-update.json <<EOF
{
  "fields": {
    "status": {
      "name": "${PROVIDER_STATUS}"
    },
    "assignee": {
      "name": "${ASSIGNEE}"
    },
    "priority": {
      "name": "${PRIORITY}"
    },
    "labels": [${LABELS_JSON}]
  }
}
EOF

curl -X PUT "${JIRA_URL}/rest/api/3/issue/${ISSUE_KEY}" \
  -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @/tmp/jira-update.json
```

**Add comment**:
```bash
cat > /tmp/jira-comment.json <<EOF
{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "paragraph",
        "content": [
          {
            "type": "text",
            "text": "${COMMENT}"
          }
        ]
      }
    ]
  }
}
EOF

curl -X POST "${JIRA_URL}/rest/api/3/issue/${ISSUE_KEY}/comment" \
  -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @/tmp/jira-comment.json
```

#### Linear

Use Linear GraphQL API:

**Update issue**:
```bash
cat > /tmp/linear-update.json <<EOF
{
  "query": "mutation IssueUpdate(\$issueId: String!, \$stateId: String, \$assigneeId: String, \$priority: Int) { issueUpdate(id: \$issueId, input: { stateId: \$stateId, assigneeId: \$assigneeId, priority: \$priority }) { success issue { id identifier url state { name } } } }",
  "variables": {
    "issueId": "${ISSUE_ID}",
    "stateId": "${STATE_ID}",
    "assigneeId": "${ASSIGNEE_ID}",
    "priority": ${PRIORITY_NUM}
  }
}
EOF

curl -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @/tmp/linear-update.json
```

**Add comment**:
```bash
cat > /tmp/linear-comment.json <<EOF
{
  "query": "mutation CommentCreate(\$issueId: String!, \$body: String!) { commentCreate(input: { issueId: \$issueId, body: \$body }) { success comment { id body } } }",
  "variables": {
    "issueId": "${ISSUE_ID}",
    "body": "${COMMENT}"
  }
}
EOF

curl -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @/tmp/linear-comment.json
```

#### Local

Update markdown file in `.aiwg/issues/`:

**Read existing ticket**:
```bash
TICKET_FILE=".aiwg/issues/${TICKET_ID}.md"

# Extract current metadata from frontmatter
CURRENT_STATUS=$(grep "^status:" "${TICKET_FILE}" | awk '{print $2}')
CURRENT_ASSIGNEE=$(grep "^assignee:" "${TICKET_FILE}" | awk '{print $2}')
CURRENT_LABELS=$(grep "^labels:" "${TICKET_FILE}" | cut -d':' -f2- | xargs)
CURRENT_PRIORITY=$(grep "^priority:" "${TICKET_FILE}" | awk '{print $2}')
```

**Update metadata**:
```bash
# Update status
if [ -n "${STATUS}" ]; then
  sed -i "s/^status:.*/status: ${STATUS}/" "${TICKET_FILE}"
  sed -i "/^\*\*Status\*\*:/s/:.*/: ${STATUS}/" "${TICKET_FILE}"
fi

# Update assignee
if [ -n "${ASSIGNEE}" ]; then
  sed -i "s/^assignee:.*/assignee: ${ASSIGNEE}/" "${TICKET_FILE}"
  sed -i "/^\*\*Assignee\*\*:/s/:.*/: ${ASSIGNEE}/" "${TICKET_FILE}"
fi

# Update priority
if [ -n "${PRIORITY}" ]; then
  sed -i "s/^priority:.*/priority: ${PRIORITY}/" "${TICKET_FILE}"
  sed -i "/^\*\*Priority\*\*:/s/:.*/: ${PRIORITY}/" "${TICKET_FILE}"
fi

# Update labels
if [ -n "${LABELS}" ]; then
  sed -i "s/^labels:.*/labels: ${LABELS}/" "${TICKET_FILE}"
fi

# Update timestamp
sed -i "s/^updated:.*/updated: $(date +%Y-%m-%d)/" "${TICKET_FILE}"
```

**Add comment**:
```bash
# Append comment to end of file
cat >> "${TICKET_FILE}" <<EOF

### $(date +%Y-%m-%d\ %H:%M)

${COMMENT}
EOF
```

### Step 6: Return Confirmation

**Output format** (consistent across providers):

```markdown
✅ Issue updated: {ticket-id}

{view-url-or-file-path}

**Updates**:
- Status: {old-status} → {new-status}
- Assignee: {old-assignee} → {new-assignee}
- Priority: {old-priority} → {new-priority}
- Labels: {old-labels} → {new-labels}
- Comment added: "{comment-preview...}"

## Next Steps

- View ticket: {url-or-command}
- Add another comment: `/issue-update {ticket-id} --comment "text"`
- Close ticket: `/issue-update {ticket-id} --status closed`
- List tickets: `issue-list`
```

## Examples

### Example 1: Update Status (Gitea)

**Command**:
```bash
/issue-update ISSUE-042 --status in_progress --comment "Started implementation, created auth module"
```

**Config** (`.aiwg/config.yaml`):
```yaml
ticketing:
  provider: gitea
  url: https://git.integrolabs.net
  owner: roctinam
  repo: ai-writing-guide
```

**Output**:
```
✅ Issue updated: ISSUE-042

View at: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42

**Updates**:
- Status: open → in_progress (Gitea: added 'in-progress' label)
- Comment added: "Started implementation, created auth module"

## Next Steps

- View ticket: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42
- Update status: `/issue-update ISSUE-042 --status closed`
- Add comment: `/issue-update ISSUE-042 --comment "Progress update"`
```

### Example 2: Close Issue with Comment (Local)

**Command**:
```bash
/issue-update ISSUE-003 --status closed --comment "Fixed in commit abc123. Tested on iOS Safari 17."
```

**Output**:
```
✅ Issue updated: ISSUE-003

File: .aiwg/issues/ISSUE-003.md

**Updates**:
- Status: in_progress → closed
- Comment added: "Fixed in commit abc123. Tested on iOS Safari 17."

## Next Steps

- View ticket: cat .aiwg/issues/ISSUE-003.md
- Reopen if needed: `/issue-update ISSUE-003 --status open`
- List closed tickets: `/issue-list --status closed`
```

### Example 3: Reassign Issue (GitHub)

**Command**:
```bash
/issue-update #128 --assignee security-team --priority critical --comment "Escalating to security team due to severity"
```

**Config** (`CLAUDE.md`):
```markdown
## Issueing Configuration

- **Provider**: github
- **Owner**: jmagly
- **Repo**: ai-writing-guide
```

**Output**:
```
✅ Issue updated: #128

View at: https://github.com/jmagly/aiwg/issues/128

**Updates**:
- Assignee: unassigned → @security-team
- Priority: medium → critical (updated in issue body)
- Comment added: "Escalating to security team due to severity"

## Next Steps

- View ticket: gh issue view 128
- Track progress: `/issue-update 128 --comment "Status update"`
- Close when resolved: `/issue-update 128 --status closed`
```

### Example 4: Add Labels Without Replacing (Gitea)

**Command**:
```bash
/issue-update ISSUE-042 --add-labels "urgent,needs-review" --comment "Ready for code review"
```

**Output**:
```
✅ Issue updated: ISSUE-042

View at: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42

**Updates**:
- Labels: feature, ui → feature, ui, urgent, needs-review
- Comment added: "Ready for code review"

## Next Steps

- View ticket: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42
- Remove label after review: `/issue-update ISSUE-042 --remove-labels "needs-review"`
```

### Example 5: Multiple Field Updates (Local)

**Command**:
```bash
/issue-update ISSUE-005 --status blocked --assignee unassigned --priority high --labels "blocked,needs-discussion" --comment "Blocked on architecture decision ADR-003. Need team discussion."
```

**Output**:
```
✅ Issue updated: ISSUE-005

File: .aiwg/issues/ISSUE-005.md

**Updates**:
- Status: in_progress → blocked
- Assignee: johndoe → unassigned
- Priority: medium → high
- Labels: feature → blocked, needs-discussion
- Comment added: "Blocked on architecture decision ADR-003. Need team discussion."

## Next Steps

- View ticket: cat .aiwg/issues/ISSUE-005.md
- Unblock: `/issue-update ISSUE-005 --status in_progress --comment "Decision made, resuming work"`
- List blocked tickets: `/issue-list --status blocked`
```

## Error Handling

### Issue Not Found

```
❌ Issue not found: ISSUE-999

Searched in:
- Provider: gitea
- Repository: roctinam/ai-writing-guide

Available tickets:
- ISSUE-001: Implement user auth (open)
- ISSUE-002: Add dark mode (in_progress)
- ISSUE-003: Fix navigation bug (closed)

List all tickets: discover and load `issue-list`.
Create a new ticket: discover and load `issue-create`.
```

### Invalid Status

```
❌ Invalid status: 'inprogress'

Valid statuses:
- open
- in_progress
- closed
- blocked
- review

Example: /issue-update ISSUE-001 --status in_progress
```

### No Updates Specified

```
❌ No updates specified.

At least one update parameter required:
- --status STATE
- --comment "text"
- --assignee USER
- --labels "label1,label2"
- --add-labels "label1,label2"
- --remove-labels "label1,label2"
- --priority LEVEL

Example: /issue-update ISSUE-001 --status in_progress --comment "Started work"
```

### Provider-Specific Errors

**Gitea MCP Error**:
```
❌ Failed to update Gitea issue:

Error: 403 Forbidden
- Insufficient permissions to edit issue
- Verify token permissions at https://git.integrolabs.net/user/settings/applications
- Token needs 'write:issue' scope

Cannot update ticket.
```

**GitHub CLI Error**:
```
❌ Failed to update GitHub issue:

Error: issue not found: #999
- Verify issue number: gh issue list --repo jmagly/ai-writing-guide
- Check repository access: gh auth status

Cannot update ticket.
```

**Local File Error**:
```
❌ Failed to update local ticket file:

Error: Permission denied - .aiwg/issues/ISSUE-001.md
- Check file permissions: ls -la .aiwg/issues/ISSUE-001.md
- Ensure writable: chmod 644 .aiwg/issues/ISSUE-001.md

Cannot update ticket.
```

## Best Practices

1. **Add meaningful comments** - Document progress, blockers, and decisions
2. **Update status frequently** - Keep stakeholders informed
3. **Use status transitions wisely** - Follow team workflow (e.g., open → in_progress → review → closed)
4. **Reassign when blocked** - Don't let tickets languish without clear ownership
5. **Remove labels when resolved** - Clean up metadata (e.g., remove "needs-review" after review)
6. **Close tickets with resolution comments** - Document how issue was resolved
7. **Link to artifacts** - Reference commits, PRs, or SDLC artifacts in comments
8. **Batch updates** - Update multiple fields in single command when possible

## Integration with SDLC Workflows

**Construction Phase (Development)**:
```bash
# Start work
/issue-update ISSUE-001 --status in_progress --comment "Started implementation"

# Progress update
/issue-update ISSUE-001 --comment "Completed authentication module, 3 tests passing"

# Ready for review
/issue-update ISSUE-001 --add-labels "needs-review" --comment "Ready for code review, see PR #45"

# Close after merge
/issue-update ISSUE-001 --status closed --comment "Merged in PR #45, deployed to staging"
```

**Testing Phase**:
```bash
# Found bug during testing
/issue-update ISSUE-001 --status blocked --assignee qa-team --comment "Failed QA: auth broken on Safari"

# Bug fixed
/issue-update ISSUE-001 --status in_progress --assignee dev-team --comment "Fix deployed, ready for retest"

# Passed testing
/issue-update ISSUE-001 --status closed --comment "Passed QA, deployed to production"
```

**Security Review**:
```bash
# Start security review
/issue-update ISSUE-001 --status review --assignee security-team --add-labels "security-review"

# Findings identified
/issue-update ISSUE-001 --status blocked --comment "Security review found SQL injection risk, see ISSUE-042"

# Resolved
/issue-update ISSUE-001 --status closed --remove-labels "security-review" --comment "Security issues resolved, review passed"
```

**Retrospectives**:
```bash
# Action item from retro
/issue-update ISSUE-001 --add-labels "process-improvement" --comment "Retro action: Add automated tests for this pattern"
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/config/issueing-config.md - Configuration schema
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-create/SKILL.md - Create ticket skill
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-list/SKILL.md - List tickets skill
- @CLAUDE.md - User ticketing configuration
