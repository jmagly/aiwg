---
namespace: aiwg
name: issue-list
platforms: [all]
description: List and filter tickets/issues from configured backend
commandHint:
  argumentHint: [--status STATE --label LABEL --assignee USER --limit NUM --format table|json|markdown]
  allowedTools: Read, Write, Glob, Bash
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


# Issue List

## Purpose

List and filter tickets/issues from the configured ticketing provider (Gitea, GitHub, Jira, Linear) or local file-based tracking. Supports filtering by status, labels, assignee, and custom output formats.

## Task

Given optional filter parameters:

1. **Load configuration** from `.aiwg/config.yaml` or project `CLAUDE.md`
2. **Fetch tickets** from provider or local files
3. **Apply filters** (status, labels, assignee)
4. **Format output** (table, JSON, or markdown)
5. **Display results** with summary statistics

## Parameters

- **`--status STATE`** (optional): Filter by status (open|in_progress|closed|blocked|review|all)
  - Default: `open` (only show open tickets)
  - Use `all` to show all tickets regardless of status
- **`--label LABEL`** (optional): Filter by label (can specify multiple: `--label bug --label high-priority`)
- **`--label-role ROLE`** (optional): Resolve a stable semantic role from
  `.aiwg/aiwg.config` `issues.labels` for the target tracker, then filter by its
  provider-native name
- **`--assignee USER`** (optional): Filter by assignee (use `unassigned` for unassigned tickets)
- **`--limit NUM`** (optional): Limit results to NUM tickets (default: 50)
- **`--sort FIELD`** (optional): Sort by field (created|updated|priority|id)
  - Default: `created` (newest first)
- **`--format FORMAT`** (optional): Output format (table|json|markdown|compact)
  - Default: `table`
- **`--provider NAME`** (optional): Override configured provider

## Inputs

**Configuration sources** (same as `issue-create` and `issue-update`):
1. `.aiwg/config.yaml` - Project-level configuration
2. `CLAUDE.md` - User-level configuration
3. Default: `local` provider

## Outputs

**Table Format** (default):
```
┌──────────┬────────────────────────┬────────────┬──────────┬──────────┬────────────┐
│ ID       │ Title                  │ Status     │ Priority │ Assignee │ Labels     │
├──────────┼────────────────────────┼────────────┼──────────┼──────────┼────────────┤
│ ISSUE-1 │ Implement user auth    │ in_progress│ high     │ johndoe  │ feature,ui │
│ ISSUE-2 │ Add dark mode          │ open       │ medium   │ janedoe  │ feature    │
│ ISSUE-3 │ Fix navigation bug     │ closed     │ critical │ johndoe  │ bug        │
└──────────┴────────────────────────┴────────────┴──────────┴──────────┴────────────┘

Summary: 3 tickets (1 open, 1 in_progress, 1 closed)
```

**Compact Format**:
```
ISSUE-1  [in_progress] [high]     Implement user auth          @johndoe  [feature,ui]
ISSUE-2  [open]        [medium]   Add dark mode                @janedoe  [feature]
ISSUE-3  [closed]      [critical] Fix navigation bug           @johndoe  [bug]

Summary: 3 tickets (1 open, 1 in_progress, 1 closed)
```

**Markdown Format**:
```markdown
# Issues

## ISSUE-1: Implement user auth

**Status**: in_progress
**Priority**: high
**Assignee**: @johndoe
**Labels**: feature, ui
**Created**: 2026-01-10
**Updated**: 2026-01-13

---

## ISSUE-2: Add dark mode

**Status**: open
**Priority**: medium
**Assignee**: @janedoe
**Labels**: feature
**Created**: 2026-01-11
**Updated**: 2026-01-11

---

## Summary

3 tickets (1 open, 1 in_progress, 1 closed)
```

