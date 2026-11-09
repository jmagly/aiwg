# Authorization grant v1

`authorization-grant.aiwg.io/v1` is a bounded human grant, governed by
`schemas/effects/AuthorizationGrant.v1.schema.json` and registered in the existing
effects schema catalog. Valid/invalid fixtures live in `test/fixtures/effects/`.

A grant records a stable `grantId`, human identity and authentication reference,
provider/session provenance and user-turn digest, the answered question's digest,
policy version, creation and expiry times, and explicit revocation state. Scope
contains extensible action categories, target descriptors (repos, trackers,
workspace members, providers or workers), non-production environments, resource
globs and verbs. Limits include reversibility, impact, conditions and optional
`maxUses`. `until-revoked` is permitted only for low impact. Expiry must follow
creation; revocation cannot precede creation. Links may name a different grant
through `supersedes` or `revokes`.

The schema requires exclusions for secrets, destructive, production and
policy-override actions. Runtime validation also rejects those classes in scope
names, unrestricted category/verb wildcards, restricted material and tokens.
Categories and verbs are lowercase dotted or hyphenated names. Environments are
bounded to local, development, test, testnet and staging. These descriptors do not
classify an actual action: a future resolver must independently enforce the
human-authorization rule on host-classified actions.

## Signed storage API

The existing `src/effects/` API exports:

- `recordAuthorizationGrant(ledger, grant, links?)`: validate and append a signed
  `x.aiwg.authorization-grant` intent, then refresh the derived index. The capturing
  host must authenticate the human; supplying identity strings is not authentication.
- `readAuthorizationGrants(ledger)`: return verified grant history and integrity
  failures. Any integrity failure suppresses all grants in that ledger, so damaged
  records cannot supply authority. No signing key is needed to read or verify.
- `verifyAuthorizationGrants(ledger)`: verify the ledger, compare the current
  descriptor index with the reconstructed one, and replace the index if needed.

Production hosts use the existing host-configured `custom` effect ledger and its
existing keyring/key provider, also used by HITL receipts. There is no additional
signing key, trust root or effect subsystem. `authorizationGrant` is inside the
signed in-toto predicate. Its canonical JSON digest is bound to `payloadDigest`;
its ID is bound to `x-authorization-grant:<grantId>` and context `{grantId}`.
The ordinary effect identity index enforces idempotency: reusing an ID with
changed grant data conflicts, including across writers. Generic effect writers
must pass the same grant and binding validation. An intent here records a grant;
it does not dispatch an action or prove that an action ran.

The optional `links` reuse the ledger's `operatorDecisionEventId` and
`operatorDecisionRecordHash` fields. A capturing host can link its existing
operator-decision audit event; this storage API does not synthesize human events.
The existing `aiwg effect verify --with-decisions FILE --subsystem custom` checks
those links against an independently verified decision chain.

`effects/custom/authorization-index.json` under the configured artifact root is a
private (0600), derived index of scope descriptors, limits and ledger references.
It carries no authentication references, verbatim questions, user turns or tokens.
Readers use signed records, never index entries as authority. Writes and rebuilds
share a ledger directory lock and use the existing atomic/fsync file replacement.
Artifact routing and workspace access follow existing effect-store behavior,
including fail-closed external roots and owner-only directories; broader group
sharing changes belong to #3869.

## Verification command

```bash
aiwg config authorization verify [--target DIRECTORY]
# Equivalent existing entry point:
aiwg steward authorization verify [--target DIRECTORY]
```

The command reports grant count, index changes and integrity reasons without
printing grant descriptors or key material. A missing derived index is rebuilt
successfully. A changed or malformed index is repaired and exits 6 on that run.
Invalid ledger signatures, hashes, chains, bindings or checkpoint/index integrity
also exit 6 and rebuild an empty grant index. Ledger damage remains an error on
subsequent runs; rebuilding an index does not repair signed records. An unavailable
external artifact root exits nonzero without falling back to local storage.

There is no top-level `aiwg authorization` command.

## Compatibility and deferred consumers

This is an additive v1 effect contract revision: old records, digests, identity
vectors and signing formats are unchanged. Older strict effect readers do not
recognize the `authorizationGrant` predicate field; upgrade them before consuming new grant records.
`authorizationGrant` is allowed only on grant intents. Existing tombstone behavior
can remove it; purged grants are excluded from the derived index. No existing
`authorization.hitl` config is migrated or reinterpreted.

Part 1 stores history, including expired and revoked records. Grant resolution,
revocation/use effects and effective-use counting (#4001), native question capture
(#4002), process wiring (#4003), and search/explain/status (#4004) are deferred to
their owning issues. No stored grant currently changes a HITL decision. Optional
verbatim user phrases are omitted to preserve the effect ledger's existing raw
payload restrictions; digests bind the question and user turn instead.
