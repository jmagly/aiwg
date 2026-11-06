---
namespace: aiwg
name: forensics-profile
platforms: [all]
description: Build target system profile via SSH or cloud API enumeration
commandHint:
  argumentHint: "<target> [--output path] [--deep] [--cloud aws|azure|gcp]"
  category: forensics-reconnaissance
---

# /forensics-profile

Build a comprehensive system profile of the target by enumerating OS details, running services, user accounts, installed packages, network configuration, and security controls. The profile establishes a baseline for subsequent investigation stages.

## Usage

`/forensics-profile <target> [options]`

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| target | Yes | SSH connection string (`ssh://user@host:port`) or cloud target (`aws://account-id/region`) |
| --output | No | Custom output directory (default: `.aiwg/forensics/profiles/<hostname>-<date>/`) |
| --deep | No | Perform deep enumeration including package inventory and kernel config |
| --cloud | No | Cloud provider context: `aws`, `azure`, or `gcp` |
| --no-network | No | Skip network enumeration (faster, less intrusive) |
| --format | No | Output format: `markdown` (default) or `json` |

## Behavior

When invoked, this command:

1. **Parse Target**
   - Resolve hostname or IP from connection string
   - Verify SSH connectivity or cloud API access
   - Detect operating system family (Linux distro, version, kernel)
   - Record target identifier for artifact naming

2. **System Enumeration**
   - Collect OS version, kernel version, architecture
   - Enumerate running processes and services
   - List installed packages and versions
   - Check uptime and last reboot time
   - Identify virtualization or container environment

3. **User and Account Inventory**
   - Enumerate local user accounts from `/etc/passwd`
   - Identify privileged users (UID 0, sudo group members)
   - Check for recently created or modified accounts
   - Review `/etc/sudoers` and sudoers.d entries
   - List active login sessions and recent auth history

4. **Network Baseline**
   - Capture listening ports and bound services
   - Document active network connections
   - Record network interfaces and IP assignments
   - Identify firewall rules (iptables, nftables, ufw)
   - Note DNS resolver configuration

5. **Security Control Assessment**
   - Check for security tools (auditd, fail2ban, SELinux, AppArmor)
   - Review SSH daemon configuration
   - Identify logging configuration and log rotation
   - Note enabled/disabled security features

6. **Save Profile Artifact**
   - Write `system-profile.md` with structured findings
   - Write `system-profile.json` for machine processing
   - Generate SHA-256 hash of profile files
   - Log acquisition metadata and timestamps

## Examples

### Example 1: Basic SSH profile
```bash
/forensics-profile ssh://admin@192.168.1.50:22
```

### Example 2: Deep profile with custom output
```bash
/forensics-profile ssh://root@10.0.0.5 --deep --output .aiwg/forensics/profiles/web-server/
```

### Example 3: Cloud target
```bash
/forensics-profile aws://123456789012/us-east-1 --cloud aws
```

### Example 4: JSON output for pipeline use
```bash
/forensics-profile ssh://analyst@host --format json
```

## Output

Artifacts are saved to `.aiwg/forensics/profiles/<hostname>-<date>/`:

```
.aiwg/forensics/profiles/web01-2026-02-27/
├── system-profile.md         # Human-readable profile
├── system-profile.json       # Machine-readable profile
├── acquisition-log.yaml      # Timing and metadata
└── checksums.sha256          # Integrity hashes
```

### Sample Output

```
Profiling Target: 192.168.1.50
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Step 1: Connecting to target
  Connected via SSH (admin@192.168.1.50:22)
  OS detected: Ubuntu 22.04.3 LTS (kernel 5.15.0-91)

Step 2: System enumeration
  Hostname: web01.internal
  Uptime: 47 days, 3 hours
  Architecture: x86_64
  Running services: 23 active units
  Installed packages: 412

Step 3: User inventory
  Total accounts: 28 (4 with shell access)
  Privileged users: root, deploy
  Sudo group members: admin, deploy
  Active sessions: 2

Step 4: Network baseline
  Interfaces: eth0 (10.0.1.50/24), lo
  Listening ports: 22 (sshd), 80 (nginx), 443 (nginx), 3306 (mysqld)
  Active connections: 14 established
  Firewall: ufw active (12 rules)

Step 5: Security controls
  auditd: active
  fail2ban: active (3 jails)
  AppArmor: enforcing (18 profiles)
  SSH: password auth disabled, key-only

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Profile complete.

Output: .aiwg/forensics/profiles/web01-2026-02-27/
Next Steps:
  /forensics-triage ssh://admin@192.168.1.50    - Capture volatile data
  /forensics-investigate ssh://admin@192.168.1.50 --scope full
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/agents/recon-agent.md - Recon Agent
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/templates/target-profile.md - Profile template
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/commands/forensics-triage.md - Next stage
