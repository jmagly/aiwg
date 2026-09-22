---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.opencode
---

# OpenCode Operational Reference

> **First time using AIWG?** Begin with [Install, Connect, and Verify](https://docs.aiwg.io/pages/getting-started--install-connect-verify.html). This guide assumes AIWG is already installed, `all` is deployed for your provider, and `aiwg-regenerate` has connected the agent to this project.

OpenCode is an open-source terminal AI coding agent by Anomaly (opencode.ai). AIWG deploys skills and rules natively to OpenCode's discovery paths.

---

## Install & Deploy

**1. Install OpenCode**

```bash
# macOS / Linux
brew install opencode

# npm
npm install -g opencode

# Or see https://opencode.ai/docs/ for all install options
```

**2. Install AIWG**

```bash
npm install -g aiwg
```

**3. Deploy to your project**

```bash
cd /path/to/your/project
aiwg use all --provider opencode
```

**4. Initialize config**

Copy the AIWG config template to your project:

```bash
cp "$(aiwg runtime-info --aiwg-root)/agentic/code/frameworks/sdlc-complete/templates/opencode/opencode.json.aiwg-template" .opencode/opencode.json
```

Or create `.opencode/opencode.json` manually:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-5",
  "mcp": {
    "aiwg": {
      "type": "local",
      "command": ["npx", "aiwg", "mcp", "serve"]
    }
  },
  "instructions": [
    "AGENTS.md",
    ".aiwg/instructions.md",
    ".opencode/rule/*.md"
  ]
}
```

The `instructions` array is how OpenCode loads rules — the `.opencode/rule/*.md` entry is required for AIWG rules to take effect. **As of #1548, `aiwg use --provider opencode` wires this automatically:** when it deploys rules it adds `.opencode/rule/*.md` and `AGENTS.md` to `instructions[]`, creating `opencode.json` if absent and merging non-destructively (your existing keys and instruction entries are preserved and de-duplicated). The block above is shown for reference / manual setups; you no longer need to add the rule glob by hand.

**5. You're ready.** Run `opencode` in your project directory.

---

## What Gets Created

```text
.opencode/
├── skill/       # Skill definitions (natively discovered via SKILL.md)
└── rule/        # Context rules (loaded via instructions in opencode.json)

AGENTS.md        # Project context (auto-loaded by OpenCode)
.aiwg/           # SDLC artifacts
```

---

## Capability Details

| AIWG Artifact | Path | How OpenCode Uses It |
|---------------|------|---------------------|
| Agent personas | Not deployed | OpenCode agents are config-only (`opencode.json` `agent` key) |
| Commands | Not deployed | Commands derive from skills automatically |
| Skills | `.opencode/skill/` | Natively discovered — `{skill,skills}/**/SKILL.md` |
| Rules | `.opencode/rule/` | Loaded via `instructions` array in `opencode.json` |
| Project context | `AGENTS.md` | Auto-loaded (same file as Claude Code) |

---

## Using Skills

Skills in `.opencode/skill/` are discovered when they contain a `SKILL.md` file. OpenCode loads them on demand when the agent recognizes a matching task.

Skills also serve as the source for OpenCode's command palette — you do not need separate command files.

---

## Models

Configure via `.opencode/opencode.json`:

**Anthropic (recommended for AIWG):**

```json
{
  "model": "anthropic/claude-sonnet-5",
  "small_model": "anthropic/claude-haiku-4-5-20251001"
}
```

**Other supported providers:** OpenAI, Gemini, Groq, OpenRouter, Bedrock, Azure, VertexAI, Ollama (via custom provider).

Run `opencode models` to list available models.

---

## Agent Loop

```bash
aiwg ralph "Fix all tests" --completion "npm test passes" --provider opencode --model anthropic/claude-sonnet-5
```

See [Al Guide](../ralph-guide.md) for full documentation.

---

## Troubleshooting

**Rules not being applied?** Verify `instructions` in `.opencode/opencode.json` includes `.opencode/rule/*.md`.

**Skills not available?** Confirm deployment:
```bash
ls .opencode/skill/
```

**Redeploy if needed:**
```bash
aiwg use sdlc --provider opencode --force
```

**MCP not connecting?** Test directly:
```bash
aiwg mcp serve
```

---

## MCP Sidecar (Recommended for Full Access)

```bash
aiwg mcp install opencode
```

See the [OpenCode MCP Sidecar Guide](opencode-mcp-sidecar.md) for complete setup.
