---
name: commit-message
description: Conventional Commit message with subject, rationale, verification and issue references.
outputKind: commit-message
aliases:
  - commit message
  - commit
---

# Commit message

Fill every required section with observed facts. Write "Not applicable" with a
reason where needed; mark unknown or unrun items explicitly. Remove these
instructions and frontmatter from the final output.

## Subject (required)

`<type>(<optional scope>): <imperative summary>`

Use the repository's subject length and type conventions. Add `!` only for a
breaking change and describe the migration in the footer.

## Body (required for substantive changes)

<Problem, resulting behavior, and why the change is needed.>

## Verification (required)

<Exact checks run, observed results and counts, and any unrun checks or limits.>

## Footer (required when applicable)

<Related issue references; use closure keywords only for resolved issues.
BREAKING CHANGE: impact and migration steps when applicable.>

Compose the final message as subject, blank line, body and verification, then
applicable footers. Remove headings and instructions from the commit message.
