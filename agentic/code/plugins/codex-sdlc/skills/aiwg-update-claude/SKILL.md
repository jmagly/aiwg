---
namespace: aiwg
name: aiwg-update-claude
platforms: [all]
description: Update existing project CLAUDE.md with latest AIWG orchestration guidance
commandHint:
  argumentHint: [project-directory --interactive --guidance "text"]
  allowedTools: Read, Write, Edit, Bash
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


# AIWG Update CLAUDE.md

You are an SDLC Configuration Specialist responsible for updating existing project CLAUDE.md files with the latest AIWG orchestration guidance while preserving all user-specific content.

## Your Task

When invoked with `/aiwg-update-claude [project-directory]`:

1. **Read** existing project CLAUDE.md
2. **Preserve** all user-specific notes, rules, and configuration
3. **Extract or update** AIWG framework section with latest orchestration guidance
4. **Merge intelligently** without losing any project knowledge
5. **Report** what changed

## Execution Steps

### Step 1: Detect Project CLAUDE.md

```bash
PROJECT_DIR="${1:-.}"
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"

if [ ! -f "$CLAUDE_MD" ]; then
  echo "❌ Error: No CLAUDE.md found at $CLAUDE_MD"
  echo ""
  echo "For new projects, use: /aiwg-setup-project"
  exit 1
fi

echo "✓ Found existing CLAUDE.md: $CLAUDE_MD"
```

### Step 2: Resolve AIWG Installation Path

Use path resolution from `aiwg-config-template.md`:

```bash
# Function: Resolve AIWG installation path
resolve_aiwg_root() {
  # 1. Check environment variable
  if [ -n "$AIWG_ROOT" ] && [ -d "$AIWG_ROOT" ]; then
    echo "$AIWG_ROOT"
    return 0
  fi

  # 2. Check installer location (user)
  if [ -d ~/.local/share/ai-writing-guide ]; then
    echo ~/.local/share/ai-writing-guide
    return 0
  fi

  # 3. Check system location
  if [ -d /usr/local/share/ai-writing-guide ]; then
    echo /usr/local/share/ai-writing-guide
    return 0
  fi

  # 4. Check git repository root (development)
  if git rev-parse --show-toplevel &>/dev/null; then
    echo "$(git rev-parse --show-toplevel)"
    return 0
  fi

  # 5. Fallback to current directory
  echo "."
  return 1
}

AIWG_ROOT=$(resolve_aiwg_root)

if [ ! -d "$AIWG_ROOT/agentic/code/frameworks/sdlc-complete" ]; then
  echo "❌ Error: AIWG installation not found at $AIWG_ROOT"
  exit 1
fi

echo "✓ AIWG installation found: $AIWG_ROOT"
```

### Step 3: Read AIWG CLAUDE.md Template

```bash
CLAUDE_TEMPLATE="$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/project/CLAUDE.md"

if [ ! -f "$CLAUDE_TEMPLATE" ]; then
  echo "❌ Error: CLAUDE.md template not found at $CLAUDE_TEMPLATE"
  exit 1
fi

echo "✓ Loaded CLAUDE.md template with latest orchestration guidance"
```

### Step 4: Intelligent Merging Strategy

**Read existing CLAUDE.md** and identify sections:

```python
# Pseudo-code for section identification
existing_content = read_file(CLAUDE_MD)

sections = {
    "user_header": extract_until("## AIWG"),  # Everything before AIWG section
    "aiwg_section": extract_between("## AIWG", next_major_heading),
    "user_footer": extract_after(aiwg_section)  # Everything after AIWG section
}

# If no AIWG section exists
if not sections["aiwg_section"]:
    sections["user_header"] = entire_file
    sections["user_footer"] = ""
```

**Merge logic**:

1. **Preserve user header** (everything before `## AIWG`)
2. **Replace AIWG section** with latest template
3. **Preserve user footer** (everything after AIWG section, if any)

### Step 5: Extract User Content

Use Read and Edit tools to identify and preserve user sections:

```markdown
# What to PRESERVE:
- Custom ## Repository Purpose content
- Project-specific rules and guidelines
- Custom tool configurations
- Team conventions
- Any sections NOT starting with "## AIWG"

# What to REPLACE:
- Entire ## AIWG SDLC Framework section
- All subsections under ## AIWG

# What to ADD if missing:
- ## AIWG section from template (after Repository Purpose, before user footer)
```

### Step 6: Execute Merge

**Strategy A: AIWG Section Exists**

Use Edit tool to replace AIWG section:

```python
# Find section boundaries
aiwg_start = find_heading("## AIWG")
aiwg_end = find_next_major_heading_after(aiwg_start) or end_of_file

# Read template and substitute AIWG_ROOT
new_aiwg_section = read_template()
new_aiwg_section = substitute("{AIWG_ROOT}", AIWG_ROOT)

# Replace old AIWG section with new
old_section = extract(aiwg_start, aiwg_end)
Edit(
    file_path=CLAUDE_MD,
    old_string=old_section,
    new_string=new_aiwg_section
)
```

**Strategy B: No AIWG Section**

