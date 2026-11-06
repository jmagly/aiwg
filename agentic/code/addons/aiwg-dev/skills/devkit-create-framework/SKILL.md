---
namespace: aiwg
name: devkit-create-framework
platforms: [all]
description: Comma-separated phase names
---

# Create AIWG Framework

Create a new AIWG framework with complete lifecycle structure.

## Process

### 1. Validate Framework Name

Check that `$ARGUMENTS` contains a valid framework name:
- Must be kebab-case (lowercase with hyphens)
- Must not conflict with existing frameworks

Check existing frameworks:
```bash
ls ~/.local/share/ai-writing-guide/agentic/code/frameworks/
```

### 2. Interactive Design (if --interactive)

If `--interactive` is specified, guide the user through framework design:

**Framework Purpose**:
> What lifecycle does this framework manage? (e.g., software development, marketing campaigns, legal cases)

**Target Audience**:
> Who will use this framework? (e.g., development teams, marketing departments, legal firms)

**Phase Structure**:
> What phases does this lifecycle include?
> Default: inception, elaboration, construction, transition
> Custom examples: discovery, analysis, synthesis, publication

**Agent Categories**:
> What types of roles are needed?
> - Analysis roles (analysts, researchers)
> - Design roles (architects, designers)
> - Implementation roles (developers, writers)
> - Quality roles (reviewers, testers)
> - Management roles (coordinators, managers)

**Template Categories**:
> What artifact types will be produced?
> - Planning documents
> - Requirements documents
> - Design documents
> - Implementation artifacts
> - Quality artifacts
> - Deployment artifacts

### 3. Execute Scaffolding

Run the CLI scaffolding tool:

```bash
node ~/.local/share/ai-writing-guide/tools/scaffolding/scaffold-framework.mjs \
  <name> \
  --description "<derived from interactive>" \
  --phases "<phase1,phase2,...>"
```

### 4. Post-Creation Guidance

After scaffolding, provide guidance on next steps:

**Immediate Actions**:
1. Review and customize `actors-and-templates.md`
2. Define your first agents for each phase
3. Create initial templates for key artifacts

**Agent Creation Priority**:
- Phase 1: Create 2-3 core agents per phase
- Phase 2: Add specialized agents as needed
- Phase 3: Add orchestration agents for workflows

**Command Creation Priority**:
- Phase 1: Create phase execution commands (`flow-<phase>`)
- Phase 2: Create transition commands (`flow-<phase>-to-<next>`)
- Phase 3: Create utility commands (status, validation)

**Template Creation Priority**:
- Phase 1: Create 2-3 key templates per phase
- Phase 2: Add specialized templates
- Phase 3: Create cross-cutting templates

### 5. Provide Reference Resources

Point to existing frameworks as examples:
- `sdlc-complete`: 53 agents, 48 commands, comprehensive lifecycle
- `media-marketing-kit`: 37 agents, marketing-focused lifecycle

Reference documentation:
- `docs/development/framework-creation-guide.md`
- `docs/development/devkit-overview.md`

## Output Format

```
Framework Created: <name>
─────────────────────────

Location: ~/.local/share/ai-writing-guide/agentic/code/frameworks/<name>/

Phases: <phase1> → <phase2> → ... → <phaseN>

Created:
  ✓ manifest.json
  ✓ README.md
  ✓ plan-act-<name>.md
  ✓ actors-and-templates.md
  ✓ agents/manifest.md
  ✓ commands/manifest.md
  ✓ <framework-root>/templates/manifest.json
  ✓ flows/<phase>.md (for each phase)
  ✓ metrics/tracking-catalog.md
  ✓ config/models.json

Next Steps:
  1. Define actors: Edit actors-and-templates.md
  2. Add agents:    aiwg add-agent <name> --to <framework>
  3. Add commands:  aiwg add-command <name> --to <framework>
  4. Add templates: aiwg add-template <name> --to <framework> --category <phase>
  5. Deploy:        aiwg use <framework>
```

## Notes

- Framework creation is a significant undertaking (50+ agents typical)
- Study existing frameworks before creating new ones
- Use `--interactive` for guided design process
- Start small and iterate (core agents first, then expand)

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/README.md — aiwg-dev addon overview
- @$AIWG_ROOT/docs/extensions/overview.md — Extension system architecture
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference including scaffold-framework command
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC framework as reference implementation
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/god-session.md — Scope guidelines for agent design within frameworks
