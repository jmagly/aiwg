# Skill Namespace Migration Guide

This guide covers the invocation changes introduced by the AIWG skill namespace strategy
(ADR: `.aiwg/architecture/adr-skill-namespace-strategy.md`).

---

## What Changed and Why

AIWG skills previously deployed with short, unqualified slugs (`/sync`, `/run`, `/doctor`).
These names collide with platform built-ins, git/shell commands, and skills from other packages.

The new canonical invocation slug is `aiwg-{name}` for all skills that do not already carry
the `aiwg-` prefix. Skills already named `aiwg-*` (e.g., `aiwg-sync`, `aiwg-status`) are
**not** double-prefixed — slug computation is idempotent.

All AIWG skills now declare `namespace: aiwg` in their SKILL.md frontmatter for ownership
attribution and MCP SEP-986 registry alignment.

---

## Affected Skills — Old → New Slug

The following skills have short names that are now prefixed. Update any saved muscle memory
or documented invocations.

| Old slug | New canonical slug | Notes |
|----------|--------------------|-------|
| `/doctor` | `/aiwg-doctor` | `doctor` is also a Claude Code built-in; prefer new slug |
| `/help` | `/aiwg-help` | `help` is a Claude Code built-in; prefer new slug |
| `/list` | `/aiwg-list` | |
| `/run` | `/aiwg-run` | |
| `/update` | `/aiwg-update` | |
| `/use` | `/aiwg-use` | |
| `/version` | `/aiwg-version` | |

Skills already carrying the `aiwg-` prefix are unchanged:

| Slug | Status |
|------|--------|
| `/aiwg-sync` | Unchanged — already namespaced |
| `/aiwg-status` | Unchanged — already namespaced |
| `/aiwg-refresh` | Unchanged — already namespaced |
| `/aiwg-guide` | Unchanged — already namespaced |
| `/aiwg-kb` | Unchanged — already namespaced |
| `/aiwg-regenerate` | Unchanged — already namespaced |
| `/aiwg-regenerate-*` | Unchanged — already namespaced |
| `/aiwg-setup-*` | Unchanged — already namespaced |
| `/aiwg-update-*` | Unchanged — already namespaced |

---

## Claude Code steward collision (2.1.331+)

Invoke `/aiwg-steward-routing` on Claude Code.
`aiwg-steward-routing` is unrelated to Claude Code's built-in `/steward` (PR Steward).
Other providers keep `steward`. The source directory remains `skills/steward/`,
with shared identifier `steward` and declared Claude alias `aiwg-steward-routing`.
`aiwg show skill steward` and `aiwg discover "steward"` still resolve the skill;
`steward` is a lookup alias only on Claude, never a deployed folder.
Both `.claude/skills/steward/` and `.claude/skills/babysit/` are reserved: Claude
Code 2.1.331 PR Steward reads their `SKILL.md` as project PR instructions.
Managed `babysit` copies are archived outside native skills under
`.claude/.aiwg-reserved-skill-backups/`; unmanaged guidance stays untouched
and deploy prints a notice that PR Steward reads it.

Run `aiwg refresh --skip-update --provider claude` to migrate managed project
and user copies. Only directories with `.aiwg-managed` move. Original bytes
are retained under `aiwg-steward-routing/.aiwg-backup-steward/`; non-conflicting
resources also remain at their original relative paths. Archived `SKILL.md` files
use an `.original` suffix so Claude cannot load them. Unmanaged directories
are untouched. An unmanaged replacement or an existing migration backup causes
a clear error; the managed reserved folder is archived outside native skills
before stopping so it cannot become PR Steward instructions.

## Migration Steps

### 1. Re-deploy with the new namespaced layout

```bash
aiwg use sdlc
aiwg use all    # or whichever frameworks you have installed
```

This deploys skills to the new `aiwg/` subdirectory layout and uses the prefixed slugs.

### 2. Verify deployment

```bash
aiwg doctor
```

The health check will report any skills still deployed at old flat paths.

### 3. Optional: restore short aliases

If you want `/sync`, `/run`, etc. to continue working as aliases (and no platform conflict
exists), opt in at deploy time:

```bash
aiwg use sdlc --aliases
```

Short alias creation is suppressed automatically when a conflict is detected — you will see
a warning identifying which names were skipped.

### 4. Clean up old flat-path deployments

Old skills deployed at flat paths (`.claude/skills/sync/`, `.claude/skills/run/`, etc.) are
not forcibly removed. To clean them up:

```bash
aiwg migrate-workspace   # moves flat-deployed AIWG skills to namespaced paths
```

---

## Slug Computation Rules (for extension authors)

When `namespace: aiwg` is present in a SKILL.md, the deployment engine computes the
canonical slug as follows:

```
canonical_slug = name starts with "{namespace}-" ? name : "{namespace}-{name}"
```

This is **idempotent**: a skill named `aiwg-sync` with `namespace: aiwg` keeps the slug
`aiwg-sync`, not `aiwg-aiwg-sync`.

---

## Platform Deployment Paths

| Platform | New skill path | Devin Desktop (1-level limit) |
|----------|---------------|--------------------------|
| Claude Code | `.claude/skills/aiwg/{slug}/SKILL.md` | N/A |
| Cursor | `.cursor/skills/aiwg/{slug}/SKILL.md` | N/A |
| OpenCode | `.opencode/skills/aiwg/{slug}/SKILL.md` | N/A |
| Devin Desktop | `.windsurf/skills/{slug}/SKILL.md` | flat — no subdir |
| Universal | `.agents/skills/aiwg/{slug}/SKILL.md` | N/A |

---

## Timeline

| Release | What happens |
|---------|-------------|
| This release | New `aiwg-{name}` slugs are canonical; old short slugs still work if re-deployed |
| Next release | Old short-slug deployments emit a deprecation warning on `aiwg use` |
| +1 release | Old flat-path deployments are removed by default on `aiwg use` |

---

## References

- ADR: `.aiwg/architecture/adr-skill-namespace-strategy.md`
- Extension types: `docs/extensions/extension-types.md` — SkillMetadata.namespace
- Issue #695 — Namespace strategy design decision
- Issue #697 — Deployment path changes
- Issue #698 — Collision detection implementation
