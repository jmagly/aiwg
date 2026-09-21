---
namespace: aiwg
name: evidence-preservation
description: "Chain of custody and evidence preservation procedures covering log collection, hash verification, custody documentation, and evidence packaging per RFC 3227"
tools: Bash, Read, Write, Glob, Grep
platforms: [all]

---

# evidence-preservation

Implements evidence preservation procedures aligned with RFC 3227 (Guidelines for Evidence Collection and Archiving) and NIST SP 800-86. Guides examiners through volatile-first collection ordering, cryptographic verification of all evidence items, chain of custody documentation, and evidence packaging for storage or legal handoff.

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "chain of custody" → forensic evidence handling
- "bag and tag" → evidence collection shorthand
- "SHA-256 verify" → evidence hash verification

## Purpose

Evidence that cannot be authenticated is evidence that cannot be used. Without documented chain of custody, opposing counsel can challenge whether evidence was tampered with between collection and presentation. This skill enforces RFC 3227 collection ordering, generates cryptographic hashes at collection time, and produces legally defensible custody documentation.

## Behavior

For a pull-request investigation, ingest the exact-head receipt described in
`docs/security/pr-evidence-receipts.md` with its source blobs. Verify each
`evidenceManifest` SHA-256, record omissions and `actionTrail` in custody notes,
and keep scope triage separate from attack attribution. A partial PR receipt
is evidence of incomplete collection, not evidence of compromise.

When triggered, this skill:

1. **Initialize case record**:
   - Prompt for: case ID, examiner name, incident date/time, target system identifier
   - Generate a unique evidence package ID: `<case-id>-<YYYYMMDD>-<random4>`
   - Record collection start timestamp in UTC
   - Create custody log file: `.aiwg/forensics/evidence/<package-id>/custody.log`

2. **Apply RFC 3227 collection ordering (most volatile first)**:
   - Order of collection:
     1. Registers, cache, and running process state (memory)
     2. Routing table, ARP cache, process table, kernel statistics
     3. Temporary file system contents
     4. Disk data
     5. Remote logging and monitoring data
     6. Physical configuration and network topology
   - Document what was and was not collected, with reason for any omission

3. **Volatile data collection**:
   - Capture system time and skew: `date -u` and compare against NTP source
   - Running processes: `ps auxwww`
   - Network connections: `ss -anp` or `netstat -anp`
   - ARP table: `arp -n` or `ip neigh show`
   - Routing table: `ip route show`
   - Active network interfaces: `ip addr show`
   - Mounted filesystems: `mount`
   - Open files: `lsof -n 2>/dev/null`
   - All collection commands run within 60 seconds of each other; record exact timestamp per item

4. **Disk image acquisition guidance**:
   - Recommend write-blocking hardware or software (`dc3dd`, `ddrescue`) before imaging
   - Command example with hashing:
     ```bash
     dc3dd if=/dev/sda hash=sha256 hof=evidence.dd log=acquisition.log
     ```
   - Verify image hash matches source after acquisition
   - Record: source device, image file path, hash algorithm, hash value, acquisition tool version

5. **Log file collection**:
   - Copy (do not move) log files to evidence directory
   - Preserve original timestamps: `cp -p` or `rsync -a`
   - Hash each file immediately after copy:
     ```bash
     sha256sum /var/log/auth.log > /var/log/auth.log.sha256
     ```
   - Record: original path, copy path, file size, SHA-256 hash, last modification time

6. **Cloud evidence collection** (when cloud resources are in scope):
   - AWS: Create EBS snapshot of instance volume; export CloudTrail events; generate IAM credential report. Hash each downloaded artifact. Record snapshot IDs in custody log — snapshot integrity is attested by the provider.
   - Azure: Create VM disk snapshot; export Activity Log to JSON. Hash each artifact.
   - GCP: Create disk snapshot; export Audit Logs to JSON. Hash each artifact.
   - Store all cloud artifacts in `cloud/` subdirectory. Custody-log each item.

7. **Container evidence collection** (when containers are in scope):
   - Enumerate running and stopped containers before touching anything
   - For each relevant container, collect in this order:
     ```bash
     docker logs <container_id> > /evidence/containers/<container_id>-logs.txt
     docker export <container_id> > /evidence/containers/<container_id>-filesystem.tar
     docker inspect <container_id> > /evidence/containers/<container_id>-inspect.json
     ```
   - Hash each artifact immediately after collection
   - Do not stop or remove containers until all three artifacts are collected and hashed
   - Store all container artifacts in `containers/` subdirectory. Custody-log each item.

8. **Hash verification procedure**:
   - After all items are collected, re-hash each item and compare against initial hashes
   - Any mismatch is a custody integrity failure — document immediately
   - Generate a master hash manifest:
     ```bash
     find .aiwg/forensics/evidence/<package-id>/ -type f -not -name '*.sha256' | \
       xargs sha256sum > .aiwg/forensics/evidence/<package-id>/manifest.sha256
     ```

9. **Chain of custody documentation**:
   - Record each transfer of custody:
     - Date and time of transfer (UTC)
     - Transferring party (name, role, organization)
     - Receiving party (name, role, organization)
     - Method of transfer (hand delivery, encrypted upload, shipping tracking number)
     - Reason for transfer
   - Document evidence storage location between transfers (locked cabinet, encrypted volume, etc.)
   - Record any access to evidence items after collection (date, accessor, purpose)

10. **Evidence packaging**:
   - Create a compressed, encrypted archive of the evidence directory:
     ```bash
     tar czf - .aiwg/forensics/evidence/<package-id>/ | \
       gpg --symmetric --cipher-algo AES256 -o <package-id>.tar.gz.gpg
     ```
   - Hash the final package file
   - Record passphrase storage location (separate from package, in a sealed physical envelope or secrets manager)

11. **Write custody documentation**:
   - Custody log: `.aiwg/forensics/evidence/<package-id>/custody.log`
   - Hash manifest: `.aiwg/forensics/evidence/<package-id>/manifest.sha256`
   - Collection notes: `.aiwg/forensics/evidence/<package-id>/collection-notes.md`
   - Final summary: `.aiwg/forensics/reports/<package-id>-custody-report.md`

## Usage Examples

### Example 1 — Begin evidence collection
```
preserve evidence
```
Initializes case record and guides through collection.

### Example 2 — Document a custody transfer
```
chain of custody transfer --to "Jane Smith, Legal" --method "encrypted email"
```

### Example 3 — Package collected evidence
```
package evidence <package-id>
```

## Output Locations

- Custody log: `.aiwg/forensics/evidence/<package-id>/custody.log`
- Hash manifest: `.aiwg/forensics/evidence/<package-id>/manifest.sha256`
- Collection notes: `.aiwg/forensics/evidence/<package-id>/collection-notes.md`
- Custody report: `.aiwg/forensics/reports/<package-id>-custody-report.md`

## Configuration

```yaml
evidence_preservation:
  hash_algorithm: sha256
  collection_order: rfc3227
  encrypt_packages: true
  encryption_cipher: AES256
  timestamp_format: ISO8601
  volatile_collection_window_seconds: 60
  require_write_blocker_confirmation: true
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/rules/evidence-integrity.md — Evidence integrity requirements this skill implements (hashing, custody chain, packaging)
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/rules/non-destructive.md — Never modify source evidence; copy-only collection and read-only access rules
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — Confirm case ID and examiner authorization before beginning collection; custody transfers require explicit approval
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/rules/volatility-order.md — RFC 3227 volatile-first collection ordering this skill enforces
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/skills/ioc-extraction/SKILL.md — IOC extraction follows evidence preservation; cannot extract from unpreserved artifacts
