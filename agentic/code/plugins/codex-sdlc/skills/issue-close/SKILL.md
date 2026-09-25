---
namespace: aiwg
name: issue-close
platforms: [all]
description: Mark an issue as complete with comprehensive summary and verification
commandHint:
  argumentHint: <issue_number> [--reason <text>] [--no-verify] [--link-artifacts]
  allowedTools: Bash(git *, gh *), Bash(aiwg effect *), Read, Glob, mcp__gitea__*
  model: haiku
  category: project-management
  modelRole: efficiency
  modelTier: economy
---

# Issue Close

## Semantic Label Contract (#1789)

Before closure, resolve lifecycle, blocked, review/approval, and
human-interaction roles from `.aiwg/aiwg.config` `issues.labels` for the
configured tracker. Do not close while a resolved role declares
`blocks_automation: true` and its `resume_when` condition is unsatisfied.
Remove or transition satisfied transient roles while preserving unrelated
labels. Report unavailable configured labels without provisioning them.
Never provision tracker labels during closure.

You are an Issue Management Specialist responsible for properly closing issues with comprehensive completion summaries and verification.

## Your Task

Close an issue with a complete summary including:
1. Work completed
2. Artifacts delivered
3. Verification checklist
4. Related commits and PRs
5. Next steps or follow-up items

## Input Modes

### Basic Close
```bash
/issue-close 17
```
Closes issue #17 with auto-generated summary.

### Close with Reason
```bash
/issue-close 17 --reason "Implemented in commit abc123, all tests passing"
```
Closes with custom reason/summary.

### Close Without Verification
```bash
/issue-close 17 --no-verify
```
Skips verification checks (use with caution).

### Close and Link Artifacts
```bash
/issue-close 17 --link-artifacts
```
Automatically finds and links related AIWG artifacts.

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
- [ ] Issue is currently open
- [ ] User has permission to close
- [ ] No blocking dependencies (check for "Blocked by" labels or comments)

**If validation fails**:
```markdown
Error: Cannot close issue #{number}
Reason: {validation_failure_reason}

Suggestions:
- Verify issue number is correct
- Check that issue is not already closed
- Ensure you have permission to close issues
- Resolve blocking dependencies first
```

### Step 2: Gather Issue Context

**Collect Issue Details**:
- Issue title
- Issue body/description
- Labels
- Assignees
- Milestone
- Created date
- Comments (extract important info)

**Extract Acceptance Criteria**:

Parse issue body for checklist items:

```markdown
### Acceptance Criteria
- [x] Feature implemented
- [x] Tests added
- [ ] Documentation updated  ← INCOMPLETE
```

**If acceptance criteria incomplete**:
```markdown
Warning: Not all acceptance criteria are checked.

Incomplete items:
- [ ] Documentation updated

Proceed with closing? (--no-verify to skip this check)
```

### Step 3: Find Related Work

**Scan Recent Commits**:

```bash
# Search commit messages for issue reference
git log --all --grep="#{issue_number}" --oneline

# Also check variations
git log --all --grep="issue.*#{issue_number}" --oneline
git log --all --grep="[#]#{issue_number}" --oneline
```

**Scan AIWG Artifacts**:

```bash
# Use grep to find references
grep -r "#{issue_number}" .aiwg/
grep -r "@issues/{issue_number}" .aiwg/
```

**Scan Code References**:

```bash
# Find TODOs and issue references in code
grep -r "TODO.*#{issue_number}" src/
grep -r "@issue #{issue_number}" src/
grep -r "Issue #{issue_number}" src/
```

**Find Related PRs**:

```bash
# GitHub
gh pr list --search "#{issue_number}" --state all

# Gitea (use MCP to search)
```

### Step 4: Verify Completion

**Verification Checklist** (unless --no-verify):

