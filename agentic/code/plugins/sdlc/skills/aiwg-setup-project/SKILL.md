---
namespace: aiwg
name: aiwg-setup-project
platforms: [all]
description: Update project CLAUDE.md with AIWG framework context and configuration
commandHint:
  argumentHint: [project-directory --interactive --guidance "text"]
  allowedTools: Read, Write, Edit, Glob, Bash
  model: haiku
  category: sdlc-setup
  modelRole: efficiency
  modelTier: economy
---

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills first. Most are not kernel-listed and cannot be invoked as `/skill-name` by every platform. Reach them portably via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name>
> ```
>
> Claude Code deployments also mirror selected operator workflows into `.claude/commands/`; this skill is available there as `/aiwg-setup-project`. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# AIWG Setup Project

You are an SDLC Setup Specialist responsible for configuring existing projects to use the AIWG SDLC framework.

## Your Task

When invoked with `/aiwg-setup-project [project-directory]`:

1. **Detect** AIWG installation path
2. **Read** existing project CLAUDE.md (if present)
3. **Preserve** all user-specific notes, rules, and configuration
4. **Add or update** AIWG framework section with orchestration guidance
5. **Create** .aiwg/ directory structure if needed
6. **Validate** setup is complete

## Important Context

This command is designed for **existing projects** that want to adopt the AIWG SDLC framework. For **new projects**, use `aiwg -new` instead.

**Key differences**:
- `aiwg -new`: Creates fresh project scaffold with CLAUDE.md template
- `aiwg-setup-project`: Updates existing CLAUDE.md while preserving user content

## Execution Steps

### Step 1: Resolve AIWG Installation Path

Detect where AIWG is installed using standard resolution:

```bash
# Priority order:
# 1. Environment variable: $AIWG_ROOT
# 2. User install: ~/.local/share/ai-writing-guide
# 3. System install: /usr/local/share/ai-writing-guide
# 4. Git repo (dev): <current-repo-root>
```

**Implementation**:

```bash
# Try environment variable first
if [ -n "$AIWG_ROOT" ] && [ -d "$AIWG_ROOT/agentic/code/frameworks/sdlc-complete" ]; then
  AIWG_PATH="$AIWG_ROOT"
# Try standard user install
elif [ -d "$HOME/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete" ]; then
  AIWG_PATH="$HOME/.local/share/ai-writing-guide"
# Try system install
elif [ -d "/usr/local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete" ]; then
  AIWG_PATH="/usr/local/share/ai-writing-guide"
# Fallback: not found
else
  echo "❌ Error: AIWG installation not found"
  echo ""
  echo "Please install AIWG first:"
  echo "  curl -fsSL https://raw.githubusercontent.com/jmagly/ai-writing-guide/refs/heads/main/tools/install/install.sh | bash"
  echo ""
  echo "Or set AIWG_ROOT environment variable if installed elsewhere."
  exit 1
fi
```

Use Bash tool to resolve the path, then store result.

### Step 2: Check Existing CLAUDE.md

Detect if project already has CLAUDE.md and whether it contains AIWG section:

```bash
PROJECT_DIR="${1:-.}"  # Default to current directory
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
```

**Three scenarios**:

1. **No CLAUDE.md** → Copy template directly
2. **CLAUDE.md exists, no AIWG section** → Append AIWG section
3. **CLAUDE.md exists with AIWG section** → Update AIWG section in place

Use Read tool to check file, grep to detect AIWG section.

### Step 3: Load AIWG Template

Read the AIWG CLAUDE.md template:

```bash
TEMPLATE_PATH="$AIWG_PATH/agentic/code/frameworks/sdlc-complete/templates/project/CLAUDE.md"
```

Use Read tool to load template content.

**Template contains**:
- Repository Purpose (placeholder for user)
- **AIWG Framework Overview** (lines 11-62)
- **Core Platform Orchestrator Role** (lines 64-165) ← Critical for orchestration
- **Natural Language Command Translation** (lines 167-210)
- **Available Commands Reference** (lines 233-282)
- **AIWG-Specific Rules** (lines 305-313)
- **Reference Documentation** (lines 315-323)
- **Phase Overview** (lines 325-365)
- **Quick Start** (lines 367-399)
- **Common Patterns** (lines 401-441)
- **Troubleshooting** (lines 443-468)
- **Resources** (lines 470-482)
- **Project-Specific Notes** (placeholder for user) (lines 485-488)

### Step 4: Merge Strategy

**Scenario 1: No existing CLAUDE.md**

```python
# Pseudo-code
template_content = read(TEMPLATE_PATH)
final_content = template_content.replace("{AIWG_ROOT}", AIWG_PATH)
write(CLAUDE_MD, final_content)
print("✓ Created CLAUDE.md from AIWG template")
print("⚠️  Please fill in 'Repository Purpose' section")
```

**Scenario 2: CLAUDE.md exists, no AIWG section**

```python
# Pseudo-code
existing_content = read(CLAUDE_MD)
template_content = read(TEMPLATE_PATH)

