---
namespace: aiwg
name: ld-doctor
description: Diagnose LaunchDarkly credential classes, intended SDK placement, region, plan signals and SDK version without disclosing values.
platforms: [all]
triggers:
  - "diagnose LaunchDarkly connection"
  - "check LaunchDarkly SDK key"
---

# ld-doctor

## Behavior

1. Invoke `ld-docs` for [environment keys](https://launchdarkly.com/docs/home/account/environment/keys.md), [API tokens](https://launchdarkly.com/docs/home/account/api.md) and [plans](https://launchdarkly.com/docs/home/account/plans.md). Do not ask for a credential value. Use private local inspection returning only a classification; never read auth/token files into model context.
2. The pure local helper `scripts/doctor.mjs` exports `classifyCredential(value, intendedUse)`. It consumes an in-memory value and returns only class, placement and mismatch; it does no I/O. Use `server`, `mobile`, `client` or `api` as intended use. AIWG guidance: these shapes are local diagnostic heuristics, not a vendor format guarantee or proof of validity:

| Shape | Classification | Intended placement |
|---|---|---|
| `sdk-` plus nonempty suffix | server SDK key | server only |
| `mob-` plus nonempty suffix | mobile key | mobile SDK |
| `api-` plus nonempty suffix | API access token | management client, local secret store |
| exactly 24 hexadecimal characters | client-side ID | client SDK, never server SDK authentication |
| other/missing | unknown | stop and verify privately |

3. If a client-side ID is offered as an SDK key, report “client-side ID; server SDK requires a server key” without a fragment of the value. Do not attempt a live probe with the wrong type. Apply the same mismatch stop to mobile/API credentials.
4. Establish region from operator metadata, not key shape. Check selected transport and endpoint with `ld-connect`. Unknown region is blocked. Do not infer region or subscription from a credential prefix.
5. Inspect dependency manifests/lockfiles for installed SDK name/version and runtime; consult the matching current vendor page before recommending an upgrade. Inspect intended credential placement without reading secret files; flag browser-exposed server variables/bundle wiring by variable name only.
6. Record plan signals as observed, unavailable, denied or unknown per capability, with source and date. The plans page names Developer, Foundation and Enterprise but also contains conflicting tier wording; token eligibility differs across [API token](https://launchdarkly.com/docs/home/account/api.md) and [creation](https://launchdarkly.com/docs/home/account/api-create.md) docs. Do not infer entitlement from a successful trial or a 403. Offer a manual supported path or defer, never purchase/upgrade.
7. Return sanitized checks (class, mismatch, region, transport, SDK version, permission/plan uncertainty and remediation). No raw responses or credential values, including unsolicited client/mobile fields.

## Examples

Input: synthetic 24-hex value supplied locally with intended use `server`.
Output: `{ "kind": "client-side-id", "placement": "client", "mismatch": true }`; stop server authentication and guide private correction.


## Rules and references

Apply all four bound rules: `ld-key-safety`, `ld-change-authorization`, `ld-docs-currency`, `ld-flag-hygiene`.
See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
