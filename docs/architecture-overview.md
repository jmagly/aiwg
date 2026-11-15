# AIWG Architecture Overview

> **Version**: 2026.11.x

The current architecture source is [AIWG CLI architecture](architecture/cli/index.md).
It replaces this page's earlier 2026.5 overview with C4 context, container and
component views checked against the shipped CLI.

Start with the part that answers your question:

- [What AIWG deploys and why](how-it-works.md).
- [CLI boundaries and building blocks](architecture/cli/index.md).
- [What changes after `aiwg use`](architecture/cli/flow-use.md).
- [Provider layouts, context files and optional hooks](architecture/cli/provider-deployment.md).
- [Discovery and kernel skills](discovery-and-kernel-skills.md).
- [Index storage and manifests](architecture/index-and-manifest-loading.md).
- [Adding project capabilities](architecture/cli/extending-cli.md).

Ordinary deployment writes instructions and ownership records; it does not require
a daemon. Optional MCP, decision services and other runtime integrations run only
when configured and invoked. Their boundaries are shown in the current architecture.
