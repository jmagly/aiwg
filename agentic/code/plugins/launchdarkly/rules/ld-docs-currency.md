---
name: ld-docs-currency
activation: bound
summary: "Ground vendor guidance in current page documentation or MCP guides with public URLs and retrieval dates."
bound_to:
  skills:
    - ld-docs
    - ld-connect
    - ld-doctor
    - ld-account-setup
  agents:
    - launchdarkly-concierge
enforcement: medium
---

# ld-docs-currency

## Rule

Call `ld-docs` before giving vendor-specific guidance. Fetch a relevant page `.md` or discover the MCP `guides` toolset; use `llms.txt` only as a navigation index. Never fetch `llms-full.txt` ([documentation index](https://launchdarkly.com/docs/llms.txt), [MCP overview](https://launchdarkly.com/docs/home/getting-started/mcp.md)).

AIWG guidance: attach a public source URL and actual retrieval date to each vendor claim. Do not label an archived reference as live. If offline, mark it last verified and stop steps that require current eligibility or syntax. Report contradictions rather than inventing a resolution: hosted token auth, service-token eligibility and older API EOL statements require rechecking. Prefer OAuth for hosted MCP and API version `20240415` for REST ([hosted MCP](https://launchdarkly.com/docs/home/getting-started/mcp-hosted.md), [API overview](https://launchdarkly.com/docs/api/overview)).
