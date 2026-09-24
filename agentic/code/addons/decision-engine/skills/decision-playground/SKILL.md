---
namespace: aiwg
name: decision-playground
platforms: [all]
description: List the installed decision pattern packs and run their offline recorded fixtures through the production decision evaluator
requires:
  - build: the installed package's compiled decision runtime (dist/src/decision)
ensures:
  - offline-only: no credential, network call, or action execution
  - real-runtime: every fixture runs through evaluateDecisionRuleset with the Jev adapter over a recorded-replay transport
  - labelled-evidence: receipts report offline-recorded execution and sanitized-recorded-fixture evidence, never live
script:
  entrypoint: scripts/decision-playground.mjs
  runtime: node
  cwd: project-root
  argsHint: "list | show <pack> | run <pack> [--fixture <id>] [--summary] | run-all | live-plan <pack>"
---

# Decision Playground

Explore the governed decision pattern packs shipped in the installed package.

- `list` shows every pack, its status (`supported`, `experimental`, or
  `unavailable`), primitive, fixtures, and live limits.
- `show <pack>` prints the manifest, its deterministic candidate policy, and the
  validation result.
- `run <pack> [--fixture <id>]` evaluates one fixture. The pack's governed
  definitions, ruleset, and offline binding run through `evaluateDecisionRuleset`
  with the production Jev adapter. A recorded-replay transport returns sanitized
  recorded answers, so acceptance policies, typed-output validation, native
  batching, and durable receipts all execute for real. Add `--summary` for a
  compact view.
- `run-all` runs every offline fixture and exits non-zero if a computed route
  differs from the fixture's documented expectation.
- `live-plan <pack>` prints the non-executing live readiness plan and the pack's
  call, token, cost, attempt, and deadline limits.

The command line never runs a live probe. Live execution requires the
programmatic `runLiveDecisionPattern()` API with explicit opt-in, approved
egress, a logical credential, and a transport; see
`docs/decision/pattern-playground.md`.

Outcomes are data. Every playground action stays `unexecuted`.
