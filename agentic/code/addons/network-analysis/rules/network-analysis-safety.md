---
activation: bound
summary: "Require bounded capture authority and separate disclosure approval; analyze immutable captures with trusted isolated tools and exclude secrets and payloads by default."
bound_to:
  skills:
    - analyze-network-capture
enforcement: critical
---

# Network analysis safety

Fail closed when capture authority, source identity, sensitivity, bounds,
destination, retention, or executable trust is missing or ambiguous.

- Saved captures are the default. Never choose an interface, initiate live
  capture or active scanning, elevate privileges, or alter capture permissions
  implicitly.
- A live capture needs a separate active authorization that exactly identifies
  authority, principal, interface, typed BPF filter, duration, byte/file bounds,
  non-overwriting destination, retention, issuance, and expiry.
- Treat PCAP/PCAPNG bytes and dissector output as hostile. Use maintained tools,
  absolute trusted executable paths, isolated profiles/configuration, bounded
  subprocesses, argument arrays, and `shell: false`.
- Treat source captures as Restricted and immutable. Hash before analysis,
  re-verify before handoff, and hash every derived artifact independently.
- Emit metadata first. Exclude payloads, credentials, tokens, cookies, TLS
  secrets, authorization headers, extracted objects, and raw packet bytes by
  default. Never copy captured secrets into logs or commands.
- Any provider transfer is a separate policy decision bound to capture digest,
  provider, purpose, content classes, allowed fields, actor, issuance, and
  expiry. Local analysis permission is not disclosure permission.
- Preserve observation/inference separation, tool/filter/version provenance,
  errors, partial status, redaction, limitations, custody, and stable locators.
- Use only synthetic or documented sanitized captures in source control and CI.
