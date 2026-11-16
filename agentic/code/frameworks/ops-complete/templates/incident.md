---
name: incident
outputKind: report.incident
aliases:
  - incident postmortem
  - incident report
  - incident
---

# Incident Report: {Title}

## Summary
| Field | Value |
|-------|-------|
| Incident ID | {INC-XXXX} |
| Severity | {P1/P2/P3/P4} |
| Status | {Investigating/Identified/Monitoring/Resolved} |
| Started | {timestamp} |
| Resolved | {timestamp} |
| Duration | {duration} |
| Affected systems | {systems} |
| Impact | {user/service impact} |

## Timeline
| Time | Event |
|------|-------|
| {HH:MM} | {First alert / detection} |
| {HH:MM} | {Investigation started} |
| {HH:MM} | {Root cause identified} |
| {HH:MM} | {Mitigation applied} |
| {HH:MM} | {Resolved / monitoring} |

## Root Cause Analysis
### What happened
{description}

### Why it happened
{5 Whys or similar root cause analysis}

### Contributing factors
- {factor 1}
- {factor 2}

## Resolution
### Immediate actions
{what was done to resolve}

### Long-term fixes
| Fix | Owner | Target Date | Status |
|-----|-------|-------------|--------|
| {fix} | {owner} | {date} | {status} |

## Lessons Learned
- {lesson 1}
- {lesson 2}

## Action Items
- [ ] {action item 1} — @{owner} — {due date}
- [ ] {action item 2} — @{owner} — {due date}

## References
- Related issues: {links}
- Related runbooks: {links}
- Monitoring dashboards: {links}