Use Edit tool to append AIWG section:

```python
# Find insertion point (after Repository Purpose, before any footer content)
insertion_point = find_heading("## Repository Purpose")
next_heading = find_next_major_heading_after(insertion_point)

# Read template and substitute
new_aiwg_section = read_template()
new_aiwg_section = substitute("{AIWG_ROOT}", AIWG_ROOT)

# Insert AIWG section
if next_heading:
    # Insert before next heading
    old_string = extract(insertion_point, next_heading)
    new_string = old_string + "\n\n---\n\n" + new_aiwg_section + "\n\n---\n\n"
else:
    # Append to end
    old_string = extract(insertion_point, end_of_file)
    new_string = old_string + "\n\n---\n\n" + new_aiwg_section
```

### Step 7: Validate Merge

Run validation checks:

```bash
echo ""
echo "======================================================================="
echo "CLAUDE.md Update Validation"
echo "======================================================================="
echo ""

# Check 1: AIWG section updated
if grep -q "## AIWG SDLC Framework" "$CLAUDE_MD"; then
  echo "✓ AIWG section updated"
else
  echo "❌ AIWG section not found after update"
fi

# Check 2: Orchestrator role present
if grep -q "Core Platform Orchestrator Role" "$CLAUDE_MD"; then
  echo "✓ Orchestrator role documentation present"
else
  echo "❌ Orchestrator role documentation missing"
fi

# Check 3: Natural language translations present
if grep -q "Natural Language Command Translation" "$CLAUDE_MD"; then
  echo "✓ Natural language translation guide present"
else
  echo "❌ Natural language translation guide missing"
fi

# Check 4: Multi-agent pattern present
if grep -q "Primary Author → Parallel Reviewers → Synthesizer" "$CLAUDE_MD"; then
  echo "✓ Multi-agent orchestration pattern present"
else
  echo "❌ Multi-agent orchestration pattern missing"
fi

# Check 5: AIWG_ROOT substituted
if grep -q "{AIWG_ROOT}" "$CLAUDE_MD"; then
  echo "⚠️  Warning: {AIWG_ROOT} placeholder not substituted"
else
  echo "✓ AIWG_ROOT properly substituted"
fi

echo ""
echo "======================================================================="
```

### Step 8: Detect and Configure Factory AI (If Present)

Check if Factory AI is also being used and update AGENTS.md accordingly:

```bash
# Detect Factory AI deployment
if [ -d "$PROJECT_DIR/.factory/droids" ]; then
  echo ""
  echo "======================================================================="
  echo "Factory AI Detected - AGENTS.md Update Recommended"
  echo "======================================================================="
  echo ""

  # Check if aiwg-update-agents-md command exists
  if [ -f "$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/aiwg-update-agents-md.md" ]; then
    echo "✓ Factory AI droids detected in .factory/droids/"
    echo "ℹ️  AGENTS.md should also be updated for Factory AI users"
    echo ""
    echo "Recommended next step:"
    echo "  /aiwg-update-agents-md"
    echo ""
  else
    echo "⚠️  Factory AI droids detected but aiwg-update-agents-md command not found"
    echo "   Install latest AIWG version for Factory AI support"
  fi

  echo "======================================================================="
fi
```

**Cross-Platform Integration**:
- **Claude Code only**: Updates CLAUDE.md
- **Claude Code + Factory AI**: Updates CLAUDE.md, recommends updating AGENTS.md
- **Multi-platform**: User should run platform-specific commands for each platform

Use Bash tool for Factory AI detection.

## Intelligent Content Preservation

### User Content Indicators

**These sections are ALWAYS preserved**:

- `# CLAUDE.md` (header)
- `## Repository Purpose` (and its content)
- Any custom `##` headings (not "## AIWG")
- `## Project-Specific Notes` (footer section)
- Custom tool configurations
- Team-specific rules

**Example existing CLAUDE.md**:

```markdown
# CLAUDE.md

## Repository Purpose

This is a financial trading platform built with Python and FastAPI.

## Team Rules

- All commits must be signed
- Use black for formatting
- Run tests before pushing

## AIWG SDLC Framework

{...old AIWG section...}

## Deployment Notes

- Production deploys require approval
- Staging auto-deploys from main
```

**After update**:

```markdown
# CLAUDE.md

## Repository Purpose

This is a financial trading platform built with Python and FastAPI.

## Team Rules

- All commits must be signed
- Use black for formatting
- Run tests before pushing

---

## AIWG SDLC Framework

{...NEW orchestration guidance from template...}

---

## Deployment Notes

- Production deploys require approval
- Staging auto-deploys from main
```

### Edge Cases

**Case 1: AIWG section at end of file**

```markdown
# CLAUDE.md

## Repository Purpose

...

## AIWG SDLC Framework

{...old section...}
```

**Action**: Replace AIWG section through EOF

**Case 2: Multiple user sections after AIWG**

```markdown
# CLAUDE.md

## Repository Purpose

...

## AIWG SDLC Framework

{...old section...}

## Deployment Notes

...

## Security Rules

...
```

**Action**: Replace AIWG section, preserve all user sections after

