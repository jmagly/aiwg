# Model Configuration Guide

## Overview

AIWG uses a configurable model mapping system that allows users to specify which AI models to use for different agent roles without modifying deployment scripts or documentation.

The current provider-aware contract separates three concerns:

- canonical policy: `model-role`, `model-tier`, optional `model-effort`, and an
  exceptional exact `model-override`;
- provider capabilities:
  `agentic/code/providers/model-capabilities.v1.json`; and
- volatile exact identifiers:
  `agentic/code/providers/model-catalog.v1.json`.

Provider compilation reports one of `native`, `compiled`, `inherited`,
`global-only`, `informational`, or `unsupported`. An unsupported field is
omitted rather than copied into an artifact that ignores it.

Generated bootstrap context also presents a bounded delegation rubric. For
independent work, orchestrators prefer `aiwg-model-efficiency-worker` for
discovery and focused low-cost tasks, `aiwg-model-coding-worker` for
implementation and tests, and `aiwg-model-reasoning-worker` for architecture
or high-consequence analysis. This complements model routing: routing resolves
the role to provider policy, while the delegation rubric decides whether the
work should leave the primary context at all. Trivial, tightly coupled, serial,
or shared-state-sensitive work stays with the primary agent, which always owns
integration and final validation.

The versioned schemas are under `schemas/models/`. Project/user compatibility
input still accepts `max-quality` for one migration window, but canonical
policy uses `premium`.

## Configuration File Location

Models are defined in `models.json` files with the following priority:

1. **Project-level**: `./models.json` (highest priority)
2. **User-level**: `~/.config/aiwg/models.json`
3. **AIWG defaults**: `agentic/code/frameworks/sdlc-complete/config/models.json`

