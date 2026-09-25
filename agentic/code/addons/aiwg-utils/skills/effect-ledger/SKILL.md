---
namespace: aiwg
name: effect-ledger
platforms: [all]
description: Record an effect, sign an effect, reconcile an effect or check "did this PR merge" through the signed AIWG effect ledger, using one aiwg effect command with scriptable exit codes
---

# Effect Ledger

Record and reconcile side effects (tracker comments, PR merges, issue closes,
git commits and tags, files, decision receipts) in the signed AIWG effect
ledger with the `aiwg effect` CLI. The ledger proves what AIWG recorded and
what a verifier observed. It never authorizes an effect and never replays one:
an operator decision authorizes, the ledger proves.

## Triggers

- "record an effect" → `aiwg effect record`
- "sign an effect" → `aiwg effect record` (signed intent and completed)
- "reconcile effect" → `aiwg effect reconcile`
- "did this PR merge" → `aiwg effect reconcile --kind tracker.pr.merged`
- "did we already post this comment" → `aiwg effect lookup` before posting
- "verify the effect ledger" → `aiwg effect verify`
- "the effect ledger lock is stuck" → `aiwg effect recover-lock` (operator only)

## When to record

Record every externally visible effect that a retry or a crash could repeat:
cycle and closing comments, merges, issue closes, tags, release files, and
decision receipts. Do not record read-only queries.

## Process

1. **Name the effect.** Pick the kind and target, and the causal context that
   makes it unique. For a cycle comment:
   `--kind tracker.comment --target gitea:owner/repo#12 --issue 12 --action cycle-comment --cycle 1`.
   `aiwg effect id <identity>` prints the effect ID.
2. **Check before acting.** Run `aiwg effect lookup <identity>`. Exit 0 means
   the effect is already present: do not repeat it. Exit 4 means an earlier
   attempt has no outcome: run `aiwg effect reconcile` first.
3. **Carry the ID into the target** wherever the target allows it: a hidden
   `<!-- aiwg-effect: <effect-id> -->` line in a comment body, or an
   `Effect-Id: <effect-id>` git trailer. Verifiers use the marker to prove the
   effect happened.
4. **Perform the effect**, then record and sign it in one call:

   ```bash
   aiwg effect record --kind tracker.comment --target gitea:owner/repo#12 \
     --issue 12 --action cycle-comment --cycle 1 --payload-file comment.md
   ```

   `record` writes the signed intent, runs the kind's verifier, and appends
   `completed` when the verifier reports `present`. Repeating it with the same
   payload exits 0 with `"idempotent":true`. Use `--unverified` only when no
   verifier can see the target, and say so in your report.
5. **Reconcile uncertain effects.** `aiwg effect reconcile <effect-id>` (or the
   same identity flags) asks the verifier again and appends a `reconciled`
   record each time. For "did this PR merge", once the merge intent is
   recorded: `aiwg effect reconcile --kind tracker.pr.merged --target gitea:owner/repo#34`.
   Reconciling an effect with no recorded intent is a usage error (exit 2);
   record the intent first with `aiwg effect intent` or `aiwg effect record`.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | present or recorded | Continue |
| 3 | absent | The target does not show the effect. Do not assume it is safe to replay; follow the workflow's own policy |
| 4 | unknown | Stop and escalate. Never replay on unknown |
| 5 | conflict | The same effect ID was recorded with a different payload. Stop |
| 6 | integrity failure | The ledger failed verification. Stop and report |
| 2 / 1 / 7 | usage / internal / artifact root unavailable | Fix the command or the artifact root; nothing was written |

## Rules

- Output is JSON by default and every document has a `schema` member; add
  `--format text` only for people.
- Never pass raw bodies, secrets or tokens as flags. Payloads are digested from
  `--payload-file` or given as `--payload-digest`.
- The ledger key lives in the host secret service. `aiwg effect keys list`
  shows key IDs and public keys only; `keys init` and `keys rotate` are
  operator actions.
- `aiwg effect recover-lock --lock <name> --authorize` is an operator action.
  It refuses live, reused or unverifiable lock owners and records the recovery
  in the ledger. Never run it without the operator's explicit approval.

## References

- @$AIWG_ROOT/docs/contracts/effect-ledger.v1.md — contract, exit codes and verifier rules
- @$AIWG_ROOT/docs/cli/reference.md — `aiwg effect` command reference
