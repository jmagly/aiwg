---
namespace: aiwg
name: devkit-test
platforms: [all]
description: Run comprehensive tests on an AIWG package (addon, framework or extension) to verify structure, functionality and deployment readiness
---

# Test AIWG Package

Run comprehensive tests on an AIWG package to verify structure, functionality, and deployment readiness.

## Process

### 1. Locate and Identify Package

Resolve the package path from `$ARGUMENTS`:
- If relative path, resolve from current directory
- If package name, look in addons/ and frameworks/

Identify package type from manifest.json:
- `"type": "addon"` → Addon tests
- `"type": "framework"` → Framework tests
- `"type": "extension"` → Extension tests

### 2. Run Structure Tests

**Manifest Validation**:
- [ ] manifest.json exists and is valid JSON
- [ ] Required fields present: id, type, name, version, description
- [ ] Entry paths exist and match actual directories
- [ ] Component arrays match actual files

**Directory Structure**:
- [ ] Expected directories exist (agents/, commands/, etc.)
- [ ] No orphaned files outside expected structure
- [ ] README.md exists and is non-empty

**Component Files**:
- [ ] All agents listed in manifest exist as .md files
- [ ] All commands listed in manifest exist as .md files
- [ ] All skills listed in manifest have SKILL.md
- [ ] All templates listed in manifest exist

### 3. Run Content Tests

**Agent Validation**:
For each agent file:
- [ ] Valid YAML frontmatter with name, description, model, tools
- [ ] Model is valid (sonnet, opus, haiku)
- [ ] Tools list contains valid tool names
- [ ] Content sections present (Domain Expertise, Responsibilities, etc.)

**Command Validation**:
For each command file:
- [ ] Valid YAML frontmatter with name, description
- [ ] Args defined with name and description
- [ ] Process section present
- [ ] No broken internal references

**Skill Validation**:
For each skill:
- [ ] SKILL.md has valid frontmatter
- [ ] Trigger phrases defined
- [ ] Execution process documented
- [ ] References directory exists (if referenced)

### 4. Run Type-Specific Tests

**Addon Tests**:
- [ ] No `requires` field (addons are standalone)
- [ ] Can be deployed independently

**Extension Tests**:
- [ ] `requires` field present and valid
- [ ] Parent framework exists
- [ ] Located in correct extensions/ subdirectory

**Framework Tests**:
- [ ] Phases defined in manifest
- [ ] Flow documents exist for each phase
- [ ] actors-and-templates.md exists
- [ ] config/models.json exists
- [ ] metrics/tracking-catalog.md exists

### 5. Run Deployment Test

Simulate deployment to temporary directory:
```bash
# Create temp test directory
mkdir -p /tmp/aiwg-test-$$

# Attempt deployment
aiwg -deploy-agents --source <package-path> --target /tmp/aiwg-test-$$ --dry-run

# Check expected output structure
```

### 6. Auto-Fix (if --fix)

When `--fix` is specified, attempt to repair:

**Fixable Issues**:
- Missing directories → Create them
- Manifest component arrays out of sync → Update from files
- Missing README.md → Generate from manifest
- Invalid JSON formatting → Reformat

**Non-Fixable Issues** (report only):
- Missing required fields in manifest
- Invalid agent/command content
- Missing parent framework (extensions)

### 7. Generate Report

**Summary Format**:
```
Package Test: <package-id>
Type: <addon|extension|framework>
─────────────────────────────────

Structure Tests: <pass/fail count>
Content Tests: <pass/fail count>
Type Tests: <pass/fail count>
Deployment Test: <pass/fail>

Overall: <PASS|FAIL>
```

**Detailed Format (--verbose)**:
```
Package Test: <package-id>
─────────────────────────────────

[Structure Tests]
  ✓ manifest.json exists
  ✓ manifest.json is valid JSON
  ✓ Required fields present
  ✓ agents/ directory exists
  ✗ commands/ directory missing
  ...

[Content Tests]
  ✓ agent-one.md: valid frontmatter
  ✓ agent-one.md: valid model (sonnet)
  ✗ agent-two.md: missing tools field
  ...

[Type Tests]
  ✓ No requires field (addon)
  ...

[Deployment Test]
  ✓ Dry-run deployment successful

[Issues Found]
  ERROR: commands/ directory missing
  WARNING: agent-two.md missing tools field

[Auto-Fixed] (if --fix)
  ✓ Created commands/ directory
```

## Exit Codes

- 0: All tests passed
- 1: Tests failed (fixable issues remain)
- 2: Tests failed (non-fixable issues)

## Examples

```bash
# Test addon
/devkit-test aiwg-utils

# Test with verbose output
/devkit-test sdlc-complete --verbose

# Test and auto-fix
/devkit-test my-addon --fix --verbose

# Test extension
/devkit-test sdlc-complete/extensions/hipaa
```

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/README.md — aiwg-dev addon overview
- @$AIWG_ROOT/docs/extensions/overview.md — Extension system architecture and package types
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference including validate-metadata command
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Verification-before-action pattern
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC framework as example test target
