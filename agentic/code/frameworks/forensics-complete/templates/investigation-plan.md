# Investigation Plan

> This template defines the structured investigation workflow for a specific target and incident.
> Complete the metadata section before beginning. Reference the target profile for system-specific values.
> Update phase status and command output inline as the investigation progresses.

---

## Investigation Metadata

| Field | Value |
|-------|-------|
| Case ID | `{{case_id}}` |
| Case Title | `{{case_title}}` |
| Target System | `{{hostname}}` |
| Target IP | `{{target_ip}}` |
| Investigator | `{{investigator_name}}` |
| Investigation Date | `{{investigation_date}}` |
| Investigation Start Time | `{{start_time}}` |
| Authorized By | `{{authorized_by}}` |
| Authorization Reference | `{{authorization_ref}}` (ticket, email, or document ID) |
| Classification | `{{classification}}` (e.g., INTERNAL, CONFIDENTIAL) |

---

## Target Profile Reference

- Target Profile Location: `{{target_profile_path}}`
- Profile Version / Date: `{{profile_date}}`
- OS: `{{os_name}} {{os_version}}`
- Environment: `{{environment}}`
- Known Concerns Pre-Investigation: `{{known_concern_ids}}`

---

## Investigation Scope

```
{{scope_description}}
```

**In scope:**
- `{{in_scope_1}}`
- `{{in_scope_2}}`

**Out of scope:**
- `{{out_of_scope_1}}`
- `{{out_of_scope_2}}`

**Incident trigger:**
```
{{incident_trigger_description}}
```

---

## Investigation Phases

Check each phase as completed. Name the evidence scope and verification gate; retain observed incident timestamps separately.

