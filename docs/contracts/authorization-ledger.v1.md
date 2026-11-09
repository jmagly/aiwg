# Authorization ledger v1

The authorization ledger is the existing signed **custom effect ledger**, under
`effects/custom/` in the configured artifact root. It introduces no new trust
root, subsystem or configuration root. Its storage and signing rules are the
[effect ledger contract](effect-ledger.v1.md); grant fields, safety exclusions,
identity bindings and native confirmation follow the
[authorization grant contract](authorization-grant.v1.md).

## Authority and history

A validated `authorization-grant.aiwg.io/v1` descriptor is carried by a signed
`x.aiwg.authorization-grant` intent. The canonical descriptor digest binds the
payload; grant ID binds the target and effect context. Verified signed records
are authoritative. `authorization-index.json` is private, derived descriptor data;
lookup never trusts its contents or repairs it. Any ledger verification failure
suppresses all grant authority. External artifact-root failures never fall back
to another directory.

The deterministic resolver compares category, verb, repo, target, governing
workspace paths, environment, resource globs, time, revocation, conditions,
impact and remaining uses. Safety exclusions, platform restrictions and governing
policy still apply. A matching grant alone is not a receipt or action dispatch.
Successful receipt consumption records `x.aiwg.authorization-use` under the
existing authorization lock. Read-only explanation never records a receipt or
consumes a use.

Revocation appends a new signed grant record with a distinct ID, `revokes` naming
the original grant, and `revocation.state: revoked`. The record retains the
original scope and human evidence as historical lineage, not a new human
approval. The removal record has its own creation time, low-impact bound and
`until-revoked` duration, so expired or future-created grants can also be revoked. Its `decisionEventId` hashes the CLI revocation event
(operation, original grant ID, timestamp and random event ID); it does not claim
an independently authenticated native question event. The record itself cannot
authorize actions. The resolver honors its link at the next check and when
consuming an existing receipt, including when the linked original has expired.
`supersedes` likewise removes the linked grant's authority. Purging grant history
makes remaining durable authority ineligible because a revocation could be lost.
Independent config profiles retain their own authority after grant revocation.

## Operator surface

All commands operate under `aiwg config authorization`; `aiwg steward authorization`
is equivalent. They accept `--target DIRECTORY` and `--json` (JSON is the default).
There is no top-level authorization command.

```bash
aiwg config authorization list --active --json
aiwg config authorization list --expired
aiwg config authorization list --revoked
aiwg config authorization show grant-issue-filing
aiwg config authorization search "create issues development"
aiwg config authorization explain --action-file action.json
aiwg config authorization revoke grant-issue-filing
aiwg config authorization verify
```

List filters are mutually exclusive. Unfiltered history includes future-created
(pending), expired and removed records. Revoked includes superseded grants and
revocation records. Show returns the signed descriptor and effect/hash references;
unknown IDs fail. Search tokenizes ASCII letters/digits case-insensitively,
deduplicates tokens and counts one point per matching token/field pair over
categories, verbs, targets, environments, resources and grant/effect/hash IDs.
It returns at most 20 positive-score matches with field/token/value reasons;
ties sort by grant ID then effect ID. No model calls, stemming or semantic
inference occur. Punctuation-only queries return no matches; blank queries
and queries longer than 4096 characters fail.

Explain canonicalizes the host-classified action file using the same resource
checks as `check`, runs `matchDurableAuthorization` with the resolver's glob
matcher and snapshot, and returns `matchingGrant` or `nearestGrant` with differing
fields, the policy resolution and `safetyClassForcesEscalation`. A matching scope
can still be denied by policy. Invalid descriptors escalate; action files cannot
supply approval or session authority. Explain is diagnostic; use `check` for the
signed receipt required by workflow gates.

Revoke needs the existing host signing key and fails on unverifiable history or
unknown IDs. Already revoked IDs return without another write. Legacy `revoke`
without an ID disables the config policy; `revoke --profile NAME` removes a config
profile. These remain distinct operations. Verify compares/rebuilds the derived
index; missing indexes rebuild successfully, drift exits 6 after repair, and
signed ledger damage remains an error. See the grant contract for details.

## Health and shell-free inspection

`aiwg status --probe` includes `authorization`; `aiwg doctor` includes an
`authorization-grants` check. Both inspect without signing keys or storage writes:

- `active` counts temporally active, non-revoked/non-superseded records. It is an
  inventory count, not proof that conditions, uses or policy permit an action.
- `expiringSoon` counts active records expiring within the inclusive next seven
  days. `AUTHORIZATION_EXPIRING_SOON_MS` defines this window; expired, pending,
  revoked and `until-revoked` records are excluded.
- `unverifiable` counts untrusted grant intents when ledger integrity fails; it
  is `null` when unreadable records prevent a reliable count. Failures are reported
  separately, never used as authority. Active counts are zero on integrity failure.
- `index` is `current`, `drift`, `missing`, or `absent` (empty ledger with no index).
  An unavailable health read reports `unknown` with an explicit failure. Doctor
  warns for expiry, verification failures, missing indexes or drift.

The local MCP tool `aiwg_authorization_grant_lookup` accepts strict requests:
`{operation:"list", status?:"active"|"expired"|"revoked"}`,
`{operation:"search", query:"create issues"}`, or
`{operation:"explain", action:{...}}`. It shares the CLI operations, uses the
server's trusted project, and never writes grants, revocations, receipts or uses.
It needs no form elicitation capability. Grant capture remains exclusively the
native-confirmed `aiwg_authorization_grant_request` tool. Remote HTTP projections
retain their existing tool allowlist.