# Extract AIWG section from template (starts at line 11: "## AIWG")
aiwg_section = extract_from_line(template_content, "## AIWG")
aiwg_section = aiwg_section.replace("{AIWG_ROOT}", AIWG_PATH)

# Append to existing CLAUDE.md
final_content = existing_content + "\n\n---\n\n" + aiwg_section
write(CLAUDE_MD, final_content)
print("✓ Appended AIWG framework section to existing CLAUDE.md")
print("✓ All existing content preserved")
```

**Scenario 3: CLAUDE.md exists with AIWG section**

```python
# Pseudo-code
existing_content = read(CLAUDE_MD)
template_content = read(TEMPLATE_PATH)

# Find existing AIWG section boundaries
aiwg_start = find_line(existing_content, r"^## AIWG")
aiwg_end = find_next_major_section_or_eof(existing_content, aiwg_start)

# Extract new AIWG section from template
new_aiwg_section = extract_from_line(template_content, "## AIWG")
new_aiwg_section = new_aiwg_section.replace("{AIWG_ROOT}", AIWG_PATH)

# Replace old AIWG section with new
before_aiwg = existing_content[:aiwg_start]
after_aiwg = existing_content[aiwg_end:]
final_content = before_aiwg + new_aiwg_section + after_aiwg

write(CLAUDE_MD, final_content)
print("✓ Updated AIWG framework section in existing CLAUDE.md")
print("✓ All user content preserved")
```

**CRITICAL**: Use Edit tool for Scenario 3 to ensure clean replacement.

### Step 5: Create .aiwg/ Directory Structure

Ensure artifact directories exist:

```bash
mkdir -p "$PROJECT_DIR/.aiwg"/{intake,requirements,architecture,planning,risks,testing,security,quality,deployment,team,working,reports,handoffs,gates,decisions}
```

Use Bash tool to create directories.

### Step 6: Validate Setup

Run validation checks:

```bash
echo ""
echo "======================================================================="
echo "AIWG Setup Validation"
echo "======================================================================="
echo ""

# Check 1: AIWG installation accessible
if [ -d "$AIWG_PATH/agentic/code/frameworks/sdlc-complete" ]; then
  echo "✓ AIWG installation: $AIWG_PATH"
else
  echo "❌ AIWG installation not accessible"
fi

# Check 2: CLAUDE.md updated
if [ -f "$CLAUDE_MD" ]; then
  if grep -q "## AIWG" "$CLAUDE_MD"; then
    echo "✓ CLAUDE.md has AIWG section"
  else
    echo "❌ CLAUDE.md missing AIWG section"
  fi
else
  echo "❌ CLAUDE.md not found"
fi

# Check 3: Template accessible
if [ -d "$AIWG_PATH/agentic/code/frameworks/sdlc-complete/templates" ]; then
  echo "✓ AIWG templates accessible"
else
  echo "❌ AIWG templates not found"
fi

# Check 4: .aiwg directory structure
if [ -d "$PROJECT_DIR/.aiwg/intake" ] && [ -d "$PROJECT_DIR/.aiwg/requirements" ]; then
  echo "✓ .aiwg/ directory structure created"
else
  echo "❌ .aiwg/ directory incomplete"
fi

# Check 5: Natural language translations accessible
if [ -f "$AIWG_PATH/agentic/code/frameworks/sdlc-complete/docs/simple-language-translations.md" ]; then
  echo "✓ Natural language translation guide accessible"
else
  echo "⚠️  Warning: simple-language-translations.md not found"
fi

