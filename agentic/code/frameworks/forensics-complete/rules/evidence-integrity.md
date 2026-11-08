---
enforcement: critical
activation: bound
summary: Hash evidence at collection, verify before analysis and reporting, preserve originals, and record timestamped custody transfers.
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
  - verify forensic evidence hashes and custody
---

# Evidence Integrity

**Enforcement Level**: CRITICAL
**Scope**: All forensics agents (triage-agent, disk-agent, memory-agent, network-agent, cloud-agent, container-agent, reporting-agent)

## Overview

Every piece of evidence must be cryptographically hashed at the moment of collection and that hash must be verified before any analysis begins. The chain of custody must document every person or system that handled the evidence. Timestamps are required on every operation. The evidence source must never be modified.

Failure to maintain evidence integrity can invalidate findings in legal proceedings, allow evidence tampering to go undetected, and produce incorrect analysis conclusions.

## Rules

### Rule 1: Hash at Collection

A SHA-256 hash must be computed immediately after evidence is collected and before any transfer or storage occurs.

```bash
# Disk image
sha256sum evidence.dd > evidence.dd.sha256

# Memory dump
sha256sum memory.lime > memory.lime.sha256

# Log file copy
sha256sum auth.log.copy > auth.log.copy.sha256

# Directory tree (use find + sha256sum for multiple files)
find /evidence/collected/ -type f -exec sha256sum {} \; > manifest.sha256
```

The hash file must be stored separately from the evidence file. Both must be included in the chain of custody record.

MD5 is acceptable only for legacy system compatibility where SHA-256 is unavailable. If MD5 is used, document the reason.

```bash
# Legacy only - document why SHA-256 is unavailable
md5sum evidence.dd > evidence.dd.md5
```

### Rule 2: Hash Verification Before Analysis

Before any analysis tool processes evidence, the hash must be recomputed and compared against the collection hash.

```bash
# Verify before opening
sha256sum -c evidence.dd.sha256
# Expected output: evidence.dd: OK

# If verification fails — STOP. Do not proceed.
# Log the failure, alert the investigator, preserve both files.
```

If verification fails:
1. Stop all analysis immediately
2. Log the mismatch with timestamps
3. Alert the lead investigator
4. Quarantine both the evidence file and the hash file
5. Do not delete either — the mismatch is itself evidence

### Rule 3: Hash at Report Time

At the time a forensic report is finalized, recompute hashes for all evidence referenced in the report. Include the collection hash and the report-time hash in the report appendix.

If collection hash and report-time hash match: document as verified.
If they differ: the report must note the discrepancy and explain it (e.g., analysis tool wrote metadata — the original must be preserved alongside the modified copy).

### Rule 4: Custody Transfer Logging

Every transfer of evidence between handlers requires a custody log entry. The log entry must include:

- Timestamp (ISO 8601 with timezone, e.g., `2025-11-14T09:32:00Z`)
- Handler name and role (transferring from, transferring to)
- Evidence identifier
- SHA-256 hash of evidence at transfer time
- Transfer method (physical media, encrypted network transfer, cloud storage, etc.)
- Purpose of transfer

Example custody log entry:

```
2025-11-14T09:32:00Z | TRANSFER
  From:   J. Smith (First Responder)
  To:     A. Patel (Forensic Analyst)
  Item:   disk-image-server01.dd
  Hash:   a4f3c2...d819
  Method: Encrypted USB (VeraCrypt container)
  Purpose: Analysis handoff
```

Custody log files must themselves be hashed at each entry addition.

### Rule 5: Write-Blocking Requirement

Physical disk evidence must be acquired through a hardware or software write blocker. The write blocker type and serial number (for hardware) must be recorded.

```bash
# Software write-block example (Linux)
blockdev --setro /dev/sdb
blockdev --getro /dev/sdb  # Must return 1

# Acquire through write-blocked device
dc3dd if=/dev/sdb of=/evidence/disk-sdb.dd hash=sha256 hlog=/evidence/disk-sdb.log

# dc3dd computes hash during acquisition — use this value as collection hash
```

### Rule 6: Immutable Storage

After collection and initial hashing, evidence must be moved to write-protected storage. If using a filesystem:

```bash
# Make file immutable (Linux ext4/xfs)
chattr +i /evidence/disk-sdb.dd

# Verify immutable flag
lsattr /evidence/disk-sdb.dd
# Expected: ----i-------- /evidence/disk-sdb.dd
```

If using cloud storage (S3, Azure Blob, GCS), enable object lock / WORM policy before uploading.

## References

- RFC 3227: Guidelines for Evidence Collection and Archiving
- NIST SP 800-86: Guide to Integrating Forensic Techniques into Incident Response
- NIST SP 800-101: Guidelines on Mobile Device Forensics
- SWGDE Best Practices for Computer Forensic Acquisitions