**JSON Format**:
```json
{
  "tickets": [
    {
      "id": "ISSUE-1",
      "title": "Implement user auth",
      "status": "in_progress",
      "priority": "high",
      "assignee": "johndoe",
      "labels": ["feature", "ui"],
      "created": "2026-01-10",
      "updated": "2026-01-13",
      "url": "https://git.integrolabs.net/roctinam/ai-writing-guide/issues/1"
    },
    {
      "id": "ISSUE-2",
      "title": "Add dark mode",
      "status": "open",
      "priority": "medium",
      "assignee": "janedoe",
      "labels": ["feature"],
      "created": "2026-01-11",
      "updated": "2026-01-11",
      "url": "https://git.integrolabs.net/roctinam/ai-writing-guide/issues/2"
    }
  ],
  "summary": {
    "total": 3,
    "open": 1,
    "in_progress": 1,
    "closed": 1
  }
}
```

## Workflow

### Step 1: Parse Parameters

Extract from command invocation:

```bash
# List all open tickets (default)
/issue-list

# List all tickets (including closed)
/issue-list --status all

# Filter by status
/issue-list --status in_progress
/issue-list --status closed

# Filter by label
/issue-list --label bug
/issue-list --label feature --label high-priority

# Filter by assignee
/issue-list --assignee johndoe
/issue-list --assignee unassigned

# Combine filters
/issue-list --status open --label bug --assignee johndoe

# Limit results
/issue-list --limit 10

# Sort by field
/issue-list --sort updated
/issue-list --sort priority

# Change format
/issue-list --format compact
/issue-list --format json
/issue-list --format markdown
```

**Parameter extraction**:
- All parameters optional
- Default: `--status open --limit 50 --format table --sort created`

### Step 2: Load Configuration

Same resolution rules as `issue-create` (preferred path):

