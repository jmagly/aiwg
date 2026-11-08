---
enforcement: high
activation: paths
summary: Require explicit bind addresses for Docker publishes; review wildcard binds, IPv6 and the forwarding path before accepting internet exposure.
triggers:
  - "docker published ports"
  - "compose port binding"
  - "docker run publish"
bound_to:
  skills:
    - host-hardening
    - exposure-analysis
paths:
  - "**/compose*.yml"
  - "**/compose*.yaml"
  - "**/docker-compose*.yml"
  - "**/docker-compose*.yaml"
  - "**/*.sh"
---

# published-port-binding

**Enforcement Level**: HIGH
**Scope**: Compose and docker run changes publishing host ports

## Requirements

Every published port MUST name a bind address. Short Compose syntax must use
`IP:HOST:CONTAINER`; long syntax must supply `host_ip`. `docker run -p` /
`--publish` follows the same requirement. Reject implicit all-interface binds,
including publish-all (`-P`) for private services. Render variables and merges
before validation; unresolved binds require review. `expose:` is not publishing.

Prefer a named private/VPN address or loopback for datastores and exporters.
An explicit wildcard (`0.0.0.0` or `::`) needs a documented public-service reason,
reviewed source/port restriction and separate IPv4/IPv6 exposure verification.
Host networking must be reviewed against actual listeners; `ports:` cannot
restrict it. Docker forwarding can bypass UFW INPUT denies: inspect DNAT,
FORWARD and DOCKER-USER rather than accepting `ufw status` as proof of closure.

## Examples

```yaml
services:
  queue:
    ports:
      - "10.8.0.2:6379:6379"  # explicit VPN bind
  exporter:
    ports:
      - target: 9121
        published: "9121"
        host_ip: 127.0.0.1
```

Flag `"6379:6379"`, long syntax missing `host_ip`, and
`docker run -p 6379:6379 redis` as `missing-bind`.
Accept explicit `docker run --publish '[::1]:6379:6379' redis` for binding
syntax; still review service policy separately.

## Enforcement

Run the host-hardening static checker on rendered sanitized Compose/command
files. It reports recommendations only and never rewrites files, changes
firewalls or restarts containers. Route live exposure review to exposure-analysis.

## References

- ../skills/host-hardening/SKILL.md
- ../../forensics-complete/skills/exposure-analysis/SKILL.md
- ../../ops-complete/rules/ops-safety.md
