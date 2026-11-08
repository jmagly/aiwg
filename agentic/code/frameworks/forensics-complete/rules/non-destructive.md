---
enforcement: critical
activation: bound
summary: Keep evidence sources read-only, write only to the investigation workspace, and obtain documented authorization before containment or any destructive exception.
bound_to:
  agents:
    - cloud-analyst
    - container-analyst
    - forensic-acquisition-agent
    - forensics-orchestrator
    - ioc-analyst
    - log-analyst
    - memory-analyst
    - network-analyst
    - persistence-hunter
    - recon-agent
    - reporting-agent
    - timeline-builder
    - triage-agent
  skills:
    - cloud-forensics
    - container-forensics
    - exposure-analysis
    - evidence-preservation
    - forensics-acquire
    - forensics-hunt
    - forensics-investigate
    - forensics-ioc
    - forensics-profile
    - forensics-report
    - forensics-status
    - forensics-timeline
    - forensics-triage
    - ioc-extraction
    - linux-forensics
    - log-analysis
    - memory-forensics
    - sigma-hunting
    - supply-chain-forensics
    - target-profiling
triggers:
  - keep investigation evidence read only
---

# Non-Destructive Investigation

**Enforcement Level**: CRITICAL
**Scope**: All forensics agents

## Overview

Forensic investigation must never modify the evidence it examines. Modification of evidence — intentional or accidental — can render findings inadmissible, invalidate analysis conclusions, and expose investigators to legal liability.

Every read operation is permitted. Every write operation against the evidence source is prohibited unless explicitly authorized. All writes during an investigation go to the designated investigation workspace.

## Rules

### Rule 1: Read-Only Operations on Evidence Sources

All access to evidence sources (live systems under investigation, acquired disk images, memory dumps, log archives) must be read-only.

For live systems:
```bash
# Mount disk evidence read-only
mount -o ro,noatime /dev/sdb1 /mnt/evidence

# Verify mount is read-only before proceeding
mount | grep /mnt/evidence | grep -q "ro," && echo "Confirmed read-only" || echo "WARNING: Not read-only"

# Use immutable flag on copied evidence files
chattr +i /evidence/disk-image.dd
```

For disk images:
```bash
# Open Autopsy/Sleuth Kit in read-only mode
# mmls always reads without modifying
mmls /evidence/disk-image.dd

# Mount image read-only
sudo mount -o ro,loop,noatime /evidence/disk-image.dd /mnt/disk-evidence
```

For log files and copies:
```bash
# Never edit, compress (in-place), or delete source log files
# Always work from copies
cp /var/log/auth.log /workspace/auth.log.copy
# Work only on the copy
grep "Failed password" /workspace/auth.log.copy
```

### Rule 2: All Writes Go to Investigation Workspace

The investigation workspace is a separate filesystem location that contains:
- Collected evidence copies
- Analysis tool output
- Notes and annotations
- Tool-generated artifacts

The investigation workspace path must be established before investigation begins and documented in the case record.

```bash
# Establish workspace at investigation start
CASE_ID="IR-2025-001"
WORKSPACE="/investigations/${CASE_ID}"
mkdir -p "${WORKSPACE}/evidence" "${WORKSPACE}/analysis" "${WORKSPACE}/reports"

# All tool output goes to workspace
volatility3 -f /evidence/memory.lime linux.pslist > "${WORKSPACE}/analysis/pslist.txt"
volatility3 -f /evidence/memory.lime linux.netstat > "${WORKSPACE}/analysis/netstat.txt"

# Never write to /evidence/ except during initial collection
```

### Rule 3: No Process Termination Before Evidence Capture

Do not send SIGKILL, SIGTERM, or any terminating signal to suspect processes until their evidence is fully captured.

Prohibited before evidence capture:
```bash
# These are all prohibited before capture
kill -9 <pid>
pkill <processname>
systemctl stop <service>
service <service> stop
docker stop <container>
docker kill <container>
```

Required sequence before terminating any suspect process:
1. Capture full memory dump (Level 2 per volatility-order.md)
2. Capture process-specific memory: `gcore <pid>` or `procdump`
3. Capture open file descriptors: `ls -la /proc/<pid>/fd/`
4. Capture network connections for that process: `ss -tunap | grep <pid>`
5. Capture environment: `cat /proc/<pid>/environ | tr '\0' '\n'`
6. Document all captures with timestamps
7. Obtain explicit operator authorization for termination

Exception: If a running process is actively exfiltrating data or actively attacking other systems, the operator may authorize immediate network isolation (not process termination) as a first step.

### Rule 4: No File Deletion

Do not delete, shred, truncate, or overwrite any file on an evidence system or in the evidence collection.

Prohibited:
```bash
# All of these are prohibited during investigation
rm <file>
shred <file>
> <file>          # truncate via redirect
truncate -s 0 <file>
dd if=/dev/zero of=<file>
```

If a file must be removed from a live system for containment reasons (e.g., an actively exploited web shell), this requires:
1. Explicit written authorization from the operator
2. A complete copy of the file in the investigation workspace
3. SHA-256 hash recorded before removal
4. Documentation of the removal in the case record with timestamp and justification

### Rule 5: No Configuration Changes

Do not modify system configuration during investigation. This includes:

- `/etc/` files of any kind
- Firewall rules (iptables, nftables, ufw, firewalld)
- Cron jobs
- Systemd service files
- User accounts or passwords
- SSH authorized_keys files
- PAM configuration
- Network interface configuration
- Container or orchestrator configuration

Configuration changes for containment purposes are a separate phase (Containment in SANS PICERL) that occurs after the investigation and collection phases are complete, and requires operator authorization.

### Rule 6: No Package Installation or Updates on Evidence System

Do not install, upgrade, or remove packages on a system under investigation. Package operations modify timestamps, overwrite files, and alter system state in ways that corrupt the forensic record.

Prohibited:
```bash
apt install <package>
apt upgrade
yum install <package>
pip install <package>
npm install <package>
```

If investigation tools need to be run on the evidence system, use:
- Pre-compiled statically-linked binaries brought from clean media
- Tools already present on the system (even if potentially compromised — document the risk)
- Remote analysis tools that run on a separate analysis system (Velociraptor, osquery)

### Rule 7: Exceptions Require Documented Operator Authorization

Any deviation from this rule set requires written authorization from the lead investigator or incident commander. The authorization must include:

- Name and role of authorizing person
- Timestamp
- Specific action authorized
- Justification
- Expected impact on evidence integrity

Authorization must be recorded in the case log before the action is taken, not after.

## References

- NIST SP 800-86: Guide to Integrating Forensic Techniques into Incident Response (Section 4.3)
- RFC 3227: Guidelines for Evidence Collection and Archiving
- IOCE Guidelines for Best Practice in the Forensic Examination of Digital Technology
- Federal Rules of Evidence, Rule 901 (Authentication of Evidence)
