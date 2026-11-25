---
namespace: aiwg
name: dev-mode-init
description: Switch AIWG CLI to dev mode (local repo source), rebuild, deploy dev tools, and run a health check — all via the Steward agent
platforms: [all]

---

# Dev Mode Init

You activate AIWG dev mode, rebuild the local source, deploy the developer toolkit, and run a dev health check. All operations go through the AIWG Steward agent and CLI — no direct file writes.

## Triggers

- "switch to dev mode" → full dev mode bootstrap
- "aiwg --use-dev" → full dev mode bootstrap
- "run aiwg from my local checkout" → full dev mode bootstrap
- "activate dev mode" → full dev mode bootstrap
- "use local repo source" → switch CLI to dev + build
- "switch back to stable" → deactivate dev mode
- "rebuild and redeploy dev" → build + redeploy aiwg-dev without switching mode

> `aiwg use dev` is not dev mode: it installs the ops DevOps extension (`dev`). Dev mode is `aiwg --use-dev <path>`; the developer toolkit is `aiwg use aiwg-dev`.

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Full init | "switch to dev mode" | All steps |
| From repo path | "use dev mode at ~/dev/aiwg" | Switch + build from path |
| Stable | "switch back to stable" | `aiwg --use-stable` |
| Rebuild only | "rebuild dev" | Build + redeploy, skip mode switch |
| Check mode | "am I in dev mode?" | `aiwg version` + report |

## Process

### Step 1 — Resolve repo path

If the user supplied a path, use it. Otherwise default to the current working directory.

```bash
# Verify the target looks like the AIWG repo
ls package.json src/ agentic/ 2>/dev/null
```

If `package.json` is not found, stop and report: "Directory does not appear to be an AIWG repo — no package.json found."

### Step 2 — Switch CLI to dev mode

```bash
aiwg --use-dev <resolved-path>
```

Expected output confirms: `Switched to dev mode. Dev repo: <path>`

If already in dev mode pointing at the same path, skip and note "already in dev mode".

### Step 3 — Build local source

```bash
# TypeScript compile + web app build
npm run build
```

On failure: report the tsc or vite error, stop, and suggest running `npm run build` manually to see full output. Do not proceed past a broken build.

On success: note build time and output sizes (xterm, index bundles).

### Step 4 — Deploy aiwg-dev addon (with Steward)

```bash
aiwg use aiwg-dev
```

This deploys:
- Steward agent (via aiwg-utils dependency)
- Dev rules (skill-placement, no-circular-skill-calls, component-completeness, addon-boundaries)
- Dev skills (dev-doctor, devkit-create-*, devkit-validate, devkit-test)

### Step 5 — Dev health check

Invoke dev-doctor for a fast structural check:

```bash
# TypeScript gate (already passed in step 3, but double-check deployed state)
npx tsc --noEmit
```

Then trigger `/dev-doctor` or report inline:

```bash
# Run dev doctor sections 1–3 (structure, orphans, placement)
# Full run happens via aiwg dev-doctor or the dev-doctor skill
```

### Step 6 — Report

```markdown
## Dev Mode Init — Complete

**Mode**: dev [active]
**Repo**: <path>
**Build**: <duration> — xterm <size>, index <size>
**Deployed**: aiwg-dev (steward + dev tools)

### Status
- CLI mode:    ✓ dev
- Build:       ✓ clean (0 errors)
- Deployment:  ✓ aiwg-dev
- TypeScript:  ✓ passes

### Available
- `@aiwg-steward` — upgrade, sync, health check, capability routing
- `/dev-doctor` — structural health check
- `/devkit-create-*` — scaffolding tools
- `aiwg serve --no-open` + `cd apps/web && npm run dev` — live dashboard

### To switch back
`aiwg --use-stable`
```

## Deactivation (switch back to stable)

When user requests stable mode:

```bash
aiwg --use-stable
```

Report: "Switched back to stable npm package. Run `aiwg sync` to ensure frameworks are current."

## Examples

### Example 1: Full bootstrap from repo root

**User**: "switch to dev mode"

**Action**:
1. Detect CWD is `/home/user/dev/aiwg` with `package.json` present
2. Run `aiwg --use-dev /home/user/dev/aiwg`
3. Run `npm run build` — succeeds in 8s
4. Run `aiwg use aiwg-dev`
5. Run `npx tsc --noEmit` — 0 errors

**Output**:
```
Dev Mode Init — Complete

Mode: dev [active] — /home/user/dev/aiwg
Build: 8.2s — xterm 291KB, index 246KB
Deployed: aiwg-dev (steward, 5 rules, 11 skills)
TypeScript: 0 errors

@aiwg-steward is ready. Use it for upgrades, syncs, and health checks.
```

### Example 2: Path specified

**User**: "activate dev mode at ~/dev/aiwg"

**Action**: Run `aiwg --use-dev ~/dev/aiwg` → build → deploy → doctor

### Example 3: Already in dev mode

**User**: "switch to dev mode"

**Aiwg version shows**: `2026.4.0-rc.26  [dev]  path: /home/user/dev/aiwg`

**Action**: Skip step 2. Still run build (source may have changed) and redeploy.

**Output**: "Already in dev mode. Rebuilding and redeploying..."

### Example 4: Broken build

**User**: "switch to dev mode"

**npm run build fails** with TypeScript errors

**Output**:
```
Dev Mode Init — BLOCKED

Step 3 (build) failed. Fix TypeScript errors before proceeding.

Errors:
  src/serve/pty-bridge.ts(210,5): error TS2345: ...

Run `npm run build` to see full output.
Dev mode flag was set — run `aiwg --use-stable` to revert if needed.
```

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-dev/skills/dev-doctor/SKILL.md — Dev structural health check
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/agents/aiwg-steward.md — Steward agent (maintenance + upgrades)
- @$AIWG_ROOT/docs/development/aiwg-development-guide.md — Full dev workflow guide
- @$AIWG_ROOT/docs/development/dev-testing.md — Dev testing patterns
