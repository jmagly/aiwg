---
namespace: aiwg
name: aiwg-update-agents-md
platforms: [all]
description: Update AGENTS.md with project-specific context for Factory AI based on codebase analysis
commandHint:
  argumentHint: '[project-directory] [--provider factory --interactive --guidance "text"]'
  allowedTools: 'Read, Write, Edit, Glob, Grep, Bash, TodoWrite'
  model: haiku
  category: sdlc-setup
  modelRole: efficiency
  modelTier: economy
---

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills, **not slash commands**. Most are not kernel-listed and cannot be invoked as `/skill-name` by the platform. Reach them via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name>
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `steward`) are directly invokable as slash commands. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# AIWG Update AGENTS.md

You are a Technical Documentation Specialist responsible for updating AGENTS.md files with project-specific context and AIWG framework integration for Factory AI.

## Your Task

When invoked with `/aiwg-update-agents-md [project-directory] [--provider factory]` (Factory AI) or `/aiwg-update-agents-md [project-directory]` (Claude Code):

1. **Analyze** the project codebase structure
2. **Detect** build/test commands from package.json, Makefile, or scripts
3. **Identify** architecture patterns and conventions
4. **Read** existing AGENTS.md (if present) to preserve user content
5. **Update** AGENTS.md with project-specific commands and AIWG context
6. **Validate** the updated AGENTS.md is complete

## Important Context

This command is specifically designed for **Factory AI** users. It creates or updates AGENTS.md to include:
- Project-specific build/test/run commands (analyzed from codebase)
- AIWG SDLC Framework integration section
- Factory droid usage examples
- Multi-agent workflow patterns

For Claude Code users, use `aiwg-update-claude` instead (note the `/` prefix for Claude Code).

## Execution Steps

### Step 1: Analyze Codebase

**Detect Project Type and Commands**:

```bash
PROJECT_DIR="${1:-.}"
cd "$PROJECT_DIR"

# Check for package.json (Node.js/TypeScript)
if [ -f "package.json" ]; then
  PROJECT_TYPE="node"
  # Extract common scripts
  SCRIPTS=$(node -pe "JSON.parse(fs.readFileSync('package.json')).scripts" 2>/dev/null || echo "{}")
fi

# Check for Makefile
if [ -f "Makefile" ]; then
  PROJECT_TYPE="${PROJECT_TYPE}-make"
fi

# Check for Python (requirements.txt, pyproject.toml, setup.py)
if [ -f "requirements.txt" ] || [ -f "pyproject.toml" ] || [ -f "setup.py" ]; then
  PROJECT_TYPE="${PROJECT_TYPE}-python"
fi

# Check for Go (go.mod)
if [ -f "go.mod" ]; then
  PROJECT_TYPE="go"
fi

# Check for Rust (Cargo.toml)
if [ -f "Cargo.toml" ]; then
  PROJECT_TYPE="rust"
fi
```

Use Bash tool to detect project type.

**Extract Build Commands**:

For Node.js projects, read package.json and extract critical scripts:
- `test` - Test command
- `build` - Build command  
- `lint` - Linting command
- `dev` or `start` - Development server
- `coverage` or `test:coverage` - Coverage command

Use Read tool to read package.json, then parse scripts.

**Example extraction**:
```json
{
  "scripts": {
    "test": "jest",
    "build": "tsc",
    "lint": "eslint src/",
    "dev": "tsx watch src/index.ts",
    "test:coverage": "jest --coverage"
  }
}
```

### Step 2: Detect Architecture Patterns

**Scan project structure** to identify:

1. **Source directory** (`src/`, `lib/`, `app/`)
2. **Test directory** (`tests/`, `test/`, `__tests__/`)
3. **Configuration files** (`.env`, `config/`)
4. **Documentation** (`docs/`, `README.md`)

Use Glob tool to scan directories.

**Identify patterns**:
- Monorepo (Nx, Turborepo, Lerna)
- Microservices (multiple services/)
- Monolith (single src/)
- Frontend/Backend split
- Full-stack (client/ + server/)

Use Grep tool to search for framework-specific patterns:
- React: Search for `import React` or `from 'react'`
- Vue: Search for `<template>` or `vue`
- Express: Search for `express()` or `from 'express'`
- FastAPI: Search for `FastAPI` or `from fastapi`
- Django: Search for `django` imports

### Step 3: Read Existing AGENTS.md (If Present)

