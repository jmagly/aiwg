---
namespace: aiwg
name: forensics-report
platforms: [all]
description: Generate forensic investigation report
commandHint:
  argumentHint: "<forensics-path> [--format triage|full|executive] [--output path]"
  category: forensics-reporting
---

# /forensics-report

Compile all forensic findings, analysis outputs, timelines, and IOC registers into a structured investigation report. Supports three report formats: triage summary for immediate response, full technical report for detailed review, and executive summary for leadership briefing.

## Usage

`/forensics-report <forensics-path> [options]`

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| forensics-path | Yes | Path to investigation directory (e.g., `.aiwg/forensics/`) |
| --format | No | Report format: `triage`, `full`, `executive` (default: `full`) |
| --output | No | Output path (default: `.aiwg/forensics/reports/forensic-report.md`) |
| --include | No | Specific sections to include: `timeline`, `ioc`, `evidence`, `remediation` |
| --severity-threshold | No | Minimum finding severity to include: `low`, `medium`, `high` (default: `low`) |
| --investigator | No | Investigator name for report attribution |
| --case-id | No | Override case ID in report header |

## Behavior

When invoked, this command:

1. **Collect Investigation Artifacts**
   - Scan forensics directory for all completed outputs
   - Load: triage summary, acquisition manifest, analysis findings, timeline, IOC register
   - Identify missing sections and note gaps in coverage
   - Record report generation timestamp

2. **Severity Classification**
   - Review all findings from analysis agents
   - Classify each finding: CRITICAL, HIGH, MEDIUM, LOW, INFORMATIONAL
   - Count findings by severity for executive dashboard
   - Identify the most significant findings for report lead section

3. **Executive Summary** (all formats)
   - State incident classification (confirmed breach, suspected breach, false positive)
   - Summarize attack scope: affected systems, accounts, data
   - State attacker objectives and achieved goals (if determinable)
   - List top 3-5 critical findings
   - State immediate actions taken or required

4. **Technical Findings Section** (triage and full formats)
   - Structured finding table: ID, severity, title, affected asset, evidence reference
   - Per-finding detail: description, evidence, MITRE ATT&CK mapping, recommendation
   - Link each finding to source log lines or artifacts

5. **Timeline Section** (full format)
   - Include condensed attack timeline with key milestones
   - Reference full timeline at `timeline/incident-timeline.md`
   - State attacker dwell time and activity window

6. **IOC Section** (full format)
   - Embed IOC register summary
   - Highlight immediately actionable IOCs (IPs to block, hashes to scan)
   - Reference full IOC register for SIEM/firewall import

7. **Evidence Documentation** (full format)
   - List all collected evidence artifacts with case IDs
   - Include SHA-256 hashes for integrity verification
   - Reference chain-of-custody log
   - Note preservation status

8. **Remediation Plan**
   - Prioritized action list with severity-based ordering
   - Short-term: immediate containment and eradication steps
   - Medium-term: hardening and configuration changes
   - Long-term: detection improvements and monitoring enhancements
   - Assign suggested owner categories (security team, sysadmin, management)

9. **Report Finalization**
   - Write formatted report to output path
   - Generate PDF-ready markdown with proper heading hierarchy
   - Compute report integrity hash
   - Update investigation state to `reporting-complete`

## Report Formats

| Format | Audience | Length | Sections |
|--------|----------|--------|----------|
| `triage` | First responders | 1-2 pages | Executive summary, critical findings, immediate actions |
| `full` | Security team, legal | 10-20 pages | All sections: findings, timeline, IOCs, evidence, remediation |
| `executive` | Leadership, board | 1 page | Business impact, incident classification, remediation summary |

## Examples

### Example 1: Full report
```bash
/forensics-report .aiwg/forensics/
```

### Example 2: Triage report for immediate response
```bash
/forensics-report .aiwg/forensics/ --format triage
```

### Example 3: Executive summary
```bash
/forensics-report .aiwg/forensics/ --format executive --output .aiwg/forensics/reports/exec-summary.md
```

### Example 4: High and critical findings only
```bash
/forensics-report .aiwg/forensics/ --severity-threshold high
```

### Example 5: Include specific sections
```bash
/forensics-report .aiwg/forensics/ --include timeline,ioc,remediation
```

## Output

Artifacts are saved to `.aiwg/forensics/reports/`:

```
.aiwg/forensics/reports/
├── forensic-report.md            # Primary investigation report
├── executive-summary.md          # Executive version (if requested)
├── triage-report.md              # Triage version (if requested)
└── report-metadata.yaml          # Generation metadata and integrity hash
```

### Sample Report Structure (full format)

```markdown
# Forensic Investigation Report
Case ID: INV-2026-02-27-web01
Generated: 2026-02-27T15:01:44Z
Classification: CONFIDENTIAL

## Executive Summary

**Incident Classification**: Confirmed Breach
**Severity**: CRITICAL
**Affected Systems**: web01.internal (192.168.1.50)
**Attack Window**: 2026-02-26 22:14Z - 2026-02-27 02:15Z (4h 1m)
**Attacker Objectives**: Persistent access, C2 implant installation
**Data Impact**: Undetermined (investigation ongoing)

Key Findings:
1. [CRITICAL] Successful SSH brute force against account 'deploy'
2. [CRITICAL] C2 implant installed via cron persistence (/tmp/.update)
3. [HIGH] Active C2 beacon to 185.220.101.42:4444
4. [HIGH] Privilege escalation: deploy -> root via sudo
5. [HIGH] Attacker IP 185.220.101.42 is known Tor exit node

## Findings

| ID   | Severity | Title                          | Asset  | MITRE         |
|------|----------|--------------------------------|--------|---------------|
| F-01 | CRITICAL | SSH brute force success        | web01  | T1110.001     |
| F-02 | CRITICAL | Cron-based persistence         | web01  | T1053.003     |
| F-03 | HIGH     | Active C2 connection           | web01  | T1071.001     |
...

## Remediation Plan

### Immediate (0-24h)
- [ ] Isolate web01 from network
- [ ] Revoke 'deploy' account credentials
- [ ] Block 185.220.101.42 at perimeter firewall
- [ ] Remove /tmp/.update and associated cron entry

### Short-term (1-7 days)
- [ ] Rotate all SSH keys on affected system
- [ ] Audit all user accounts for unauthorized additions
- [ ] Review and harden SSH daemon configuration
...
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/agents/reporting-agent.md - Reporting Agent
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/templates/forensic-report.md - Report template
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/templates/forensic-report.md - Executive template
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/commands/forensics-status.md - Investigation status
