---
namespace: aiwg
name: workspace-reset
platforms: [all]
description: Wipe .aiwg/ directory and optionally restart with fresh intake
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


# Workspace Reset

Completely wipe the `.aiwg/` directory to start fresh. Optionally backs up existing content and can reinitialize with fresh intake templates.

## Parameters

| Flag | Description |
|------|-------------|
| `project-directory` | Project root (default: `.`) |
| `--backup` | Create timestamped backup before wiping |
| `--keep-intake` | Preserve `.aiwg/intake/` directory |
| `--keep-team` | Preserve `.aiwg/team/` directory (team profile, assignments) |
| `--reinitialize` | Run intake wizard after reset |
| `--force` | Skip confirmation prompts |
| `--dry-run` | Preview what would be deleted |

## Use Cases

1. **Project Pivot** - Requirements changed significantly, need fresh start
2. **Framework Upgrade** - Clean slate for new AIWG version
3. **Corrupted State** - Artifacts became inconsistent
4. **Learning Project** - Experimented, ready to start properly
5. **Handoff Cleanup** - Removing trial work before official start

## Execution Steps

### Step 1: Analyze Current State

Inventory what will be deleted:

```bash
# Count files by category
echo "=== Workspace Contents ==="
for dir in .aiwg/*/; do
  count=$(find "$dir" -type f 2>/dev/null | wc -l)
  size=$(du -sh "$dir" 2>/dev/null | cut -f1)
  echo "$(basename "$dir"): $count files ($size)"
done
```

Report:
```
Workspace Reset Analysis
========================

Current .aiwg/ contents:
  intake/        3 files    (12 KB)
  requirements/ 15 files    (45 KB)
  architecture/ 12 files    (78 KB)
  planning/      8 files    (23 KB)
  risks/         4 files    (8 KB)
  testing/       7 files    (34 KB)
  security/      5 files    (15 KB)
  team/          2 files    (4 KB)
  working/       9 files    (28 KB)
  archive/      14 files    (56 KB)
  reports/       6 files    (19 KB)
  ─────────────────────────────────
  TOTAL:        85 files   (322 KB)

Git Status:
  Tracked:     45 files (committed)
  Untracked:   40 files (local only)
```

### Step 2: Confirm Destruction

Unless `--force` is provided, require explicit confirmation:

```
╔════════════════════════════════════════════════════════════════╗
║                    ⚠️  DESTRUCTIVE OPERATION ⚠️                  ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  This will DELETE 85 files (322 KB) from .aiwg/               ║
║                                                                ║
║  Including:                                                   ║
║    - All requirements (15 files)                              ║
║    - All architecture documents (12 files)                    ║
║    - All planning artifacts (8 files)                         ║
║    - All test documentation (7 files)                         ║
║    - All security artifacts (5 files)                         ║
║    - All archived content (14 files)                          ║
║    - All reports (6 files)                                    ║
║                                                                ║
║  45 files are committed to git and can be recovered.          ║
║  40 files are NOT in git and will be PERMANENTLY LOST.        ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝

Options:
  --backup    Create backup before deletion
  --keep-intake    Preserve intake forms
  --keep-team      Preserve team profile

Type 'RESET' to confirm deletion: _
```

### Step 3: Create Backup (if requested)

**If `--backup` flag:**

```bash
# Create timestamped backup
backup_dir=".aiwg-backup-$(date +%Y%m%d-%H%M%S)"
cp -r .aiwg "$backup_dir"

# Create backup manifest
cat > "$backup_dir/BACKUP_MANIFEST.md" <<EOF
# .aiwg Backup

**Created:** $(date -Iseconds)
**Reason:** Workspace reset
**Commit:** $(git rev-parse HEAD 2>/dev/null || echo "N/A")

## Contents

$(find .aiwg -type f | wc -l) files backed up

## Restore Command

\`\`\`bash
rm -rf .aiwg && cp -r $backup_dir .aiwg
\`\`\`
EOF

echo "Backup created: $backup_dir"
```

Report:
```
Backup Created
==============
Location: .aiwg-backup-20251209-102345/
Files:    85
Size:     322 KB

To restore: rm -rf .aiwg && cp -r .aiwg-backup-20251209-102345 .aiwg
```

### Step 4: Preserve Requested Content

**If `--keep-intake`:**
```bash
# Stash intake
mv .aiwg/intake /tmp/aiwg-intake-preserve
```

**If `--keep-team`:**
```bash
# Stash team
mv .aiwg/team /tmp/aiwg-team-preserve
```

### Step 5: Execute Wipe