```markdown
## Pre-Close Verification

### Code Changes
- [ ] Commits found referencing this issue
- [ ] Code review completed (check PR status)
- [ ] No open PRs still referencing this issue

### Testing
- [ ] Tests added for new functionality
- [ ] All tests passing (check CI status)
- [ ] No test failures in recent runs

### Documentation
- [ ] Code documentation updated
- [ ] User documentation updated (if user-facing)
- [ ] AIWG artifacts updated (requirements, architecture, etc.)

### Quality
- [ ] No new lint errors introduced
- [ ] Code coverage maintained or improved
- [ ] No security vulnerabilities introduced

### Acceptance Criteria
- [ ] All acceptance criteria met (from issue template)
- [ ] Definition of Done satisfied

### Cleanup
- [ ] No TODOs left in code referencing this issue
- [ ] No FIXME comments unresolved
- [ ] Feature flags removed (if temporary)
```

**Auto-Check Where Possible**:

```bash
# Check CI status of recent commits
gh run list --limit 5 --json conclusion

# Check for remaining TODOs
grep -r "TODO.*#${issue_number}" src/ test/

# Check test coverage (if available)
npm test -- --coverage
```

**Report Verification Results**:

```markdown
## Verification Results

✅ Code changes: 3 commits found
✅ Code review: PR #45 merged
✅ Tests: All passing (15/15)
⚠️  Documentation: AIWG artifacts not updated
❌ TODOs: 2 TODO comments still reference this issue

Blockers:
- Resolve remaining TODOs before closing
- Update .aiwg/requirements/use-cases/UC-017.md

Proceed anyway? Use --no-verify to skip checks.
```

### Step 5: Generate Completion Summary

Using `task-completed.md` template, generate comprehensive summary:

```markdown
## Task Completed

**Status**: Completed
**Closed by**: {user}
**Completion date**: {timestamp}
**Time to resolution**: {days} days

## Original Request

{issue_title}

{issue_body_summary}

## Summary of Work

{auto_generated_summary_from_commits_and_artifacts}

## Deliverables

### Code Changes
- Commits: {count}
  - {sha1}: {message}
  - {sha2}: {message}
- Pull Requests: {count}
  - PR #{number}: {title} (Merged: {date})

### Artifacts Created/Updated
- `{artifact_path}` - {description}
- `{artifact_path}` - {description}

### Tests Added
- `{test_path}` - {description}
- Coverage: {percentage}% ({lines} lines covered)

### Documentation Updated
- `{doc_path}` - {description}

## Implementation Details

### Files Modified
- `{file_path}` - {change_summary}
- `{file_path}` - {change_summary}

Total changes: +{lines_added} -{lines_removed} across {files_count} files

### Key Decisions

{if_any_ADRs_or_design_decisions}
- {decision_1}: {rationale}
- {decision_2}: {rationale}

## Verification

- [x] All acceptance criteria met
- [x] Tests passing ({test_count} tests)
- [x] Code reviewed and approved
- [x] Documentation updated
- [x] CI/CD pipeline passing
- [x] No outstanding TODOs
- [x] Ready for deployment

## Related Items

- Closes: #{issue_number}
- Related PRs: #{pr_numbers}
- Related issues: #{related_issue_numbers}
- Artifacts: {artifact_paths}
- Commits: {commit_range}

## Impact Assessment

### User Impact
- {impact_description}

### System Impact
- Performance: {performance_changes}
- Security: {security_improvements}
- Dependencies: {dependency_updates}

## Deployment Notes

{if_applicable}
- Deployment required: {yes/no}
- Migration needed: {yes/no}
- Feature flags: {enabled/disabled}
- Rollback plan: {description}

## Follow-Up Items

{if_applicable}
### Future Enhancements
- {enhancement_1} - Consider for future milestone
- {enhancement_2} - Tracked in #{issue_number}

### Technical Debt
- {debt_item_1} - Address in #{issue_number}

### Monitoring
- Watch for: {metrics_to_monitor}
- Alert thresholds: {thresholds}

## Next Steps

1. {next_step_1}
2. {next_step_2}
3. {next_step_3}

---

*This issue has been completed and verified. All acceptance criteria met and tests passing. Closing as complete.*
```

### Step 6: Close Issue with Summary

