# Connect AIWG to Muse Code

> **Status:** Experimental.

For the complete first-time journey, start with [Install, Connect, and Verify](../getting-started/install-connect-verify.md).

Muse Code is the **provider** in this guide — Meta's terminal/CI coding agent built on Muse Spark. Complete the [safe Node.js setup](../getting-started/install-node.md) first if `node` or `npm` is unavailable.

## 1. Install Muse Code

Install [Muse Code](https://dev.meta.ai/docs/muse-code/) for your platform and confirm the `muse` binary is on your PATH:

```bash
muse --version
```

## 2. Install AIWG and deploy

From a terminal opened in the project's main folder, install AIWG and deploy the complete system:

```bash
npm install -g aiwg
aiwg use all --provider muse
```

The deployment command refreshes AIWG's shared project context and prints a verification result.

## 3. Trust the workspace, then start a new session

Muse Code loads project `AGENTS.md` only after the workspace is explicitly trusted. When Muse shows the first-run trust prompt, **trust the workspace, then start a new Muse session** (or re-read skills) so the deployed bridge and skills load. Reloading an IDE window does not apply here — this provider is not Cursor.

## 4. Work discover-first

Muse skills deploy natively to `<project>/.agents/skills/`; agents, commands, and rules stay indexed. Before improvising, run:

```text
aiwg discover "<what you need>"
aiwg show <type> <name>
```

Then ask Muse Code to verify AIWG by reporting the project root, provider files it can read, installed frameworks, and one useful next action.

Try one small task immediately after verification:

```text
Review this project's README and getting-started docs for unclear positioning, missing setup steps, or unsupported claims. Save the three highest-priority fixes with file references and a recommended next edit at .aiwg/marketing/brand/audit/readme-review.md. Leave the reviewed files unchanged.
```

Success means Muse Code names the intended project, follows the AIWG bootstrap into `WORKSPACE.md` and `AIWG.md` or the provider-specific adapter, and produces a concrete review you can inspect.

## User-scope skills

For user-level skills across projects:

```bash
aiwg use all --provider muse --scope user
```

Skills land in `$XDG_CONFIG_HOME/muse/skills` (default `~/.config/muse/skills`), resolved at deploy time. AIWG never writes to `~/.muse`, foreign provider paths, or `~/.agents/skills`.

## Sessions

Session history is **export-first**: share an explicit `muse export` / `/export trajectory` JSON document with the operator rather than assuming a native log root. AIWG never scrapes `~/.muse` or similar homes for sessions.

For advanced flags, compatibility notes, and recovery details, see the [Muse Code operational reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/muse.md).
