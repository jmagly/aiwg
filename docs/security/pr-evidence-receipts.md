# Pull request evidence receipts

`tools/security/pr-evidence-receipt.mjs` provides a read-only PR collector and
an assessment aggregator. `tools/security/pr-evidence-forge.mjs` implements the
GitHub and Gitea API adapters. The entry point is:

```bash
node tools/security/pr-evidence-receipt-cli.mjs \
  --provider gitea --api-url https://forge.example/api/v1 \
  --repo owner/name --number 42 --base-context canonical-base.json \
  --config .aiwg/aiwg.config
```

For GitHub, use `--provider github --api-url https://api.github.com`.
`AIWG_FORGE_TOKEN` supplies private-repository read access without putting the
token in process arguments. The command emits JSON to stdout and performs no
forge writes. Capture the receipt and source blobs in the configured artifact
store; avoid posting raw body/file evidence to a public review comment.
`canonical-base.json` must be independently prepared from the base revision
with `source: "trusted-base"` and its exact `revision`; PR-supplied files cannot
provide it. The collector never executes the PR's code, dependencies,
workflows, or instructions.

The adapter's `list` operation is called for `bodyHistory`, `comments`,
`reviews`, inline `reviewComments`, `checks`, `commits`, and `files`. Each page must return `items`,
`nextPage` (null only at the end), `complete`, and preferably `totalCount`.
Collection is bounded to 100 pages of 100 entries, 1,000 files, and 256 KiB per
file. A cap, malformed cursor, unavailable endpoint, binary file, oversized
file, or changed head/base appears as a specific omission with a next step.
Omissions make the PR-wide receipt incomplete. The original body belongs in
`bodyHistory` when the forge exposes it. GitHub GraphQL exposes edit diffs: if
the body was edited, its original text is marked unavailable until an
independent archive supplies it. Gitea does not expose this history through
the adapter and the omission remains explicit rather than inventing a body.

`assessPrEvidence(snapshot, trustedPolicy, { currentHead, proposedAction })`
calls the shared threat engine on title, current and historical body, review
comments, and every acquired changed text file. Changed `AGENTS.md`, rules, and
handoff documents are assessed as diff data, never loaded as instructions or
used to select the policy. The receipt records source SHA-256 hashes, revision,
line coverage, scanner findings, collection completeness, and an action trail.
The receipt schema is `schemas/security/pr-evidence-receipt.v1.schema.json`.

For a repository maintainer, `claims` records prose assertions while
`verified.reviews` and `verified.checks` include only forge events attached to
the exact PR head. Recollect and reassess after any head or base change. A
complete receipt means the declared surfaces were collected and scanned; it is
not an application security certification or permission to install, test,
approve a workflow, write, or merge. Operational actions have a separate gate.

For forensic handling, retain the receipt, the source blobs, and the
`evidenceManifest` hashes together under the configured artifact root. Cite
`activeFindings` by source ID and hash, record unknowns from
`completeness.omissions`, and carry `actionTrail` into chain-of-custody notes.
`scopeTriage` describes how the change relates to the independently obtained
canonical base. `maliciousness` remains `unestablished` without independent
attack evidence. Renames, large changes, and unexplained imports are triage
signals, not attribution. `codeOrigin` remains unknown absent an exact source
match and licensing evidence.