**Guard against a duplicate closing comment (#2722).** Re-entry after a crash
must not post the summary twice. Record both effects in the effect ledger with
the issue on the configured tracker as the target
(`gitea:<owner>/<repo>#<N>` or `github:<owner>/<repo>#<N>`):

```bash
COMMENT=(--kind tracker.comment --target "gitea:{owner}/{repo}#{number}" --issue {number} --action close-summary)
CLOSE=(--kind tracker.issue.closed --target "gitea:{owner}/{repo}#{number}" --issue {number} --action close)
EFFECT_ID=$(aiwg effect id "${COMMENT[@]}" --format text)
# Append to completion-summary.md:  <!-- aiwg-effect: $EFFECT_ID -->
aiwg effect lookup "${COMMENT[@]}"
```

- `lookup` exit `0`: the closing comment is already recorded. Skip the comment
  and continue with the close.
- `lookup` exit `4` (an intent with no outcome): run
  `aiwg effect reconcile "${COMMENT[@]}"`. Exit `0` means the marker comment is
  already on the thread; skip the comment. Exit `3` means it is absent; post
  it. Exit `4` means the tracker could not be read; stop and report a blocker.
- `lookup` exit `3`: record the intent, then post:
  `aiwg effect intent "${COMMENT[@]}" --payload-file completion-summary.md`.

After posting, record the comment and the closure:

```bash
aiwg effect record "${COMMENT[@]}" --payload-file completion-summary.md --verify
# ... close the issue (below) ...
aiwg effect record "${CLOSE[@]}" --payload-digest sha256:<digest-of-completion-summary> --verify
```

`record --verify` exits `0` only when the tracker shows the marker comment by
the pinned tracker actor, or the issue state `closed`. Exit `4` means the
tracker could not be read: report it and never claim the issue closed.

**GitHub**:

```bash
# Close issue with comment
gh issue close {issue_number} --comment "{completion_summary}"

# Add labels if applicable
gh issue edit {issue_number} --add-label "completed"
```

**Gitea**:

```bash
# Add completion comment first
mcp__gitea__create_issue_comment \
  --owner {owner} \
  --repo {repo} \
  --issue_number {number} \
  --body "{completion_summary}"

# Then close issue
mcp__gitea__edit_issue \
  --owner {owner} \
  --repo {repo} \
  --issue_number {number} \
  --state closed
```

### Step 7: Update Related Issues

**If this issue unblocks others**:

```bash
# Find issues blocked by this one
gh issue list --search "blocked by #{issue_number}"

# Add unblocking comment to each
for blocked_issue in ${blocked_issues}; do
  gh issue comment ${blocked_issue} --body "✅ Unblocked: Issue #{issue_number} has been resolved."
done
```

**If this closes a milestone**:

```bash
# Check milestone status
gh issue list --milestone "{milestone}" --state open

# If all issues closed
gh api repos/{owner}/{repo}/milestones/{milestone_id} \
  -X PATCH \
  -f state=closed \
  -f description="Completed {date}: All issues resolved"
```

### Step 8: Generate Closure Report

```markdown
## Issue Closure Report

**Issue**: #{issue_number} - {title}
**Closed by**: {user}
**Closed at**: {timestamp}
**Resolution time**: {duration}

### Summary

{brief_summary}

### Work Completed

- Commits: {count}
- PRs merged: {count}
- Files changed: {count}
- Tests added: {count}
- Artifacts updated: {count}

### Verification

All pre-close checks passed:
- ✅ Acceptance criteria met
- ✅ Tests passing
- ✅ Code reviewed
- ✅ Documentation updated
- ✅ CI/CD passing

### Related Updates

{if_applicable}
- Unblocked issues: #{numbers}
- Milestone completed: {milestone_name}
- Follow-up issues created: #{numbers}

### Links

- Issue: {issue_url}
- PR: {pr_url}
- Commits: {commit_range_url}
- Artifacts: {artifact_paths}

---

Issue #{issue_number} successfully closed with verification complete.
```

## Advanced Features

### Automatic Follow-Up Issue Creation

If incomplete items detected:

```markdown
## Follow-Up Items Detected

Creating follow-up issues for:

1. Documentation improvements
   - Created issue #{new_number}: "Update API documentation for feature X"

2. Technical debt
   - Created issue #{new_number}: "Refactor auth logic for better testability"

3. Future enhancements
   - Created issue #{new_number}: "Add support for OAuth providers"

These items were moved to new issues to allow closing #{original_issue}.
```

### Milestone Auto-Complete

If this is the last issue in a milestone:

```markdown
## Milestone Completed! 🎉

Issue #{issue_number} was the last open issue in milestone "{milestone}".

Milestone summary:
- Total issues: {count}
- Completed: {count}
- Duration: {start_date} - {end_date}
- Success rate: 100%

The milestone has been automatically marked as complete.
```

### Artifact Traceability Update

Update AIWG artifacts with completion status:

```markdown
## References

- Implements: @.aiwg/requirements/UC-017.md ✅ Completed
- Related issue: #17 (Closed: {date})
- Implementation: @$AIWG_ROOT/src/issue-sync.ts
- Tests: @test/unit/issue-sync.test.ts
```

### Changelog Generation

Add entry to CHANGELOG.md:

```markdown
### Issue #17 - Issue sync automation (Closed: 2025-01-13)

- Implemented automatic issue synchronization from commits
- Added issue comment templates
- Created /issue-sync, /issue-close, /issue-comment commands
- Test coverage: 85%
- PRs: #45, #46

Closes #17
```

## Configuration

### `.aiwg/config.yaml`

```yaml
issue_close:
  verify_before_close: true
  require_all_acceptance_criteria: true
  auto_link_artifacts: true
  create_follow_ups: true
  update_changelog: true
  minimum_time_open: 1h  # Prevent immediate close
  labels:
    on_close: ["completed", "verified"]
    on_skip_verify: ["closed-unverified"]
```

## Error Handling

### Issue Already Closed

```markdown
Error: Issue #{number} is already closed.

Status: Closed {date} by {user}
Resolution: {previous_summary}

No action needed.
```

### Incomplete Verification

```markdown
Error: Pre-close verification failed.

Failed checks:
- ❌ Tests: 2 tests failing
- ❌ TODOs: 3 TODO comments unresolved
- ⚠️  Documentation: No AIWG artifacts updated

Options:
1. Fix failing checks and try again
2. Use --no-verify to skip checks (not recommended)
3. Document why checks can be skipped
```

### Permission Denied

```markdown
Error: Cannot close issue #{number} - insufficient permissions.

Required permission: triage or maintain role

Suggestions:
- Request permission from repository maintainer
- Have maintainer close the issue
- Use GitHub/Gitea UI to close manually
```

## Best Practices

### When to Close

**Close immediately when**:
- All acceptance criteria met
- Tests passing
- Code reviewed and merged
- Documentation complete

**Delay closing when**:
- Awaiting deployment verification
- Monitoring for issues in production
- Need user acceptance testing
- Dependent work not complete

### Creating Follow-Ups

**Good follow-up issues**:
```markdown
Title: Improve error handling in issue sync (follow-up to #17)

Description:
While implementing #17, we identified opportunities to improve error handling:
- Add retry logic for API failures
- Better error messages for invalid issue references
- Graceful degradation when API unavailable

This is a follow-up enhancement, not blocking #17 completion.

Labels: enhancement, technical-debt
```

### Closure Comments

**Comprehensive**:
```markdown
✅ All acceptance criteria met
✅ 15 tests added, all passing
✅ Code reviewed and approved in PR #45
✅ Documentation updated in .aiwg/requirements/

Ready for deployment to production.
```

**Concise**:
```markdown
Implemented in commit abc123. Tests passing. Docs updated. Ready to deploy.
```

## References

- Template: `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/issue-comments/task-completed.md`
- Related: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-sync.md, @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/issue-comment.md
- MCP tools: Gitea issue management
- GitHub CLI: `gh issue close`

## Success Criteria

This command succeeds when:

- [x] Issue is successfully closed
- [x] Comprehensive completion summary added
- [x] All verification checks passed (unless --no-verify)
- [x] Related issues updated (if blocking others)
- [x] Artifacts linked and updated
- [x] Follow-up issues created (if needed)
- [x] Changelog updated (if configured)
- [x] Clear closure report generated
