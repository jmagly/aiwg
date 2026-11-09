---
precedence: critical
overridable: true
enforcement: critical
triggers:
  - is this command destructive
  - can I run this safely
  - blast radius
  - this needs sudo
  - interactive command
  - gate destructive operational commands
activation: kernel
summary: Assess blast radius before commands; require human approval for destructive or cross-host changes, dry-run high-risk operations, and sanitize collected output.
---

# Ops Safety Rules

**Enforcement Level**: CRITICAL
**Scope**: All operational commands, agent-executed procedures, and infrastructure changes

## Interactive Commands

Flag commands requiring passwords, confirmation prompts, editors, or TUIs for human execution. Do not enter passwords or answer interactive prompts. Examples include `sudo`, `cryptsetup luksOpen`, `passwd`, `ssh-keygen`, `mysql -p`, `fdisk`, `cfdisk`, `parted`, `visudo`, `systemctl edit`, and `nmtui`.

Present the command, explain the interactive requirement, and ask the operator to run it and confirm completion. A pre-authorized non-interactive alternative is permitted: for example, `sudo -n` fails instead of prompting, and `sfdisk` accepts a reviewed partition-layout file. These alternatives do not waive destructive-operation approval.

## Destructive Operations

Require explicit human confirmation before execution. Present the exact command, effect, blast radius, reversibility, and verified backup status; wait for an explicit yes.

Always gate:

- Filesystem destruction: `rm -rf`, `shred`, `mkfs.*`, raw disk writes such as `dd ... of=/dev/*`.
- Disk/partition/volume changes: `fdisk`, `parted`, `gdisk`, `lvremove`, `vgremove`, `mdadm --stop` or `--remove`.
- Network/firewall destruction: `iptables -F`, `ufw reset`, `ip link delete`, `nmcli con delete`.
- Service/system changes: `systemctl disable`, `systemctl mask`, stopping host-defined critical services, `reboot`, `shutdown`, `poweroff`, `update-grub`, `grub-install`.
- Destructive package operations: `apt purge`, `apt autoremove`, `dnf remove`, `rpm -e`.
- Database destruction: `DROP DATABASE`, `DROP TABLE`, `TRUNCATE TABLE`.

## Blast Radius and Dry Runs

Classify every operation before execution.
Record every operation's blast-radius classification in the operation plan before execution.

| Level | Scope | Required gate |
|---|---|---|
| CRITICAL | Multiple hosts, data loss, unrecoverable operations | Human approval, dry-run, backup verification |
| HIGH | Single-host service outage or recoverable change | Human approval and dry-run |
| MEDIUM | Single service, brief disruption | Human notification |
| LOW | Read-only checks, monitoring, no disruption | No gate |

Multiple affected hosts or data destruction without backup is CRITICAL. Service outages and boot/network/authentication changes are at least HIGH. Read-only/informational operations are LOW.

A firewall flush on a gateway and DNS record deletion are CRITICAL operations and require human approval, a supported dry-run, and backup verification.
Routine log rotation, cache clearing, and temporary-file cleanup are MEDIUM operations requiring human notification, subject to the destructive-operation gates and any higher blast-radius classification.

For HIGH/CRITICAL operations, attempt a dry-run when supported before actual execution. Use `rsync --dry-run`, package-manager dry runs, Ansible `--check`, or `terraform plan`; for deletion, list candidates first; for firewall/service changes, inspect current rules/dependencies first.

## Host Boundaries

Never cross host boundaries without explicit human authorization.
Never apply one host's configuration to another, or silently target a whole fleet, without explicit human confirmation. Identify source and target hosts, the configuration, differing hardware/interfaces/IP assignments/roles, and likely impact before requesting confirmation.

## Secrets and Runtime Output

Follow core token-security. Keep token variables scoped to a heredoc/subshell lifetime; never place literal tokens in command history or persistent exports. Never put tokens, SSH keys, or certificates in runbooks, issues, or commit messages. Never store tokens in operational documents or runbooks, including procedure documents and response text. SSH keys and certificates follow the same rules as API tokens. Systemd secrets must use `LoadCredential=` or `EnvironmentFile=`.

Before collected command/API output, URLs, stack traces, or generated evidence reaches any response, audit file, artifact, repository, commit helper, tracker body, export, or bundle, invoke the mandatory `ops-information-governance` boundary. Safe secret references at authoring time do not make resolved output safe. Complete sanitization before emitting stream bytes; retain typed markers and optional fingerprints rather than secret values. Persistent/external sinks fail closed on sanitization failure. Provider masking does not replace the boundary.

## Enforcement

On any violation, halt immediately, report it, and await human instruction. Review executed actions, assess damage, restore backups if needed, and repair procedure gates. Report any CRITICAL operation executed without approval as an incident.