echo ""
echo "======================================================================="
```

Use Bash tool for validation.

### Step 7: Detect and Configure Factory AI (If Present)

Check if Factory AI is also being used and update AGENTS.md accordingly:

```bash
# Detect Factory AI deployment
if [ -d "$PROJECT_DIR/.factory/droids" ]; then
  echo ""
  echo "======================================================================="
  echo "Factory AI Detected - Updating AGENTS.md"
  echo "======================================================================="
  echo ""

  # Check if aiwg-update-agents-md command exists
  if [ -f "$AIWG_PATH/agentic/code/frameworks/sdlc-complete/commands/aiwg-update-agents-md.md" ]; then
    echo "✓ Factory AI droids detected in .factory/droids/"
    echo "✓ Running Factory AI configuration..."
    echo ""

    # This would trigger the Factory-specific configuration command
    # In practice, the orchestrator would call this command directly
    echo "FACTORY_AI_DETECTED=true"
  else
    echo "⚠️  Factory AI droids detected but aiwg-update-agents-md command not found"
    echo "   Skipping AGENTS.md update"
  fi

  echo ""
  echo "======================================================================="
fi
```

**Logic**:
1. Check for `.factory/droids/` directory existence
2. If found, indicate Factory AI is also configured
3. Signal that AGENTS.md should also be updated
4. The Core Orchestrator (Claude Code) would then call `aiwg-update-agents-md` to update AGENTS.md with project-specific content

**Cross-Platform Scenario**:
- **Claude Code only**: Updates CLAUDE.md only
- **Claude Code + Factory AI**: Updates both CLAUDE.md and AGENTS.md
- **Multi-platform**: Updates all relevant platform config files

Use Bash tool for Factory AI detection.

### Step 8: Provide Next Steps

After successful setup, provide clear guidance:

```markdown
# AIWG Setup Complete ✓

**Project**: {project-directory}
**AIWG Installation**: {AIWG_PATH}
**CLAUDE.md**: {CREATED | UPDATED | APPENDED}

## Changes Made

### CLAUDE.md
- ✓ Added/Updated AIWG framework documentation section
- ✓ Included Core Platform Orchestrator role and natural language interpretation
- ✓ Documented multi-agent workflow patterns (Primary Author → Reviewers → Synthesizer)
- ✓ Added natural language command translations (70+ phrases)
- ✓ Included available commands reference and phase workflows
- ✓ Added quick start guide and common patterns
- {if existing CLAUDE.md} ✓ Preserved all existing user notes and rules

### Project Structure
- ✓ Created .aiwg/ artifact directory structure
- ✓ Subdirectories: intake, requirements, architecture, planning, risks, testing, security, quality, deployment, team, working, reports, handoffs, gates, decisions

### Documentation Access
- ✓ AIWG installation verified at: {AIWG_PATH}
- ✓ Templates accessible at: {AIWG_PATH}/agentic/code/frameworks/sdlc-complete/templates/
- ✓ Natural language translation guide: {AIWG_PATH}/docs/simple-language-translations.md

{if Factory AI detected}
### Factory AI Integration
- ✓ Factory AI droids detected in .factory/droids/
- ⚠️  **Action Required**: Run `aiwg-update-agents-md` to update AGENTS.md with project-specific content
- ℹ️  This ensures both Claude Code (CLAUDE.md) and Factory AI (AGENTS.md) are configured

## Next Steps

1. **Review CLAUDE.md**:
   - Open `{CLAUDE_MD}` and review the AIWG framework section
   - Fill in 'Repository Purpose' if not already done
   - Add any project-specific notes to 'Project-Specific Notes' section

2. **Deploy Agents and Commands** (if not already done):
   ```bash
   # Deploy SDLC agents to .claude/agents/
   aiwg -deploy-agents --mode sdlc

   # Deploy SDLC commands to .claude/commands/
   aiwg -deploy-commands --mode sdlc
   ```

   {if Factory AI detected}
   **Factory AI Users**:
   ```bash
   # Update AGENTS.md with project-specific content
   /aiwg-update-agents-md

   # Or if not yet deployed, deploy Factory droids first
   aiwg -deploy-agents --provider factory --mode sdlc --deploy-commands --create-agents-md
   ```

3. **Start Intake** (if new to AIWG):
   ```bash
   # Generate intake forms interactively
   /intake-wizard "your project description" --interactive

   # Or analyze existing codebase
   /intake-from-codebase . --interactive
   ```

4. **Check Project Status**:
   ```bash
   # Natural language (preferred)
   User: "Where are we?"

   # Or explicit command
   /project-status
   ```

5. **Begin SDLC Flow**:
   ```bash
   # Natural language (preferred)
   User: "Let's transition to Elaboration"

   # Or explicit command
   /flow-inception-to-elaboration
   ```

## How to Use Natural Language

You can now use natural language to trigger SDLC workflows. Examples:

**Phase Transitions**:
- "Let's transition to Elaboration"
- "Move to Construction"
- "Ready to deploy"

