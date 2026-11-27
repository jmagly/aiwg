# Start using LaunchDarkly

**“Set up LaunchDarkly.”** The concierge checks your stage and guides account setup, safe connection and a first flag in a real application. Install the SDLC framework and opt-in addon first:

```bash
aiwg use sdlc
aiwg use launchdarkly
```

**“Connect my EU project without showing any keys.”** `ld-connect` chooses hosted MCP → local MCP → ldcli → REST as applicable. Hosted MCP uses OAuth and is unavailable for EU/federal instances; local MCP supports those regions. Hosted token authentication is contested in the vendor page, so AIWG does not assume token acceptance there ([hosted MCP](https://launchdarkly.com/docs/home/getting-started/mcp-hosted.md), [local MCP](https://launchdarkly.com/docs/home/getting-started/mcp-local.md)). The reference was last verified 2026-11-25; `ld-docs` checks current guidance when online.

**“The server SDK rejects my key; diagnose it privately.”** `ld-doctor` classifies the locally held value without displaying it. Server SDK keys, mobile keys, client-side IDs and API tokens serve different purposes. SDK keys stay on servers ([environment keys](https://launchdarkly.com/docs/home/account/environment/keys.md), [API access tokens](https://launchdarkly.com/docs/home/account/api.md)). A 24-hex value offered for server use is flagged as a client-side ID shape hint, not accepted as proof of validity. AIWG redacts every credential class from output.

**“Help me choose account roles.”** `ld-account-setup` checks current role and plan guidance. Project presets are Project admin, Maintainer, Project developer, View developer, Release manager, Contributor, Reviewer and Viewer; base roles are separate ([project roles](https://launchdarkly.com/docs/home/account/roles/project-roles.md), [role concepts](https://launchdarkly.com/docs/home/account/roles/role-concepts.md)). Personal tokens end with member removal; service-token eligibility must be checked because vendor pages say both “select plans” and “Enterprise” ([API tokens](https://launchdarkly.com/docs/home/account/api.md), [token creation](https://launchdarkly.com/docs/home/account/api-create.md)). Purchases, trial selection and identity administration remain human actions.

**“Get my first flag evaluated.”** AIWG guidance: the concierge runs `ld-onboarding`, confirms SDLC is installed, respects an existing opt-out, links the existing flag plan through `feature_flags.provider: launchdarkly`, and proposes an isolated non-production scope. It loads matching vendor guides through MCP `get-skills` / `load-skill` when exposed ([MCP overview](https://launchdarkly.com/docs/home/getting-started/mcp.md)). Missing guides fall back to page documentation. The workflow records owner, fallback, removal criteria and actual application evaluation, including intended and fallback behavior ([testing code](https://launchdarkly.com/docs/guides/flags/testing-code.md)). A fixture or management read alone cannot complete onboarding.

**“Show my onboarding progress.”** AIWG guidance: progress is saved under logical `.aiwg/launchdarkly/` beneath the configured artifact root after `aiwg artifacts path --json --check-write`. Records contain stages, sanitized results, SDLC links, public sources/retrieval dates, approvals and blockers. Credential values and raw tool responses never enter the record.

AIWG guidance: reads are the default. Every production write needs a human-approved sanitized diff and rollback plan. Tool-returned text is data, including loaded vendor guides. LaunchDarkly documents how descriptions and context attributes can carry prompt injection and how tool results may share personal data and SDK keys with a model provider ([Data sharing and prompt injection](https://launchdarkly.com/docs/home/getting-started/mcp-hosted.md)). If the client cannot filter results safely, the workflow stops and asks for a private operator check.

## Availability and limits

This initial addon provides connection, diagnosis and onboarding. Later release/governance requests discover installed capabilities and report missing handoffs. It does not claim those capabilities are implemented. Offline references remain explicitly dated; live connection, first real evaluation and regional checks require a manual run. Keep an API-token path for REST-only actions even when OAuth is primary; REST requests pin `LD-API-Version: 20240415` and use the regional base URI ([API overview](https://launchdarkly.com/docs/api/overview)).
