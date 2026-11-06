---
name: pull-request-description
description: Pull request description template covering summary, root cause, changes, verification commands with pass/fail counts, related issues, and risk and rollback.
triggers:
  - pull request description
  - write a PR description
  - draft a pull request body
---

# Pull Request Description

Fill every required section below. Replace placeholders with observed facts;
write "Not applicable" with a reason when a section does not apply. Strip the
frontmatter, title, and these instructions from the posted body. Never add
attribution trailers or generated-by text.

## Summary

<Concrete problem and resulting behavior; explain who is affected.>

## Cause

<Why the previous behavior occurred; cite the relevant code or configuration.
For new capabilities, explain the missing behavior.>

## Changes

- <Meaningful change and why it solves the problem; include paths when useful.>

## Verification

| Exact command or manual check | Passed | Failed | Result / limitations |
|---|---:|---:|---|
| `npm run typecheck` | <count> | <count> | <observed result> |
| `npm run build:cli` | <count> | <count> | <observed result> |
| <touched tests and neighbours> | <count> | <count> | <observed result> |

Record skipped or unrun checks and pre-existing failures explicitly. Do not
claim a check passed without running it. For AIWG workspace PRs, verify locally
before merging and check post-merge CI on main according to delivery policy.

- Verified head SHA: <head SHA>
- Main SHA: <base SHA; confirm branch is current and recheck after updates>

## Related issues

- Closes #<issue resolved by this PR>
- Refs #<related issue; explain the relationship>

Use closure keywords only for issues this PR resolves, on the configured
tracker. For direct delivery, put closure references in the commit instead.

## Risk and rollback

- Risk: <low / medium / high, with reason and any remaining limitations>
- Rollback: <concrete revert or recovery action>
