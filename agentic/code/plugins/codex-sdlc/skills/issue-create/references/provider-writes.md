# Provider-specific issue writes

## Mapped control workspaces

For a mapped `/srv/*-workspace`, resolve `config/repository-routing.yaml`
`workTracker` to the target member in the access manifest. Authorize `read` for
duplicate searches and `issue-comment` for issue writes, then load the member's
`.aiwg/aiwg.config`. Use its `remotes.issue_tracker`, `remotes.issue_provider`,
and `remotes.tracker_actor` (including `login`, `credential`, and `forbid_actors`).
The control workspace config and a default forge login cannot replace them.

Query and file directly on the member's tracker through its tracker tools;
do not initialize local issues in the control workspace to enable filing.
For native `aiwg issues create`, use the authorized member directory as cwd;
the CLI does not consume `repository-routing.yaml`. Preserve the composition
and HITL gates in the parent skill before every write.

`aiwg issues list` supports local storage only. A configured external tracker
requires its tracker tools for duplicate searches; `--provider local` explicitly
selects initialized local storage. Treat a failed query as a blocker, never as
"no matching issues". A local-only project must run `aiwg issues init --prefix
<PROJECT>` before listing or creating local issues.

On HTTP 401, use a token belonging to the member's `tracker_actor.login`.
Save it using `aiwg auth secret set <name> --value-stdin`, then configure
`remotes.tracker_actor.credential` as `{"store":"<name>"}` (or an env reference
whose variable is supplied). Refresh the configured source when already set.
Verify `/user` matches the configured actor; never fall back to another login.

### Step 6: Create Issue (Provider-Specific)

#### Gitea

Use MCP tool `mcp__gitea__create_issue`:

```bash
# Load configuration
TOKEN=$(cat ~/.config/gitea/token)
URL="https://git.integrolabs.net"
OWNER="roctinam"
REPO="ai-writing-guide"

# Prepare issue body
BODY="${description}"

# Add metadata section if labels/assignee/priority specified
if [ -n "$LABELS" ] || [ -n "$ASSIGNEE" ] || [ -n "$PRIORITY" ]; then
  BODY="${BODY}\n\n---\n\n"
  [ -n "$LABELS" ] && BODY="${BODY}**Labels**: ${LABELS}\n"
  [ -n "$ASSIGNEE" ] && BODY="${BODY}**Assignee**: @${ASSIGNEE}\n"
  [ -n "$PRIORITY" ] && BODY="${BODY}**Priority**: ${PRIORITY}\n"
fi

# Create issue via MCP
# Note: Use actual MCP tool invocation here
```

**MCP Tool Parameters**:
- `owner`: Organization/user name
- `repo`: Repository name
- `title`: Issue title
- `body`: Issue description (markdown)
- `assignee`: Username (optional)
- `labels`: Array of label names (optional)

**Return format**:
```
✅ Issue created: ISSUE-42

View at: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42

Title: Implement user auth
Status: open
Labels: feature, high-priority
```

#### GitHub

Use `gh` CLI:

```bash
# Basic creation
gh issue create \
  --repo "${OWNER}/${REPO}" \
  --title "${TITLE}" \
  --body "${DESCRIPTION}"

# With labels
gh issue create \
  --repo "${OWNER}/${REPO}" \
  --title "${TITLE}" \
  --body "${DESCRIPTION}" \
  --label "${LABELS}"

# With assignee
gh issue create \
  --repo "${OWNER}/${REPO}" \
  --title "${TITLE}" \
  --body "${DESCRIPTION}" \
  --assignee "${ASSIGNEE}"

# With milestone
gh issue create \
  --repo "${OWNER}/${REPO}" \
  --title "${TITLE}" \
  --body "${DESCRIPTION}" \
  --milestone "${MILESTONE}"
```

**Return format**:
```
✅ Issue created: #42

View at: https://github.com/jmagly/aiwg/issues/42

Title: Implement user auth
Status: open
Labels: feature, high-priority
```

#### Jira

Use Jira REST API v3:

```bash
# Prepare JSON payload
cat > /tmp/jira-issue.json <<EOF
{
  "fields": {
    "project": {
      "key": "${PROJECT_KEY}"
    },
    "summary": "${TITLE}",
    "description": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "${DESCRIPTION}"
            }
          ]
        }
      ]
    },
    "issuetype": {
      "name": "Task"
    },
    "priority": {
      "name": "${PRIORITY:-Medium}"
    }
  }
}
EOF

# Create issue
curl -X POST "${JIRA_URL}/rest/api/3/issue" \
  -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @/tmp/jira-issue.json
```

**Return format**:
```
✅ Issue created: PROJECT-42

View at: https://yourcompany.atlassian.net/browse/PROJECT-42

Title: Implement user auth
Status: To Do
Priority: High
```

#### Linear

Use Linear GraphQL API:

```bash
# Prepare GraphQL mutation
cat > /tmp/linear-mutation.json <<EOF
{
  "query": "mutation IssueCreate(\$teamId: String!, \$title: String!, \$description: String) { issueCreate(input: { teamId: \$teamId, title: \$title, description: \$description }) { success issue { id identifier url } } }",
  "variables": {
    "teamId": "${TEAM_ID}",
    "title": "${TITLE}",
    "description": "${DESCRIPTION}"
  }
}
EOF

# Create issue
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @/tmp/linear-mutation.json
```

**Return format**:
```
✅ Issue created: ENG-42

View at: https://linear.app/team/issue/ENG-42

Title: Implement user auth
Status: Backlog
Priority: High
```

#### Local

Create markdown file in `.aiwg/issues/`:

```bash
# Determine next ticket number
mkdir -p .aiwg/issues
NEXT_NUM=$(ls .aiwg/issues/ISSUE-*.md 2>/dev/null | wc -l)
NEXT_NUM=$((NEXT_NUM + 1))
TICKET_ID=$(printf "ISSUE-%03d" $NEXT_NUM)
TICKET_FILE=".aiwg/issues/${TICKET_ID}.md"

# Create ticket file
cat > "${TICKET_FILE}" <<EOF
---
id: ${TICKET_ID}
title: ${TITLE}
status: open
created: $(date +%Y-%m-%d)
updated: $(date +%Y-%m-%d)
assignee: ${ASSIGNEE:-unassigned}
labels: ${LABELS:-none}
priority: ${PRIORITY:-medium}
---

# ${TICKET_ID}: ${TITLE}

**Status**: open
**Created**: $(date +%Y-%m-%d)
**Updated**: $(date +%Y-%m-%d)
**Assignee**: ${ASSIGNEE:-unassigned}
**Priority**: ${PRIORITY:-medium}

## Description

${DESCRIPTION}

## Acceptance Criteria

- [ ] (Add acceptance criteria here)

## Comments

### $(date +%Y-%m-%d\ %H:%M)

Issue created.
EOF
```

**Return format**:
```
✅ Issue created: ISSUE-001

File: .aiwg/issues/ISSUE-001.md

Title: Implement user auth
Status: open
Priority: medium
```

