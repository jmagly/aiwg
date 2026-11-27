---
namespace: aiwg
name: ld-connect
description: Choose a regional LaunchDarkly connection, verify through a filtered read and preserve a REST API-token fallback.
platforms: [all]
triggers:
  - "connect LaunchDarkly"
  - "configure LaunchDarkly MCP"
---

# ld-connect

## Behavior

1. Run `ld-docs` and `ld-doctor`. Determine commercial, EU or federal region from operator-supplied non-secret metadata. Unknown or conflicting region blocks connection. Classify locally supplied credential shapes before use; never request values in chat.
2. Try this ladder in order, recording why each unavailable step was skipped:

| Path | Configuration and constraints | Public source |
|---|---|---|
| Hosted MCP | `https://mcp.launchdarkly.com/mcp`, OAuth, `writes=none`; commercial only, unavailable on EU/federal. Use least privilege, short sessions and review calls. Hosted API-token acceptance is contested in the page; do not assume it works. | [Hosted MCP](https://launchdarkly.com/docs/home/getting-started/mcp-hosted.md) |
| Local MCP | `@launchdarkly/mcp-server`, API token from local secret placement, Reader role AND `--scope read`; EU `https://app.eu.launchdarkly.com`, federal `https://app.launchdarkly.us`. Check installed version and runtime guidance before starting. | [Local MCP](https://launchdarkly.com/docs/home/getting-started/mcp-local.md) |
| ldcli | Check installed `ldcli --help`; guide interactive `ldcli login` privately. Do not dump config or place a token in a command/transcript. Resolve regional base URI before connecting. | [CLI](https://launchdarkly.com/docs/home/getting-started/ldcli.md) |
| REST v2 | Local API access token, raw `Authorization` header without Bearer, `LD-API-Version: 20240415`; regional base URI as above, commercial `https://app.launchdarkly.com`. Handle 429 using supplied retry headers. | [REST guide](https://launchdarkly.com/docs/guides/api/rest-api.md), [API overview](https://launchdarkly.com/docs/api/overview) |

3. AIWG guidance: configure using the harness's supported local secret mechanism; show placeholders only. Do not automatically install packages, write credential-bearing config, read token files into context, or change permissions. Keep a separate API-token path for REST-only actions even when hosted OAuth works. Check the current [experiment API](https://launchdarkly.com/docs/api/overview) before any archive request; availability must not be inferred from MCP tool names.
4. Discover actual tool names at runtime. Select one minimal read such as project metadata; deny key-fetch tools. Ordinary reads can contain credentials: apply an allowlist of project/environment identifiers and status BEFORE any response enters chat or an artifact. If filtering cannot be guaranteed, stop; ask the operator to run a private check and supply only success/failure.
5. Use scripts/connection-summary.mjs (connectionSummary) for the private read result: pass only succeeded, configured transport and region, and emit only its allowlisted summary. It discards every other field; it does not itself make a network call or prove authentication. Record only transport, region, credential class, permission evidence, read success/failure, public docs URL and retrieval date. A 401 means verify class/region/permission, never retry by printing credentials. A 403 may indicate authorization or eligibility; do not infer plan or elevate. Back off on transient errors within a bounded retry budget.
6. Discover `get-skills` / `load-skill` in the `guides` toolset for `mcp-configure` if available ([MCP overview](https://launchdarkly.com/docs/home/getting-started/mcp.md)). When absent, use `ld-docs`; keep all AIWG gates.

## Examples

Input: “Connect my EU project.”
Output: skip hosted, guide local MCP with Reader plus read scope, perform a filtered read, and save only sanitized status. Never print an API token or raw project response.


## Rules and references

Apply all four bound rules: `ld-key-safety`, `ld-change-authorization`, `ld-docs-currency`, `ld-flag-hygiene`.
See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
