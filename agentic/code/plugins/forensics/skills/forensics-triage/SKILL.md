---
namespace: aiwg
name: forensics-triage
platforms: [all]
description: Quick triage investigation following RFC 3227 volatility order
commandHint:
  argumentHint: "<target> [--output path] [--scope network|process|all]"
  category: forensics-triage
---

# /forensics-triage

Perform rapid triage of a potentially compromised system by capturing volatile data in order of volatility per RFC 3227. Identifies active threats, running malicious processes, suspicious network connections, and immediate red flags within minutes of invocation.

## Usage

`/forensics-triage <target> [options]`

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| target | Yes | SSH connection string (`ssh://user@host:port`) |
| --output | No | Output directory (default: `.aiwg/forensics/findings/<hostname>-<date>/`) |
| --scope | No | Triage scope: `network`, `process`, `filesystem`, or `all` (default: `all`) |
| --fast | No | Skip slower checks; capture critical volatile data only |
| --no-hash | No | Skip file hashing for speed (not recommended for evidence) |

## Behavior

When invoked, this command:

1. **Establish Baseline Connection**
   - Connect to target via SSH
   - Record exact timestamp (UTC) of triage start
   - Note investigator identity and tool version
   - Capture system clock drift vs. investigator clock

2. **Volatile Data Capture (RFC 3227 Order)**
   - CPU registers and running state (process list snapshot)
   - Network connections and ARP cache
   - Login sessions and active users
   - Contents of memory (process memory maps)
   - Temporary file system state (`/tmp`, `/dev/shm`)
   - Swap space indicators
   - Disk mount state

3. **Red Flag Detection**
   - Processes with deleted binaries (`/proc/*/exe` pointing to deleted files)
   - Processes listening on unexpected ports
   - Base64 or encoded strings in process command lines
   - World-writable files recently modified
   - Unexpected cron entries or scheduled tasks
   - Suspicious SUID/SGID binaries
   - Outbound connections to non-RFC-1918 addresses

4. **Network Snapshot**
   - All established and listening connections with PIDs
   - ARP table for lateral movement indicators
   - DNS cache contents
   - Routing table anomalies
   - Active traffic rates per interface

5. **Process Inventory**
   - Full process tree with parent-child relationships
   - Processes running from unusual locations (`/tmp`, `/dev/shm`, hidden dirs)
   - Processes with suspicious names or masquerading as system processes
   - CPU/memory outliers suggesting crypto mining or exfiltration
   - Open file handles for suspicious processes

6. **Quick Assessment and Scoring**
   - Assign threat score (0-100) based on red flags found
   - Classify finding severity (CRITICAL, HIGH, MEDIUM, LOW, INFO)
   - Determine recommended next steps
   - Flag whether live response escalation is needed

7. **Save Triage Artifacts**
   - Write `triage-summary.md` with findings and threat score
   - Save raw volatile data captures to `volatile/`
   - Record chain-of-custody entry with hashes
   - Update investigation state file

## Examples

### Example 1: Standard triage
```bash
/forensics-triage ssh://admin@192.168.1.50
```

### Example 2: Network-focused triage
```bash
/forensics-triage ssh://admin@192.168.1.50 --scope network
```

### Example 3: Fast capture (critical data only)
```bash
/forensics-triage ssh://root@10.0.0.5 --fast
```

### Example 4: Custom output directory
```bash
/forensics-triage ssh://admin@host --output .aiwg/forensics/incident-2026-02-27/
```

## Output

Artifacts are saved to `.aiwg/forensics/findings/<hostname>-<date>/`:

```
.aiwg/forensics/findings/web01-2026-02-27/
├── triage-summary.md         # Threat assessment and findings
├── volatile/
│   ├── process-list.txt      # Running processes at capture time
│   ├── network-connections.txt
│   ├── arp-cache.txt
│   ├── login-sessions.txt
│   ├── open-files.txt
│   └── memory-maps.txt
├── chain-of-custody.yaml     # Evidence integrity log
└── checksums.sha256
```

### Sample Output

```
Triaging Target: 192.168.1.50
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Triage started: 2026-02-27T14:32:01Z
Clock drift: +0.3s

Step 1: Capturing volatile data (RFC 3227 order)
  Process list: 187 processes captured
  Network connections: 42 connections captured
  ARP cache: 8 entries captured
  Login sessions: 3 active sessions
  Open files: 1,847 handles captured

Step 2: Red flag detection
  [CRITICAL] Process 'kworker' running from /tmp/kworker (deleted binary)
  [HIGH] Outbound connection to 185.220.101.42:4444 (known C2 range)
  [HIGH] Base64 in process args: PID 3847 (/bin/bash -c 'echo <b64>...')
  [MEDIUM] Unusual SUID binary: /usr/local/bin/.hidden (modified 2h ago)
  [MEDIUM] Cron entry added 4h ago: * * * * * /tmp/.update

Step 3: Network snapshot
  Established: 42 connections
  Suspicious outbound: 2 connections to non-RFC-1918
  DNS anomaly: None detected

Step 4: Process assessment
  Suspicious processes: 3
  Crypto mining indicators: None
  Masquerading processes: 1 ('kworker' from /tmp)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Threat Score: 87/100 (CRITICAL)

IMMEDIATE ACTION REQUIRED
Active compromise indicators detected.

Next Steps:
  /forensics-acquire ssh://admin@192.168.1.50 --logs --memory
  /forensics-investigate ssh://admin@192.168.1.50 --scope full
```

