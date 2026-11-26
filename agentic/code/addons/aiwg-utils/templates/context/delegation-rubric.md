### Delegation
{{policy}} ({{mode}}; {{strategy}}; ceiling {{ceiling}}){{defaults_note}}: bounded read-heavy, verbose, independent/verification work → cheapest capable worker.
Extraction `aiwg-model-explorer`/economy; coding/review `aiwg-model-coding-worker`/standard; high-consequence `aiwg-model-reasoning-worker`/premium.
Keep local: trivial lookups, coupled edits, serial, user back-and-forth.
Return ≤ {{return_budget}} tokens: pointers, confidence, open questions. Verify centrally; never concatenate.
No auto-flagship; session model ≠ worker tier. Escalate one step on failed checks/low confidence.
See: `aiwg show rule subagent-scoping`.
