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
classify an actual action: the resolver independently enforces the
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

## Native confirmation capture

The AIWG MCP server exposes `aiwg_authorization_grant_request` in its core toolset
on local stdio connections. It accepts a proposed scope, never a claimed approval:

```json
{
  "categories": ["tracker.write"],
  "targets": ["repo:roctinam/aiwg", "tracker:local"],
  "environments": ["development"],
  "resources": ["issues/**"],
  "verbs": ["create"],
  "maxImpact": "low",
  "expiresAt": "until-revoked"
}
```

Use the actual tracker target from the host-classified action descriptor.
`expiresAt` may instead be a future UTC timestamp; optional `maxUses` bounds
consumption. The server adds the canonical project and governing workspace
targets, fixes reversibility and the safety exclusions, and leaves `conditions`
empty. It validates the complete grant before asking, including prohibited
classes and the requirement that until-revoked grants have low impact.

The native form shows all scope fields, workspace bindings, impact, duration and
use limit. Only `action: "accept"` with `content.confirm: "confirm"` from that
elicitation records the signed grant and returns `{status: "recorded", grantId}`.
Decline, cancel, malformed responses, transport errors and the 60-second timeout
record nothing. Cancellation or an expiry reached while answering also refuses.
Unknown arguments, including approval text or caller-supplied provenance, fail
validation. Issue bodies, ordinary `ask-user` output and model messages create
no grants. There is no CLI recording flag or text-reply recording fallback.

Clients without form elicitation receive an actionable refusal: use the harness's
native question tool to ask the user, then retry from a client supporting MCP
form elicitation. That retry still needs its own explicit native confirmation.
The restricted remote HTTP tool projection does not expose this writing tool.

`grantedBy.kind` is human; its ID comes from trusted MCP request authentication's
client ID when present, otherwise the MCP session ID. Stdio connections without
a session ID receive a server-generated connection ID. These identify the
confirming client/session, not a separately verified personal identity.
`authenticationRef` names that session's elicitation event;
`provenance.nativeEventRef` contains the actual outgoing JSON-RPC request ID.
The server observes that ID at the public transport boundary, correlating
concurrent elicitations with server-generated metadata. `questionDigest` hashes
the exact displayed message; `userTurnDigest` hashes the JSON confirmation result.
Only digests are stored, never raw question or answer text. Signing uses the
existing project `custom` ledger and configured host key provider.

## Lookup before ask

`aiwg config authorization check --action-file FILE [--target DIRECTORY]` reads
the host's `custom` ledger on every check and again before receipt consumption.
Integrity failures escalate even when a config profile could otherwise authorize.
Platform restrictions, destructive/secret/production actions, high impact,
irreversibility and all override classes (including `threat.override`) always
retain review. Governing config denies and `requireReview` still apply.

Scope matching uses exact category, verb, target, repo and environment equality,
and requires every canonical resource path to match a resource glob. For existing
action descriptors, target defaults to `repo:<repo>` and verb to the final dotted
category component (`repo.edit` → `edit`). Hosts can supply explicit `target` and
`verb` for other effect classes. The grant's `scope.targets` must include the
target, `repo:<repo>`, and `workspace:<canonical-directory>` for the project and
each governing config root. These workspace descriptors are exact absolute
paths supplied by the host, never action-file authorization claims. A copied
ledger cannot approve a different checkout just because it has the same repo name.

Expired, future-created, revoked, superseded, tombstoned and exhausted grants do
not match. A signed grant naming `revokes` invalidates that ID on the next check;
the revocation record itself supplies no authority. Nonempty free-text conditions
escalate because this resolver cannot prove them satisfied. `until-revoked`
grants issue receipts lasting at most 24 hours; every consumption still rechecks
revocation. Config policy expiry/freshness can shorten that receipt lifetime.

Matching grants sort by `grantId`, then effect ID. If no grant matches and no
independent profile authorizes, the escalation names the nearest grant and its
differing fields, minimizing the number of differences with the same tie-break.
Receipts carry `provenance: durable-user` and `authorizationGrant` containing
`grantId`, `effectId` and `recordHash`; these links are bound by the signed receipt
digest and compared again during consumption.

Every successful durable receipt consumption appends a signed
`x.aiwg.authorization-use` intent in the same ledger, linking the grant's ID,
effect/hash and receipt effect. The existing `authorization-index` lock serializes
consumption with grant writes and other consumers, so concurrent checks cannot
overspend `maxUses`. A use reserves authorization, not evidence that the proposed
action executed. A repeated receipt consumption spends another use. If recording
a use fails, the check escalates; already-recorded uses remain spent. Purged use
records make finite-use grants ineligible rather than replenishing their budget.
Purged grant history makes remaining durable grants ineligible because a purged
revocation could have removed an older grant's authority; config profiles retain
their existing behavior.

## Compatibility and deferred consumers

This is an additive v1 effect contract revision: old records, digests, identity
vectors and signing formats are unchanged. Older strict effect readers do not
recognize the `authorizationGrant` predicate field; upgrade them before consuming new grant records.
`authorizationGrant` is allowed only on grant intents. Existing tombstone behavior
can remove it; purged grants are excluded from the derived index. No existing
`authorization.hitl` config is migrated or reinterpreted.

Part 1 stores history, including expired and revoked records. Part 2 (#4001)
resolves grants and counts uses through the existing authorization check. Part 3
(#4002) captures grants through MCP form elicitation. Operator search/explain/status and CLI revocation are specified in the
[authorization ledger contract](authorization-ledger.v1.md). Process wiring (#4003)
builds on these APIs. Harness hook capture (for example PostToolUse on a native
question tool) remains deferred to its owning follow-up. Optional
verbatim user phrases are omitted to preserve the effect ledger's existing raw
payload restrictions; digests bind the question and user turn instead.
