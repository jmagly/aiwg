---
namespace: aiwg
name: forensics-timeline
platforms: [all]
description: Build correlated event timeline from multiple sources
commandHint:
  argumentHint: "<findings-path> [--window start/end] [--sources logs|network|process|all] [--mitre]"
  category: forensics-timeline
---

# /forensics-timeline

Correlate events from multiple forensic sources into a unified chronological timeline. Normalizes timestamps across log files, network captures, process events, and file system artifacts. Reconstructs the attack chain and maps events to MITRE ATT&CK techniques.

## Usage

`/forensics-timeline <findings-path> [options]`

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| findings-path | Yes | Path to findings directory (e.g., `.aiwg/forensics/findings/web01-2026-02-27/`) |
| --window | No | Time window filter: `start/end` in ISO 8601 (e.g., `2026-02-26T18:00:00Z/2026-02-27T06:00:00Z`) |
| --sources | No | Event sources to include: `logs`, `network`, `process`, `filesystem`, `all` (default: `all`) |
| --mitre | No | Annotate events with MITRE ATT&CK technique IDs |
| --output | No | Output path (default: `.aiwg/forensics/timeline/incident-timeline.md`) |
| --granularity | No | Minimum event significance level: `all`, `medium`, `high` (default: `medium`) |
| --format | No | Output format: `markdown` (default), `json`, `csv` |

## Behavior

When invoked, this command:

1. **Discover Evidence Sources**
   - Scan findings directory for all log files, captures, and analysis outputs
   - Identify available sources: auth logs, syslog, journal, audit, network, process lists
   - Record source timestamps and timezone/offset metadata
   - Note any gaps in log coverage

2. **Normalize Timestamps**
   - Convert all timestamps to UTC
   - Detect and compensate for clock skew between sources
   - Handle timezone-naive log entries using system timezone from profile
   - Flag entries with ambiguous or inconsistent timestamps

3. **Event Extraction**
   - Parse authentication events: logins, logouts, sudo, su, failed attempts
   - Extract network events: connections established, DNS queries, port scans
   - Extract process events: spawns, exits, executions from unusual paths
   - Extract filesystem events: file modifications, creations, deletions (if auditd active)
   - Extract privilege events: uid changes, capability grants, SUID executions
   - Extract persistence events: cron modifications, service installs, key changes

4. **Correlation and Deduplication**
   - Match related events across sources (e.g., SSH login + process spawn)
   - Deduplicate events appearing in multiple log sources
   - Link network connections to responsible processes via PID correlation
   - Group events into logical attack phases

5. **Attack Chain Reconstruction**
   - Identify initial access vector (brute force, key use, web exploit, etc.)
   - Map progression: initial access, execution, persistence, lateral movement
   - Identify patient zero: first compromised account or process
   - Estimate attacker dwell time from first to last activity
   - Determine data exfiltration indicators

6. **MITRE ATT&CK Mapping** (when `--mitre` specified)
   - Map each significant event to ATT&CK technique IDs
   - Label tactics: TA0001 Initial Access, TA0002 Execution, TA0003 Persistence, etc.
   - Note relevant sub-techniques where applicable

7. **Timeline Output**
   - Write chronological event table
   - Include severity, source, raw event, and interpretation for each entry
   - Highlight critical events (red flags, attack milestones)
   - Generate attack chain narrative summary
   - Save `incident-timeline.md`

## Examples

### Example 1: Standard timeline
```bash
/forensics-timeline .aiwg/forensics/findings/web01-2026-02-27/
```

### Example 2: Filtered time window
```bash
/forensics-timeline .aiwg/forensics/findings/ --window 2026-02-26T20:00:00Z/2026-02-27T04:00:00Z
```

### Example 3: Network and process sources with MITRE mapping
```bash
/forensics-timeline .aiwg/forensics/ --sources network,process --mitre
```

### Example 4: High-significance events only, JSON output
```bash
/forensics-timeline .aiwg/forensics/ --granularity high --format json
```

## Output

Artifacts are saved to `.aiwg/forensics/timeline/`:

```
.aiwg/forensics/timeline/
├── incident-timeline.md      # Full chronological timeline
├── attack-chain.md           # Attack progression narrative
├── timeline.json             # Machine-readable event list
└── mitre-mapping.yaml        # ATT&CK technique annotations (if --mitre)
```

### Sample Output

```
Building Timeline
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sources discovered:
  auth.log          (72h, 14,832 entries)
  journal           (72h, 187,441 entries)
  audit.log         (72h, 92,318 entries)
  network captures  (triage snapshot)
  process list      (triage snapshot)

Timestamps normalized to UTC
Clock skew: 0s (synchronized)

Events extracted: 1,247 raw -> 312 significant
Correlations found: 48

Timeline window: 2026-02-26T22:00:00Z to 2026-02-27T02:15:00Z (4h 15m)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Time (UTC)          | Sev      | Source   | Event                                              |
|---------------------|----------|----------|----------------------------------------------------|
| 2026-02-26 22:14:33 | HIGH     | auth.log | 847 failed SSH attempts from 185.220.101.42        |
| 2026-02-26 22:29:01 | CRITICAL | auth.log | Successful SSH login for 'deploy' from 185.220.101.42 |
| 2026-02-26 22:29:04 | HIGH     | journal  | Process spawn: /bin/bash (child of sshd PID 3821) |
| 2026-02-26 22:31:18 | HIGH     | audit    | Privilege escalation: sudo -l (deploy -> root)    |
| 2026-02-26 22:33:45 | CRITICAL | audit    | New cron entry: * * * * * /tmp/.update             |
| 2026-02-26 22:34:01 | CRITICAL | journal  | File created: /tmp/.update (executable)           |
| 2026-02-27 00:00:00 | HIGH     | journal  | Cron executed: /tmp/.update                       |
| 2026-02-27 00:00:02 | CRITICAL | journal  | Outbound connection: 185.220.101.42:4444          |

Attack Chain Summary:
  Initial Access:  22:14Z - SSH brute force (T1110.001)
  Execution:       22:29Z - Interactive shell via compromised credentials (T1059.004)
  Persistence:     22:33Z - Cron job installation (T1053.003)
  C2:              00:00Z - Reverse shell beaconing (T1071.001)
  Dwell time: 1h 46m (first access to C2 beacon)
  Patient zero: account 'deploy'

Output: .aiwg/forensics/timeline/incident-timeline.md
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/agents/timeline-builder.md - Timeline Builder
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/templates/incident-timeline.md - Timeline format
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/commands/forensics-ioc.md - IOC extraction
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/commands/forensics-report.md - Report generation
