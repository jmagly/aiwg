# PreToolUse Context Injection Hooks

**Issue:** #284
**Platform:** Claude Code v2.1.9+
**Type:** Documentation/Templates

## Overview

Claude Code v2.1.9 introduced PreToolUse hooks that can return `additionalContext` to inject targeted context immediately before tool invocation. This enables smart context loading without bloating the global CLAUDE.md file.

**Key Benefits**:
- Context loaded only when relevant tool is used
- Reduces token usage vs always-loaded context
- Path-aware context injection
- Tool-specific guidance at point of use

**How It Works**:
1. Claude Code evaluates hook matcher before tool invocation
2. If matcher succeeds, hook runs and can return `additionalContext`
3. Context is injected into the tool invocation
4. After tool execution, context is discarded (not persisted)

## Hook Configurations

### 1. AIWG Artifact Write Guard

**Purpose**: Inject AIWG artifact conventions when writing to `.aiwg/**` paths.

**Matcher**: `Write` tool targeting `.aiwg/**` paths

**Context Injected**:
- Artifact frontmatter requirements
- @-mention wiring patterns
- Progressive disclosure labels (ESSENTIAL, EXPAND WHEN READY, ADVANCED)
- Reference section templates

**Hook Configuration** (`.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "id": "aiwg-artifact-guard",
        "name": "AIWG Artifact Write Guard",
        "description": "Injects AIWG artifact conventions when writing to .aiwg/ paths",
        "matcher": {
          "tool": "Write",
          "pathPattern": ".aiwg/**"
        },
        "handler": {
          "type": "additionalContext",
          "content": "When writing AIWG artifacts:\n\n1. **Frontmatter Required** (for documents):\n   - Use YAML frontmatter with metadata\n   - Include created timestamp\n   - Add created_by agent reference\n\n2. **@-Mentions Required**:\n   - Add References section\n   - Wire to source requirements\n   - Wire to implementations\n   - Use semantic qualifiers (@implements, @tests, @depends)\n\n3. **Progressive Disclosure** (for templates):\n   - Label sections: ESSENTIAL, EXPAND WHEN READY, ADVANCED\n   - Use <details> tags for collapsible sections\n   - Include inline examples\n\n4. **Provenance Tracking**:\n   - Record in .aiwg/research/provenance/records/ if significant\n\nSee @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/mention-wiring.md and @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/progressive-disclosure.md"
        }
      }
    ]
  }
}
```

**Example Usage**:
```
User: "Create a use case for user authentication"
→ Agent invokes Write tool targeting .aiwg/requirements/use-cases/UC-001.md
→ Hook matches, injects artifact conventions
→ Agent generates use case with proper frontmatter, @-mentions, labels
```

---

### 2. Security Context for Bash

**Purpose**: Inject token security rules and git conventions before executing bash commands.

**Matcher**: `Bash` tool (all invocations)

**Context Injected**:
- Token security patterns (heredoc, no hard-coding)
- Git commit conventions (no --no-verify)
- Safe scripting patterns

**Hook Configuration** (`.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "id": "bash-security-guard",
        "name": "Bash Security Context",
        "description": "Injects security rules before bash execution",
        "matcher": {
          "tool": "Bash"
        },
        "handler": {
          "type": "additionalContext",
          "content": "**Security Requirements for Bash Commands**:\n\n1. **Token Handling**:\n   - NEVER hard-code tokens in commands\n   - Use heredoc for token operations: bash <<'EOF' ... EOF\n   - Load tokens inline: $(cat ~/.config/gitea/token)\n\n2. **Git Commits**:\n   - NEVER use --no-verify or --no-gpg-sign\n   - NEVER force push to main/master\n   - Use conventional commit format\n\n3. **Safe Patterns**:\n   - Quote paths with spaces\n   - Use absolute paths when possible\n   - Check file existence before operations\n\nSee @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/token-security.md and @CLAUDE.md Git Conventions"
        }
      }
    ]
  }
}
```

**Example Usage**:
```
User: "Push changes to Gitea"
→ Agent invokes Bash tool with git commands
→ Hook injects security rules
→ Agent uses heredoc for token, avoids --no-verify
```

---

### 3. Voice Profile for Content Writes

**Purpose**: Remind about voice profile when writing markdown content outside `.aiwg/`.

**Matcher**: `Write` tool targeting `*.md` files (excluding `.aiwg/**`)

**Context Injected**:
- Active voice preference
- Sophistication maintenance
- Authenticity markers

**Hook Configuration** (`.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "id": "voice-profile-reminder",
        "name": "Voice Profile Context",
        "description": "Injects voice profile guidance for markdown content",
        "matcher": {
          "tool": "Write",
          "pathPattern": "**/*.md",
          "excludePattern": ".aiwg/**"
        },
        "handler": {
          "type": "additionalContext",
          "content": "**AIWG Voice Profile (Technical Authority)**:\n\n1. **Active Voice**: Prefer active over passive\n   - Good: 'The system validates input'\n   - Avoid: 'Input is validated by the system'\n\n2. **Maintain Sophistication**: Preserve domain vocabulary\n   - Use precise technical terms\n   - Don't oversimplify for accessibility\n\n3. **Authenticity Markers**:\n   - Include opinions when appropriate\n   - Acknowledge trade-offs\n   - Vary sentence structure\n\n4. **Specificity**: Use exact metrics and concrete examples\n\nSee @$AIWG_ROOT/agentic/code/addons/voice-framework/voices/templates/technical-authority.yaml"
        }
      }
    ]
  }
}
```

**Example Usage**:
```
User: "Write README for the testing framework"
→ Agent invokes Write tool for README.md
→ Hook injects voice profile
→ Agent writes with active voice, maintains technical depth
```

---

### 4. Research Citation Guard

**Purpose**: Enforce citation policy when writing research documents.

**Matcher**: `Write` tool targeting `.aiwg/research/**` paths

**Context Injected**:
- Citation verification requirements
- GRADE quality levels
- Hedging language by evidence quality

**Hook Configuration** (`.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "id": "research-citation-guard",
        "name": "Research Citation Policy",
        "description": "Enforces citation standards for research documents",
        "matcher": {
          "tool": "Write",
          "pathPattern": ".aiwg/research/**"
        },
        "handler": {
          "type": "additionalContext",
          "content": "**Citation Policy Requirements**:\n\n1. **Verify Before Citing**:\n   - Only cite sources in .aiwg/research/sources/\n   - Check file exists before referencing\n   - Use exact quotes with page numbers\n\n2. **GRADE Quality Levels**:\n   - HIGH: 'demonstrates', 'shows', 'confirms'\n   - MODERATE: 'suggests', 'indicates', 'supports'\n   - LOW: 'some evidence', 'limited data'\n   - VERY LOW: 'anecdotal', 'exploratory'\n\n3. **Never Fabricate**:\n   - NEVER invent DOIs, URLs, page numbers\n   - NEVER cite sources not in corpus\n   - Acknowledge gaps explicitly\n\n4. **Frontmatter Required**:\n   - ref_id (REF-XXX)\n   - title, authors, year\n   - key_findings with metrics\n   - quality_assessment (GRADE)\n\nSee @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/citation-policy.md and @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/research-metadata.md"
        }
      }
    ]
  }
}
```

**Example Usage**:
```
User: "Document the Agent Laboratory research paper"
→ Agent invokes Write tool for .aiwg/research/findings/REF-057.md
→ Hook injects citation policy
→ Agent includes proper frontmatter, uses GRADE hedging, cites corpus sources
```

---

## Cross-Platform Note

**PreToolUse hooks are Claude Code-specific.** On other platforms, equivalent context is loaded via:

| Platform | Alternative Method |
|----------|-------------------|
| **Cursor** | Path-scoped rules in `.cursor/rules/` |
| **GitHub Copilot** | Context files in `.github/copilot/` |
| **All Platforms** | Relevant sections in CLAUDE.md (always loaded) |
| **Agent Systems** | Agent system prompts with tool-specific guidance |

For maximum portability:
- Keep critical guidance in CLAUDE.md
- Use hooks for non-critical, context-heavy additions
- Document hook patterns so they can be adapted to other platforms

---

## Installation

### Method 1: Project Settings (Recommended)

Add hook configurations to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      // ... hook configurations from above
    ]
  }
}
```

### Method 2: User-Wide Settings

Add to `~/.claude/settings.json` for all projects:

```json
{
  "hooks": {
    "PreToolUse": [
      // ... hook configurations
    ]
  }
}
```

### Verification

To verify hooks are active:

1. Trigger a matching tool operation (e.g., write to `.aiwg/`)
2. Check Claude Code's internal logs (if available)
3. Observe agent behavior - does it follow injected guidance?

---

## Best Practices

1. **Keep Context Concise**: Hooks inject on every tool use - keep payload small
2. **Reference Full Rules**: Point to detailed docs (e.g., @$AIWG_ROOT/agentic/code/.../rules/...)
3. **Test Matcher Logic**: Verify pathPattern and excludePattern work as expected
4. **Version Control Settings**: Commit `.claude/settings.json` for team consistency
5. **Document Rationale**: Explain why each hook exists (link to issues)

---

## Troubleshooting

**Hook not firing?**
- Check matcher syntax (tool name, pathPattern)
- Verify Claude Code version (v2.1.9+)
- Check `.claude/settings.json` for JSON errors

**Context not being followed?**
- Verify content is clear and actionable
- Test with explicit instruction in user message
- Consider adding to CLAUDE.md if critical

**Performance issues?**
- Reduce context length
- Use more specific matchers
- Consider consolidating hooks

---

## References

- Issue #284 - PreToolUse context injection implementation
- Claude Code v2.1.9 Release Notes - additionalContext feature
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/mention-wiring.md - @-mention patterns
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/token-security.md - Security requirements
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/citation-policy.md - Citation standards
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/progressive-disclosure.md - Artifact templates

---

**Status**: Active
**Last Updated**: 2026-02-06
**Maintainer**: AIWG Contributors
