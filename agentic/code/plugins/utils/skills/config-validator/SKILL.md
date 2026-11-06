---
namespace: aiwg
name: config-validator
platforms: [all]
description: Validate AIWG configuration files and project setup for correctness and completeness

---

# config-validator

Validate AIWG configuration files and project setup for correctness and completeness.

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "validate [YAML/JSON]" in configuration context → config schema check
- "is this valid config" → configuration validation

## Purpose

This skill ensures AIWG projects are properly configured by:
- Validating YAML/JSON configuration syntax
- Checking required fields and values
- Verifying file references and paths
- Detecting configuration conflicts
- Recommending fixes for issues

## Behavior

When triggered, this skill:

1. **Locates configuration files**:
   - Scan for AIWG config files
   - Identify framework configs
   - Find project-specific configs

2. **Validates syntax**:
   - Parse YAML/JSON files
   - Check for syntax errors
   - Validate structure against schema

3. **Checks completeness**:
   - Verify required fields present
   - Check for missing sections
   - Validate cross-references

4. **Verifies references**:
   - Check file paths exist
   - Validate agent references
   - Verify template paths

5. **Detects conflicts**:
   - Duplicate definitions
   - Conflicting settings
   - Incompatible options

6. **Generates report**:
   - List all issues found
   - Severity classification
   - Fix recommendations

## Configuration Files Validated

### AIWG Core Configs

```yaml
aiwg_configs:
  project_config:
    path: .aiwg/config/project.yaml
    schema: schemas/project-config.schema.yaml
    required_fields:
      - project_name
      - project_type
      - phase

  team_profile:
    path: .aiwg/team/team-profile.yaml
    schema: schemas/team-profile.schema.yaml
    required_fields:
      - team_name
      - members

  risk_register:
    path: .aiwg/risks/risk-register.yaml
    schema: schemas/risk-register.schema.yaml
    required_fields:
      - risks

  artifact_config:
    path: .aiwg/config/artifacts.yaml
    schema: schemas/artifact-config.schema.yaml
```

### Framework Configs

```yaml
framework_configs:
  sdlc_complete:
    models:
      path: agentic/code/frameworks/sdlc-complete/config/models.json
      validates:
        - model_ids
        - model_tiers

    agents:
      path: agentic/code/frameworks/sdlc-complete/agents/*.md
      validates:
        - frontmatter_schema
        - required_sections

  media_marketing:
    brand:
      path: .aiwg/marketing/brand/*.yaml
      validates:
        - color_formats
        - typography_specs

    channel_specs:
      path: .aiwg/marketing/config/channel-specs.yaml
      validates:
        - platform_requirements
```

### Voice Framework Configs

```yaml
voice_configs:
  voice_profiles:
    path: .aiwg/voices/*.yaml
    schema: schemas/voice-profile.schema.yaml
    required_fields:
      - name
      - traits
      - formality

  banned_patterns:
    path: validation/banned-patterns.md
    validates:
      - pattern_syntax
      - category_structure
```

## Validation Rules

### Syntax Validation

```yaml
syntax_rules:
  yaml:
    - valid_yaml_syntax
    - proper_indentation
    - no_tabs_in_yaml
    - valid_anchors_references

  json:
    - valid_json_syntax
    - proper_escaping
    - no_trailing_commas

  markdown:
    - valid_frontmatter
    - proper_code_fences
    - valid_links
```

### Schema Validation

```yaml
schema_validation:
  project_config:
    project_name:
      type: string
      required: true
      min_length: 3

    project_type:
      type: string
      required: true
      enum: [sdlc, marketing, hybrid]

    phase:
      type: string
      enum: [concept, inception, elaboration, construction, transition, production]

    created_at:
      type: date
      format: ISO8601
```

### Reference Validation

```yaml
reference_rules:
  file_paths:
    - path_exists
    - correct_extension
    - within_project_root

  agent_refs:
    - agent_exists
    - agent_has_required_tools

  template_refs:
    - template_exists
    - template_has_placeholders
```

## Validation Report Format

```markdown
# Configuration Validation Report

**Date**: 2025-12-08
**Scope**: Full Project Validation
**Validator**: config-validator skill

## Summary

| Category | Files | Issues | Status |
|----------|-------|--------|--------|
| AIWG Core | 5 | 2 | ⚠️ Warnings |
| Framework | 8 | 0 | ✅ Pass |
| Voice | 3 | 1 | ⚠️ Warning |
| Custom | 2 | 1 | ❌ Error |
| **Total** | **18** | **4** | **Review Needed** |

## Issues Found

### ❌ Error: Invalid Project Config

**File**: `.aiwg/config/project.yaml`
**Line**: 12
**Issue**: Missing required field `project_type`
**Severity**: Error (blocking)

**Current**:
```yaml
project_name: "My Project"
phase: inception
```

**Required**:
```yaml
project_name: "My Project"
project_type: sdlc  # Required field
phase: inception
```

**Fix**: Add `project_type` field with value: `sdlc`, `marketing`, or `hybrid`

---

### ⚠️ Warning: Invalid File Reference

**File**: `.aiwg/config/artifacts.yaml`
**Line**: 34
**Issue**: Referenced template does not exist
**Severity**: Warning

**Current**:
```yaml
template: templates/custom/<template>.md
```

**Problem**: File `templates/custom/<template>.md` not found

**Fix Options**:
1. Create the missing template file
2. Update reference to existing template
3. Remove the reference if not needed

---

### ⚠️ Warning: Deprecated Field

**File**: `.aiwg/team/team-profile.yaml`
**Line**: 8
**Issue**: Field `team_lead` is deprecated
**Severity**: Warning

**Current**:
```yaml
team_lead: "Jane Smith"
```

**New Format**:
```yaml
roles:
  - name: "Jane Smith"
    role: team_lead
