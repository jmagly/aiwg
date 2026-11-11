---
namespace: aiwg
name: validate-addon
description: Validate an entire AIWG addon package for completeness and release readiness
platforms: [all]

---

# Validate Addon

You check an entire AIWG addon directory for completeness and release readiness, then produce a detailed structured report covering manifest integrity, artifact completeness, placement violations, and any blocking issues.

## Triggers

- "validate this addon" → check the addon in the current or named directory
- "is this addon ready to release" → run full release readiness check
- "check the <addon-name> addon" → validate the named addon
- "pre-release check on my addon" → run validate-addon
- "addon readiness report" → full validation with report output
- "validate addon at <path>" → validate the addon at the given path

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Current directory | "validate this addon" | Validate addon at cwd |
| Named addon | "check the aiwg-dev addon" | Find addon by name and validate |
| Path-specific | "validate addon at agentic/code/addons/my-addon" | Validate at given path |
| Release gate | "is this addon ready to release" | Full validation, block on any FAIL |
| Quick check | "any issues with this addon" | Run validation, summarize findings |

## Process

1. **Locate the addon**:
   - If path given: use it
   - If name given: check project-local `addons/<name>/manifest.json` under the configured artifact root and `agentic/code/addons/<name>/manifest.json`; if both exist, require an explicit path
   - If current directory: look for `manifest.json` in cwd or walk up to nearest addon root
   - Treat the located directory as the source root throughout this validation, including placement checks

2. **Read and validate `manifest.json`**:
   - File exists at addon root
   - Valid JSON (parseable)
   - Required fields present: `id`, `type`, `name`, `version`, `description`
   - `type` equals `"addon"`
   - `version` follows CalVer format (`YYYY.M.PATCH`, no leading zeros)
   - `core` field present (boolean; accept legacy `addonConfig.core` when absent at top level)
   - `autoInstall` field present (boolean; accept legacy `addonConfig.autoInstall` when absent at top level)
   - If `devOnly: true`: confirm this is intentional (it excludes from `aiwg use all`)
   - For project-local addons, also run `aiwg list --project-local` from the project root and check this manifest's diagnostics against the canonical bundle schema (`src/extensions/manifest.ts`). It requires `manifestVersion`, `platforms`, `keywords`, `deployment`, and `addonConfig` in addition to the common fields above. Preserve unknown-field and type errors; do not invent extra manifest fields to satisfy this skill.
   - Resolve artifact inventories from the top-level `skills`, `agents`, `rules`, and `flows` arrays, falling back to the corresponding `addonConfig` arrays for legacy manifests. Resolve directories from `addonConfig.entry` (or legacy `entry`), defaulting to `skills/`, `agents/`, `rules/`, and `flows/`. Apply these inventories and paths in steps 4–7.

3. **Check `README.md`**:
   - File exists at addon root
   - Non-empty content

4. **Validate each skill listed in manifest**:
   For each entry in `manifest.json` `skills` array:
   - `skills/<name>/SKILL.md` exists
   - `description:` frontmatter present
   - `# Title` section present
   - `## Behavior` or `## Process` section present
   - Collect any missing skills (in manifest but no SKILL.md) and orphaned skills (SKILL.md exists but not in manifest)

5. **Validate each agent listed in manifest**:
   For each entry in `manifest.json` `agents` array:
   - Agent `.md` file exists
   - YAML frontmatter present
   - `name:`, `description:`, `model:`, `tools:` fields in frontmatter
   - Collect missing and orphaned agents

6. **Validate each rule listed in manifest**:
   For each entry in `manifest.json` `rules` array:
   - `rules/<name>.md` exists
   - `RULES-INDEX.md` exists in `rules/`
   - Rule name appears in `RULES-INDEX.md`

7. **Validate flows**:
   - Resolve the flow directory from `addonConfig.entry.flows` (or legacy `entry.flows`), defaulting to `flows/`
   - Read each `.yaml` or `.yml` flow document in that directory, including nested directories; do not follow symlinks
   - Validate `FlowCapability` documents (`apiVersion: flow.aiwg.io/v1`) against the existing `$AIWG_ROOT/agentic/code/addons/aiwg-utils/workflow/schemas/workflow-capability.schema.json`; use the corresponding existing workflow schema for other Flow kinds and accepted legacy aliases
   - Require `metadata.name` and the schema-required `spec` fields; report malformed YAML or schema failures as blocking issues
   - If a `flows` inventory is declared (top-level first, then `addonConfig.flows`), match each name to `metadata.name`; collect missing declarations and orphaned documents. If no inventory is declared, enumerate the flow directory
   - For project-local addons, from the project root run `aiwg index build --graph project`, then `aiwg discover "<metadata.name>" --type flow` and `aiwg show flow <metadata.name>`; verify the flow is found and its card shows `Owner: addon:<id>`
   - Include a `Flows (<count>)` section with each flow name and PASS/FAIL status in the report

