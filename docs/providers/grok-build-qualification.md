# Grok Build qualification and stable-promotion gate

The contract is [grok-build-qualification.json](grok-build-qualification.json),
pinned to released CLI **1.0.38** and public source revision
`4247f661689354b831191f11eeeac8424993fe3d`. AIWG remains experimental.
The source revision is provenance, not proof that an unreleased checkout behaves
like the released binary. Use the official released binary on each host.

Run each provider-under-workflow (PUW) in a disposable project and home, with
a second project that already contains operator-owned `.grok/config.toml`,
`.grok/skills/operator/SKILL.md`, `WORKSPACE.md`, `AGENTS.md`, and, for the
compatibility check, `CLAUDE.md` and `.agents/skills/operator/SKILL.md`.
Do not place real credentials in qualification fixtures or committed receipts.

| Host | Install and update | Deploy and verify | Refresh and uninstall |
|---|---|---|---|
| Linux | Review upstream Linux installer for exact release; `grok --version`, then `grok update --check` | Run the common commands below in both projects and user scope | Regenerate, refresh, dry-run remove, remove, inspect preserved operator files |
| macOS | Review upstream macOS installer for exact release; `grok --version`, then `grok update --check` | Same commands on a native macOS host | Same lifecycle and backup/restore test |
| Windows PowerShell | Review upstream PowerShell installer for exact release; `grok --version`, then `grok update --check` | Same commands in PowerShell with Windows paths | Same lifecycle and rollback test |
| WSL | Install the Linux binary inside WSL for exact release; `grok --version`, then `grok update --check` | Same commands in the WSL filesystem and a Windows-mounted project | Same lifecycle; confirm path normalization and no writes outside targets |

Common project commands (use native PowerShell syntax for environment setup):

```text
aiwg use all --provider grok-build --scope project --dry-run
aiwg use all --provider grok-build --scope project
aiwg regenerate --workspace --provider grok-build
aiwg build-verify --provider grok-build
grok inspect --json
aiwg use all --provider grok-build --scope user --dry-run
aiwg use all --provider grok-build --scope user
aiwg refresh
```

For uninstall, run `aiwg remove <bundle> --provider grok-build --dry-run`
for each deployed bundle, then repeat without `--dry-run` after reviewing the
target list. Before/after each operation, snapshot operator-owned files and the intended
deployment roots. Repeat deploy and regenerate and compare hashes for
idempotence. Inject a controlled failure during refresh and verify backup or
transactional rollback restores the preimage. Run uninstall first as a dry run,
then inspect exactly which AIWG-owned paths it proposes; prove operator files
remain. Scan command logs and receipts for canary secrets and absolute personal
paths. Verify `AGENTS.md` loads `WORKSPACE.md` before `AIWG.md` and that a
Claude-compatible hook remains additive. `.agents/skills` is a compatibility
surface only; native deployment is `.grok/skills`.

For each host, after deployment, create a redacted smoke receipt:

```bash
npm run smoke:grok-build:live -- --output /path/to/private/receipt.json
```

The command records OS, released version, upstream source revision,
authentication **mode only**, Grok inspection outcome, AIWG build verification,
and observed instruction/skill surfaces. It does not record credential values,
raw `grok inspect` output, or configuration contents. The `checks` fields start
at `pending`; an operator records `pass` only after the corresponding PUW is
observed and adds an `evidence.<surface>` entry with `kind: "live"` and a
reviewable `reference` under `docs/`, `test-results/`, or an HTTPS URL for every
native surface. The live command's own receipt is evidence for instruction and
skill inspection, but a reviewable copy or link must be attached. Never
edit a receipt into a false pass merely to promote the provider.

Promotion is checked by `npm run gate:grok-build`. If provider inventory is set
to `stable`, the gate requires exactly one current receipt for Linux, macOS,
Windows PowerShell, and WSL, all lifecycle/security checks passed, and a live
`pass` for every native surface in the contract. Deferred or unsupported
surfaces need explicit reasons. The scheduled drift job compares the pinned
source revision with upstream `SOURCE_REV` and points maintainers here when
the CLI/config/InspectReport contract needs review. A new upstream revision
does not silently update the tested release pin.

Official contracts: [overview](https://docs.x.ai/build/overview),
[CLI reference](https://docs.x.ai/build/cli/reference),
[settings](https://docs.x.ai/build/settings),
[source](https://github.com/xai-org/grok-build).
