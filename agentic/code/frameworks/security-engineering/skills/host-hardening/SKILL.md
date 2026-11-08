---
namespace: aiwg
name: host-hardening
platforms: [all]
description: Read-only system hardening baseline and plan-first host hardening recommendations for SSH, Docker bind addresses, firewall persistence, datastores, exporters and audit retention.
triggers:
  - "system hardening"
  - "host hardening baseline"
  - "plan host remediation"
  - "check compose port bindings"
tools: Read, Bash, Write
requires:
  - sanitized host baseline and operator-defined service health checks
ensures:
  - baseline report with diff-style recommendations, backup plan, access gates and re-verification checklist
invariants:
  - never changes host firewall rules or services, even with an apply request
  - never collects secrets, SSH key material or datastore passwords
---

# Host Hardening

## Purpose

Review a Linux host after exposure reconstruction or as a recurring baseline.
Extend `security-assessment` with concrete host checks, using existing
`sys-host-audit` inventory and `exposure-analysis` findings. Recommendations
are plan-first and read-only under `ops-safety`: this skill never applies a
firewall, SSH, datastore or service change. `--apply` is rejected.

## Triggers

- "system hardening"
- "host hardening baseline"
- "lockout-safe SSH remediation plan"
- "compose ports without bind address"

## Behavior

1. Identify the operator-authorized host, timestamp, role and service owners.
   Resolve report destination with `aiwg artifacts path --json --check-write`.
   Apply `ops-information-governance` to collected metadata before emission.
   Reuse sanitized inventory and exposure reports. Missing or restricted data
   means UNKNOWN, never PASS. Do not read auth/token files, authorized_keys,
   datastore passwords or environment values; operators provide safe boolean
   assessments for sensitive controls.
2. Assess the baseline below, recording evidence references and exceptions.
   Confirm effective sshd settings in relevant Match contexts, including
   included files; checking one config line cannot establish effective policy.
3. Prepare a reviewable diff-style recommendation per failed control. Map
   stale/over-broad firewall rule removal candidates to exact rule identifiers,
   listeners, container publishing and named service owners. Specify public,
   private or VPN binds for proposed Compose changes. Do not assume a standby
   rule is disposable because the listener is currently absent.
4. Include dated backup requirements, pre-change SHA-256, verified restore
   procedure and rollback deadline for every affected file/ruleset. Backups
   stay in operator-controlled restricted storage, not in reports. The helper
   produces backup instructions only; it never creates host backups.
5. Gate any separately performed SSH change on verified key-based access
   (second session with intended account) AND verified console break-glass
   access. A key file existing is insufficient. Require explicit operator
   authorization for exact changes, `sshd -t` and effective Match review,
   an open recovery session and timed rollback before password/root restriction.
   Network, boot and authentication changes have at least HIGH blast radius.
6. Hand the plan to the operator for a separate authorized operational change.
   Even explicit apply authorization does not make this read-only skill a
   mutation tool. Do not run reload/restart, firewall writes or datastore DDL.
7. After the operator reports application, obtain fresh captures. Re-run
   exposure analysis, SSH checks and the baseline. Re-verify listeners,
   IPv4/IPv6 firewall, Docker forwarding/binds, a new key-based session and
   every named health check (queue ready, monitoring targets still up, CDN
   origin HTTP/HTTPS). Record failures and recommend rollback; never claim
   verification from the pre-change snapshot. Missing results remain UNKNOWN.

## Baseline

| Area | Checks and safe metadata fields under `baseline` |
|---|---|
| SSH | `ssh.passwordAuthentication: no`, `permitRootLogin: no`, `maxAuthTries <= 3`, `caTrustReviewed`, `authorizedKeysFromRestricted` (from= review) |
| Firewall | `firewall.defaultDeny4`, `defaultDeny6`, `persistent` across reboot; compare runtime/persistent rules and default policy |
| Docker | `docker.userGuard`, `afterVpn` (readiness + startup/restart dependency), `liveRestore`, `explicitBinds` |
| Datastores | `datastores.authAcl`, `redisDangerousCommandsRestricted`, `postgresConnectionLogging`, `appRolesNotSuperuser` |
| Exporters | `exporters.privateBind`, `fixedTargets` (no caller-chosen multi-target scrapes) |
| Audit | `audit.rulesLoaded`, `retentionReviewed` (auditd rules, journal/rotation capacity and preservation) |

Boolean controls require `true` for PASS. Use `null`/omission for unknown,
not an assumed value; mark non-applicable controls with a documented operator
exception in the report. The helper leaves omitted controls UNKNOWN. Redis ACL
restrictions should deny dangerous commands for application users; do not
blindly rename commands or lock out maintenance/replication. Review SSH CA
principals and role privileges without exposing key or credential values.

## Offline helper and static check

```bash
node "$AIWG_ROOT/agentic/code/frameworks/security-engineering/skills/host-hardening/scripts/check.mjs" --snapshot baseline.json --compose compose.yaml
node "$AIWG_ROOT/agentic/code/frameworks/security-engineering/skills/host-hardening/scripts/check.mjs" --snapshot baseline.json --docker-run reviewed-commands.txt
```

Snapshot requires `host`, `capturedAt`, optional `baseline` and `healthChecks`
(array of safe named checks). Compose parsing uses the existing YAML dependency.
Short and long syntax require explicit literal `host_ip`/bind addresses;
wildcards receive a separate review finding. Render interpolation and merged
Compose files through an operator-approved process before static checking;
never execute shell substitutions from files. `expose:` alone does not publish
host ports. Host networking and publish-all require explicit listener review.
The docker-run checker covers literal `-p`, `--publish`, `-P`; shell-generated,
multiline or computed commands require manual review.

## Examples

Input: `PasswordAuthentication yes`, `PermitRootLogin yes`, six auth tries.
Output: failed SSH controls with `-PasswordAuthentication yes` /
`+PasswordAuthentication no`, dated operator-backup requirements, key and
console gates, explicit authorization and fresh-capture rechecks. Nothing is
changed. `--apply` fails with the read-only boundary explanation.

Input: Compose `ports: ["6379:6379"]` or long syntax without `host_ip`.
Output: `missing-bind`. `"10.8.0.2:6379:6379"` names the VPN bind;
`"[::1]:6379:6379"` names IPv6 loopback. `0.0.0.0` and `::` require public
service justification. An explicit address alone does not establish safety.

## Output and recurring checks

Write the sanitized report beneath resolved
`.aiwg/security-engineering/reviews/`. The helper emits JSON to stdout with
checks, findings, plan and `summary: {status, passed, failed, unknown}`.
Exit codes: 0 PASS, 2 FAIL, 3 UNKNOWN, 1 invalid input or prohibited apply.
Use existing operator scheduling for post-deploy and monthly checks; emit
`host, capturedAt, status, failed, unknown, report reference` to the operations
log and alert on nonzero status. This skill installs no schedules or services.

## Tool selection and limits

Suggested default: existing `ss`, Docker metadata and native firewall read
commands, with offline helper for reproducible narrow checks. Use nftables or
firewalld's native views when those own the host; review hook order manually
when the exposure helper reports unsupported semantics. Existing benchmark
reports may supply baseline evidence, with their scope and capture time.
For newer backend versions evaluate read-only behavior, both address families,
Docker integration and lockout recovery against sanitized fixtures before
trusting their results. No package vulnerability scanner is added here.

## References

- ../../rules/published-port-binding.md
- ../../../ops-complete/rules/ops-safety.md
- ../../../forensics-complete/skills/exposure-analysis/SKILL.md
- ../dfir-readiness/SKILL.md
- ../../docs/network-control-review.md
