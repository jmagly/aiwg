# Provider Context and Persistent-Memory Firewall

AIWG inventories provider-facing context before it reaches an agent session. The
firewall is a local, read-only gate: it measures context cost, compares deployed
artifacts with current packaged sources, applies review trust labels, and flags
instruction-poisoning signals without printing source contents.

Run the advisory scan from a project root:

```bash
aiwg context-firewall scan
aiwg doctor --provider claude
```

Use strict mode in CI or before a sensitive run:

```bash
aiwg context-firewall scan --strict
aiwg doctor --provider claude --strict-context
```

Strict mode exits non-zero for an over-budget context, stale deployment,
quarantined or external input, changed reviewed content, or a missing review
baseline. The default doctor check reports the same state as a warning so an
operator can review and remediate it first.

## What the Gate Measures

The report separates six contributions rather than presenting one opaque total:

| Contribution | Budget treatment |
|---|---|
| `memory` | Counts provider memory and workspace orientation loaded into context |
| `rule` | Counts deployed rules loaded by a provider |
| `skill` | Counts listing metadata in the active budget; reports full bodies as potential on-demand context |
| `agent` | Reports bodies as potential subagent context, not startup context |
| `generated-bridge` | Counts generated provider bridge files |
| `project-local` | Counts `.aiwg/context`, `.aiwg/memory`, and operator workspace context |

The portable default is 200,000 tokens with a warning at 60%. Override it for a
known provider tier with `--budget-tokens <n>` or doctor's
`--context-budget-tokens <n>`. A larger budget does not suppress stale or unsafe
input findings.

For managed deployments, the report includes both deployed bytes and current
packaged-source bytes. A manifest digest mismatch is labeled `stale`; it cannot be
hidden by an unchanged total byte count.

`packagedDigestMatch` accepts identical source bytes or a verified deployment
receipt: deployed bytes must match the receipt's `hash`, and the current packaged
source must match its `sourceHash`. This accounts for provider frontmatter,
managed markers, and bound rules without ignoring edits to those sections.
Kernel skills use their per-skill `.aiwg-manifest.json` receipts and report
`manifest-current` when their bytes match. Run `aiwg refresh` to add source hashes
to older receipts; transformed files without that evidence remain unverified
against the package. Generated context bridges have no single packaged source.

Provider layouts come from the firewall's exported provider keys; doctor uses the
same source. Unknown providers are reported as **not yet supported** and skipped,
including in strict mode; supported siblings still scan. Missing baselines and
unsafe files retain their strict failures.

The additional layouts follow the existing deployers and provider documentation:

| Provider | Context and resource paths | Sources |
|---|---|---|
| Pi | `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, `.pi/skills`, `.pi/.aiwg/skills` | [Deployer](../../tools/agents/providers/pi.mjs), [context loading](../providers/pi-direct.md) |
| OMP | `.omp/AGENTS.md`, `.omp/agents`, `.omp/rules`, `.agents/skills` | [Deployer](../../tools/agents/providers/omp.mjs), [native resources](../providers/omp.md) |
| Antigravity | `AGENTS.md`, `.agents/agents`, `.agents/skills`, `.agents/.aiwg/skills` | [Deployer](../../tools/agents/providers/antigravity.mjs), [workspace surfaces](../providers/antigravity.md) |
| DeepSeek Harness | `AGENTS.md`, `CLAUDE.md`, `.agents/skills` | [Deployer](../../tools/agents/providers/deepseek-harness.mjs), [native context](../providers/deepseek-harness.md) |

## Trust and Review

Every discovered file receives one trust label:

| Label | Meaning |
|---|---|
| `user-authored` | Local operator content without a package provenance record |
| `generated` | Deployed content matches its package manifest or packaged source |
| `external` | A symlink leaves the project root; its target is not read |
| `stale` | Deployed bytes differ from the recorded or current packaged source |
| `quarantined` | Poisoning signals or an unreviewed digest change require review |
| `superseded` | The review baseline marks the file inactive |

`quarantined` is a gate state, not a filesystem move. The scanner never deletes,
rewrites, or follows an external link. Its JSON and text reports contain paths,
digests, sizes, labels, and signal identifiers only—not matched content or file
bodies.

After reviewing every reported file, create the digest baseline explicitly:

```bash
aiwg context-firewall baseline --plan
aiwg context-firewall baseline --write --confirm-reviewed
git add .aiwg/context-memory-firewall-baseline.json
```

The plan is read-only and prints every record that would enter the baseline.
Custom destinations use `--output <project-relative-path>`. The writer rejects
absolute, parent-traversal, and symlink-resolved destinations outside the project
root, and replaces the baseline atomically only after the explicit confirmation.

The writer refuses to approve stale, quarantined, or external entries. Review a
changed file, remove any injected instructions, then deliberately regenerate the
baseline. To retire trusted content without deleting it, change that entry's
`trust` value to `superseded` in the reviewed baseline.

## Remediation

- Stale generated deployment: run `aiwg refresh --provider <provider>`, then scan
  again.
- Unneeded framework or addon: run `aiwg remove <name>`, or redeploy only the
  required set with `aiwg use <name> --provider <provider>`. Provider-scoped
  removal is not supported.
- Excess standing context: follow the [context tier model](../context-tier-model.md)
  and move procedures or examples from Tier 1 rules/bridges into Tier 2 routing or
  Tier 3 on-demand skills.
- Skill listing pressure: use the provider-specific controls in the
  [skills budget guide](../skills-budget-guide.md). Increase a listing budget only
  where the provider supports it and only after narrowing unnecessary skills.
- Poisoning or changed memory: inspect the named local file, remove or rewrite the
  unsafe instruction, review its provenance, and regenerate the baseline. Do not
  approve a baseline merely to clear the gate.

Use `--json` for CI evidence and `--limit <n>` to bound human-readable changed-file
output. The fixture at `test/fixtures/context-memory-firewall` exercises malicious
memory, changed reviewed memory, superseded context, and deployed/package drift.

This gate protects a single project checkout. Organization-wide policy,
endpoint isolation, and provider-side session retention remain outside its scope.