## Investigation Profiles

Profiles select a pre-configured subset of checks tuned for a specific investigation scenario. Pass a profile name via `--profile <name>`. Profiles can be combined with `--scope` for further narrowing.

```bash
/forensics-triage ssh://admin@host --profile quick-triage
/forensics-triage ssh://admin@host --profile targeted-ssh
/forensics-triage ssh://admin@host --profile targeted-container
```

### quick-triage

**Time budget**: ~5 minutes. Use when you need immediate situational awareness before a fuller investigation, or when the triage window is constrained (active incident, system may be shut down soon).

**Captures**:
- Network connections only: `ss -tunap`, ARP cache, routing table
- Process list only: `ps auxwwef`, processes from `/tmp`/`/dev/shm`/`/var/tmp`
- Skips: disk checks, kernel modules, open file handles, auth logs

**Red flag checks included**:
- Processes with deleted executables
- Active outbound connections on unexpected ports
- Processes running from temporary directories
- Interfaces in promiscuous mode

**Skipped checks**: SUID binary inventory, LD_PRELOAD scan, cron modifications, failed login history

**Output**: Condensed `triage-summary.md` with threat score and top-priority findings. No `volatile/` subdirectory — all data written to a single capture file.

**When to use**: First 5 minutes of an active incident; pre-escalation snapshot before calling the incident commander; when `--fast` alone is insufficient but a full triage is not yet authorized.

---

### targeted-ssh

**Time budget**: ~15 minutes. Use when the suspected intrusion vector is SSH — brute force, credential stuffing, stolen key, or unauthorized key addition.

**Captures** (in addition to standard volatile capture):
- Full authentication log correlation: `auth.log`, `secure`, `journalctl -u sshd`
- Last 7 days of SSH authentication events, not just last 100 lines
- Active SSH sessions: `who`, `w`, `last`, `lastb`
- Authorized keys across all user accounts (`~/.ssh/authorized_keys`)
- SSHD configuration snapshot (`/etc/ssh/sshd_config`) for unauthorized changes
- Failed login pattern analysis: count by source IP, frequency, username targeting
- Successful logins cross-referenced against failed attempts (brute-force success detection)
- Login timing anomalies: logins outside business hours, geographically inconsistent IPs
- SSH agent forwarding indicators in active sessions

**Red flag checks included**: All standard red flags plus:
- New authorized keys added within the investigation window
- SSHD configuration changes (PermitRootLogin, PasswordAuthentication changes)
- Successful root login preceded by failed attempts (Red Flag 6 with full context)
- SSH sessions with unusually long durations or high data transfer

**Output**: Standard artifact structure plus `ssh-analysis.md` containing the full auth correlation report and a timeline of SSH activity sorted by timestamp.

**When to use**: Alert triggered by SSH brute-force detection; user reports unauthorized access; unusual login from unexpected geography or time; post-incident review of a suspected credential compromise.

---

### targeted-container

**Time budget**: ~10 minutes. Use when the target is a Docker host, Kubernetes node, or containerized workload.

**Captures** (in addition to standard volatile capture):
- Docker daemon state: `docker ps -a`, `docker stats`, `docker inspect` for running containers
- Container network namespaces: connections from within each running container
- Kubernetes pod state (if node is part of a cluster): `kubectl get pods --all-namespaces`, `kubectl describe pod`
- Privileged containers: `docker inspect` output filtered for `Privileged: true` or host namespace mounts
- Volume mounts: host path mounts that could allow container escape (`/`, `/etc`, `/var/run/docker.sock`)
- Image provenance: image IDs vs. expected registry tags (`docker images --digests`)
- Container escape indicators: unexpected processes outside container namespaces, host filesystem access from within containers
- K8s: recent pod creation/deletion events, service account token usage, admission controller logs

**Red flag checks included**: All standard red flags plus:
- Containers running as root with host PID or network namespace (`--pid=host`, `--network=host`)
- Docker socket mounted inside a container (`/var/run/docker.sock` in container mounts) — allows full host escape
- Images pulled from unexpected registries or untagged images
- Pods with `hostPath` volumes pointing to sensitive host directories
- Containers with recent image pulls not matching deployment manifests

**Output**: Standard artifact structure plus `container-analysis.md` with container inventory, privilege audit, and escape-path assessment.

**When to use**: Alert from container runtime security tooling (Falco, Sysdig); unexpected privileged container detected; pod behavior anomaly in K8s cluster; post-incident review of a containerized workload compromise.

---

## References

- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/agents/triage-agent.md - Triage Agent
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/templates/triage-summary.md - Report template
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/commands/forensics-acquire.md - Evidence acquisition
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/commands/forensics-investigate.md - Full investigation
