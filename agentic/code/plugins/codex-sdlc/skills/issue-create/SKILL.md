---
namespace: aiwg
name: issue-create
platforms: [all]
description: Create a new ticket/issue with configurable backend (Gitea, GitHub, Jira, Linear, or local files)
script:
  entrypoint: scripts/compose.mjs
  runtime: node
  cwd: project-root
  argsHint: plan --title <title> [--body <text>|--body-file <path>] [--labels a,b]
commandHint:
  argumentHint: <title> [description] [--provider NAME --labels "label1,label2" --assignee USER --check-regression]
  allowedTools: Read, Write, Glob, Bash, mcp__gitea__create_issue
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


# Issue Create

## Semantic Label Contract (#1789)

Resolve the target workspace member first and check its `issue-comment`
capability. Then resolve that member's `.aiwg/aiwg.config`
`remotes.issue_tracker`, `remotes.tracker_actor`, and `issues.labels` before
translating any semantic label role into a tracker-native string. Validate the
resolved label against the target tracker catalog. Preserve caller-supplied
unrelated labels, report unavailable roles, and never provision a missing label
implicitly. If `issues.labels` is absent, retain legacy behavior with an
explicit fallback warning rather than silently guessing project semantics.
Reject any write route whose authenticated login is listed in the target
member's `forbid_actors`.

## Purpose

Create a new ticket/issue for tracking work items, bugs, features, or tasks. Automatically uses the configured ticketing provider (Gitea, GitHub, Jira, Linear) or falls back to local file-based tracking.

## Task

Given a ticket title and optional description:

1. **Resolve the target member and authorization**, then load its `.aiwg/aiwg.config`
2. **Validate configuration** and authenticate with provider
3. **Check for regressions** (if bug report with `--check-regression`)
4. **Compose and assess the final draft before any write**; split it at enforced
   policy boundaries when possible
5. **Create only approved ticket segment(s)** using the appropriate backend
   (MCP, CLI, or local file), then cross-link split siblings
6. **Return ticket reference(s)** and deterministic recovery state if a
   multi-ticket write stops partway through

## Parameters

- **`<title>`** (required): Short, descriptive title for the ticket
- **`[description]`** (optional): Detailed description of the work item
- **`--provider NAME`** (optional): Override configured provider (gitea|github|jira|linear|local)
- **`--labels "label1,label2"`** (optional): Comma-separated labels/tags
- **`--assignee USER`** (optional): Assign to specific user
- **`--priority LEVEL`** (optional): Priority level (low|medium|high|critical)
- **`--milestone NAME`** (optional): Associate with milestone (provider-dependent)
- **`--check-regression`** (optional): Run regression check for bug reports (auto-runs if labels include "bug" or "regression")

## Inputs

**Configuration sources** (checked in order):
1. `.aiwg/config.yaml` - Project-level configuration
2. `CLAUDE.md` - User-level configuration
3. Default: `local` provider

**Required for Gitea**:
- Provider: `gitea`
- URL: Base URL (e.g., `https://git.integrolabs.net`)
- Owner: User or organization name
- Repo: Repository name
- Token: `~/.config/gitea/token` (or configured path)

**Required for GitHub**:
- Provider: `github`
- Owner: User or organization name
- Repo: Repository name
- Auth: `gh` CLI authenticated

**Required for Jira**:
- Provider: `jira`
- URL: Jira instance URL
- Owner: Project key
- Auth: `JIRA_API_TOKEN` environment variable

**Required for Linear**:
- Provider: `linear`
- URL: `https://api.linear.app`
- Owner: Team ID
- Auth: `LINEAR_API_TOKEN` environment variable

**Required for Local**:
- Provider: `local`
- Directory: `.aiwg/issues/` (created if missing)

## Outputs

**Gitea/GitHub/Jira/Linear**:
- Issue created on remote system
- Issue number returned
- URL to view ticket

**Local**:
- File created: `.aiwg/issues/ISSUE-{num}.md`
- Issue number returned
- File path returned

## Workflow

### Step 1: Parse Parameters

Extract from the user's request or from composed skill arguments:

