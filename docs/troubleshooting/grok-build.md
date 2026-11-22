# Grok Build troubleshooting

This page covers the `grok` coding-agent CLI (`grok-build` in AIWG), distinct
from Grok Bot and Grok web Build. Start with the
[quickstart](../integrations/grok-build-quickstart.md) and
[provider reference](../agents/providers/grok-build.md).

| Symptom | Check and recovery |
|---|---|
| AIWG files exist but project instructions are absent | Run `grok inspect` in the intended project. Review the folder before granting trust; an untrusted folder can show user skills while loading no project instructions. Restart the session after changes. |
| Skills appear in the wrong scope | Preview `aiwg use all --provider grok-build --scope project --dry-run` or `--scope user --dry-run`. Project kernel skills belong in `.grok/skills`; user mirroring is additive under `$GROK_HOME/skills`. Confirm `GROK_HOME` is absolute; relative paths, filesystem roots, bare `~` and null bytes are rejected. Quote paths containing spaces in PowerShell. |
| Only `.agents/skills` or `.claude` files exist | Deploy `--provider grok-build` and verify native `.grok` surfaces. Compatibility loading is not required by the adapter. Follow the [migration guide](../migration/grok-build-from-claude-workaround.md) and retain operator files. |
| MCP/hooks appear configured but do not execute | Check trust and the [MCP sidecar/hook guide](../integrations/grok-build-native-extensions.md). Configuration presence does not establish execution; current live evidence is deferred. |
| Session content is missing | Check [sessions](../providers/grok-build-sessions.md) for export/store limits. Export does not include tool output. Preserve provider session storage during removal. |
| Agent runs with an unexpected model | Grok 1.0.77 ignores agent frontmatter model pins. Select the worker model through the CLI; see [models](../providers/grok-build-models.md) and [automation](../providers/grok-build-native-agents.md). |
| Refresh fails or refuses a linked path | Preserve a backup, remove the unsafe link only after reviewing its owner, and retry a dry run. The offline suite proves a staged compilation failure leaves exact project preimages. General I/O failure recovery may require operator restoration from backup. |
| Uninstall retains files | Preview `aiwg remove grok-build --provider grok-build --dry-run`. Edited/unverifiable files are retained intentionally. Do not delete `.grok/config.toml`, sessions, operator skills or shared context to force removal. |
| Smoke skips or fails | Login privately with `grok login`, declare auth mode and opt in using the [exact smoke commands](../providers/grok-build-qualification.md#read-only-live-smoke). A version mismatch requires reviewed captures, not a bypass. Never paste credentials or raw config into receipts. |
| Scheduled drift fails | Review the named qualification contract, upstream source revision and affected inspect/config owners. Re-run the offline captured comparison with reviewed samples before changing pins. |

The adapter stays experimental. Real Windows PowerShell/WSL and new live smoke
evidence remain deferred; Linux fixtures and Windows simulation do not close
those gaps. The [promotion gate](../providers/grok-build-qualification.md)
lists all native surfaces still needing evidence.