1. **`--provider` flag** — explicit override always wins.
2. **`.aiwg/aiwg.config` `remotes.issue_tracker`** (#994) — derive provider via `resolveRemotes()` + `resolveRemoteProvider()` from `src/config/aiwg-config.ts`.
   Resolve any `--label-role` through `resolveIssueLabels()` for that provider.
   Report missing, duplicate, conflicting, or unavailable taxonomy entries;
   never provision tracker labels during a list operation.
3. **Legacy `.aiwg/config.yaml`** (`ticketing` block) — back-compat.
4. **`CLAUDE.md` "Issueing Configuration"** — fallback.
5. **`local`** — default.

When `resolveRemoteProvider(url)` returns `'unknown'` (self-hosted instances), the operator must pass `--provider` explicitly. Don't guess.

### Step 3: Fetch Issues (Provider-Specific)

#### Gitea

Use Gitea REST API:

```bash
# Build query parameters
STATE="open"  # or "closed" or "all"
LABELS="${LABEL:-}"
ASSIGNEE="${ASSIGNEE:-}"
LIMIT="${LIMIT:-50}"
SORT="created"  # or "updated"
ORDER="desc"

# Fetch issues
curl -s -H "Authorization: token $(cat ~/.config/gitea/token)" \
  "${URL}/api/v1/repos/${OWNER}/${REPO}/issues?state=${STATE}&labels=${LABELS}&assignee=${ASSIGNEE}&limit=${LIMIT}&sort=${SORT}&order=${ORDER}"
```

**Response mapping**:
```json
[
  {
    "number": 1,
    "title": "Implement user auth",
    "state": "open",
    "labels": [{"name": "feature"}, {"name": "ui"}],
    "assignee": {"login": "johndoe"},
    "created_at": "2026-01-10T10:00:00Z",
    "updated_at": "2026-01-13T15:30:00Z",
    "html_url": "https://git.integrolabs.net/roctinam/ai-writing-guide/issues/1"
  }
]
```

**Map to internal format**:
```bash
ID="ISSUE-${number}"
TITLE="${title}"
STATUS="${state}"  # map to generic status
PRIORITY="${extracted from body or labels}"
ASSIGNEE="${assignee.login}"
LABELS="${labels[].name joined by comma}"
CREATED="${created_at}"
UPDATED="${updated_at}"
URL="${html_url}"
```

#### GitHub

Use `gh` CLI:

```bash
# Build query
STATE="${STATUS:-open}"  # or "closed" or "all"
LABELS="${LABEL:-}"
ASSIGNEE="${ASSIGNEE:-}"
LIMIT="${LIMIT:-50}"

# Fetch issues
gh issue list \
  --repo "${OWNER}/${REPO}" \
  --state "${STATE}" \
  --label "${LABELS}" \
  --assignee "${ASSIGNEE}" \
  --limit "${LIMIT}" \
  --json number,title,state,labels,assignees,createdAt,updatedAt,url
```

**Response mapping**:
```json
[
  {
    "number": 42,
    "title": "Implement user auth",
    "state": "OPEN",
    "labels": [{"name": "feature"}, {"name": "ui"}],
    "assignees": [{"login": "johndoe"}],
    "createdAt": "2026-01-10T10:00:00Z",
    "updatedAt": "2026-01-13T15:30:00Z",
    "url": "https://github.com/jmagly/aiwg/issues/42"
  }
]
```

**Map to internal format**:
```bash
ID="#${number}"
TITLE="${title}"
STATUS="${state}"  # map OPEN → open, CLOSED → closed
PRIORITY="${extracted from labels or body}"
ASSIGNEE="${assignees[0].login}"
LABELS="${labels[].name joined by comma}"
CREATED="${createdAt}"
UPDATED="${updatedAt}"
URL="${url}"
```

#### Jira

Use Jira REST API v3:

```bash
# Build JQL query
JQL="project = ${PROJECT_KEY}"

# Add status filter
if [ "${STATUS}" != "all" ]; then
  case "${STATUS}" in
    open) JQL="${JQL} AND status = 'To Do'" ;;
    in_progress) JQL="${JQL} AND status = 'In Progress'" ;;
    closed) JQL="${JQL} AND status = 'Done'" ;;
    blocked) JQL="${JQL} AND status = 'Blocked'" ;;
    review) JQL="${JQL} AND status = 'In Review'" ;;
  esac
fi

# Add label filter
if [ -n "${LABEL}" ]; then
  JQL="${JQL} AND labels = '${LABEL}'"
fi

# Add assignee filter
if [ -n "${ASSIGNEE}" ]; then
  if [ "${ASSIGNEE}" = "unassigned" ]; then
    JQL="${JQL} AND assignee is EMPTY"
  else
    JQL="${JQL} AND assignee = '${ASSIGNEE}'"
  fi
fi

# Fetch issues
curl -s -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  "${JIRA_URL}/rest/api/3/search?jql=${JQL}&maxResults=${LIMIT}&fields=summary,status,priority,assignee,labels,created,updated"
```

**Response mapping**:
```json
{
  "issues": [
    {
      "key": "PROJECT-123",
      "fields": {
        "summary": "Implement user auth",
        "status": {"name": "In Progress"},
        "priority": {"name": "High"},
        "assignee": {"displayName": "John Doe"},
        "labels": ["feature", "ui"],
        "created": "2026-01-10T10:00:00.000+0000",
        "updated": "2026-01-13T15:30:00.000+0000"
      }
    }
  ]
}
```

**Map to internal format**:
```bash
ID="${key}"
TITLE="${fields.summary}"
STATUS="${fields.status.name}"  # map to generic status
PRIORITY="${fields.priority.name}"
ASSIGNEE="${fields.assignee.displayName}"
LABELS="${fields.labels joined by comma}"
CREATED="${fields.created}"
UPDATED="${fields.updated}"
URL="${JIRA_URL}/browse/${key}"
```

#### Linear

Use Linear GraphQL API:

```bash
# Build GraphQL query
cat > /tmp/linear-query.json <<EOF
{
  "query": "query { issues(filter: { team: { id: { eq: \"${TEAM_ID}\" } }, state: { name: { in: [\"${STATE_NAMES}\"] } } }, first: ${LIMIT}) { nodes { id identifier title state { name } priority priorityLabel assignee { name } labels { nodes { name } } createdAt updatedAt url } } }"
}
EOF

# Fetch issues
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @/tmp/linear-query.json
```

**Response mapping**:
```json
{
  "data": {
    "issues": {
      "nodes": [
        {
          "id": "abc123",
          "identifier": "ENG-42",
          "title": "Implement user auth",
          "state": {"name": "In Progress"},
          "priority": 2,
          "priorityLabel": "High",
          "assignee": {"name": "John Doe"},
          "labels": {"nodes": [{"name": "feature"}, {"name": "ui"}]},
          "createdAt": "2026-01-10T10:00:00.000Z",
          "updatedAt": "2026-01-13T15:30:00.000Z",
          "url": "https://linear.app/team/issue/ENG-42"
        }
      ]
    }
  }
}
```

**Map to internal format**:
```bash
ID="${identifier}"
TITLE="${title}"
STATUS="${state.name}"  # map to generic status
PRIORITY="${priorityLabel}"
ASSIGNEE="${assignee.name}"
LABELS="${labels.nodes[].name joined by comma}"
CREATED="${createdAt}"
UPDATED="${updatedAt}"
URL="${url}"
```

#### Local

Read files from `.aiwg/issues/`:

```bash
# Find all ticket files
TICKET_FILES=(.aiwg/issues/ISSUE-*.md)

# Read each file
for TICKET_FILE in "${TICKET_FILES[@]}"; do
  # Extract metadata from frontmatter
  ID=$(grep "^id:" "${TICKET_FILE}" | awk '{print $2}')
  TITLE=$(grep "^title:" "${TICKET_FILE}" | cut -d':' -f2- | xargs)
  STATUS=$(grep "^status:" "${TICKET_FILE}" | awk '{print $2}')
  CREATED=$(grep "^created:" "${TICKET_FILE}" | awk '{print $2}')
  UPDATED=$(grep "^updated:" "${TICKET_FILE}" | awk '{print $2}')
  ASSIGNEE=$(grep "^assignee:" "${TICKET_FILE}" | awk '{print $2}')
  LABELS=$(grep "^labels:" "${TICKET_FILE}" | cut -d':' -f2- | xargs)
  PRIORITY=$(grep "^priority:" "${TICKET_FILE}" | awk '{print $2}')

  # Build ticket object
  # Add to results array
done
```

**Map to internal format**:
```bash
ID="${id}"
TITLE="${title}"
STATUS="${status}"
PRIORITY="${priority}"
ASSIGNEE="${assignee}"
LABELS="${labels}"
CREATED="${created}"
UPDATED="${updated}"
URL=".aiwg/issues/${ID}.md"  # file path
```

### Step 4: Apply Filters

After fetching tickets, apply additional filters:

**Status filter**:
```bash
if [ "${STATUS_FILTER}" != "all" ]; then
  # Keep only tickets matching status
  FILTERED_TICKETS=$(filter_by_status "${TICKETS}" "${STATUS_FILTER}")
fi
```

**Label filter**:
```bash
if [ -n "${LABEL_FILTER}" ]; then
  # Keep only tickets with matching label(s)
  FILTERED_TICKETS=$(filter_by_label "${TICKETS}" "${LABEL_FILTER}")
fi
```

**Assignee filter**:
```bash
if [ -n "${ASSIGNEE_FILTER}" ]; then
  if [ "${ASSIGNEE_FILTER}" = "unassigned" ]; then
    # Keep only unassigned tickets
    FILTERED_TICKETS=$(filter_unassigned "${TICKETS}")
  else
    # Keep only tickets assigned to user
    FILTERED_TICKETS=$(filter_by_assignee "${TICKETS}" "${ASSIGNEE_FILTER}")
  fi
fi
```

**Sort**:
```bash
case "${SORT}" in
  created)
    SORTED_TICKETS=$(sort_by_field "${TICKETS}" "created" "desc")
    ;;
  updated)
    SORTED_TICKETS=$(sort_by_field "${TICKETS}" "updated" "desc")
    ;;
  priority)
    SORTED_TICKETS=$(sort_by_priority "${TICKETS}")  # critical → high → medium → low
    ;;
  id)
    SORTED_TICKETS=$(sort_by_field "${TICKETS}" "id" "asc")
    ;;
esac
```

**Limit**:
```bash
if [ -n "${LIMIT}" ]; then
  FINAL_TICKETS=$(head -n "${LIMIT}" "${SORTED_TICKETS}")
fi
```

### Step 5: Format Output

#### Table Format

```bash
# Print header
printf "┌──────────┬────────────────────────┬────────────┬──────────┬──────────┬────────────┐\n"
printf "│ %-8s │ %-22s │ %-10s │ %-8s │ %-8s │ %-10s │\n" "ID" "Title" "Status" "Priority" "Assignee" "Labels"
printf "├──────────┼────────────────────────┼────────────┼──────────┼──────────┼────────────┤\n"

# Print rows
for TICKET in "${FINAL_TICKETS[@]}"; do
  printf "│ %-8s │ %-22s │ %-10s │ %-8s │ %-8s │ %-10s │\n" \
    "${ID}" \
    "$(truncate_string "${TITLE}" 22)" \
    "${STATUS}" \
    "${PRIORITY}" \
    "${ASSIGNEE}" \
    "$(truncate_string "${LABELS}" 10)"
done

printf "└──────────┴────────────────────────┴────────────┴──────────┴──────────┴────────────┘\n"
```

#### Compact Format

```bash
for TICKET in "${FINAL_TICKETS[@]}"; do
  printf "%-10s  [%-11s] [%-8s]   %-30s @%-10s  [%s]\n" \
    "${ID}" \
    "${STATUS}" \
    "${PRIORITY}" \
    "$(truncate_string "${TITLE}" 30)" \
    "${ASSIGNEE}" \
    "${LABELS}"
done
```

#### Markdown Format

```bash
echo "# Issues"
echo ""

for TICKET in "${FINAL_TICKETS[@]}"; do
  echo "## ${ID}: ${TITLE}"
  echo ""
  echo "**Status**: ${STATUS}"
  echo "**Priority**: ${PRIORITY}"
  echo "**Assignee**: @${ASSIGNEE}"
  echo "**Labels**: ${LABELS}"
  echo "**Created**: ${CREATED}"
  echo "**Updated**: ${UPDATED}"
  echo ""
  echo "---"
  echo ""
done
```

#### JSON Format

```bash
cat <<EOF
{
  "tickets": [
$(for TICKET in "${FINAL_TICKETS[@]}"; do
  cat <<TICKET_JSON
    {
      "id": "${ID}",
      "title": "${TITLE}",
      "status": "${STATUS}",
      "priority": "${PRIORITY}",
      "assignee": "${ASSIGNEE}",
      "labels": [$(echo "${LABELS}" | sed 's/,/", "/g' | sed 's/^/"/' | sed 's/$/"/')],
      "created": "${CREATED}",
      "updated": "${UPDATED}",
      "url": "${URL}"
    }$([ "${TICKET}" != "${FINAL_TICKETS[-1]}" ] && echo ",")
TICKET_JSON
done)
  ],
  "summary": {
    "total": ${TOTAL_COUNT},
    "open": ${OPEN_COUNT},
    "in_progress": ${IN_PROGRESS_COUNT},
    "closed": ${CLOSED_COUNT},
    "blocked": ${BLOCKED_COUNT},
    "review": ${REVIEW_COUNT}
  }
}
EOF
```

### Step 6: Display Summary Statistics

After displaying tickets, show summary:

```bash
echo ""
echo "Summary: ${TOTAL_COUNT} tickets (${OPEN_COUNT} open, ${IN_PROGRESS_COUNT} in_progress, ${CLOSED_COUNT} closed)"

if [ -n "${LABEL_FILTER}" ]; then
  echo "Filtered by label: ${LABEL_FILTER}"
fi

if [ -n "${ASSIGNEE_FILTER}" ]; then
  echo "Filtered by assignee: ${ASSIGNEE_FILTER}"
fi

if [ "${STATUS_FILTER}" != "all" ]; then
  echo "Filtered by status: ${STATUS_FILTER}"
fi
```

## Examples

### Example 1: List All Open Issues (Default)

**Command**:
```bash
/issue-list
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
┌──────────┬────────────────────────┬────────────┬──────────┬──────────┬────────────┐
│ ID       │ Title                  │ Status     │ Priority │ Assignee │ Labels     │
├──────────┼────────────────────────┼────────────┼──────────┼──────────┼────────────┤
│ ISSUE-1 │ Implement user auth    │ in_progress│ high     │ johndoe  │ feature,ui │
│ ISSUE-2 │ Add dark mode          │ open       │ medium   │ janedoe  │ feature    │
│ ISSUE-4 │ Security audit         │ open       │ critical │ security │ security   │
└──────────┴────────────────────────┴────────────┴──────────┴──────────┴────────────┘

Summary: 3 tickets (2 open, 1 in_progress, 0 closed)
```

### Example 2: List Closed Issues

**Command**:
```bash
/issue-list --status closed
```

**Output**:
```
┌──────────┬────────────────────────┬────────────┬──────────┬──────────┬────────────┐
│ ID       │ Title                  │ Status     │ Priority │ Assignee │ Labels     │
├──────────┼────────────────────────┼────────────┼──────────┼──────────┼────────────┤
│ ISSUE-3 │ Fix navigation bug     │ closed     │ critical │ johndoe  │ bug        │
│ ISSUE-5 │ Update documentation   │ closed     │ low      │ janedoe  │ docs       │
└──────────┴────────────────────────┴────────────┴──────────┴──────────┴────────────┘

Summary: 2 tickets (0 open, 0 in_progress, 2 closed)
Filtered by status: closed
```

### Example 3: List Bugs Assigned to User

**Command**:
```bash
/issue-list --label bug --assignee johndoe
```

**Output**:
```
┌──────────┬────────────────────────┬────────────┬──────────┬──────────┬────────────┐
│ ID       │ Title                  │ Status     │ Priority │ Assignee │ Labels     │
├──────────┼────────────────────────┼────────────┼──────────┼──────────┼────────────┤
│ ISSUE-3 │ Fix navigation bug     │ closed     │ critical │ johndoe  │ bug        │
│ ISSUE-6 │ Fix auth timeout       │ open       │ high     │ johndoe  │ bug        │
└──────────┴────────────────────────┴────────────┴──────────┴──────────┴────────────┘

Summary: 2 tickets (1 open, 0 in_progress, 1 closed)
Filtered by label: bug
Filtered by assignee: johndoe
```

### Example 4: List Unassigned Issues (Compact Format)

**Command**:
```bash
/issue-list --assignee unassigned --format compact
```

**Output**:
```
ISSUE-2   [open]        [medium]   Add dark mode                @unassigned  [feature]
ISSUE-7   [open]        [low]      Refactor API module          @unassigned  [refactor]
ISSUE-8   [blocked]     [high]     Deploy to staging            @unassigned  [deployment,blocked]

Summary: 3 tickets (2 open, 0 in_progress, 0 closed, 1 blocked)
Filtered by assignee: unassigned
```

### Example 5: List All Issues (JSON Format)

**Command**:
```bash
/issue-list --status all --format json --limit 2
```

**Output**:
```json
{
  "tickets": [
    {
      "id": "ISSUE-1",
      "title": "Implement user auth",
      "status": "in_progress",
      "priority": "high",
      "assignee": "johndoe",
      "labels": ["feature", "ui"],
      "created": "2026-01-10",
      "updated": "2026-01-13",
      "url": "https://git.integrolabs.net/roctinam/ai-writing-guide/issues/1"
    },
    {
      "id": "ISSUE-2",
      "title": "Add dark mode",
      "status": "open",
      "priority": "medium",
      "assignee": "janedoe",
      "labels": ["feature"],
      "created": "2026-01-11",
      "updated": "2026-01-11",
      "url": "https://git.integrolabs.net/roctinam/ai-writing-guide/issues/2"
    }
  ],
  "summary": {
    "total": 8,
    "open": 3,
    "in_progress": 1,
    "closed": 2,
    "blocked": 1,
    "review": 1
  }
}
```

### Example 6: List High-Priority Issues (Markdown Format)

**Command**:
```bash
/issue-list --status all --format markdown | grep -A10 "Priority\*\*: high"
```

**Output**:
```markdown
## ISSUE-1: Implement user auth

**Status**: in_progress
**Priority**: high
**Assignee**: @johndoe
**Labels**: feature, ui
**Created**: 2026-01-10
**Updated**: 2026-01-13

---

## ISSUE-6: Fix auth timeout

**Status**: open
**Priority**: high
**Assignee**: @johndoe
**Labels**: bug
**Created**: 2026-01-12
**Updated**: 2026-01-12

---
```

## Error Handling

### No Issues Found

```
No tickets found.

Filters applied:
- Status: open
- Label: bug
- Assignee: johndoe

Try:
- Remove filters by loading `issue-list` without filters.
- Change status filter by loading `issue-list` with status all.
- Create a ticket by loading `issue-create`.
```

### Provider Error

```
❌ Failed to fetch tickets from Gitea:

Error: 401 Unauthorized
- Token may be invalid or expired
- Verify token at https://git.integrolabs.net/user/settings/applications

Falling back to local provider...
```

### Invalid Filter

```
❌ Invalid status filter: 'inprogress'

Valid status values:
- open
- in_progress
- closed
- blocked
- review
- all

Example: /issue-list --status in_progress
```

## Best Practices

1. **Use filters wisely** - Narrow results to relevant tickets
2. **Default to open tickets** - Focus on actionable work
3. **Use compact format for quick scans** - Easy to parse visually
4. **Use JSON format for automation** - Parse with jq or scripts
5. **Use markdown format for reports** - Copy to documentation
6. **Sort by updated** - See recently active tickets first
7. **Limit results** - Avoid overwhelming output
8. **Combine filters** - Find exactly what you need (e.g., `--label bug --assignee unassigned`)

## Integration with SDLC Workflows

**Daily Standup**:
```bash
# What am I working on?
/issue-list --assignee me --status in_progress

# What's blocked?
/issue-list --status blocked
```

**Sprint Planning**:
```bash
# What's in the backlog?
/issue-list --status open --sort priority

# What's unassigned?
/issue-list --assignee unassigned --label feature
```

**Bug Triage**:
```bash
# Critical bugs
/issue-list --label bug --status open --sort priority

# Unassigned bugs
/issue-list --label bug --assignee unassigned
```

**Security Review**:
```bash
# Security tickets
/issue-list --label security --status all

# Security vulnerabilities
/issue-list --label vulnerability --status open
```

**Retrospective**:
```bash
# Closed this sprint
/issue-list --status closed --sort updated --limit 20

# Blocked items
/issue-list --status blocked
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/config/issueing-config.md - Configuration schema
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-create/SKILL.md - Create ticket skill
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-update/SKILL.md - Update ticket skill
- @CLAUDE.md - User ticketing configuration