Check if AGENTS.md already exists:

```bash
AGENTS_MD="$PROJECT_DIR/AGENTS.md"

if [ -f "$AGENTS_MD" ]; then
  echo "Found existing AGENTS.md"
  EXISTING_CONTENT=$(cat "$AGENTS_MD")
  
  # Check if it already has AIWG section
  if echo "$EXISTING_CONTENT" | grep -q "AIWG SDLC Framework"; then
    echo "⚠️  AGENTS.md already contains AIWG section"
    HAS_AIWG=true
  else
    echo "No AIWG section found, will append"
    HAS_AIWG=false
  fi
else
  echo "No existing AGENTS.md, will create from scratch"
  EXISTING_CONTENT=""
  HAS_AIWG=false
fi
```

Use Read tool to read existing AGENTS.md, Grep to detect AIWG section.

### Step 4: Generate Project-Specific Commands Section

**IMPORTANT:** Keep project-specific content concise (≤75 lines) to maintain total AGENTS.md ≤150 lines (75/75 split).

Based on codebase analysis, generate the project commands section:

**For Node.js/TypeScript projects**:

```markdown
## Project Commands

```bash
npm test              # Run tests
npm run build         # Build project
npm run lint          # Lint code
npm run dev           # Development server
```
```

**For Python projects**:

```markdown
## Project Commands

```bash
pytest                # Run tests
pip install -r requirements.txt  # Install deps
python -m uvicorn app.main:app --reload  # Dev server
```
```

**For Multi-language projects** (like IntelCC):

```markdown
## Project Commands

```bash
# TypeScript
npm test && npm run build

# Python
python -m pytest agents/tests/

# System
npm run all           # Start services
npm run pm2:status    # Check status
```
```

### Step 5: Generate Architecture Overview Section (Optional - Only if Critical)

**Keep minimal** (3-5 lines max). Only include if architecture is non-standard.

```markdown
## Architecture

{Pattern}: {src_dir}/, {test_dir}/  
{Tech}: {Framework} + {Database} + {Infrastructure}
```

**Example:**
```markdown
## Architecture

Monorepo: packages/api, packages/web  
Tech: React + Express + PostgreSQL + Docker
```

### Step 6: Generate Conventions Section (Optional - Only if Critical)

**Keep minimal** (3-5 lines max). Only include unusual patterns.

```markdown
## Development Notes

- {Critical constraint or pattern}
- {Important gotcha}
```

**Example:**
```markdown
## Development Notes

- npm test requires CI=true environment variable
- Coverage target: 85% (current: 43%)
```

### Step 7: Load AIWG Template Section

Read the Factory AGENTS.md template:

```bash
FACTORY_TEMPLATE="$AIWG_PATH/agentic/code/frameworks/sdlc-complete/templates/factory/AGENTS.md.aiwg-template"
```

Use Read tool to load the AIWG section (everything after "<!-- AIWG SDLC Framework Integration -->").

### Step 8: Merge and Write

**Scenario A: No existing AGENTS.md** (Create new)

```markdown
# AGENTS.md

> Factory AI configuration and AIWG SDLC framework integration

{Project-specific content generated from codebase analysis}

---

<!-- AIWG SDLC Framework Integration -->

{AIWG template section}
```

**Scenario B: Existing AGENTS.md WITHOUT AIWG** (Append)

```markdown
{Existing user content - preserved}

---

<!-- AIWG SDLC Framework Integration -->

{AIWG template section}
```

**Scenario C: Existing AGENTS.md WITH AIWG** (Update AIWG section only)

Preserve user content above AIWG marker, replace AIWG section with updated template.

Use Edit tool for clean replacement.

### Step 9: Validate and Report

```bash
echo ""
echo "======================================================================="
echo "AGENTS.md Update Summary"
echo "======================================================================="
echo ""
echo "Project: $PROJECT_DIR"
echo "Type: $PROJECT_TYPE"
echo "AIWG Path: $AIWG_PATH"
echo ""
echo "✓ Commands section: {X commands detected}"
echo "✓ Architecture: {Pattern} detected"
echo "✓ Tech stack: {Detected technologies}"
echo "✓ AIWG section: {Created/Updated/Preserved}"
echo ""
echo "Next steps:"
echo "  1. Review AGENTS.md and customize project-specific sections"
echo "  2. Deploy Factory droids: aiwg -deploy-agents --provider factory --mode sdlc"
echo "  3. Run intake: /intake-wizard 'your project description'"
echo ""
```

