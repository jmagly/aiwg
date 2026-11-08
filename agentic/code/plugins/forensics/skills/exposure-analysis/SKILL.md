---
namespace: aiwg
name: exposure-analysis
platforms: [all]
description: Read-only firewall analysis and effective host exposure reconstruction for Docker published ports, UFW bypass, stale rules, CDN scope, IPv6 asymmetry and external probe allowlists.
triggers:
  - "firewall analysis"
  - "docker published ports"
  - "what is reachable from the internet"
  - "reconstruct host exposure"
tools: Read, Bash, Write
requires:
  - operator-named host and authorized local or SSH read-only collection
  - sanitized timestamped listener, Docker and firewall captures
ensures:
  - effective exposure report with evidence hashes, limitations and pass/fail/unknown summary
invariants:
  - never changes host firewall rules, services, containers or credentials
  - unknown or incomplete evidence never proves a port closed
---

# Exposure Analysis

## Purpose

Relate listener inventory from `sys-host-audit` / Sys Host Profiler to host
firewall and Docker paths. Explain why a port is exposed, rather than trusting
`ufw status`. Use `container-forensics` for compromise indicators. This skill
produces reports and recommendations only, locally or over explicitly authorized
SSH. Do not install tools, elevate privileges, alter rules or probe unnamed hosts.

## Triggers

- "firewall analysis"
- "docker published ports"
- "UFW says closed but Docker publishes it"
- "CDN origin exposure" / "stale firewall rules"

## Behavior

1. Confirm host, interface/address inventory, capture time in UTC, permitted
   collection scope and artifact destination (`aiwg artifacts path --json --check-write`).
   Load `evidence-integrity`, `non-destructive`, `ops-safety` and
   `ops-information-governance` before collection. Keep this workflow read-only
   even when a caller asks to fix findings.
2. Reuse the existing host inventory when available. Within authorized scope,
   collect bounded metadata using `ss -ltnup`, `ip -j address show`,
   `iptables-save`, `ip6tables-save`, `ufw status numbered`,
   `nft -j list ruleset` or `firewall-cmd --list-all-zones` as applicable.
   Review runtime and persistent firewalld configuration separately. Record
   permission failures as UNKNOWN; never interpret a failed command as no rules.
   For SSH use the operator-named host with batch mode and a bounded connect
   timeout; no fleet expansion or private configuration searches.
3. Narrow Docker inspection to Name, NetworkMode, PortBindings,
   NetworkSettings.Ports and Networks. NEVER capture full `docker inspect`,
   process environments, datastore secrets, private keys or container Env.
   Route collected bytes through the existing information-governance boundary
   before terminal, artifact or report emission. Operator-held raw evidence is
   hashed at acquisition; sanitized derivatives have separate hashes and custody
   links. The helper only accepts already sanitized snapshots.
4. Classify every listener by address family, protocol and bind scope:
   loopback, private, named VPN address, all interfaces, public or unknown.
   Record owning process/PID from ss and correlate its unit/container using
   approved inventory metadata. Missing process/unit ownership stays unknown.
5. Trace new inbound traffic in actual rule order. Docker rootful bridge traffic
   normally traverses PREROUTING DNAT → FORWARD → DOCKER-USER → DOCKER.
   INPUT/UFW denies do not protect this forwarding path. Include earlier raw,
   mangle and native nft hooks, interface matches, conntrack and default policies.
   Record each rule's listener/publish match; flag missing bind addresses, empty
   DOCKER-USER guards, unused allows, earlier covering terminal rules, public-IP
   allow-all and CDN ranges permitting ports beyond the reviewed 80/443 scope.
   A stale rule is a review candidate: check socket activation, maintenance and
   standby services before recommending removal.
6. Review IPv4 and IPv6 independently, including IPv6 Docker publishing,
   wildcard dual-stack sockets and differing defaults. Different family rules
   are a review signal, not proof of equivalent reachability. Never infer IPv6
   closure from an IPv4-only capture.
7. External verification is optional and requires the operator to name the
   vantage, source addresses, target and bounded port set. Compare the probe's
   actual public egress/NAT source to all source allowlists, including CDN/VPN
   and both address families. If the source matches an allow rule, explicitly
   warn that a closed result proves nothing about ordinary internet sources.
   A clean probe is still limited to that vantage/protocol/time. The helper
   consumes supplied results; it never launches probes.
8. Hash-check evidence before analysis and again before report finalization.
   Include capture times, commands, collection failures, custody links and
   rule paths. For "reachable on date X", use dated config history/backups
   with their own hashes and distinguish reconstructed historical configuration
   from observed reachability; today's captures cannot establish past exposure.

## Offline helper

Run the bundled helper against an operator-supplied JSON snapshot:

```bash
node "$AIWG_ROOT/agentic/code/frameworks/forensics-complete/skills/exposure-analysis/scripts/analyze.mjs" --snapshot sanitized-snapshot.json
```

Required metadata: `host`, `capturedAt` (ISO UTC). Capture fields are strings:
`ss`, `docker` (JSON array of narrowed inspect records), `iptables4`,
`iptables6`, `ufw`. Supply `ingressInterface`, `vpnAddresses`, `cdnRanges`
(operator-reviewed CIDRs), and `hashes` mapping capture names to acquisition
SHA-256 values. Omitted hashes are explicitly unverified; a supplied mismatch
stops analysis. Optional `external` entries contain `source`, `port`, `protocol`,
`result`, capture time and vantage identity.

The helper supports ordered iptables/ip6tables filter and DNAT paths with
simple source/destination, protocol, port, interface and NEW-state selectors.
Unsupported selectors/chains, extra hook tables, native nftables/firewalld,
rootless/userland proxies and routed/host networks require manual analysis;
helper verdicts remain UNKNOWN. A host-path verdict never establishes upstream
internet routing or cloud controls. Do not represent the helper as a complete
Linux firewall evaluator. Cloud/Kubernetes controls are out of scope; attach
separately reviewed adapter findings to the existing network-audit report.

## Examples

Input: `-p 6379:6379`, UFW deny 6379, matching DNAT and forwarding accepts,
empty DOCKER-USER. Output: **internet-reachable via Docker** on the captured
host path; `docker-ufw-bypass`, `missing-bind`, `empty-docker-user` findings.
A DOCKER-USER DROP before the Docker accept instead reports the captured path
blocked. An unused 5432 allow is stale; a CDN source allowing all ports is
`over-broad-cdn`. See sanitized fixtures in `test/fixtures/host-exposure/`.

## Output and recurring checks

Use the existing `network-audit-report` template for the human report, storing
it under the resolved `.aiwg/forensics/reports/` and evidence/custody under
`.aiwg/forensics/evidence/`. The helper writes JSON only to stdout; caller owns
sanitization and artifact routing. Include a compact operations-log record:
`host, capturedAt, status, failed, unknown, report reference`.
Exit codes: 0 PASS, 2 FAIL, 3 UNKNOWN, 1 input/integrity error. Alert on any
nonzero result, not only FAIL. Post-deploy and monthly callers use existing
operator scheduling; every run needs fresh captures. No timer or service is
installed by this skill.

## References

- ../../rules/evidence-integrity.md
- ../../rules/non-destructive.md
- ../../../ops-complete/rules/ops-safety.md
- ../container-forensics/SKILL.md
- ../../../../extensions/net/templates/network-audit-report.md
- ../../../security-engineering/skills/host-hardening/SKILL.md