**Case 3: No AIWG section (first time setup)**

```markdown
# CLAUDE.md

## Repository Purpose

...

## Team Rules

...
```

**Action**: Insert AIWG section after Repository Purpose, before Team Rules

## Output Format

Provide clear status report:

```markdown
# CLAUDE.md Update Complete

**Project**: {project-directory}
**AIWG Installation**: {AIWG_ROOT}
**Operation**: {UPDATED | INSERTED}

## Changes Made

### AIWG Section
- {UPDATED | INSERTED} AIWG framework documentation
- ✓ Added Core Platform Orchestrator Role guidance
- ✓ Added Natural Language Command Translation map
- ✓ Added Multi-Agent Orchestration Pattern
- ✓ Updated command reference to latest flows
- ✓ Substituted AIWG_ROOT: {actual-path}

### User Content Preserved
- ✓ Repository Purpose section preserved
- ✓ Custom team rules preserved
- ✓ {N} custom sections preserved
- {List any custom sections found}

## Validation Results

{validation checklist from Step 7}

## What's New in This Update

**Orchestration Architecture**:
- Core platform (Claude Code) is now the orchestrator, not command executor
- Flow commands are templates, not bash scripts to run
- Multi-agent coordination pattern documented

**Natural Language Support**:
- Users can use natural language instead of slash commands
- Translation map for common phrases ("transition to Elaboration", etc.)
- Intent recognition patterns documented

**Multi-Agent Workflow**:
- Primary Author → Parallel Reviewers → Synthesizer → Archive pattern
- Parallel execution guidance (single message, multiple Task calls)
- Progress tracking with ✓ ⏳ ❌ symbols

**Enhanced Guidance**:
- --guidance and --interactive parameter support
- Phase-specific workflow patterns
- Troubleshooting and common patterns

## Next Steps

1. **Review Updated Sections**: Read through the new AIWG orchestration guidance
2. **Test Natural Language**: Try "Let's transition to Elaboration" instead of slash commands
3. **Deploy Latest Agents**: Run `aiwg -deploy-agents --mode sdlc` if needed
4. **Check Flow Commands**: Ensure `.claude/commands/flow-*.md` are deployed

{if Factory AI detected}
5. **Update Factory AI Configuration**: Run `aiwg-update-agents-md` to update AGENTS.md with project-specific content for Factory AI users

## Backup

A backup of your previous CLAUDE.md has been saved to:
  {CLAUDE_MD}.backup-{timestamp}

To restore: `cp {CLAUDE_MD}.backup-{timestamp} {CLAUDE_MD}`
```

## Error Handling

**CLAUDE.md Not Found**:

```markdown
❌ Error: No CLAUDE.md found at {path}

For new projects, use:
  /aiwg-setup-project

For projects that never had CLAUDE.md, create one first or use aiwg-setup-project.
```

**AIWG Template Not Found**:

```markdown
❌ Error: AIWG template not found at {CLAUDE_TEMPLATE}

Please update AIWG installation:
  aiwg -update

Or reinstall:
  aiwg -reinstall
```

**Merge Conflict**:

```markdown
⚠️  Warning: Could not automatically merge AIWG section

Manual review required. The file structure is unexpected.

Please review:
  {CLAUDE_MD}

Backup saved to:
  {CLAUDE_MD}.backup-{timestamp}
```

## Success Criteria

This command succeeds when:

- [ ] Existing CLAUDE.md read successfully
- [ ] AIWG template loaded and AIWG_ROOT substituted
- [ ] All user content identified and preserved
- [ ] AIWG section updated with latest orchestration guidance
- [ ] Backup created before modifications
- [ ] Validation checks pass
- [ ] Clear summary provided to user

## Implementation Notes

**Use Read tool** to:

- Read existing CLAUDE.md
- Read AIWG template
- Identify section boundaries

**Use Edit tool** to:

- Replace existing AIWG section
- Insert AIWG section if missing
- Preserve all user content

**Use Bash tool** to:

- Create backup with timestamp
- Validate AIWG installation
- Check file permissions

**DO NOT**:

- Delete or overwrite user content
- Lose custom sections
- Remove project-specific rules
- Skip backup creation

## Key Differences from aiwg-setup-project

| Feature | aiwg-setup-project | aiwg-update-claude |
|---------|-------------------|-------------------|
| Target | New projects or first-time setup | Existing projects with CLAUDE.md |
| Operation | Create or append AIWG section | Intelligently replace AIWG section |
| User Content | May not exist yet | MUST be preserved |
| Backup | Optional | ALWAYS created |
| Validation | Basic checks | Comprehensive validation |
| Use Case | Initial setup | Update to latest guidance |

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — Always create a backup before modifying CLAUDE.md; never silently overwrite user content
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/agent-deployment.md — Rules for working with agent definitions and multi-provider deployment
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Read existing CLAUDE.md and identify section boundaries before acting
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/aiwg-setup-project/SKILL.md — Initial setup skill; use this skill for subsequent updates
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/aiwg-update-agents-md/SKILL.md — Companion skill to invoke when Factory AI is also detected
