# Move Grok Build projects from temporary Claude deployment

If Grok Build was previously configured through `--provider claude`, keep
`WORKSPACE.md` as the source of shared guidance. Preview the existing-project
adoption transaction if needed with `aiwg regenerate --existing-project
--dry-run`, then apply it only after reviewing its file plan. Existing operator
text in `AGENTS.md` and `CLAUDE.md` belongs to the operator.

Deploy `aiwg use all --provider grok-build --scope project`, run `aiwg
regenerate --workspace --provider grok-build`, and confirm `aiwg build-verify
--provider grok-build` plus `grok inspect --json`. The native skill directory is
`.grok/skills`; `.agents/skills` and Claude files are compatibility surfaces,
not a substitute for this check. If Claude Code is also used, retain its
generated hook and project assets. Remove only AIWG-owned obsolete Claude
artifacts through a reviewed dry-run uninstall. This migration does not move
Grok Bot (`grokbot`) state or Grok web Build content.
