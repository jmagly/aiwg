---
namespace: aiwg
name: ld-account-setup
description: Guide LaunchDarkly account, plan, project, environment and least-privilege role setup before a first flag.
platforms: [all]
triggers:
  - "create LaunchDarkly account"
  - "LaunchDarkly account setup"
---

# ld-account-setup

## Behavior

1. Runtime precondition: inspect `aiwg config show --project --json` for the target project and confirm the installed selection includes `sdlc` / `sdlc-complete`. Use scripts/preflight.mjs (hasSdlcDeployment) on the resolved installed map for the active provider; reject declared-only and kernel-only records. If absent, stop onboarding and guide `aiwg use sdlc`, then recheck. Respect any feature-flag opt-out. Read the existing SDLC flag plan and `feature_flags.provider` seam; propose `launchdarkly` only for an accepted provider choice.
2. Run `ld-docs`; identify account/no-account, region, stack, intended environments and plan needs. Present current trial/plan options from the [plans page](https://launchdarkly.com/docs/home/account/plans.md); let the human create the account and make purchase decisions. Do not freeze prices, trial duration or entitlement assumptions.
3. Explain projects as the flag namespace and environments as separate targeting/SDK credential scopes using the current [environment keys page](https://launchdarkly.com/docs/home/account/environment/keys.md). Confirm project/environment names, distinguish production explicitly, and propose any creation before writing. Default first evaluation to an isolated non-production environment.
4. Explain server SDK key (server-only), mobile key and client-side ID through `ld-doctor`. Keep API management tokens separate. Guide private secret placement, never a paste into chat ([environment keys](https://launchdarkly.com/docs/home/account/environment/keys.md), [API tokens](https://launchdarkly.com/docs/home/account/api.md)).
5. Start with Reader for reads. Explain the distinction between base roles Reader, Writer, Admin, Owner and plan-dependent project presets. Verified preset names (all prefixed “LaunchDarkly” in vendor UI): **Project admin, Maintainer, Project developer, View developer, Release manager, Contributor, Reviewer, Viewer**. Select the least privilege for the requested operation; do not request broad admin access to fix a denied read ([role concepts](https://launchdarkly.com/docs/home/account/roles/role-concepts.md), [project roles](https://launchdarkly.com/docs/home/account/roles/project-roles.md)).
6. Personal tokens are limited by their creator and are deactivated on member removal; service tokens are independent of membership but plan availability is contested (“select plans” vs “Enterprise”). Verify eligibility before recommending a long-lived integration ([API tokens](https://launchdarkly.com/docs/home/account/api.md), [create tokens](https://launchdarkly.com/docs/home/account/api-create.md)). Route SSO/SCIM questions to `ld-docs` using the vendor [documentation index](https://launchdarkly.com/docs/llms.txt); do not assert unverified plan eligibility or configure identity management during onboarding.
7. Call `ld-connect` for a read-only check. Enumerate vendor `get-skills` and load matching `onboarding` / `mcp-configure` guides when present; preserve AIWG rules and use page docs when absent ([MCP overview](https://launchdarkly.com/docs/home/getting-started/mcp.md)).
8. Resolve `aiwg artifacts path --json --check-write`; write the onboarding record beneath its `artifact_root` at logical `.aiwg/launchdarkly/onboarding-record.md`, using the manifest's declared memory path. Never hardcode a repository-local artifact root. Record sanitized roles, plan signals, region, stage, SDLC links, approvals and next action; no key values or raw tool responses.

## Examples

Input: “I have no account; help me get my first flag working.”
Output: concierge stage `no-account`, manual account choice, least-privilege connection, then `ld-onboarding` with a pending first-evaluation checkpoint until a real application evaluates the flag.


## Rules and references

Apply all four bound rules: `ld-key-safety`, `ld-change-authorization`, `ld-docs-currency`, `ld-flag-hygiene`.
See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
