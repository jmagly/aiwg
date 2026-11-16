---
name: release-notes-template
outputKind: release-notes
aliases:
  - release notes
---

# Release Notes Template

## Purpose

Communicate the contents, fixes, and operational considerations of a release to end users, support teams, and other
stakeholders.

## Ownership & Collaboration

- Document Owner: Deployment Manager
- Contributor Roles: Integrator, Project Manager, Test Engineer
- Automation Inputs: Change log, resolved defects, feature list
- Automation Outputs: `release-notes.md` with highlights, changes, and known issues

## Completion Checklist

- Features and fixes categorized clearly with impact statements
- Known issues and workarounds documented
- Upgrade/rollback notes synchronized with Deployment Plan

## Document Sections

1. **Release Overview**
   - Provide release identifier, date, and summary.
2. **Highlights**
   - Summarize key features or improvements.
3. **Detailed Changes**
   - Use subsections or tables for features, enhancements, defects resolved.
   - Reference issue IDs or backlog items.
4. **Breaking Changes**
   - Describe any backwards-incompatible changes and mitigation.
5. **Upgrade Instructions**
   - Outline prerequisites and high-level steps; link to Deployment Plan for detail.
6. **Rollback Considerations**
   - Provide summary of rollback implications and necessary data backups.
7. **Known Issues**
   - List unresolved issues, severity, and workarounds.
8. **Security Notes**
   - Highlight security fixes or new risks introduced.
9. **Documentation Updates**
   - Point to updated manuals, API docs, or training assets.
10. **Support Contacts**
    - Provide contact info and escalation path for release-related inquiries.

## Agent Notes

- Use consistent formatting for change lists (e.g., `- [ID] Description`).
- Coordinate with Product Acceptance Plan and Support Runbook so messaging aligns.
- Include links to analytics dashboards or monitoring when relevant.
- Verify the Automation Outputs entry is satisfied before signaling completion.
