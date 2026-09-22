# Session-PR Linking for Code Review Workflows

This guide documents how AIWG leverages Claude Code's session-PR linking capabilities to streamline code review workflows.

## What Session-PR Linking Does

Session-PR linking is a Claude Code feature that creates persistent connections between coding sessions and GitHub pull requests.

### Automatic Linking

When you create a pull request during a Claude Code session using `gh pr create`, the session automatically links to that PR. This creates a bidirectional relationship:

- The session knows which PR it created
- The PR can be traced back to the session where it originated

### Session URLs for Attribution

Each Claude Code session has a unique URL that can be used for attribution and traceability. When committing changes or commenting on PRs, you can reference the session URL to provide context about where the work was done.

**Example Commit Attribution**:
```bash
git commit -m "fix: resolve authentication timeout issue

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
Session: https://claude.ai/session/abc123"
```

### Resuming Sessions with PR Context

The `--from-pr` flag allows you to resume a session with full pull request context:

```bash
claude --from-pr 123
```

This automatically loads:
- The PR diff (all changes in the pull request)
- PR comments and review feedback
- PR metadata (title, description, labels)
- Commit history for the PR

## AIWG Code Review Patterns

### Starting a Code Review

To begin reviewing a pull request:

```bash
# Resume existing session with PR context
claude --from-pr 123

# Or start fresh with PR context
claude --from-pr 123 --new-session
```

The PR context is immediately available, allowing you to:
- Review the full diff
- Address reviewer comments
- Make suggested changes
- Run tests and validations

### Multi-Session Reviews

Large pull requests often require multiple review sessions. Session-PR linking makes this seamless:

**Session 1: Initial Review**
```bash
claude --from-pr 123
# Review first batch of files
# Make some changes
# Commit progress
```

**Session 2: Address Feedback**
```bash
claude --from-pr 123
# Automatically resumes with latest PR state
# Address reviewer comments
# Make additional changes
```

Each session picks up where the previous one left off, with full context of:
- Previous session work
- New comments added since last session
- Updated diff showing your changes

### Attribution in Review Comments

When providing review feedback, include session URLs for traceability:

```markdown
## Review Comments

**Issue**: Missing error handling in `processPayment()`

**Suggested Fix**: Add try-catch wrapper and log errors

**Session**: https://claude.ai/session/abc123

The suggested implementation was validated in the linked session.
```

This creates an audit trail showing:
- Who reviewed the code (human + AI)
- Where the review work happened
- What context was considered

### Integration with `/pr-review` Skill

AIWG's `/pr-review` skill integrates with session-PR linking:

```bash
# Inside a Claude Code session
/pr-review 123
```

The skill automatically:
1. Detects if session is already linked to a PR
2. Loads PR diff and comments as context
3. Provides structured review feedback
4. Suggests `--from-pr` for follow-up sessions if needed

**Example Workflow**:

```
You: /pr-review 123

Claude: Loading PR #123 context...

PR Title: "Add authentication timeout handling"
Files Changed: 5
Comments: 3 unresolved

Reviewing changes...

### Security Review
✓ Timeout values are configurable
⚠ Consider adding rate limiting for failed attempts

### Code Quality
✓ Error handling is comprehensive
- Suggest extracting retry logic to helper function

To continue this review later, use:
  claude --from-pr 123
```

## Cross-Platform Considerations

### Claude Code + GitHub CLI Specifics

Session-PR linking is a feature specific to Claude Code when used with GitHub CLI (`gh`). The integration provides:

- Automatic PR detection during `gh pr create`
- Session URL generation
- `--from-pr` session resumption
- Persistent PR-session associations

### Other Platforms

Other AI coding platforms have different PR/review integrations:

| Platform | PR Integration | Session Linking |
|----------|----------------|-----------------|
| **Claude Code** | `gh` CLI + automatic session linking | Yes (via `--from-pr`) |
| **GitHub Copilot** | Native GitHub integration | Via workspace/repo context |
| **Cursor** | `gh` CLI manually | No automatic linking |
| **Factory AI** | `gh` CLI manually | No automatic linking |

### AIWG's Platform-Independent `/pr-review`