```

---

### ⚠️ Warning: Voice Profile Incomplete

**File**: `.aiwg/voices/brand-voice.yaml`
**Line**: 15
**Issue**: Missing recommended field `examples`
**Severity**: Info

**Recommendation**: Add examples section for better voice application:
```yaml
examples:
  greeting: "Hi there! Let's get started."
  error: "Oops, something went wrong. Here's what to try..."
```

## Validation Details

### AIWG Core Configs

| File | Status | Issues |
|------|--------|--------|
| project.yaml | ❌ Error | Missing project_type |
| team-profile.yaml | ⚠️ Warning | Deprecated field |
| risk-register.yaml | ✅ Pass | - |
| artifacts.yaml | ⚠️ Warning | Invalid reference |
| phases.yaml | ✅ Pass | - |

### Framework Configs

| File | Status | Issues |
|------|--------|--------|
| models.json | ✅ Pass | - |
| channel-specs.yaml | ✅ Pass | - |
| brand-colors.yaml | ✅ Pass | - |

### Voice Configs

| File | Status | Issues |
|------|--------|--------|
| brand-voice.yaml | ⚠️ Info | Missing examples |
| technical-voice.yaml | ✅ Pass | - |
| casual-voice.yaml | ✅ Pass | - |

## Quick Fixes

### Automated Fixes Available

These issues can be fixed automatically:

| # | Issue | File | Fix Command |
|---|-------|------|-------------|
| 1 | Deprecated field migration | team-profile.yaml | `config-validator --fix` |
| 2 | Add missing defaults | project.yaml | `config-validator --fix` |

Run `config-validator --fix` to apply automated fixes.

### Manual Fixes Required

These issues require manual intervention:

1. **project_type selection**: Choose appropriate value based on project
2. **Missing template**: Create or select correct template
3. **Voice examples**: Add custom examples matching your brand

## Recommendations

1. **Immediate**: Fix the error in `project.yaml` (blocking)
2. **Soon**: Update deprecated fields before next major version
3. **Recommended**: Add voice examples for better consistency

## Re-Validation

After fixes, re-run validation:
```
"validate config"
```

Expected result: All checks passing
```

## Usage Examples

### Full Validation

```
User: "Validate config"

Skill executes:
1. Scan for all config files
2. Validate syntax and schema
3. Check references
4. Generate report

Output:
"Configuration Validation Complete

Files Checked: 18
Errors: 1 (blocking)
Warnings: 3

Critical Issue:
❌ project.yaml: Missing required field 'project_type'

Warnings:
⚠️ team-profile.yaml: Deprecated field 'team_lead'
⚠️ artifacts.yaml: Template reference not found
⚠️ brand-voice.yaml: Missing recommended 'examples'

Quick Fix Available:
Run 'config-validator --fix' for automated fixes

Report: .aiwg/reports/config-validation.md"
```

### Specific File Validation

```
User: "Check team profile config"

Skill validates single file:
1. Parse team-profile.yaml
2. Validate against schema
3. Check references

Output:
"Team Profile Validation

File: .aiwg/team/team-profile.yaml
Status: ⚠️ Warning

Issues:
1. Deprecated field 'team_lead' on line 8
   - Current: team_lead: "Jane Smith"
   - New format: roles: [{ name: "Jane Smith", role: team_lead }]

All other fields valid."
```

### Auto-Fix

```
User: "Fix config issues"

Skill applies fixes:
1. Identify fixable issues
2. Apply transformations
3. Backup originals
4. Report changes

Output:
"Configuration Auto-Fix Applied

Fixed:
✅ team-profile.yaml: Migrated deprecated field
✅ project.yaml: Added default project_type

Backed up:
- .aiwg/backup/team-profile.yaml.bak
- .aiwg/backup/project.yaml.bak

Manual fixes still needed:
⚠️ artifacts.yaml: Create missing template

Re-validate to confirm."
```

## Integration

This skill uses:
- `project-awareness`: Find config files
- `artifact-metadata`: Track validation history

## Configuration

### Validation Strictness

```yaml
strictness:
  development:
    errors: block
    warnings: report
    info: report

  staging:
    errors: block
    warnings: block
    info: report

  production:
    errors: block
    warnings: block
    info: block
```

### Custom Schemas

```yaml
custom_schemas:
  location: .aiwg/config/schemas/
  format: json_schema_draft7
  auto_discover: true
```

## Output Locations

- Validation reports: `.aiwg/reports/config-validation.md`
- Fix backups: `.aiwg/backup/`
- Schema cache: `.aiwg/cache/schemas/`

## References

- Schema definitions: schemas/
- Config templates: templates/config/
- Migration guides: docs/config-migrations.md
