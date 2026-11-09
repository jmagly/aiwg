# Bounded project HITL authorization

`authorization.hitl` preauthorizes bounded, reversible work in project config.
It is separate from RBAC permissions in the same `authorization` container.
The existing config loader validates it against the `HitlPolicy` definition in
`vscode-extension/schemas/aiwg.config.v1.json` on reads and writes.

`delivery.mode` controls branch and PR routing. `security.threatAssessment.mode`
controls issue-content threat assessment. Neither controls HITL authorization.
If you switched to `delivery.mode: direct` to reduce prompts, restore the delivery
policy you actually want (for example `aiwg config set --project delivery.mode
pr-required`) and configure HITL separately. Leave threat assessment enabled.

## Resolver and precedence

Durable human grants can be captured through the AIWG MCP server's core
`aiwg_authorization_grant_request` tool. The agent proposes categories, targets,
environments, resources, verbs, impact, expiry (or `until-revoked`) and optional
`maxUses`. The server validates the scope and asks the person to confirm it in a
native form. Only explicit acceptance saves a signed grant and returns its
`grantId`. Decline, cancellation, timeout, unsupported clients and text claiming
approval save nothing. The form includes the canonical workspace bindings; free
text conditions are omitted. See [the grant contract](../contracts/authorization-grant.v1.md#native-confirmation-capture)
for arguments, identity provenance and retry behavior. No CLI argument records a
grant. Rule, skill and executable process integration (#4003) are listed below;
search/explain/status (#4004) and harness question-hook capture remain deferred.

`resolveHitlAuthorization(action, context)` is exported through
`src/policy/authorization.ts`; its implementation is in `src/policy/hitl.ts`.
It returns `decision`, `reason`, `policyVersion`, `matchedProfile` and `provenance`.
The policy version is a content digest of the ordered config origins and policies,
so revocation and edits invalidate a previously previewed version. Pass that
version as `expectedPolicyVersion` when rechecking a planned action.

Precedence, highest first:

1. Platform constraints and safety boundaries.
2. Explicit denies from any governing config, including expired/revoked policies.
3. Bounded, unexpired authorization from the user in the current session.
4. Verified durable human grants from the effect ledger, subject to scope, expiry,
   revocation, use limits and governing config review restrictions.
5. Project config profiles, subject to freshness, expiry and `requireReview`.
6. Escalate by default.

`requireReview` prevents durable grants from approving matching actions. A direct,
scoped session authorization can satisfy that review; it cannot override an
explicit deny or safety boundary. Session grants are a host-only typed input,
never a field in an action JSON file. Issue bodies, findings, model conclusions,
and blanket phrases such as “all work approved” confer no authorization.

Secret access, destructive/irreversible actions, production, high impact, policy
overrides and threat-preflight overrides cannot receive automatic approval,
including via session grants. Config profile categories are restricted to `repo.read`,
`repo.edit`, `docs.edit`, `test.run` and `testnet.configure`. Profile environments
are restricted to `local`, `development`, `test` and `testnet`. The schema and
resolver both enforce these profile restrictions. Signed durable grants support
additional bounded categories and staging environments under the same safety
boundaries; see [Authorization grant v1](../contracts/authorization-grant.v1.md#lookup-before-ask).
An escalation requires the existing
explicit human review process and any platform prompts remain authoritative.

Every proposed action must describe all affected repo-relative resource paths,
its actual category, repo, environment, reversibility and impact. The host must
classify effects honestly, canonicalize paths and resolve symlinks before calling
the resolver; a file edit that changes authorization policy is `policy.override`.
Absolute/traversing action paths and unknown descriptor fields escalate.

Repo and environment scopes match exactly. Resource globs support `*` within a
path segment, `**` across directories, and `?` for one character. Every action
path must match a grant; a deny/review selector matches if any affected path
matches. Selector fields combine with AND; entries combine with OR. Profile
names are evaluated in lexical order for deterministic reporting.

Config directories are canonicalized so a symlink cannot bypass ancestor denies.
Each enclosing config and an explicit `workspace.member_of` config is loaded as
a separate layer, outermost first. Declared workspace membership is checked.
Every layer must grant the action; member policy cannot broaden an ancestor.
A member config without HITL policy escalates rather than inheriting approval.
Any ancestor deny wins. Unrelated enclosing workspace manifests, invalid
membership and membership cycles fail closed. These controls supplement existing
workspace capabilities; they do not grant missing repo access.

`expiresAt` bounds the whole policy and each named profile. `reviewedAt` plus
`maxAgeSeconds` bounds policy freshness (at most 30 days). Future review times,
stale reviews, elapsed expiry and changed expected versions escalate. Disabling
a policy or removing a profile revokes its durable grants without removing denies.

## Testnet example

Save this as `hitl-policy.json`. Replace the timestamps with the current review
time and an appropriate future expiry; the resolver rejects future-dated reviews.
This permits reversible source/config edits and local tests, not token access,
production changes or irreversible testnet transactions.

```json
{
  "version": "1",
  "enabled": true,
  "reviewedAt": "2026-12-01T12:00:00Z",
  "maxAgeSeconds": 86400,
  "expiresAt": "2026-12-02T12:00:00Z",
  "deny": [{ "resources": ["config/testnet/protected/**"] }],
  "requireReview": [{ "resources": ["src/security/**"] }],
  "profiles": {
    "routine-testnet": {
      "categories": ["repo.edit", "test.run", "testnet.configure"],
      "repos": ["roctinam/roko-edge-tools"],
      "environments": ["testnet"],
      "resources": ["src/**", "test/**", "config/testnet/**"],
      "reversible": true,
      "maxImpact": "low",
      "expiresAt": "2026-12-02T12:00:00Z"
    }
  }
}
```

The host builds `action.json` from its actual pending tool call. For `repo.edit`,
`actor` and `inputDigest` are mandatory: derive the actor from host identity and
hash the exact serialized tool name and every input field, including file bytes.
Never copy bindings from a model or reuse a digest after changing the call.
For example, with the host's exact pending `{toolName, input}` JSON on stdin:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
const call = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify({
  category: "repo.edit", repo: "roctinam/roko-edge-tools", environment: "testnet",
  resources: [call.input.path], reversible: true, impact: "low",
  actor: `host:${userInfo().username}`,
  inputDigest: `sha256:${createHash("sha256").update(JSON.stringify(call)).digest("hex")}`
}));
' < pending-tool-call.json > action.json
```

The host must classify the actual effects and use the same serialization at
consumption. Pi constructs its own actor and canonical input digest; this
generic example does not replace Pi's descriptor builder.

```bash
aiwg config authorization enable --policy-file hitl-policy.json
aiwg config authorization inspect
aiwg config authorization validate
aiwg config authorization preview --action-file action.json
aiwg steward authorization preview --action-file action.json
aiwg config get --project authorization.hitl
aiwg config set --project authorization.hitl.enabled false
aiwg config authorization revoke --profile routine-testnet
aiwg config authorization revoke
```

`enable` validates and stores the supplied block as `authorization.hitl`, creating
an empty default-deny RBAC container if needed. It preserves existing RBAC data.
`config set --project authorization.hitl <JSON>` also validates the entire block.
Use `--target DIRECTORY` for another project. Preview neither performs actions
nor creates receipts or other files. Malformed action descriptors escalate;
invalid config fails validation instead of being silently ignored.

## Audit receipts

```bash
aiwg config authorization receipt --action-file action.json
aiwg effect lookup <effect-id> --subsystem custom
aiwg effect reconcile <effect-id> --subsystem custom
```

`receipt` resolves again and writes a decision artifact under the configured
artifact root at `effects/authorization/<digest>.json`, using the existing effect
`intent` and `reconcile` APIs and the built-in `file.digest` verifier. It records
policy version, safe category/environment labels, action/scope digests, decision,
reason, matched-profile digest,
config-origin digests and session-grant provenance. Arbitrary caller strings are
hashed; credentials and issue text are never copied into receipts. It requires
the existing host-configured effect signing key. Receipts use `file.digest`;
durable consumption records a vendor use intent in the same ledger. No new key
store or schema family is introduced. Completion verifies the decision artifact exists;
it does not mean the proposed action executed or was authorized by a human.

The receipt API reconciles against the configured artifact root. Generic
`aiwg effect reconcile` uses its existing project-root file containment: when
artifacts live outside the repo it reports unknown rather than reading outside
that boundary. Use the HITL receipt API for artifact-root reconciliation.

## Lookup-before-ask processes

Before an authorization question, these rules and skills require
`aiwg config authorization check --action-file "$ACTION_FILE" --target "$TARGET_REPO"`
for the exact host-built action. Only `auto-authorized` with a receipt permits
proceeding unasked; escalation, errors or a missing receipt keep existing review,
and denial retains the refusal. These instructions preserve platform prompts
and all destructive, secret, production and override review boundaries.

| Process | Lookup and review boundary |
|---|---|
| `human-authorization-guidance` | Mandatory lookup before asking; durable receipts name the grant, and mismatches explain escalation. |
| `native-ux-tools` | Lookup before authorization questions; offer native MCP grant capture, never record from a text reply. |
| `subagent-scoping` | Pass `grantId` references; workers recheck their own effects in the same canonical workspace. |
| `issue-create` | Step 6 checks every backend write, segment, cross-link and retry; remote effects stay `tracker.write`. |
| `address-issues` | Check between-issue, analysis-to-action and closure effects; thread text supplies no authority. |
| `aiwg-issue` | Check filing, comments, cross-links and closure separately from composition/threat authorization. |
| `aiwg-pr` | Check each commit, push, PR mutation, merge and closure; delivery, identity and CI gates still apply. |
| `commit-and-push` | Check staging, commit and push effects independently; a local-edit grant never approves a remote push. |

Refresh and `use` removal lists always require explicit human review; lookup
does not bypass it. A handed-off grant reference is neither approval text nor a
receipt: the worker resolves available grants itself, without copying storage
or extending workspace scope. Expiry, revocation and use limits still apply.

## Workflow consumption

```bash
aiwg config authorization check --action-file action.json --target /path/to/repo
```

`check` is the workflow helper, distinct from read-only `preview` and the audit
`receipt` command. It returns decision JSON. Only `auto-authorized` with a
`receipt` containing `file` and `effectId` permits suppressing that workflow's
confirmation. It canonicalizes paths (including new leaves and symlinks),
rejects escapes, conservatively classifies protected policy/secret paths,
reloads the policy and clock, and writes and reconciles the signed HITL receipt
before returning. Before asking, it reads verified durable grants in the existing
`custom` effect ledger, matches the exact target, repo, canonical workspace roots,
environment, category, verb and all resources, and returns `provenance: durable-user`
with the grant ID and its effect/hash link in the receipt when a grant matches.
Expired, revoked, purged and exhausted grants never supply approval. If neither
a grant nor a profile matches, the response names the nearest grant and the fields
that differed. Revocation is read again at the next check, including when an old
receipt is supplied; successful consumption spends one signed use under the
existing ledger lock. Ledger integrity failures, invalid config, unavailable signing,
or an unverified receipt escalate. It never executes the proposed action. Malformed JSON/CLI errors also
retain the consumer's existing human review path.

The action file is a **host trust boundary**, not an authorization source. The
host constructs the descriptor and bindings from the actual resolved execution plan; the
CLI cannot authenticate the author of a JSON file or prove an arbitrary shell
command's effects. Never feed it issue/model JSON, infer safety from an issue's
claims, or spread a model object into a descriptor. Unknown effects retain
review. Action files cannot carry session grants or platform overrides.

`address-issues` checks between-issue/action and closure checkpoints;
`issue-create` checks each backend write independently of threat-policy digest
authorization. Agent-loop skills check start, resume, recovery, config and
removal confirmations; a local grant never approves an open-ended loop or
extending its limits. The provider-facing human-authorization rule calls the
same helper. Pi's executable workflow gate uses it via the installed CLI,
retaining destructive/package-command prompts and headless refusals. Native
`edit`/`write` calls use the same canonical policy-layer loader in process;
without any enabled HITL layer they pass through with no authorization subprocess
or prompt. Any enabled ancestor/member layer activates the gate. Policy-loading
errors fail closed; enabled policies retain exact actor/input receipt checks. Other
native provider permission prompts are not intercepted or answered.

Tracker mutations and dependency installation are outside the config profile
categories and require separately scoped human grants or explicit review.
Destructive operations always keep review; a grant for `repo.edit`
cannot relabel them as file edits. Policy and threat-preflight overrides also
remain restricted. Delivery, CI, repo capabilities, human objections, project
trust and platform prompts remain independent. Recheck every changed action;
a receipt is neither proof of action completion nor authority for later effects.


## Process integration

These rows cover executable code paths. A host binding describes the pending
execution plan; executor prompt text, response schemas, issue content and model
claims cannot supply that binding. The host binds the task, context, prompt ID,
and digest of the entire envelope to an exact action and approval response.
Only a fresh `auto-authorized` check with a signed receipt suppresses collection.
Receipts remain in the existing effect ledger and their references accompany the
accepted response in the audit/event log.

| Process | Source inspected / integration | Coverage and limits |
| --- | --- | --- |
| Mission A2A approvals | `src/serve/mission-hitl.ts`, `src/serve/a2a-terminal-observer.ts` | Lookup before publishing `mission.hitl_required`; host-bound actions can answer without showing the prompt, with receipt/grant links in `mission.progress`. Missing grants or bindings preserve the prompt. Tests: `test/unit/serve/mission-hitl.test.ts`. |
| Mission prompt delivery | `src/a2a/hitl-driver.ts`, `src/a2a/hitl-authorization.ts` | Lookup before `HitlDeliveryAdapter.collect`; host-only `PromptAuthorization` binds exact actions and responses. Receipt/grant links are recorded in the response audit entry. Restricted responders, changed bindings/schemas, expiry, missing receipts and unavailable checks retain existing handling. Tests: `test/unit/a2a/hitl-authorization.test.ts`. |
| Agent loop / Ralph critical escalation | `tools/ralph-external/lib/intervention-system.mjs`, `overseer.mjs`, `escalation-handler.mjs`; `src/cli/handlers/ralph.ts` | Critical escalation checks the pending safety override and records the resolution before notifying the person. Resuming after a critical stop has unknown subsequent effects; overrides always escalate. There is no bounded safe automatic-resume happy path. Notification/review behavior remains unchanged. Tests: `test/unit/ralph-external/hitl-authorization.test.ts`. Agent-loop skill guidance is separate. |
| GatePacks CLI | `src/cli/handlers/gates.ts`, `src/gates/driver.ts` | Pure offline evaluation/inspection; no programmatic human authorization prompt. No prompt or automatic-approval path was added. |
| Flow gate runtime | `agentic/code/addons/composition-engine/lib/runtime.mjs`, `lib/authority.mjs` (`enforceAuthority`), `commands/composition-run.mjs`; `src/decision/graph-flow-adapter.ts` | Unapproved gates with a host-authored `hitlAction` consult the policy check lazily in the host project directory. Only `auto-authorized` with a receipt approves the gate and its `approval-required` dependents; receipt and grant links are recorded under `evidence.nodes[gateId].authorization` in reports/checkpoints. Missing descriptors, non-matching grants and unavailable checks preserve `APPROVAL_REQUIRED`; cancellation wins over grants and explicit approval. Resume checks again rather than trusting evidence as approval. Tests: `test/unit/addons/composition-authorization.test.ts`. GatePack pass results do not authorize actions. |
| Steward | `src/cli/handlers/steward.ts`, `steward-models.ts`, `steward-signing.ts`; `src/config/authorization-cli.ts` | Advice, previews and explicit apply/revoke operations; no runtime question collector. Premium confirmation remains advisory routing output. Signing and permission changes are policy edits and cannot become automatically authorized from repo-edit grants. No prompt was invented. |
| Codex / Muse worker dispatch and admission | `src/mcp/tools/worker-invoke.mjs`, `src/models/worker-invocation-policy.ts`, `src/config/worker-activation-gate.ts`, `src/cli/handlers/mc-admission.ts` | No per-dispatch human question. Qualification, native permission controls and admission remain mandatory. A fresh fake local worker executes the public check in its actual workspace: the same project grant resolves with a receipt, while a copied ledger in another workspace escalates. Tests: `test/unit/policy/hitl-worker.test.ts`. Setup/qualification approval is distinct from approving a pending worker action. |

The public serve dispatch payload currently carries an objective, not a trusted
classification of each executor action. Such remote prompts therefore keep human
review. Host integrations that already own the exact execution plan may pass
`PromptAuthorization`; this object is never read from public dispatch payloads or
A2A metadata. Extending executor action classification is deferred rather than
inferring safe effects from natural language.