AIWG's `/pr-review` skill works on **all platforms** by using `gh` CLI directly:

```bash
# Works on Claude Code, Cursor, Copilot, etc.
/pr-review 123
```

The skill:
- Calls `gh pr view 123 --json` to fetch PR data
- Calls `gh pr diff 123` to get the diff
- Parses the results into structured review context
- Works identically regardless of platform

**Platform-Specific Enhancements**:

- On **Claude Code**: Suggests using `--from-pr` for session persistence
- On **other platforms**: Provides full review in current session without session linking

## Best Practices

### When to Use `--from-pr`

Use `--from-pr` when:
- Beginning a code review session
- Resuming work on a PR after interruption
- Addressing review feedback from others
- Making changes across multiple files in a PR

### When to Use `/pr-review`

Use `/pr-review` when:
- You need structured review feedback
- You want to check security/quality patterns
- You're doing a quick review in an existing session
- You're on a platform without `--from-pr` support

### Combining Both

For comprehensive reviews on Claude Code:

```bash
# Start with PR context
claude --from-pr 123

# Run structured review
/pr-review 123

# Make changes based on feedback
# Commit with session attribution
git commit -m "fix: address review feedback

Session: https://claude.ai/session/abc123"
```

### Attribution Standards

When attributing AI-assisted work:

**In commits**:
```
fix: implement error handling

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
Session: https://claude.ai/session/abc123
```

**In PR comments**:
```markdown
**Reviewed with AI assistance**
Session: https://claude.ai/session/abc123

Summary: Security and code quality checks performed. All critical issues addressed.
```

**In AIWG artifacts** (`.aiwg/` files):
```yaml
review_metadata:
  reviewer: human-name
  ai_assistant: claude-opus-5
  session_url: https://claude.ai/session/abc123
  date: 2026-02-06
```

## Examples

### Example 1: Initial PR Review

```bash
# Create PR and automatically link session
gh pr create --title "Add timeout handling" --body "Fixes #42"

# Session is now linked to new PR #123
# Continue working in same session, or resume later:
claude --from-pr 123
```

### Example 2: Address Review Feedback

```bash
# Resume session with PR #123 context
claude --from-pr 123

# Run structured review
/pr-review 123

# Make changes
# Commit with attribution
git add .
git commit -m "fix: add rate limiting per review feedback

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
Session: https://claude.ai/session/abc123"

git push
```

### Example 3: Multi-Day Review

**Day 1: Initial Review**
```bash
claude --from-pr 123
/pr-review 123
# Review 3 of 8 files, commit changes
git push
```

**Day 2: Continue Review**
```bash
claude --from-pr 123
# Session resumes with updated PR state
# Review remaining 5 files
git push
```

### Example 4: Cross-Platform Review

**On Claude Code**:
```bash
claude --from-pr 123
/pr-review 123
# Full session linking
```

**On Cursor**:
```bash
# Open Cursor in repo
# In Cursor chat:
/pr-review 123
# Works identically, no session linking
```

## Troubleshooting

### PR Not Auto-Linking

If a PR isn't automatically linked:

1. **Verify `gh` CLI is authenticated**:
   ```bash
   gh auth status
   ```

2. **Manually specify PR**:
   ```bash
   claude --from-pr 123
   ```

3. **Check session was active during PR creation**:
   - Session must be active when `gh pr create` runs
   - If PR was created outside session, use `--from-pr` to link

### Session URL Not Available

Session URLs are Claude Code-specific. On other platforms:
- Use commit SHAs for traceability
- Reference PR numbers in attribution
- Use AIWG's `.aiwg/ralph/` state files for session history

### `--from-pr` Not Found

If `--from-pr` flag is not recognized:
- Ensure you're using Claude Code (not another platform)
- Update Claude Code to latest version
- Use `/pr-review` skill as fallback

## References

- @.claude/skills/pr-review.md - AIWG PR review skill definition
- @docs/cli/reference.md - Full CLI command reference
- @docs/ralph-guide.md - Al iterative workflow integration
- @CLAUDE.md - Git and commit conventions

---

**Last Updated**: 2026-02-06
**Related Issues**: #291
**Platform**: Claude Code (cross-platform `/pr-review` skill available)
