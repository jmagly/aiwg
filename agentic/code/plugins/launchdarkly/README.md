# LaunchDarkly

Say **“set up LaunchDarkly”** to reach `launchdarkly-concierge`. It identifies your maturity stage, checks the connection safely, and guides a first real flag evaluation.

```bash
aiwg use sdlc
aiwg use launchdarkly
aiwg discover "set up LaunchDarkly"
```

This addon is opt-in, index-only by default, and identifies itself at the documented SDLC seam as `feature_flags.provider: launchdarkly`. It does not change flag-fit policy or install a second flag lifecycle.

## Runtime dependency

`sdlc-complete` is required for onboarding and SDLC linkage. The current `aiwg use` dependency resolver accepts addon IDs only, so the manifest declares the framework as optional rather than making activation fail. Before onboarding, inspect `aiwg config show --project --json` and confirm the installed selection includes `sdlc` / `sdlc-complete`. If absent, stop and guide `aiwg use sdlc`; recheck before proceeding. Use scripts/preflight.mjs (hasSdlcDeployment) on the resolved installed map and active provider; a declared-only entry, kernel-only deployment or all alone does not pass. Indexing and documentation lookup can work without the framework. The concierge and onboarding skill enforce this runtime precondition.

## Components

| Component | Purpose |
|---|---|
| `launchdarkly-concierge` | Stage assessment and onboarding orchestration |
| `ld-docs` | Small, current, cited vendor documentation |
| `ld-connect` | Regional connection ladder and read-only verification |
| `ld-doctor` | Credential shape, placement, SDK and plan diagnosis |
| `ld-account-setup` | Account, roles, projects and environments |
| `ld-onboarding` | Gated path to a real first evaluated flag |
| `onboarding-record` | Sanitized progress, approvals and SDLC links |
| `ld-key-safety`, `ld-change-authorization` | High enforcement safety rules |
| `ld-docs-currency`, `ld-flag-hygiene` | Medium enforcement grounding and lifecycle rules |

## Safety and vendor reuse

AIWG guidance: keep reads as the default, show a proposed diff before production writes, and save only sanitized evidence. The addon never asks for credential values in chat.

LaunchDarkly documents data sharing and prompt injection in its [hosted MCP guide](https://launchdarkly.com/docs/home/getting-started/mcp-hosted.md). SDK keys belong on servers; client-side IDs and mobile keys have different placement rules ([environment keys](https://launchdarkly.com/docs/home/account/environment/keys.md)). The AIWG redaction policy covers all three plus API tokens, including unsolicited tool results.

Load available vendor guides through MCP `get-skills` / `load-skill` in the `guides` toolset rather than copying their text ([MCP overview](https://launchdarkly.com/docs/home/getting-started/mcp.md)). For a local/EU path without guides, use page documentation or a separately reviewed pinned `ai-tooling` reference: commit `22a512139` observed 2026-11-25 ([vendor repository](https://github.com/launchdarkly/ai-tooling)). No vendor skill content is bundled; see NOTICE.

User guide: `$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md`. Connection detail: `docs/hosted-mcp.md`. Offline diagnosis fixtures contain synthetic values only; run the repository's LaunchDarkly vitest suite. Live account checks are manual and must be recorded separately from fixtures.
