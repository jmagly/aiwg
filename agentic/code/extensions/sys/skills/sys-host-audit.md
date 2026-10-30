---
name: sys-host-audit
description: Read-only host audit of server resources, hardware, OS, disk usage, running services and listening ports; collect a baseline or compare with host documentation using Sys Host Profiler.
trigger: when the operator requests a host audit, doc verification, or drift check for a specific host
triggers:
  - "audit host"
  - "audit this host"
  - "host disk usage"
  - "what's running on this server"
  - "profile this machine before we put agents on it"
  - "check the box's resources and services"
  - "inspect server hardware and listening ports"
  - "summarize this computer's memory storage and daemons"
---

# Host Audit

## Purpose

Audit the current host or a specified remote host using the existing **Sys Host Profiler** agent. Collect a read-only resource and service snapshot, even when no documentation exists. When a sanitized system-spec or `host-profile.yaml` is available, compare it with live state and report documentation drift. Requests to profile a machine before putting agents on it produce this snapshot only; runner planning and provisioning are separate work.

## Collection Safety

- NEVER read or print credentials, keys, tokens, environment values, or private config. This includes `.env`, SSH/provider credential files, process environments, service environment directives, and private CLI config contents.
- NEVER use sudo or require elevated privileges. Skip unavailable or restricted probes and report `UNABLE_TO_VERIFY`; do not change services, packages, permissions, or host configuration.
- Use bounded metadata commands only. Do not dump config files, service definitions, process command lines, logs, or home directories. If identifying installed agent CLIs, collect executable/config-directory names only, never config contents.
- Redact anything sensitive before it reaches terminal output, saved artifacts, or the report. Omit uncertain fields and note the collection gap rather than capture raw output for later cleanup. Do not copy sensitive values from documentation into comparisons or suggested diffs.
- For remote collection, use `ssh -o ConnectTimeout=10`; report connection failures after at most two retries.

## Workflow

### 1. Load Documentation

Use an approved, sanitized system-spec or `host-profile.yaml` when available. Parse only documented inventory fields. If no safe baseline exists, continue collection and mark the report `BASELINE` (no diff available); never search private configuration for a baseline.

### 2. Collect Live State

Collect locally for "this host", or connect to the specified host. Record the collection timestamp in UTC. Run only permitted probes and filter/redact potentially sensitive metadata before output:

```bash
# Identity
hostname -f

# CPU
lscpu

# Memory
free -h

# Storage
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL
df -h

# Network
ip -br addr
ip -br link
ss -tln

# OS
cat /etc/os-release
uname -r

# Services
systemctl list-units --type=service --state=running --no-pager --no-legend --plain | awk '{print $1, $3, $4}'

# Encryption
lsblk -o NAME,FSTYPE | grep -i crypt
cryptsetup status /dev/mapper/* 2>/dev/null

# RAID
cat /proc/mdstat 2>/dev/null
```

### 3. Compare

For each sanitized documented field, compare against the live value. With no baseline, report the snapshot without pass/fail drift totals.

| Category | Field | Documented | Actual | Status |
|----------|-------|-----------|--------|--------|
| Hardware | CPU Model | {doc_value} | {live_value} | MATCH / DRIFT / MISSING |
| Hardware | RAM Total | {doc_value} | {live_value} | MATCH / DRIFT / MISSING |
| Network | {iface} IP | {doc_value} | {live_value} | MATCH / DRIFT / MISSING |
| ... | ... | ... | ... | ... |

### 4. Classify Findings

- **MATCH**: Documented value matches live state
- **DRIFT**: Documented value differs from live state
- **MISSING_DOC**: Live system has something not documented
- **MISSING_LIVE**: Documentation claims something that doesn't exist on the host
- **UNABLE_TO_VERIFY**: Could not collect live data for comparison (e.g., requires root)

### 5. Produce Audit Report

```markdown
# Host Audit: {hostname}
**Date**: {timestamp}
**Baseline**: {sanitized document path or BASELINE — no prior profile}
**Overall**: {pass_count}/{total_count} checks passed ({percentage}%)

## Drift Detected
| Field | Documented | Actual | Severity |
|-------|-----------|--------|----------|

## Undocumented Items
| Category | Item | Details |

## Recommended Actions
1. Update system-spec: {specific_fields}
2. Investigate: {unexpected_findings}
```

## Output

- Audit report with pass/fail per field
- Suggested diff to update the system-spec document
- Severity classification (cosmetic / operational / security-relevant drift)
- Collection gaps and redacted fields, with no sensitive values in any output
