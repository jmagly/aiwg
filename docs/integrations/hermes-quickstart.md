# Connect AIWG to Hermes

> **Status:** Stable.

For the complete first-time journey, start with [Install, Connect, and Verify](../getting-started/install-connect-verify.md).

Hermes is the **provider** in this guide. Complete the [safe Node.js setup](../getting-started/install-node.md) first
if `node` or `npm` is unavailable.

## Connect, verify, and try a first task

> "Connect AIWG to Hermes in this project, then verify it by reporting the project root, the provider files you can read, the installed frameworks, and one useful next action."

Your assistant installs AIWG and runs `aiwg use all --provider hermes`, which refreshes AIWG's shared project context and prints a verification result.

> "The deploy output mentions reload commands — which ones do I run before verifying?"

Naming the reload output gets you the Hermes reload commands, with a chat restart as the fallback, instead of a generic retry.

From a terminal opened in the project's main folder, install AIWG and deploy the complete system:

The deployment command refreshes AIWG's shared project context and prints a verification result. Use Hermes reload
commands if `aiwg use` reports them, or restart the chat as a fallback. After that, ask Hermes to verify AIWG by
reporting the project root, provider files it can read, installed frameworks, and one useful next action.

### Command reference
```bash
npm install -g aiwg
aiwg use all --provider hermes
```

### Prompt-discovery hook acceptance

Deploy the optional hook with `aiwg use all --provider hermes --enable-cross-provider-hooks`.
It registers `pre_llm_call` in `$HERMES_HOME/config.yaml` (default `~/.hermes` on
Linux/macOS) and provides discovery context before Hermes answers capability questions.
Hermes skips the hook until you review and accept its command at the TTY prompt,
or explicitly opt in with `--accept-hooks`, `HERMES_ACCEPT_HOOKS=1` or
`hooks_auto_accept: true`. AIWG never enables acceptance for you; existing consent
settings and safe mode remain in effect.

Deploy prints a short next step. `aiwg doctor` (also `--scope user`) checks the exact
`pre_llm_call` command against `$HERMES_HOME/shell-hooks-allowlist.json` and existing
`hooks_auto_accept` config. Unreadable acceptance state produces an advisory.
Use the same `HERMES_HOME` for deployment, doctor and Hermes.

The command anchors the script path and checks its fingerprint before execution.
Changing script bytes blocks the old command; redeployment produces a new command
that Hermes must accept again because its allowlist compares the exact event and
command strings. See [hook patterns](../hook-patterns.md) for the wire protocol.

Try one small task immediately after verification:

> "Review this project's README and getting-started docs for unclear positioning, missing setup steps, or unsupported claims. Save the three highest-priority fixes with file references and a recommended next edit at .aiwg/marketing/brand/audit/readme-review.md. Leave the reviewed files unchanged."

Your assistant follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or the provider-specific adapter and produces a concrete review you can inspect.

Success means Hermes names the intended project, follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or the
provider-specific adapter, and produces a concrete review you can inspect. For advanced flags, compatibility notes,
and recovery details, see the [Hermes operational
reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/hermes.md).