| Phase | Description | Scope Units | Status | Completion Gate |
|-------|-------------|-----------|--------|-------------|
| 1 | Initial Triage | `{{triage_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 2 | User and Authentication Analysis | `{{auth_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 3 | Process and Service Audit | `{{process_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 4 | Persistence Mechanism Sweep | `{{persistence_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 5 | Filesystem and Artifact Analysis | `{{filesystem_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 6 | Network Forensics | `{{network_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 7 | Log Analysis and Timeline | `{{logs_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 8 | Container / Docker Audit | `{{containers_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 9 | Evidence Collection and Preservation | `{{evidence_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |
| 10 | Reporting | `{{reporting_scope}}` | [ ] Not started | `{{evidence_verified_or_not_applicable}}` |

---

## Phase-Specific Commands

All commands are parameterized from the target profile. Adjust paths and thresholds before execution.

### Phase 1: Initial Triage

```bash
# System identity confirmation
hostname && uname -a && uptime && date

# Current logged-in users
w && who

# Recent authentication events
last -n 50 {{hostname}}
lastb -n 20 2>/dev/null || echo "lastb requires root"

# Volatile memory: running processes snapshot
ps auxf > /tmp/{{case_id}}_ps_snapshot.txt

# Volatile memory: open network connections
ss -anp > /tmp/{{case_id}}_connections_snapshot.txt

# Volatile memory: loaded kernel modules
lsmod > /tmp/{{case_id}}_lsmod_snapshot.txt
```

### Phase 2: User and Authentication Analysis

```bash
# All local accounts
cat /etc/passwd | grep -v '/nologin\|/false'

# Sudo privileges
cat /etc/sudoers && ls /etc/sudoers.d/

# SSH authorized keys (check all user home dirs)
find /home /root -name authorized_keys 2>/dev/null -exec echo "=== {} ===" \; -exec cat {} \;

# Failed login attempts
grep 'Failed password\|Invalid user' /var/log/auth.log | tail -100
# For journald systems:
journalctl _SYSTEMD_UNIT=sshd.service | grep -i 'failed\|invalid' | tail -100

# Successful logins to privileged accounts
grep 'Accepted\|session opened for user root' /var/log/auth.log | tail -50

# Password changes
grep 'password changed\|chpasswd\|passwd' /var/log/auth.log | tail -20

# Account creation/deletion
grep 'useradd\|userdel\|usermod\|groupadd' /var/log/auth.log | tail -20
```

### Phase 3: Process and Service Audit

```bash
# Running processes with full command lines
ps auxf

# Processes with no binary on disk (potential memfd execution)
for pid in $(ls /proc | grep '^[0-9]'); do
  exe=$(readlink /proc/$pid/exe 2>/dev/null)
  [[ "$exe" == *"(deleted)"* ]] || [[ -z "$exe" && -d "/proc/$pid" ]] && echo "Suspicious PID $pid: $exe"
done

# Open files by process (network and unusual paths)
lsof -i 2>/dev/null | grep -v '{{expected_service_pattern}}'

# Services and their states
systemctl list-units --type=service --state=running
systemctl list-units --type=service --state=failed

# Cron jobs across all users
for user in $(cut -d: -f1 /etc/passwd); do
  crontab -l -u $user 2>/dev/null && echo "--- $user ---"
done
cat /etc/crontab /etc/cron.d/* /etc/cron.daily/* /etc/cron.hourly/* 2>/dev/null
```

### Phase 4: Persistence Mechanism Sweep

```bash
# SUID/SGID binaries not in package manager
find / -perm /6000 -type f 2>/dev/null | grep -v '^/proc\|^/sys' | sort > /tmp/{{case_id}}_suid.txt

# World-writable directories outside /tmp
find / -type d -perm -002 2>/dev/null | grep -v '^/proc\|^/sys\|^/dev\|^/tmp\|^/var/tmp'

# Systemd unit files added outside package management
find /etc/systemd /lib/systemd /usr/lib/systemd -name '*.service' -newer /etc/passwd 2>/dev/null

# Shell startup files for unexpected content
for f in /etc/profile /etc/bash.bashrc /etc/environment ~/.bashrc ~/.profile ~/.bash_profile; do
  [[ -f "$f" ]] && echo "=== $f ===" && cat "$f"
done

# /etc/ld.so.preload (LD_PRELOAD hijacking)
cat /etc/ld.so.preload 2>/dev/null && echo "WARNING: ld.so.preload is populated"

# PAM modules
cat /etc/pam.d/sshd /etc/pam.d/sudo /etc/pam.d/common-auth 2>/dev/null

# AT jobs
atq 2>/dev/null

# rc.local
cat /etc/rc.local 2>/dev/null
ls /etc/rc*.d/ 2>/dev/null
```

### Phase 5: Filesystem and Artifact Analysis

```bash
# Files modified in the last {{timeline_window_days}} days (excluding /proc, /sys, /dev)
find / -newer /tmp/{{case_id}}_reference_marker \
  -not -path '/proc/*' -not -path '/sys/*' -not -path '/dev/*' \
  -type f 2>/dev/null | sort > /tmp/{{case_id}}_modified_files.txt

# Large files over {{large_file_threshold_mb}}MB in unexpected locations
find / -size +{{large_file_threshold_mb}}M -type f \
  -not -path '/proc/*' -not -path '/sys/*' -not -path '/var/lib/docker/*' \
  2>/dev/null

# Hidden files and directories
find / -name '.*' -not -path '/proc/*' -not -path '/sys/*' \
  -not -path '/dev/*' 2>/dev/null | grep -v '.cache\|.config\|.local'

# Files with no owner (potential orphaned malware artifacts)
find / -nouser -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null

# Executable files in /tmp and /var/tmp
find /tmp /var/tmp -type f -executable 2>/dev/null

# Recently installed packages
{{package_manager_history_command}}
# Debian/Ubuntu: grep 'install\|remove' /var/log/dpkg.log | tail -50
# RHEL/CentOS: rpm -qa --last | head -30
```

### Phase 6: Network Forensics

```bash
# Current connections
ss -anp

# Connections exceeding threshold ({{connection_count_alert_threshold}} per remote IP)
ss -tn state established | awk 'NR>1 {print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn \
  | awk '$1 >= {{connection_count_alert_threshold}} {print "HIGH CONN COUNT:", $0}'

# ARP table (lateral movement indicators)
arp -n

# Routing anomalies
ip route show
ip rule show

# DNS resolution check (verify nameservers match profile)
cat /etc/resolv.conf

# Recent DNS queries (if systemd-resolved is logging)
journalctl -u systemd-resolved --since "{{investigation_date}} 00:00:00" 2>/dev/null | grep -i 'query\|NXDOMAIN'

# Firewall rules
iptables -L -n -v 2>/dev/null
nft list ruleset 2>/dev/null
ufw status verbose 2>/dev/null
```

### Phase 7: Log Analysis and Timeline

```bash
# SSH authentication events (last {{log_lookback_days}} days)
journalctl _SYSTEMD_UNIT=sshd.service --since "{{log_start_date}}" \
  | grep -E 'Accepted|Failed|Invalid|Disconnected'

# Sudo usage
grep 'sudo' /var/log/auth.log | grep -v '#pam_unix' | tail -100

# Web server access logs (if applicable)
tail -500 {{web_access_log}} 2>/dev/null | grep -E '40[0-9]|50[0-9]|PUT|DELETE|POST'

# Kernel messages (hardware errors, module loading)
dmesg | grep -iE 'error|warning|fail|module' | tail -50

# Auditd events (if configured)
ausearch -ts {{log_start_date}} -te today 2>/dev/null | aureport -au

# Build chronological event timeline
journalctl --since "{{log_start_date}}" --until "{{log_end_date}}" \
  -o short-iso | tee /tmp/{{case_id}}_system_journal.txt
```

### Phase 8: Container / Docker Audit

> Skip this phase if containers are not present per the target profile.

```bash
# Running containers
docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'

# Containers not in baseline (compare to target profile)
docker ps --format '{{.Names}}' | sort > /tmp/{{case_id}}_running_containers.txt

# Privileged containers (HIGH RISK)
docker ps -q | xargs docker inspect --format '{{.Name}}: Privileged={{.HostConfig.Privileged}}'

# Container network modes
docker ps -q | xargs docker inspect --format '{{.Name}}: NetworkMode={{.HostConfig.NetworkMode}}'

# Bind mounts to sensitive host paths
docker ps -q | xargs docker inspect --format '{{.Name}}: {{json .Mounts}}' | python3 -m json.tool

# Recent docker events
docker events --since "{{log_start_date}}" --until "{{log_end_date}}" 2>/dev/null

# Container processes
docker ps -q | while read cid; do
  echo "=== $(docker inspect --format '{{.Name}}' $cid) ==="
  docker top $cid
done
```

### Phase 9: Evidence Collection and Preservation

```bash
# Create evidence directory with case ID
mkdir -p /evidence/{{case_id}}/{volatile,logs,filesystem,network}

# Volatile data (collect first — lost on reboot)
ps auxf > /evidence/{{case_id}}/volatile/processes.txt
ss -anp > /evidence/{{case_id}}/volatile/connections.txt
lsmod > /evidence/{{case_id}}/volatile/kernel_modules.txt
arp -n > /evidence/{{case_id}}/volatile/arp_table.txt
ip route show > /evidence/{{case_id}}/volatile/routes.txt
w > /evidence/{{case_id}}/volatile/logged_in_users.txt

# Copy relevant logs
cp /var/log/auth.log /evidence/{{case_id}}/logs/ 2>/dev/null
cp /var/log/syslog /evidence/{{case_id}}/logs/ 2>/dev/null
journalctl --since "{{log_start_date}}" -o export > /evidence/{{case_id}}/logs/journal_export.bin

# Generate hashes for all collected evidence
find /evidence/{{case_id}} -type f | while read f; do
  sha256sum "$f" >> /evidence/{{case_id}}/evidence_hashes.sha256
done

echo "Evidence collection complete. Verify hashes: /evidence/{{case_id}}/evidence_hashes.sha256"
```

---

## Red Flag Escalation Criteria

If any of the following are discovered, immediately pause investigation and notify `{{escalation_contact}}`:

| # | Red Flag | Action |
|---|----------|--------|
| 1 | Root shell active from unexpected external IP | Isolate system immediately |
| 2 | `/etc/ld.so.preload` contains any entries | Potential rootkit — escalate |
| 3 | Kernel module not present in distro package | Potential rootkit — escalate |
| 4 | Process running from deleted binary path | Memory-resident malware — collect memory image |
| 5 | SSH authorized_keys modified within investigation window | Active compromise — change credentials |
| 6 | Outbound connections to `{{flagged_ip_ranges}}` | C2 indicator — escalate to threat intel |
| 7 | Evidence of data staged in `/tmp` or `/dev/shm` exceeding `{{exfil_size_threshold_mb}}`MB | Potential exfiltration |
| 8 | New user account created outside change window | Unauthorized persistence |

**Escalation Contact:** `{{escalation_contact}}`
**Escalation Channel:** `{{escalation_channel}}`

---

## Evidence Preservation Plan

| Evidence Type | Collection Method | Storage Location | Retention |
|---------------|------------------|-----------------|-----------|
| Volatile memory state | Bash capture scripts (Phase 9) | `{{evidence_storage_path}}/{{case_id}}/volatile/` | `{{retention_period}}` |
| System logs | journalctl export + raw log copy | `{{evidence_storage_path}}/{{case_id}}/logs/` | `{{retention_period}}` |
| Filesystem timeline | find + stat output | `{{evidence_storage_path}}/{{case_id}}/filesystem/` | `{{retention_period}}` |
| Network captures | pcap (if authorized) | `{{evidence_storage_path}}/{{case_id}}/network/` | `{{retention_period}}` |
| Hash manifest | SHA-256 of all collected files | `{{evidence_storage_path}}/{{case_id}}/evidence_hashes.sha256` | Permanent |

---

## Reporting Requirements

| Deliverable | Format | Recipient | Handoff Gate |
|-------------|--------|-----------|----------|
| Preliminary findings | Verbal / brief written | `{{primary_recipient}}` | Triage findings verified |
| Draft forensic report | Markdown / PDF | `{{report_recipients}}` | `{{evidence_index_verified}}` |
| Final forensic report | `{{report_format}}` | `{{report_recipients}}` | `{{report_review_approved}}` |
| IOC register | YAML + CSV | `{{ioc_recipients}}` | `{{ioc_validation_passed}}` |
| Remediation plan | Markdown | `{{remediation_recipients}}` | `{{findings_prioritized_and_owned}}` |
