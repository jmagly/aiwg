# Connect AIWG to Devin Desktop

For the complete first-time journey, start with [Install, Connect, and Verify](../getting-started/install-connect-verify.md).

Devin Desktop is the **provider** in this guide. Open a terminal in the
project folder you use with Devin Desktop:

```bash
npm install -g aiwg
aiwg use all --provider devin
```

The deployment command refreshes AIWG's shared project context and prints a
verification result. Reload Devin Desktop if the output says a reload is
required, then ask it to verify the project root, `.windsurf/` context,
installed frameworks, and one useful next action.

Try one small task immediately after verification:

```text
Review this project's README and getting-started docs for unclear positioning,
missing setup steps, or unsupported claims. Return the three highest-priority
fixes with file references and a recommended next edit.
```

Success means Devin Desktop names the intended project, follows the AIWG
bootstrap into `WORKSPACE.md`, `AIWG.md`, and the compatibility adapter, and
produces a concrete review you can inspect.

If Node.js/npm are not working, follow [Install Node.js and npm
Safely](../getting-started/install-node.md). Agent/operator details live in the
[Devin Desktop operational reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/windsurf.md).

AIWG intentionally retains the `.windsurf/` paths used by the compatibility
adapter. The older `--provider windsurf` selector still works with a
deprecation notice. The separate `devin-cli` provider is not yet supported.
See [Desktop path verification](../providers/devin-desktop-paths.md) for retained paths and the pending 3.14 check.