**Review Cycles**:
- "Run security review"
- "Execute test suite"
- "Check compliance"

**Artifact Generation**:
- "Create architecture baseline"
- "Generate SAD"
- "Build test plan"

**Status Checks**:
- "Where are we?"
- "Can we transition?"
- "Check project health"

See `{AIWG_PATH}/docs/simple-language-translations.md` for complete phrase list.

## Resources

- **AIWG Framework Docs**: {AIWG_PATH}/agentic/code/frameworks/sdlc-complete/README.md
- **Template Library**: {AIWG_PATH}/agentic/code/frameworks/sdlc-complete/templates/
- **Agent Catalog**: {AIWG_PATH}/agentic/code/frameworks/sdlc-complete/agents/
- **Flow Commands**: {AIWG_PATH}/agentic/code/frameworks/sdlc-complete/commands/
- **Natural Language Guide**: {AIWG_PATH}/docs/simple-language-translations.md
- **Orchestrator Docs**: {AIWG_PATH}/docs/orchestrator-architecture.md
- **Multi-Agent Pattern**: {AIWG_PATH}/docs/multi-agent-documentation-pattern.md

## Need Help?

If you encounter any issues, use the AIWG knowledge base:

```text
# Slash command
/aiwg-kb "setup issues"
/aiwg-kb "agent not found"
/aiwg-kb "template errors"

# Or ask naturally
"How do I fix my AIWG install?"
"Why aren't my agents working?"
"Help with AIWG templates"
```

**Common topics**: setup issues, deployment issues, path issues, platform issues

**Quick reference**: {AIWG_PATH}/docs/troubleshooting/
```

## Implementation Notes

**Tools to Use**:
1. **Bash**: Resolve AIWG path, create directories, run validation
2. **Read**: Load existing CLAUDE.md, load template
3. **Grep**: Detect AIWG section presence
4. **Edit** or **Write**: Update CLAUDE.md based on scenario

**Critical Success Factors**:
- ✅ Preserve ALL user content (never delete existing notes)
- ✅ Substitute `{AIWG_ROOT}` with actual resolved path
- ✅ Include complete AIWG section (orchestration, natural language, commands)
- ✅ Create .aiwg/ directory structure
- ✅ Validate setup before declaring success

**Error Handling**:
- If AIWG not found → Fail with install instructions
- If CLAUDE.md unparseable → Append section with warning
- If permissions denied → Fail with permission error

## Success Criteria

This command succeeds when:
- [ ] AIWG installation path resolved and validated
- [ ] CLAUDE.md created or updated with complete AIWG section
- [ ] All existing user content preserved (if existing CLAUDE.md)
- [ ] `{AIWG_ROOT}` placeholder replaced with actual path
- [ ] .aiwg/ directory structure created with all subdirectories
- [ ] Validation checks pass
- [ ] Clear next steps provided to user
- [ ] Natural language translation guide documented

## Template Sections to Include

When merging AIWG section, ensure these are included:

1. ✅ **AIWG Framework Overview** - What AIWG is, installation path
2. ✅ **Core Platform Orchestrator Role** - How to interpret natural language and orchestrate
3. ✅ **Natural Language Command Translation** - 70+ phrase mappings
4. ✅ **Multi-Agent Workflow Pattern** - Primary Author → Reviewers → Synthesizer → Archive
5. ✅ **Available Commands Reference** - All SDLC commands with descriptions
6. ✅ **AIWG-Specific Rules** - Artifact location, template usage, parallel execution
7. ✅ **Reference Documentation** - Links to all AIWG docs (including simple-language-translations.md)
8. ✅ **Phase Overview** - Inception → Elaboration → Construction → Transition → Production
9. ✅ **Quick Start Guide** - Step-by-step initialization
10. ✅ **Common Patterns** - Example workflows (risk, architecture, security, testing)
11. ✅ **Need Help** - Reference to /aiwg-kb and troubleshooting docs

**Reference**: Template at `{AIWG_ROOT}/agentic/code/frameworks/sdlc-complete/templates/project/CLAUDE.md`

---

**Command Version**: 2.0
**Category**: SDLC Setup
**Mode**: Interactive Setup and Configuration

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/agent-deployment.md — Rules for working with agent definitions and multi-provider deployment
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — Seek explicit authorization before modifying existing CLAUDE.md content
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Detect AIWG installation and project structure before making changes
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/aiwg-update-claude/SKILL.md — Companion skill for updating an already-configured project
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/aiwg-update-agents-md/SKILL.md — Companion skill invoked when Factory AI is also detected
