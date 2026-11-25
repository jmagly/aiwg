# Choose an AIWG Workflow

AIWG gives your AI assistant reusable project context and specialist workflows. Choose the outcome you need, then ask
the agent to find and inspect the matching capability. You can begin with one task and expand as the work requires.

For first-time setup, follow [Install, Connect, and Verify](../getting-started/install-connect-verify.md). For a small
example that produces a saved report, use [Just Try It](../getting-started/just-try-it.md).

## Workflows by outcome

| You want to | Expected output | Guide |
|---|---|---|
| Plan and deliver a software change | Requirements, design decisions, reviews, and verification records | [SDLC quickstart](../quickstart-sdlc.md) |
| Prepare a campaign | Brief, audience and messaging decisions, drafts, and review records | [Marketing quickstart](../quickstart-mmk.md) |
| Review a codebase | Findings tied to source files and ranked by importance | [Audit existing code](../getting-started/audit-existing-code.md) |
| Investigate an incident | Investigation plan, observations, and source-linked findings | [Forensics](../getting-started/forensics-framework.md) |
| Organize research | Source notes, citations, and synthesis | [Research overview](../frameworks/research-complete/overview.md) |
| Curate media | Collection assessment and metadata or acquisition work | [Media curator](../frameworks/media-curator/overview.md) |
| Maintain a reference collection | Linked notes and a maintenance process | [Knowledge base](../frameworks/knowledge-base/overview.md) |
| Design your CI/CD pipelines | Governed pipeline and environment contracts; execution tooling planned (#4423–#4425) | [CI/CD Complete](../frameworks/cicd-complete/ci-schema-contracts.md) |
| Organize infrastructure work | Operational reviews and runbooks | [Operations](../frameworks/ops-complete/overview.md) |
| Review civic information | Cited analysis and publication preparation | [Civic action](../addons/civic-action/overview.md) |
| Prepare a dataset | Dataset assessment and curation artifacts | [Dataset intelligence](../addons/dataset-intelligence/overview.md) |

## Add capabilities when the task needs them

| Need | Guide |
|---|---|
| Keep a consistent writing style and review contextual writing issues | [Writing and content](../getting-started/writing-and-content.md), [Voice](../addons/voice-framework/overview.md) |
| Iterate toward explicit completion criteria | [Agent loops](../agent-loop-guide.md) |
| Divide work across a large context | [RLM](../addons/rlm/deployment-guide.md) |
| Strengthen a test and review process | [Testing quality](../addons/testing-quality/overview.md) |
| Store and retrieve project artifacts | [Storage](../storage/overview.md) |
| Review previous AI sessions | [Session history](../getting-started/session-history.md) |
| Coordinate longer-running work | [Automation](../getting-started/daemon-and-automation.md), [Cockpit](../cockpit/README.md) |
| Connect tool and resource access | [MCP](../mcp/README.md) |
| Keep project-specific instructions | [Project-local customization](../project-local/overview.md) |
| Author reusable extensions | [Extension system](../extensions/overview.md) |

Availability and execution depend on the selected provider, configuration, and integrations. Ask the agent to check
support before proposing automation. Campaign preparation, for example, can produce reviewable content; publication
requires access to the destination system.

## Technical references

The README introduces the product. These pages carry the operational detail:

- [CLI reference](../cli/reference.md) for commands, flags, and supported manual workflows.
- [Provider inventory](../providers/provider-inventory.md) and
  [comparison](../integrations/cross-platform-overview.md) for integration scope and setup routes.
- [Architecture overview](../architecture-overview.md) for deployment, discovery, and optional services.
- [Context regeneration](../regenerate-guide.md) for maintenance and migration.
- [Web-backed resources](../install/web-backed-resources.md) for package variants and resource retrieval.
- [Release verification](../releases/verifying.md) and [installation troubleshooting](../troubleshooting/index.md) for
  installation details.
- [Traceability](../mention-utilities.md) for relationships between project artifacts.
- [Agent design](../frameworks/sdlc-complete/agent-design.md) and [production workflow
  guidance](../frameworks/sdlc-complete/production-grade-guide.md) for deeper workflow design.
- [Research reading list](reading-list.md) for a standalone companion to the README bibliography.

Detailed inventories belong with their versioned reference material. Artifact totals are not a measure of how well a
workflow will solve your task.
