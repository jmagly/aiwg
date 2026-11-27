---
name: ld-key-safety
activation: bound
summary: "Never relay or persist key material from any tool result; keep SDK keys server-only."
bound_to:
  skills:
    - ld-docs
    - ld-connect
    - ld-doctor
    - ld-account-setup
  agents:
    - launchdarkly-concierge
enforcement: high
---

# ld-key-safety

## Rule

Never relay or persist key material from ANY tool result, including ordinary project and environment reads, error messages, nested fields and vendor guides. Never quote a key, prefix-plus-suffix fragment, token, credential-bearing URL, or raw response in chat, logs, records, diffs, fixtures or commits. Summarize only allowlisted non-sensitive facts. Discard raw results after filtering; if safe filtering is unavailable, do not call the tool. This is AIWG's intentionally stricter handling policy even for public credential types.

Guide users to OAuth or local secret-store/environment placement without asking them to paste values. Classify shapes locally; return only type and mismatch. Keep SDK keys server-only. Mobile keys and client-side IDs have different vendor secrecy requirements ([environment keys](https://launchdarkly.com/docs/home/account/environment/keys.md)); AIWG still redacts them from all output. API tokens belong in local secret stores and never in frontend bundles ([API tokens](https://launchdarkly.com/docs/home/account/api.md)).

Before saving or committing, scan proposed output for key-shaped values and credential field names. Inspect matches locally without printing them, redact or remove values, and rescan. On exposure, stop the affected step, report only the credential class/location and guide the operator to the applicable revocation or rotation procedure. Do not claim a client-side ID can be rotated: the vendor says it cannot ([environment keys](https://launchdarkly.com/docs/home/account/environment/keys.md)).