## Enhanced Analysis for Project-Specific Content

### Detect Security Requirements

```bash
# Check for security-related dependencies
if grep -q "helmet\|cors\|bcrypt\|jsonwebtoken" package.json 2>/dev/null; then
  echo "Security libraries detected - add security section to AGENTS.md"
fi

# Check for .env files
if [ -f ".env.example" ] || [ -f ".env.template" ]; then
  echo "Environment variables detected - add secrets management note"
fi
```

### Detect Database

```bash
# Check for database libraries
if grep -q "mongoose\|sequelize\|typeorm\|prisma" package.json 2>/dev/null; then
  DB_TYPE="MongoDB/SQL"
elif grep -q "pg\|postgres" package.json 2>/dev/null; then
  DB_TYPE="PostgreSQL"
elif grep -q "mysql" package.json 2>/dev/null; then
  DB_TYPE="MySQL"
elif grep -q "sqlite" package.json 2>/dev/null; then
  DB_TYPE="SQLite"
fi

if [ -n "$DB_TYPE" ]; then
  echo "Database: $DB_TYPE detected"
fi
```

### Detect Testing Framework

```bash
# Check testing frameworks
if grep -q "jest" package.json 2>/dev/null; then
  TEST_FRAMEWORK="Jest"
  TEST_CONFIG="jest.config.js"
elif grep -q "vitest" package.json 2>/dev/null; then
  TEST_FRAMEWORK="Vitest"
  TEST_CONFIG="vitest.config.ts"
elif grep -q "pytest" requirements.txt 2>/dev/null; then
  TEST_FRAMEWORK="Pytest"
  TEST_CONFIG="pytest.ini"
fi
```

### Detect CI/CD

```bash
# Check for CI/CD configuration
if [ -d ".github/workflows" ]; then
  CI_PROVIDER="GitHub Actions"
elif [ -f ".gitlab-ci.yml" ]; then
  CI_PROVIDER="GitLab CI"
elif [ -f ".travis.yml" ]; then
  CI_PROVIDER="Travis CI"
elif [ -f "circle.yml" ] || [ -d ".circleci" ]; then
  CI_PROVIDER="CircleCI"
fi
```

## Output Format

**Target:** ≤150 total lines (≤75 project-specific + ~75 AIWG section)

The generated AGENTS.md should follow this minimal structure:

```markdown
# {Project Name}

> {One-line project description}

## Project Commands

```bash
{Top 5-8 critical commands only}
```

## Architecture (Optional - if non-standard)

{Pattern}: {directories}  
{Tech}: {Stack summary}

## Development Notes (Optional - if critical gotchas)

- {Critical constraint or gotcha}
- {Important pattern}

---

<!-- AIWG SDLC Framework Integration -->

## AIWG SDLC Framework

{Full AIWG template section from factory/AGENTS.md.aiwg-template - ~75 lines}
```

**Keep balanced:** Aim for ~75 lines of project-specific content + ~75 lines AIWG section = ≤150 total.

## Success Criteria

- [ ] Codebase analyzed successfully
- [ ] Build/test commands extracted
- [ ] Architecture pattern detected
- [ ] Project-specific AGENTS.md sections generated
- [ ] Existing AGENTS.md content preserved (if applicable)
- [ ] AIWG framework section added/updated
- [ ] .aiwg/ directory structure created
- [ ] Validation checks passed
- [ ] User informed of next steps

## Example Output (IntelCC Project)

