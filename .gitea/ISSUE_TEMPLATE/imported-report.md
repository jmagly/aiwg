---
name: Imported Report (from another tracker)
description: Import an issue report from another tracker, preserving the original source, reporter, current status, and follow-up actions.
about: Mirror an issue from a different tracker (GitHub, Discord, email) for follow-up
title: 'imported: <original title> (<source>#<number>)'
labels: ['imported']
---

> **Imported from**: <source link> (e.g. `jmagly/aiwg#123`)
> **Original reporter**: <username>
> **Platform / environment** (corrected if the source omitted it):

## TL;DR

One paragraph describing the issue in this project's terms. Note any version
mismatch between the source environment and current main.

## Status against current main

| Aspect | Status |
|---|---|
| (Sub-aspect 1) | Resolved / Open / Partially open |
| (Sub-aspect 2) | … |

## Original body

Either link to the source or paste the relevant excerpts. Preserve exact error
text and commands.

## Action

- [ ] If duplicate of an existing local issue: cross-link and close
- [ ] If meta-issue: split into discrete tickets and close this one
- [ ] If new: triage and assign

## Reporter

Original reporter handle + thanks for the report.