```bash
# Remove .aiwg directory
rm -rf .aiwg

# Report
echo "Removed: .aiwg/ (85 files, 322 KB)"
```

### Step 6: Restore Preserved Content

```bash
# Recreate .aiwg
mkdir -p .aiwg

# Restore intake if preserved
if [ -d /tmp/aiwg-intake-preserve ]; then
  mv /tmp/aiwg-intake-preserve .aiwg/intake
  echo "Restored: .aiwg/intake/"
fi

# Restore team if preserved
if [ -d /tmp/aiwg-team-preserve ]; then
  mv /tmp/aiwg-team-preserve .aiwg/team
  echo "Restored: .aiwg/team/"
fi
```

### Step 7: Reinitialize (if requested)

**If `--reinitialize` flag:**

Create minimal structure and offer intake wizard:

```bash
# Create standard directories
mkdir -p .aiwg/{intake,requirements,architecture,planning,risks,testing,security,working,archive,reports}

# Create README
cat > .aiwg/README.md <<'EOF'
# AIWG Workspace

This directory contains SDLC artifacts managed by the AIWG framework.

## Structure

| Directory | Purpose |
|-----------|---------|
| intake/ | Project intake forms |
| requirements/ | User stories, use cases, NFRs |
| architecture/ | SAD, ADRs, diagrams |
| planning/ | Phase and iteration plans |
| risks/ | Risk register and spikes |
| testing/ | Test strategy, plans, results |
| security/ | Threat models, security artifacts |
| working/ | Temporary multi-agent work |
| archive/ | Historical documents |
| reports/ | Generated reports |

## Getting Started

Run `intake-wizard` to begin project intake.
EOF
```

Report:
```
Workspace Reinitialized
=======================

Created directories:
  .aiwg/intake/
  .aiwg/requirements/
  .aiwg/architecture/
  .aiwg/planning/
  .aiwg/risks/
  .aiwg/testing/
  .aiwg/security/
  .aiwg/working/
  .aiwg/archive/
  .aiwg/reports/

Created files:
  .aiwg/README.md

Run /intake-wizard to start fresh intake.
```

### Step 8: Report Summary

```
Workspace Reset Complete
========================

Deleted:
  85 files (322 KB)

Backup:
  .aiwg-backup-20251209-102345/ (322 KB)

Preserved:
  .aiwg/intake/ (3 files)
  .aiwg/team/ (2 files)

Reinitialized:
  10 directories created
  .aiwg/README.md created

Next Steps:
  1. Run /intake-wizard to start fresh intake
  2. Or run /intake-from-codebase to analyze existing code
  3. Previous backup available at .aiwg-backup-20251209-102345/
```

## CLI Usage (Outside Claude Session)

This command is also available via the `aiwg` CLI:

```bash
# Wipe working directory only
aiwg -wipe-working

# Full workspace reset with backup
aiwg -reset-workspace --backup

# Force reset without confirmation
aiwg -reset-workspace --force

# Reset but keep intake forms
aiwg -reset-workspace --keep-intake

# Reset and reinitialize
aiwg -reset-workspace --reinitialize
```

## Examples

```bash
# Preview what would be deleted
/workspace-reset --dry-run

# Full wipe with backup
/workspace-reset --backup

# Keep intake and team, backup rest
/workspace-reset --backup --keep-intake --keep-team

# Force reset and reinitialize
/workspace-reset --force --reinitialize

# Clean slate with preserved intake
/workspace-reset --backup --keep-intake --reinitialize
```

## Error Handling

| Condition | Action |
|-----------|--------|
| No .aiwg/ directory | Info: "No workspace to reset. Use /intake-wizard to create one." |
| Backup location exists | Append unique suffix |
| Permission denied | Abort with error |
| Git dirty with untracked | Warn about permanent loss of untracked files |
| Preserve dir missing | Skip preservation, warn |

## Safety Features

1. **Confirmation Required** - Must type 'RESET' unless --force
2. **Backup Option** - Always offered, strongly recommended
3. **Git Warning** - Warns about untracked files that will be permanently lost
4. **Preserve Options** - Can keep critical files (intake, team)
5. **Dry Run** - Preview before destructive action

## Related Commands

- `workspace-realign` - Sync docs with project state (non-destructive)
- `workspace-prune-working` - Clean up working directory only
- `intake-wizard` - Start fresh intake after reset

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/README.md — aiwg-utils addon overview
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — Explicit confirmation required before destructive reset
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/vague-discretion.md — Concrete confirmation prompt and safety checks
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC artifact directory structure recreated on --reinitialize
