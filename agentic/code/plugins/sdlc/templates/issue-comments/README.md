# Issue Comment Templates

## Canonical address-issues cycle status

`al-cycle.md` is the single canonical tracker payload for every
`address-issues` cycle, including Codex and Claude Code native-goal checkpoints
and continuations after human feedback or authorization. Render and validate it
with `skills/address-issues/scripts/cycle-comment.mjs` before tracker writes.
The generic progress, feedback, blocker, and completion templates below remain
available for non-cycle `issue-comment` operations; they must not replace the
five-section AL CYCLE contract.

Standardized templates for structured issue tracking communication.

## Overview

These templates provide consistent, professional comments for issue tracking systems (GitHub Issues, Gitea Issues, etc.). They ensure all stakeholders have clear, actionable information about task status, blockers, and progress.

## Templates

### task-completed.md

**Purpose**: Mark a task as complete with comprehensive summary.

**When to use**:
- Work is finished and ready for review
- All acceptance criteria met
- Tests passing and code merged
- Issue can be closed

**Key sections**:
- Summary of completed work
- Deliverables (files, artifacts, tests)
- Changes made (file list, statistics)
- Verification checklist
- Related items (commits, PRs, issues)
- Next steps or follow-ups

**Example usage**:
```bash
/issue-close 17
# Uses task-completed.md template
```

---

### feedback-needed.md

**Purpose**: Request review or input on work in progress.

**When to use**:
- Need architectural review
- Seeking validation on approach
- Requesting code review before proceeding
- Critical decision point requiring input
- Blocked waiting for clarification

**Key sections**:
- Context of current state
- Work completed so far
- Deliverables ready for review
- Specific feedback areas
- Questions requiring answers
- Label state for the `question` label while answers are outstanding
- Blocking items (if any)
- Timeline impact
- Requested reviewers

**Example usage**:
```bash
/issue-comment 17 --type feedback --interactive
# Prompts for feedback details, uses feedback-needed.md
```

If a feedback-needed or address-issues cycle comment includes unanswered
questions, ensure the issue has the `question` label. Remove it only when all
tracked questions on the issue are answered.

---

### blocker-found.md

**Purpose**: Report blocking issues requiring immediate attention.

**When to use**:
- External dependency unavailable
- Technical blocker preventing progress
- Resource constraint (access, permissions, budget)
- Waiting on critical decision
- Upstream issue blocking work