```markdown
# IntelCC - Dual Trading Platform

> Intelligent crypto trading system combining DEX trading with Prediction Market copy-trading

## Core Commands

System Management:
- Start all services: `npm run all`
- Check status: `npm run pm2:status`
- Stop services: `./start-system.sh stop`

Development & Testing:
- Build: `npm run build`
- Test suite: `npm test` (requires CI=true env var)
- Test with coverage: `npm run test:coverage`
- Lint: `npm run lint`
- Fix lint: `npm run lint:fix`

TypeScript Services:
- DEX trading dev: `npm run dex:dev`
- PM trading dev: `npm run pm:dev`

Python Agents:
- Start agents: `npm run agents:start`
- Run tests: `python -m pytest agents/tests/`

## Project Layout

- `src/` - TypeScript services (DEX + PM trading)
- `agents/` - Python CrewAI agents
- `tests/` - TypeScript test suites
- `.aiwg/` - SDLC artifacts

## Development Patterns & Constraints

Code Style:
- TypeScript strict mode enforced
- ESLint configuration active
- Avoid `any` types (document exceptions)
- Mock all external APIs in tests

Testing:
- Jest for TypeScript (907/981 tests passing)
- Pytest for Python agents
- Coverage target: 85% (current: 43.64%)
- CI=true required for npm test commands

Architecture:
- Python agents: Signal analysis ONLY
- TypeScript: ALL market execution
- GRPC bridge: Only Python ↔ TypeScript communication
- No mixing: DEX and PM code paths separate

## Architecture Overview

Dual system architecture with isolated DEX and PM trading systems:

- **DEX Trading**: Pancakeswap/Uniswap on Base L2
- **PM Trading**: Polymarket/Kalshi copy-trading
- **Python Agents**: CrewAI pipeline for signal analysis (gRPC port 50052)
- **TypeScript Services**: Trade execution and risk management

## Security

- Passphrase-protected wallets (AES-256-GCM encryption)
- Certificate pinning enabled (Base mainnet RPC)
- Environment separation (.env.dex, .env.pm, agents/.env)
- Zero HIGH/CRITICAL vulnerabilities (security score: 92/100)

## Git Workflow Essentials

1. Default branch: `main`
2. Commit format: Conventional commits (`feat:`, `fix:`, `docs:`)
3. Pre-commit: Run `npm run lint` before committing
4. Pull requests: Must pass tests and maintain coverage

## External Services

- **RPC Providers**: Validation Cloud (Base L2, Ethereum)
- **Market Data**: Polymarket CLOB, Kalshi API
- **AI Agents**: Chutes.ai (Python agents)
- **Monitoring**: Prometheus + Grafana (ports 9090, 3001)

---

<!-- AIWG SDLC Framework Integration -->

## AIWG SDLC Framework

{Full AIWG template content}
```

## Edge Cases

### Empty or Minimal Project

If project has no package.json, Makefile, or detectable structure:

```markdown
## Core Commands

```bash
# Add your build/test commands here
# Example:
# npm test
# npm run build
# npm run lint
```
```

Then append standard AIWG section.

### Already Has Comprehensive AGENTS.md

If existing AGENTS.md has extensive project-specific content (>200 lines):
- Preserve ALL user content
- Only append AIWG section if not present
- Log: "Existing AGENTS.md is comprehensive, appending AIWG section only"

### Multi-Module Project

For monorepos or multi-module projects:

```markdown
## Project Layout

Monorepo structure:
- `packages/api/` - Backend API service
- `packages/web/` - Frontend web app
- `packages/shared/` - Shared utilities

## Core Commands

API:
- `npm run dev --workspace=api`
- `npm test --workspace=api`

Web:
- `npm run dev --workspace=web`
- `npm test --workspace=web`

All:
- `npm run build` (builds all packages)
- `npm test` (runs all tests)
```

## Integration with Intake Process

This command should be called automatically at the end of:
- `intake-wizard` (after intake forms generated)
- `intake-from-codebase` (after analyzing existing code)
- `intake-start` (after validating intake)

**Trigger condition**: If `--provider factory` is detected or `.factory/droids/` directory exists.

**Call pattern**:

```text
# At end of intake-wizard workflow:
1. Generate intake forms in .aiwg/intake/
2. Detect provider (check for .factory/droids/)
3. If Factory detected:
   → Call /aiwg-update-agents-md
   → Generate project-specific AGENTS.md
   → Log: "✓ Updated AGENTS.md with project commands and AIWG context"
```

## Provider Detection Logic

```bash
# Check for Factory droids
if [ -d ".factory/droids" ]; then
  PROVIDER="factory"
  echo "Factory AI detected (.factory/droids/ exists)"
  
# Check for Claude agents
elif [ -d ".claude/agents" ]; then
  PROVIDER="claude"
  echo "Claude Code detected (.claude/agents/ exists)"
  
# Check for OpenAI/Codex
elif [ -d ".codex/agents" ]; then
  PROVIDER="openai"
  echo "OpenAI/Codex detected (.codex/agents/ exists)"
  
# No provider detected
else
  PROVIDER="unknown"
  echo "No AI platform detected"
fi
```

## Best Practices