## Configuration File Format

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AIWG Model Configuration",
  "version": "1.0.0",

  "claude": {
    "reasoning": {
      "model": "claude-opus-5",
      "description": "Best for complex reasoning, architecture design"
    },
    "coding": {
      "model": "claude-sonnet-5",
      "description": "Best for code generation, implementation"
    },
    "efficiency": {
      "model": "claude-haiku-4-5",
      "description": "Best for quick tasks, simple edits"
    }
  },

  "factory": {
    "reasoning": {
      "model": "heavy"
    },
    "coding": {
      "model": "medium"
    },
    "efficiency": {
      "model": "light"
    }
  },

  "openai": {
    "reasoning": {
      "model": "gpt-5"
    },
    "coding": {
      "model": "gpt-5-codex"
    },
    "efficiency": {
      "model": "gpt-5-codex"
    }
  },

  "shorthand": {
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5",
    "inherit": "inherit"
  }
}
```

## Model Roles

AIWG classifies both the legacy aliases and pinned or provider-qualified
Claude-family identifiers consistently:

| Canonical family | Role | Recognized examples |
|---|---|---|
| Opus | reasoning | `opus`, `claude-opus-5`, `anthropic/claude-opus-5` |
| Sonnet | coding | `sonnet`, `claude-sonnet-5`, `anthropic/claude-sonnet-5` |
| Haiku | efficiency | `haiku`, `claude-haiku-4-5`, `anthropic/claude-haiku-4-5` |

An explicit identifier outside a recognized family remains `unknown`. Role
filters do not silently include it in the coding population, and provider
transforms preserve it instead of rewriting it as a coding model. Omitted model
metadata retains the legacy coding default during deployment.

Claude deployments compile bare aliases by default. A source agent that says
`model: sonnet` deploys to `.claude/agents/` as `model: claude-sonnet-5` (the
`claude.coding.model` tier in `models.json`; `opus` → `claude-opus-5`,
`haiku` → `claude-haiku-4-5`). A bare alias would otherwise inherit the parent
session's variant, and under a 1M-context parent every subagent dispatch then
hits the usage-credit gate (#1442, #2563). Source frontmatter stays
provider-neutral; already-pinned ids, `inherit`, and explicit `sonnet[1m]` /
`opus[1m]` opt-ins are deployed unchanged, and `--coding-model` /
`--reasoning-model` / `--efficiency-model` overrides still win.

## Provider compilation examples

Codex agents compile to standalone `.codex/agents/*.toml` files. Every file has
the required `name`, `description`, and `developer_instructions` fields; native
model controls use `model` and `model_reasoning_effort`. Codex skills have no
documented per-skill model field, so AIWG reports that policy as `unsupported`
and does not emit a pretend pin.

Warp and Hermes can apply run-wide or global delegation policy but cannot
enforce heterogeneous per-agent files. Their per-agent result is
`global-only`. Windsurf currently has no supported portable child selector, so
its per-agent result is `unsupported`.

`aiwg doctor --provider <name>` reports canonical agent counts and the target
surface separately. It does not describe skills as pinned when the provider
cannot enforce skill-local model selection.

## Model management CLI

Use the typed `aiwg models` command family to inspect effective policy before
changing canonical files:

```bash
aiwg models audit --provider codex --json
aiwg models resolve --skill address-issues --provider claude
aiwg models set --agent test-engineer --tier economy --dry-run --json
aiwg models set --glob '*-reviewer' --tier standard
aiwg models set-default economy --scope project
aiwg models validate
aiwg models migrate --all --dry-run
```

Selectors support exact agents/skills, globs, role, current tier, framework,
provider compilation, and `--all`. Project configuration resolves under
`--target/models.json`; user defaults resolve under
`~/.config/aiwg/models.json`. Writes use
same-directory temporary files and atomic rename, preserve unrelated JSON or
frontmatter content, and validate the full requested change set before writing.

Skill policy lives under `commandHint` as `modelRole`, `modelTier`, and optional
`modelEffort`; premium policy also requires `modelRationale`. During migration,
legacy `commandHint.model` remains readable:
`opus` maps to reasoning/premium, `sonnet` to coding/standard, and `haiku` to
efficiency/economy. Claude deployment compiles requested skill intent to its
native turn-scoped fields. Other providers retain canonical intent but only
report the capability outcome; they do not receive a fabricated native pin.

Canonical agents use `model-role`, `model-tier`, and, for premium defaults,
`model-rationale`. Economy is the corpus default. Premium is an allowlisted
exception whose rationale names the quality or risk reason. The compatibility
`model` aliases remain for one migration window and must not contain pinned
provider IDs.

### Reasoning (opus)
**Use for:** Complex analysis, critical decisions, strategic planning

**Agents using this role:**
- architecture-designer
- requirements-analyst
- security-architect
- executive-orchestrator
- system-analyst

### Coding (sonnet)
**Use for:** Code generation, implementation, debugging, code review

**Agents using this role:**
- software-implementer
- code-reviewer
- devops-engineer
- test-engineer
- debugger

### Efficiency (haiku)
**Use for:** Quick tasks, file operations, simple edits, summaries

**Agents using this role:**
- documentation-synthesizer
- technical-writer
- configuration-manager

## Customization Examples

### Example 1: Use Latest Models

Create `models.json` in your project root:

```json
{
  "factory": {
    "reasoning": { "model": "claude-opus-4-2" },
    "coding": { "model": "claude-sonnet-5-0" },
    "efficiency": { "model": "claude-haiku-4-0" }
  },
  "shorthand": {
    "opus": "claude-opus-4-2",
    "sonnet": "claude-sonnet-5-0",
    "haiku": "claude-haiku-4-0"
  }
}
```

### Example 2: Use Same Model for Everything

```json
{
  "factory": {
    "reasoning": { "model": "claude-sonnet-5" },
    "coding": { "model": "claude-sonnet-5" },
    "efficiency": { "model": "claude-sonnet-5" }
  }
}
```

### Example 3: Custom Model for Specific Tasks

```json
{
  "factory": {
    "reasoning": { "model": "claude-opus-custom-finetuned" },
    "coding": { "model": "claude-sonnet-5" },
    "efficiency": { "model": "claude-haiku-4-5" }
  }
}
```

### Example 4: OpenAI Models

```json
{
  "openai": {
    "reasoning": { "model": "gpt-5-preview" },
    "coding": { "model": "gpt-5-codex-preview" },
    "efficiency": { "model": "gpt-5-codex" }
  }
}
```

## User-Level Configuration

To set models for all your projects, create a user-level config:

```bash
# Create config directory
mkdir -p ~/.config/aiwg

# Create user models.json
cat > ~/.config/aiwg/models.json <<'EOF'
{
  "factory": {
    "reasoning": { "model": "claude-opus-5" },
    "coding": { "model": "claude-sonnet-5" },
    "efficiency": { "model": "claude-haiku-4-5" }
  },
  "shorthand": {
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5"
  }
}
EOF
```

## Project-Level Configuration

To override models for a specific project:

```bash
cd /path/to/project

# Create project models.json
cat > models.json <<'EOF'
{
  "factory": {
    "reasoning": { "model": "my-custom-reasoning-model" },
    "coding": { "model": "my-custom-coding-model" },
    "efficiency": { "model": "my-custom-efficiency-model" }
  }
}
EOF

# Deploy with project-specific models
aiwg use sdlc --provider factory
```

## Command-Line Overrides

You can override models on the command line (takes precedence over config files):

```bash
# Override all model tiers
aiwg use sdlc --reasoning-model opus-4-2 --coding-model sonnet-5 --efficiency-model haiku-4

# Override just the reasoning tier
aiwg use sdlc --reasoning-model claude-opus-4-2

# Override and save for future deployments
aiwg use sdlc --reasoning-model opus-4-2 --save
```

### Selective Deployment with Filters

Apply model changes to specific agents using filters:

```bash
# Only update architect agents
aiwg use sdlc --filter "*architect*" --reasoning-model opus-4-2

# Only update reasoning-tier agents
aiwg use sdlc --filter-role reasoning --reasoning-model custom-reasoning

# Only update coding-tier agents
aiwg use sdlc --filter-role coding --coding-model sonnet-5
```

### Persisting Model Selection

Save your model choices for future deployments:

```bash
# Save to project models.json (version control this for team consistency)
aiwg use sdlc --reasoning-model opus-4-2 --save

# Save to user-level config (personal preference across all projects)
aiwg use sdlc --reasoning-model opus-4-2 --save-user
```

### Preview Changes

Use `--dry-run` to see what would be deployed without making changes:

```bash
aiwg use sdlc --reasoning-model opus-4-2 --filter "*architect*" --dry-run
```

## Precedence Order

When deploying agents, models are determined in this order (highest to lowest priority):

1. **Command-line flags** (`--reasoning-model`, `--coding-model`, `--efficiency-model`)
2. **Project `models.json`** (in current directory)
3. **User `~/.config/aiwg/models.json`**
4. **AIWG defaults** (`agentic/code/frameworks/sdlc-complete/config/models.json`)
5. **Hardcoded fallbacks** (in deploy script)

## Verifying Configuration

To see which model configuration is being used:

```bash
# Deploy with verbose output
aiwg use sdlc --provider factory

# Look for line:
# Model config loaded from: <source>
```

The source will indicate which configuration file was used:
- `project (./models.json)`
- `user (~/.config/aiwg/models.json)`
- `AIWG defaults (...)`

## Updating Models

### Updating AIWG Defaults

To update the default models for all users:

1. Edit `agentic/code/frameworks/sdlc-complete/config/models.json`
2. Update model identifiers
3. Commit and push changes
4. Users run `aiwg -update` to get latest defaults

### Updating Project Models

```bash
# Edit project models.json
vim models.json

# Redeploy
aiwg use sdlc --provider factory --force
```

### Updating User Models

```bash
# Edit user models.json
vim ~/.config/aiwg/models.json

# Redeploy in any project
cd /path/to/project
aiwg use sdlc --provider factory --force
```

## Troubleshooting

### Config File Not Loaded

**Symptom:** Models.json exists but isn't being used

**Solution:**
1. Check file format (must be valid JSON)
2. Verify file location (use absolute paths to debug)
3. Check permissions (file must be readable)

**Validation:**
```bash
# Check JSON syntax
jq . models.json

# If error, fix JSON formatting
```

### Wrong Models Being Used

**Symptom:** Different models deployed than expected

**Solution:**
1. Check precedence order (command-line > project > user > defaults)
2. Verify model configuration with `--dry-run`:
```bash
aiwg use sdlc --provider factory --dry-run
```

### Model Not Available

**Symptom:** Deployment fails with "model not found"

**Solution:**
1. Verify model identifier is correct for your platform
2. Check API access/permissions
3. Use a known working model for testing

## Best Practices

1. **Use project-level configs for production** - Check into version control
2. **Use user-level configs for development** - Personal preferences
3. **Document model choices** - Add comments in `_comments` section
4. **Test model changes** - Use `--dry-run` before deploying
5. **Version model configs** - Tag when changing models significantly

## Schema Validation

The configuration file includes a JSON schema reference for validation. To validate:

```bash
# Using ajv-cli
npm install -g ajv-cli
ajv validate -s models.schema.json -d models.json

# Using jq (basic check)
jq empty models.json && echo "Valid JSON" || echo "Invalid JSON"
```

## See Also

- [Factory AI Quick Start](#integrations-factory)
- [CLI Reference](#ref-cli)