**Key sections**:
- Blocker description (clear, specific)
- Root cause (if known)
- Impact assessment (immediate and downstream)
- Risk level (technical, schedule, quality)
- Attempted resolutions
- Proposed solutions (with effort estimates)
- Recommended action
- Work stopped (what's blocked)
- Escalation path

**Example usage**:
```bash
/issue-comment 17 --type blocker --interactive
# Prompts for blocker details, uses blocker-found.md
```

---

### progress-update.md

**Purpose**: Regular status updates on work in progress.

**When to use**:
- Weekly or sprint check-ins
- After completing milestones
- When asked for status update
- Before phase transitions
- To keep stakeholders informed

**Key sections**:
- Current phase/milestone
- Completed since last update
- Deliverables completed
- Tests added
- Currently working on
- Challenges and issues
- Metrics (coverage, tests, etc.)
- Timeline status
- Dependencies (completed and waiting on)
- Decisions made
- Questions needing clarification

**Example usage**:
```bash
/issue-comment 17 --type progress
# Auto-populates from recent commits and changes
```

---

## Template Variables

All templates support variable substitution:

### Common Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{agent_or_user}` | Who performed the action | `john.doe` or `Claude` |
| `{timestamp}` | Current date/time | `2025-01-13 12:30:00 UTC` |
| `{issue_number}` | Issue reference | `17` |
| `{repo}` | Repository identifier | `owner/repo` |
| `{short_sha}` | Short commit SHA | `abc123` |
| `{full_sha}` | Full commit SHA | `abc123def456...` |

### Context-Specific Variables

| Variable | Template | Description |
|----------|----------|-------------|
| `{commit_message}` | All | Full commit message |
| `{file_path}` | All | Path to changed file |
| `{lines_added}` | All | Lines added count |
| `{lines_removed}` | All | Lines removed count |
| `{percentage}` | progress, task-completed | Completion percentage |
| `{priority}` | feedback, blocker | Priority level |
| `{severity}` | blocker | Severity assessment |
| `{deliverable_N}` | All | Deliverable item |
| `{challenge_N}` | progress, blocker | Challenge description |

### Conditional Sections

Templates include conditional sections marked with `{if_applicable}`:

```markdown
## Optional Section
{if_applicable}
- Item 1
- Item 2
```

These sections should only be included if relevant data exists.

## Customization

### Project-Specific Templates

Create custom templates in your project:

```
.aiwg/templates/issue-comments/
├── deployment-update.md
├── security-review.md
└── custom-template.md
```

Reference with:
```bash
/issue-comment 17 --template .aiwg/templates/issue-comments/deployment-update.md
```

### Template Syntax

Templates use markdown with variable placeholders:

```markdown
## Section Name

**Field**: {variable_name}

{if_applicable}
### Optional Section
{optional_content}
```

## Automated Population

Commands automatically populate templates with:

**From Git**:
- Commit SHA, message, author, timestamp
- Branch name
- Changed files and line counts
- Recent commit history

**From AIWG Artifacts**:
- Related requirements documents
- Architecture decisions
- Test plans and results

**From Code Analysis**:
- Test coverage percentages
- New test files added
- TODO/FIXME comments

**From CI/CD**:
- Pipeline status
- Test results
- Build artifacts

## Best Practices

### Completion Comments

**Include**:
- Specific deliverables with paths
- Test coverage metrics
- Verification checklist
- Links to commits and PRs

**Example**:
```markdown
## Task Completed

✅ Implemented issue sync automation
✅ Added 3 commands: /issue-sync, /issue-close, /issue-comment
✅ Created 4 comment templates
✅ Added 1 skill: issue-auto-sync
✅ Test coverage: 85% (34 tests passing)

Files: 8 created, 2 modified
Commits: abc123, def456, ghi789

Ready for review and merge.
```

### Feedback Requests

**Include**:
- Specific questions
- Context and background
- Deliverables ready for review
- Timeline constraints
- Recommended reviewers

**Example**:
```markdown
## Feedback Needed

Need architectural review on issue sync implementation.

Questions:
1. Should we use polling or webhooks for real-time updates?
2. Is the current rate limiting strategy sufficient?

Deliverables:
- Architecture doc: .aiwg/architecture/sad.md (updated)
- ADR: .aiwg/architecture/adr-017-issue-sync.md

Timeline: Blocked for 2 days, impacts sprint goals.

Reviewers: @architect, @tech-lead
```

### Blocker Notifications

**Include**:
- Clear, specific problem description
- Impact assessment (what's blocked)
- Proposed solutions with effort
- Recommended action
- Escalation path if unresolved

**Example**:
```markdown
## Blocker: GitHub API Rate Limit

Severity: HIGH
Impact: Phase-level (blocks all integration tests)

Root Cause: Exceeded 5000 req/hour during test runs

Solutions:
1. Use authenticated requests (10x limit) - 2h effort ✅ RECOMMENDED
2. Implement caching - 4h effort
3. Reduce test frequency - 30min (temporary)

Work Stopped:
- Integration test development
- CI pipeline testing

Escalate to: @tech-lead if not resolved by EOD
```

### Progress Updates

**Include**:
- Concrete accomplishments (not vague)
- Metrics and statistics
- Current focus
- Upcoming work
- Risks or blockers

**Example**:
```markdown
## Progress Update (Week 2)

✅ Completed:
- 3 commands implemented (8 files, 2000 LoC)
- 4 templates created
- 1 skill added
- Test coverage: 60% → 85% (+25%)

🔄 In Progress:
- Documentation updates
- Integration testing

📅 Next:
- E2E testing with live repos
- README finalization

⚠️  No blockers. On track for Friday completion.
```

## Integration

### With Commands

Templates are used by:
- `/issue-sync` - Auto-generates comments from commits
- `/issue-close` - Uses task-completed.md
- `/issue-comment` - Interactive template selection

### With Skills

Templates are used by:
- `issue-auto-sync` - Post-commit synchronization
- `artifact-orchestration` - Artifact completion notices
- `incident-triage` - Incident status updates

### With Git Hooks

Templates populate from:
- Post-commit hooks (issue references)
- Pre-push hooks (batch updates)
- CI/CD pipelines (deployment notices)

## References

- Commands: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-sync.md, @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-close.md, @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-comment.md
- Skills: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-auto-sync/SKILL.md

## Example Workflow

### Complete Feature Workflow

```bash
# 1. Start work
git checkout -b feature/issue-17-auto-sync

# 2. Make changes
git add .
git commit -m "Implements #17: Add issue detection logic"
# Triggers: /issue-comment 17 --type progress

# 3. More progress
git commit -m "Addresses #17: Add API integration"
# Triggers: /issue-comment 17 --type progress (updates)

# 4. Complete work
git commit -m "Fixes #17: Complete issue sync automation"
# Triggers: /issue-close 17 (uses task-completed.md)

# 5. Auto-sync creates:
# - Progress comments on #17 (commits 1-2)
# - Completion comment on #17 (commit 3)
# - Closes issue #17
```

### Blocker Workflow

```bash
# Work stops due to blocker
git commit -m "Blocked by #21: Cannot proceed without API keys"

# Triggers: /issue-comment 17 --type blocker
# Creates blocker comment on #17
# Creates reference comment on #21

# When blocker resolved
git commit -m "Addresses #17: Resumed work after #21 resolved"

# Triggers: /issue-comment 17 --type progress
# Updates #17 with progress
```

## Testing

Test templates by:

```bash
# Dry run (preview only)
/issue-comment 17 --type progress --dry-run

# Interactive mode (step through prompts)
/issue-comment 17 --type feedback --interactive

# Custom content
/issue-comment 17 --type custom --content "Quick status update"
```