1. **Always preserve user content** - Never overwrite project-specific notes
2. **Detect before assuming** - Scan codebase rather than using defaults
3. **Be specific** - Extract actual commands from package.json, not generic examples
4. **Include gotchas** - If project has unique quirks (like IntelCC's CI=true requirement), document them
5. **Link to resources** - Reference README, docs/, or other project documentation
6. **Keep it concise** - Aim for ≤200 lines project-specific content (AIWG section is separate)

## Success Indicators

```bash
echo ""
echo "✓ AGENTS.md updated successfully"
echo "✓ Project commands: {X} detected"
echo "✓ Architecture: {Pattern} identified"
echo "✓ Tech stack: {Technologies} documented"
echo "✓ AIWG framework: {Created/Updated}"
echo ""
echo "Next steps:"
echo "  1. Review AGENTS.md and customize if needed"
echo "  2. Verify droids deployed: ls .factory/droids/ (should show 54 files)"
echo "  3. Start building: /intake-wizard or /intake-from-codebase"
echo ""
```

## Error Handling

### AIWG Template Not Found

```bash
if [ ! -f "$FACTORY_TEMPLATE" ]; then
  echo "❌ Error: Factory AGENTS.md template not found"
  echo "   Expected: $FACTORY_TEMPLATE"
  echo ""
  echo "Please ensure AIWG is installed correctly:"
  echo "  ls ~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/templates/factory/"
  echo ""
  echo "Or redeploy templates:"
  echo "  aiwg -reinstall"
  exit 1
fi
```

### Cannot Parse package.json

```bash
if [ -f "package.json" ]; then
  if ! node -pe "JSON.parse(fs.readFileSync('package.json'))" >/dev/null 2>&1; then
    echo "⚠️  Warning: package.json exists but cannot be parsed"
    echo "   Using default Node.js commands"
    USE_DEFAULTS=true
  fi
fi
```

### Permission Denied

```bash
if [ ! -w "$PROJECT_DIR" ]; then
  echo "❌ Error: Cannot write to $PROJECT_DIR"
  echo "   Check permissions: ls -la $PROJECT_DIR"
  exit 1
fi
```

## Integration Pattern

This command is designed to be called by other AIWG commands:

**From intake-wizard.md**:
```markdown
# At end of workflow (after generating intake forms):

# Step 10: Update AGENTS.md for Factory users
if [ -d ".factory/droids" ] || [ "$PROVIDER" = "factory" ]; then
  echo ""
  echo "Detected Factory AI - updating AGENTS.md..."
  /aiwg-update-agents-md .
fi
```

**From intake-from-codebase.md**:
```markdown
# At end of workflow (after analyzing codebase):

# Step 12: Update AGENTS.md for Factory users
if [ -d ".factory/droids" ] || [ "$PROVIDER" = "factory" ]; then
  echo ""
  echo "Updating AGENTS.md with codebase analysis..."
  /aiwg-update-agents-md .
fi
```

**From aiwg-setup-project.md**:
```markdown
# At end of workflow (after updating CLAUDE.md):

# For Factory users, also update AGENTS.md
if [ -d ".factory/droids" ]; then
  echo ""
  echo "Factory AI detected - updating AGENTS.md..."
  /aiwg-update-agents-md .
fi
```

## Manual Invocation

Users can also call this directly:

**Factory AI:**
```bash
# Update AGENTS.md for current project
/aiwg-update-agents-md

# Update for specific project
/aiwg-update-agents-md /path/to/project

# Force update even if AIWG section exists
/aiwg-update-agents-md . --force
```

**Claude Code:**
```bash
# Update AGENTS.md for current project
/aiwg-update-agents-md

# Update for specific project
/aiwg-update-agents-md /path/to/project
```

## Summary

This command intelligently updates AGENTS.md for Factory AI users by:
1. Analyzing the codebase to detect commands, patterns, and conventions
2. Generating project-specific documentation sections
3. Appending or updating AIWG SDLC framework integration
4. Preserving all existing user content
5. Providing next steps and validation

The result is a comprehensive, project-specific AGENTS.md that combines the user's project documentation with AIWG's SDLC framework capabilities.

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/agent-deployment.md — Rules for working with agent definitions and multi-provider deployment
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — Seek explicit authorization before overwriting existing AGENTS.md content
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Analyze codebase before generating project-specific commands section
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/aiwg-setup-project/SKILL.md — Analogous Claude Code setup skill; calls this skill when Factory AI is detected
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/aiwg-update-claude/SKILL.md — Parallel update skill for Claude Code's CLAUDE.md configuration