8. **Check for placement violations**:
   - Search corresponding provider directories (`.claude/skills/`, `.github/agents/`, etc.) for any files whose names match this addon's artifacts
   - For each match: verify a source file exists under the located addon source root (project-local or `agentic/code/`)
   - Flag any deployed files with no source as violations

9. **Check for `.aiwg/` references in addon artifacts**:
   - Search all SKILL.md, agent `.md`, and command `.md` files under the addon for `@.aiwg/` path references
   - Flag any found: these only resolve inside the AIWG repository itself

10. **Compile report**:

   ```
   Addon Validation: <addon-name> v<version>
   Path: agentic/code/addons/<name>/

   Manifest:
     PASS  manifest.json present and valid JSON
     PASS  required fields: id, type, name, version, description
     PASS  version format: 2026.4.0 (CalVer, no leading zeros)
     PASS  devOnly: true (excluded from `aiwg use all` — intentional)

   README:
     PASS  README.md present

   Skills (3 listed):
     PASS  validate-component: SKILL.md present, frontmatter complete
     PASS  validate-addon: SKILL.md present, frontmatter complete
     FAIL  dev-doctor: listed in manifest but SKILL.md missing

   Agents (0 listed):
     PASS  no agents declared

   Rules (4 listed):
     PASS  skill-placement: rule file present, in RULES-INDEX.md
     PASS  no-circular-skill-calls: rule file present, in RULES-INDEX.md
     PASS  component-completeness: rule file present, in RULES-INDEX.md
     FAIL  addon-boundaries: not found in RULES-INDEX.md

   Flows (1 found):
     PASS  screen-redesign: valid FlowCapability, discoverable as flow

   Placement violations:
     PASS  no orphaned deployed files found

   .aiwg/ references:
     PASS  no .aiwg/ path references in deployable artifacts

   Result: FAIL — 2 blocking issues

   Blocking issues:
     1. skills/dev-doctor/SKILL.md missing — create the file or remove from manifest
     2. addon-boundaries not in rules/RULES-INDEX.md — add an entry

   Warnings:
     none
   ```

11. **Report result**: Surface the structured report to the user. Highlight blocking issues in the summary line. For each failure, include the specific remediation step.

## Examples

### Example 1: Fully valid addon

**User**: "Is the aiwg-dev addon ready to release?"

**Output**:
```
Addon Validation: aiwg-dev v1.0.0
Path: agentic/code/addons/aiwg-dev/

Manifest:          PASS (all required fields, valid CalVer)
README:            PASS
Skills (3):        PASS (all present and complete)
Agents (0):        PASS
Rules (4):         PASS (all present and in RULES-INDEX.md)
Flows (0):         PASS
Placement:         PASS (no violations)
.aiwg/ refs:       PASS

Result: PASS — addon is release-ready
```

### Example 2: Addon with gaps found

**User**: "check the my-new-addon addon"

**Output**:
```
Addon Validation: my-new-addon v2026.4.0
Path: agentic/code/addons/my-new-addon/

Manifest:          PASS
README:            FAIL — README.md missing
Skills (2):
  PASS  my-skill: complete
  FAIL  other-skill: SKILL.md missing (listed in manifest but file not found)
Rules (1):         PASS
Placement:         WARN — .claude/skills/orphan-skill/ found with no agentic/code/ source

Result: FAIL — 2 blocking issues, 1 warning

Blocking issues:
  1. README.md missing — create at agentic/code/addons/my-new-addon/README.md
  2. skills/other-skill/SKILL.md missing — create the file or remove from manifest

Warnings:
  W1. .claude/skills/orphan-skill/ has no source in agentic/code/ — may be a placement violation
      See: agentic/code/addons/aiwg-dev/rules/skill-placement.md
```

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/rules/component-completeness.md — Completeness requirements per artifact type
- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/rules/skill-placement.md — Placement violation detection
- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/rules/addon-boundaries.md — .aiwg/ reference detection
- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/skills/validate-component/SKILL.md — Per-component validation