```bash
# Basic request
Create an issue titled "Implement user auth"

# With description
Create an issue titled "Fix navigation bug" with the body "Nav menu not showing on mobile devices"

# With labels
Create an issue titled "Add dark mode" with labels "feature,ui"

# With assignee
Create an issue titled "Security audit", assign security-team, and mark it high priority

# Bug report with regression check
Create a bug issue titled "Login broken after deployment" and check whether it is a regression

# Override provider
Create a local issue titled "Local task" with the body "Quick reminder"
```

**Parameter extraction**:
- Title: First quoted argument (required)
- Description: Second quoted argument (optional, default: empty)
- Flags: Parse `--flag value` pairs

### Step 2: Load Configuration

**Resolution precedence** (highest first):

1. **`--provider` flag** — explicit override always wins.
2. **Target member `.aiwg/aiwg.config` `remotes.issue_tracker`** (#994, #1764) — derive provider from that member remote's URL.
3. **Legacy `.aiwg/config.yaml`** (`ticketing` block) — back-compat for older projects.
4. **`CLAUDE.md` "Issueing Configuration" block** — fallback for projects pre-dating either.
5. **`local`** — default if nothing is configured.

**Resolving from a workspace member** (the preferred path):

```ts
import { authorizeWorkspaceOperation } from 'aiwg/config/workspace';

const decision = await authorizeWorkspaceOperation(workspaceDir, targetRepo, 'issue-comment');
if (!decision.allowed || !decision.member) throw new Error(decision.reason);
const provider = decision.member.issueTracker.provider;
const url = decision.member.issueTracker.url;
const actor = decision.member.remotes.tracker_actor;
```

When `provider === 'unknown'` (self-hosted instances we can't classify by URL), the operator must pass `--provider` explicitly. Don't guess.

**Worked example for this repo** (`origin` → `git.integrolabs.net/roctinam/aiwg`):

- `resolved.issue_tracker` = `'origin'`
- `git remote get-url origin` = `git@git.integrolabs.net:roctinam/aiwg.git`
- `resolveRemoteProvider(url)` returns `'unknown'` (the host doesn't include "gitea")
- → operator must set `--provider gitea`, OR the project's `aiwg.config` must set `remotes.issue_provider: "gitea"` so issue tooling can use that explicit tracker hint.

**Override warning**: if `--provider` differs from the auto-resolved one, print:
`⚠️ Using --provider github (resolved from .aiwg/aiwg.config: gitea)`

### Step 3: Regression Detection (for Bug Reports)

**Trigger conditions**:
- Explicit: `--check-regression` flag provided
- Automatic: `--labels` contains "bug" OR "regression"
- Type: Issue is categorized as bug/defect

**Regression check process**:

```bash
# Detect if regression check should run
if [[ "$LABELS" == *"bug"* ]] || [[ "$LABELS" == *"regression"* ]] || [[ "$CHECK_REGRESSION" == "true" ]]; then
  echo "⏳ Running regression check..."

  # Run regression check against main branch
  /regression-check --baseline main --scope changed-files --format summary > /tmp/regression-results.md

  # Parse results
  REGRESSION_DETECTED=$(grep "REGRESSIONS DETECTED" /tmp/regression-results.md)

  if [ -n "$REGRESSION_DETECTED" ]; then
    # Escalate priority and add labels
    PRIORITY="critical"
    LABELS="${LABELS},regression-confirmed"

    # Extract regression details for issue body
    REGRESSION_SUMMARY=$(sed -n '/### Critical Regressions/,/###/p' /tmp/regression-results.md)

    # Append to description
    DESCRIPTION="${DESCRIPTION}

---

## Regression Analysis

${REGRESSION_SUMMARY}

**Full Report**: See attached regression-results.md"
  else
    # No regression detected
    LABELS="${LABELS},no-regression"
  fi
fi
```

**Impact on issue creation**:

| Regression Status | Priority | Labels | Action |
|-------------------|----------|--------|--------|
| REGRESSION DETECTED | Critical | bug, regression-confirmed | Escalate, include analysis |
| NO REGRESSION | Original | bug, no-regression | Standard bug workflow |
| CHECK FAILED | Original | bug, regression-check-failed | Create issue, note failure |

### Step 4: Validate Configuration

**For each provider, validate required fields**:

**Gitea**:
- [ ] `url` present and valid URL
- [ ] `owner` present
- [ ] `repo` present
- [ ] Token file exists and readable

**GitHub**:
- [ ] `owner` present
- [ ] `repo` present
- [ ] `gh` CLI installed (`which gh`)
- [ ] `gh` authenticated (`gh auth status`)

**Jira**:
- [ ] `url` present and valid URL
- [ ] `owner` (project key) present
- [ ] `JIRA_API_TOKEN` environment variable set

**Linear**:
- [ ] `url` present (default: `https://api.linear.app`)
- [ ] `owner` (team ID) present
- [ ] `LINEAR_API_TOKEN` environment variable set

**Local**:
- [ ] `.aiwg/issues/` directory exists or can be created
- [ ] Directory is writable

**Error handling**:
- If validation fails, report error and suggest fix
- Optionally fall back to `local` provider with warning

### Step 5: Policy-Boundary Composition (Required Before Every Write)

After regression metadata, labels, priority, and acceptance criteria are final,
run the same threat policy that `address-issues` will apply later:

```bash
aiwg run skill issue-create -- plan \
  --title "$TITLE" \
  --body-file "$DRAFT_BODY_FILE" \
  --labels "$LABELS" \
  --project-root "$TARGET_REPO"
```

The returned `aiwg.issue-composition-plan.v1` envelope is authoritative for the
write step:

- `single`: create the one draft unchanged.
- `authorization-required`: do not write until the issue-specific policy
  authorization is recorded for the returned digest.
- `split`: create every segment in order, using its exact title, body, labels,
  priority, provider scope, and provenance marker.
- `split-authorization-required`: obtain authorization for the digest, then
  create every independently assessed segment in order.
- `blocked`: make no tracker mutation. Report `blockingRule` and the suggested
  human-editable segments.

Never delete the `aiwg-policy-segment` marker. Before retrying a partial split,
search the target tracker for every marker in the recovery envelope and reuse
existing matches. After all segments exist, replace `{{AIWG_RELATED_ISSUES}}`
with sibling links and the declared dependency. This is what prevents a retry
from duplicating the first issue after a later write fails.

This preflight is mandatory for Gitea MCP, `tea`, GitHub CLI/API, Jira, Linear,
and local-file routes. Higher-level flows that author issues must call this
skill or the same composer; they may not jump directly to a tracker create API.

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

### Step 7: Attach Regression Report (if applicable)

If regression check was run and regression detected:

```bash
# Save regression report alongside issue
if [ -f /tmp/regression-results.md ]; then
  cp /tmp/regression-results.md ".aiwg/issues/${TICKET_ID}-regression-report.md"

  # Add reference to issue body (provider-specific)
  # For local: already included in DESCRIPTION above
  # For Gitea/GitHub: attach as comment or file
fi
```

### Step 8: Return Issue Reference

**Output format** (consistent across providers):

```markdown
✅ Issue created: {ticket-id}

{view-url-or-file-path}

**Title**: {title}
**Status**: {status}
**Priority**: {priority}
**Labels**: {labels}
**Assignee**: {assignee}

{If regression detected:}
⚠️ **Regression Detected**: Critical regressions found and documented in issue

## Next Steps

- View ticket: {url-or-command}
- To update status, discover and load `issue-update`.
- To add a comment, discover and load `issue-update`.
- To list tickets, discover and load `issue-list`.
```

## Examples

### Example 1: Create Feature Request (Gitea)

**Request**:
```bash
Create a high-priority feature issue titled "Add dark mode" with body "Implement theme toggle for light/dark mode preferences" and labels "feature,ui".
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
✅ Issue created: ISSUE-42

View at: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42

**Title**: Add dark mode
**Status**: open
**Priority**: high
**Labels**: feature, ui
**Assignee**: unassigned

## Next Steps

- View ticket: https://git.integrolabs.net/roctinam/ai-writing-guide/issues/42
- Update status by loading `issue-update` for ISSUE-42.
- Add comments through `issue-update`.
- List feature tickets by loading `issue-list`.
```

### Example 2: Create Bug Report with Regression Check (Local)

**Request**:
```bash
Create a critical bug issue titled "Login broken after deployment" with body "Users unable to authenticate since v2.1.4 deployment" and run the regression check.
```

**Output**:
```
⏳ Running regression check...
✓ Regression analysis complete: 2 critical regressions detected

✅ Issue created: ISSUE-003

File: .aiwg/issues/ISSUE-003.md

**Title**: Login broken after deployment
**Status**: open
**Priority**: critical
**Labels**: bug, critical, regression-confirmed
**Assignee**: unassigned

⚠️ **Regression Detected**: 2 critical regressions found
   - Authentication validation failing at token refresh
   - Session state not persisting across requests

**Regression Report**: .aiwg/issues/ISSUE-003-regression-report.md

## Next Steps

- View ticket: cat .aiwg/issues/ISSUE-003.md
- View regression details: cat .aiwg/issues/ISSUE-003-regression-report.md
- Update status by loading `issue-update` for ISSUE-003.
- Run regression analysis through the regression-check capability.
- List regression issues by loading `issue-list`.
```

### Example 3: Create Task with Assignee (GitHub)

**Request**:
```bash
Create an issue titled "Security audit" with body "Run penetration test on authentication endpoints", assign security-team, add labels "security,high-priority", and set milestone "Q1-2026".
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
✅ Issue created: #128

View at: https://github.com/jmagly/aiwg/issues/128

**Title**: Security audit
**Status**: open
**Priority**: medium (default)
**Labels**: security, high-priority
**Assignee**: @security-team
**Milestone**: Q1-2026

## Next Steps

- View ticket: gh issue view 128
- Update status by loading `issue-update` for #128.
- Add comments through `issue-update`.
- List security tickets by loading `issue-list`.
```

### Example 4: Bug Report with Auto-Detected Regression Check

**Request**:
```bash
Create a payments bug issue titled "Payment calculation incorrect" with body "Discount not applying for orders > $1000".
```

**Output**:
```
ℹ️ Bug report detected, running automatic regression check...
⏳ Running regression check against baseline main...
✓ Regression confirmed: Introduced in commit abc1234

✅ Issue created: ISSUE-025

**Title**: Payment calculation incorrect
**Status**: open
**Priority**: critical (escalated due to regression)
**Labels**: bug, payments, regression-confirmed
**Assignee**: unassigned

⚠️ **Regression Confirmed**:
   - Introduced in: commit abc1234 (2026-01-15)
   - Root cause: Integer division in discount calculation
   - Blast radius: 12 unit tests, 3 integration tests affected

**Actions**:
   - Priority escalated to CRITICAL
   - Regression analyst assigned
   - Full report attached

**Regression Report**: .aiwg/issues/ISSUE-025-regression-report.md

## Next Steps

- View regression analysis: cat .aiwg/issues/ISSUE-025-regression-report.md
- Assign to developer: `/issue-update ISSUE-025 --assignee developer-name`
- Review introducing commit: git show abc1234
- Run targeted regression tests: npm test -- --grep "discount calculation"
```

## Error Handling

### No Configuration Found

```
⚠️ No ticketing configuration found.

Using default: local file-based tracking (.aiwg/issues/)

To configure a provider, create .aiwg/config.yaml:

ticketing:
  provider: gitea
  url: https://git.integrolabs.net
  owner: roctinam
  repo: ai-writing-guide

Or add to CLAUDE.md:

## Issueing Configuration

- **Provider**: gitea
- **URL**: https://git.integrolabs.net
- **Owner**: roctinam
- **Repo**: ai-writing-guide

Proceeding with local provider...
```

### Invalid Configuration

```
❌ Invalid ticketing configuration:

Issues:
- provider 'gitehub' not recognized (must be: gitea, github, jira, linear, local)
- missing required field: url
- missing required field: repo

Fix configuration in .aiwg/config.yaml or CLAUDE.md

Cannot create ticket without valid configuration.
```

### Authentication Failed

```
❌ Failed to authenticate with Gitea:

Issues:
- Token file not found: ~/.config/gitea/token
- Create token at https://git.integrolabs.net/user/settings/applications
- Save to ~/.config/gitea/token (mode 600)

Falling back to local file-based tracking.

To retry with Gitea:
1. Create token at https://git.integrolabs.net/user/settings/applications
2. Save to ~/.config/gitea/token
3. Run command again

Proceeding with local provider...
```

### Regression Check Failed

```
⚠️ Regression check failed to complete:

Error: Baseline branch 'main' not found
Possible causes:
- Fresh repository without baseline
- Branch name incorrect

Creating issue without regression analysis.
Use `regression-check` manually after issue creation to verify.
```

### Missing Title

```
❌ Issue title is required.

Usage: discover and load the skill, then compose the issue request:

aiwg discover "issue create"
aiwg show skill issue-create

Examples:
- Create an issue titled "Implement user auth"
- Create a bug issue titled "Fix bug" with body "Nav menu broken on mobile"
- Create a feature issue titled "Add feature" with labels "feature,ui"
```

### Provider-Specific Errors

**Gitea MCP Error**:
```
❌ Failed to create Gitea issue:

Error: 401 Unauthorized
- Token may be invalid or expired
- Verify token at https://git.integrolabs.net/user/settings/applications
- Check token file: ~/.config/gitea/token

Falling back to local provider...
```

**GitHub CLI Error**:
```
❌ Failed to create GitHub issue:

Error: gh: command not found
- Install GitHub CLI: brew install gh (or platform equivalent)
- Authenticate: gh auth login

Or ask for a local issue explicitly after loading the `issue-create` skill.
```

**Jira API Error**:
```
❌ Failed to create Jira issue:

Error: 400 Bad Request - Invalid project key
- Verify project key: ${PROJECT_KEY}
- Check Jira URL: ${JIRA_URL}
- Verify API token: echo $JIRA_API_TOKEN

Falling back to local provider...
```

**Local Filesystem Error**:
```
❌ Failed to create local ticket file:

Error: Permission denied - .aiwg/issues/
- Check directory permissions: ls -la .aiwg/
- Ensure writable: chmod 755 .aiwg/issues/

Cannot create ticket.
```

## Best Practices

1. **Use project-level config** (`.aiwg/config.yaml`) for team consistency
2. **Provide detailed descriptions** - Include context, acceptance criteria, and steps to reproduce (for bugs)
3. **Use labels consistently** - Establish team conventions (e.g., `feature`, `bug`, `tech-debt`)
4. **Set priorities appropriately** - Reserve `critical` for urgent production issues
5. **Assign tickets early** - Use `--assignee` to clarify ownership
6. **Link to artifacts** - Reference related files (`@.aiwg/requirements/UC-001.md`)
7. **Use milestones** - Group related work with `--milestone`
8. **Test authentication** - Verify provider connectivity before creating many tickets
9. **Enable regression checks** - Use `--check-regression` for bug reports to detect regressions early
10. **Review regression reports** - Always examine attached regression analysis before starting work

## Integration with SDLC Workflows

**Requirements Phase**:
```bash
# Create tickets from use cases
Create an issue titled "Implement UC-001: User Login" referencing @.aiwg/requirements/use-cases/UC-001-login.md with labels "requirement,feature"
```

**Architecture Phase**:
```bash
# Create tickets from ADR decisions
Create an issue titled "Implement ADR-003: Use PostgreSQL" referencing @.aiwg/architecture/adrs/003-use-postgresql.md with labels "architecture,database"
```

**Testing Phase**:
```bash
# Create tickets from test failures with regression check
Create a high-priority bug issue titled "Fix failing test: auth.test.ts" and run the regression check
```

**Security Review**:
```bash
# Create tickets from security audit findings
Create a critical security issue titled "Fix SQL injection vulnerability" with labels "security,vulnerability"
```

**Retrospectives**:
```bash
# Create tickets from retro action items
Create an issue titled "Improve CI/CD pipeline" with labels "process-improvement,devops"
```

**Regression Detection**:
```bash
# Create issue from detected regression
Create a regression issue titled "Performance regression in API" and include p99 latency evidence
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/config/issueing-config.md - Configuration schema
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-update.md - Update ticket command
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-list.md - List tickets command
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/regression-check.md - Regression detection command
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/regression-analyst.md - Regression analysis agent
- @CLAUDE.md - User ticketing configuration
