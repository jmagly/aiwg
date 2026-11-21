# Scope Precedence

When the same framework is installed at both project scope (`.claude/`)
and user scope (`~/.claude/`), the AI platform decides which one
takes effect. AIWG mirrors that resolution and surfaces drift through
`aiwg doctor`.

## TL;DR

**Project scope wins.** Any artifact present in the project deploy
shadows the user-scope copy of the same name. The user-scope copy
remains intact and will be visible again the moment the project deploy
is removed (or a different project is opened).

## Why This Order

The host platforms drive the policy — AIWG follows it.

- **Claude Code**: scans `.claude/` first, then `~/.claude/`. Same-name
  artifacts in the project shadow the user copy. Documented at
  [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)
  and [/sub-agents](https://code.claude.com/docs/en/sub-agents).
- **Cursor**: project `.cursor/rules/` takes precedence over the
  user-scope rules path (per Cursor's MDC discovery rules).
- **OpenCode / Warp / Devin Desktop / Factory**: similar
  project-first-then-user resolution; AIWG records the user-scope
  paths in `USER_SCOPE_PATHS` but the platforms perform the actual
  shadow.

The behavior is consistent enough across providers that AIWG doesn't
try to enforce a different precedence — operators get whatever their
host platform does.

## Mental Model

Think of user scope as your **default** and project scope as your
**override**:

```
~/.claude/skills/sdlc-accelerate     ← default (user-scope deploy)
{repo-A}/.claude/skills/...          ← repo A uses defaults
{repo-B}/.claude/skills/sdlc-accelerate ← repo B overrides with a custom version
```

In repo A, the platform falls through to the user-scope deploy. In
repo B, the project deploy shadows it. This matches how shell
`PATH`-style resolution works in most tooling.

## Implications

### Pinning Versions

Use user scope as the place to pin a specific framework version
that should be your global default:

```bash
aiwg use sdlc --provider claude --scope user        # user-scope: 2026.5.0
cd project-A && aiwg use sdlc --provider claude     # project: 2026.5.0
cd project-B && aiwg use sdlc --provider claude     # project: 2026.6.0-beta.1
```

Project A and B each pick the project deploy; the user-scope deploy
isn't reached. Open a third project that doesn't have `.claude/`
populated and the user-scope `2026.5.0` is what's visible to Claude.

### Project-Local Overrides

Project-local bundles (`aiwg new-bundle`) deploy to project scope by
default. When a project-local bundle and a user-scope artifact have
the same name, the project-local copy shadows. This makes it easy to
override a single agent or skill per project without disturbing
your global default.

See [`from-fork-to-project-local.md`](./from-fork-to-project-local.md).

### Safety-Critical Override

Project-scope artifacts can shadow upstream cleanly. AIWG enforces a
denylist on safety-critical artifacts (security rules, license
checks): shadowing them requires an explicit `overrides:` declaration
in the project-local manifest. `--force` does not bypass the
denylist. See [adr-override-shadow-policy.md](https://github.com/jmagly/aiwg/blob/main/.aiwg/architecture/adr-override-shadow-policy.md).

This denylist applies the same way regardless of scope — a
project-scope deploy can't silently shadow a safety-critical
upstream artifact, and neither can a project-scope deploy silently
shadow a safety-critical user-scope artifact.

## Detecting Shadows

`aiwg list --shadows` (project-scope) shows project-local bundles
that shadow upstream. There's no equivalent dedicated command for
"user-scope shadowed by project-scope" because the host platform's
discovery handles the resolution and there's no AIWG-side manifest
that captures the shadow.

If you want to audit what your platform is actually using:

```bash
# What's at project scope?
aiwg list --provider claude

# What's at user scope?
aiwg list --scope user

# Compare manually — if a name appears in both, project wins.
```

`aiwg doctor --scope user` validates that user-scope artifacts still
exist on disk; it doesn't try to predict which scope your platform
will resolve at runtime.

## Refresh Behavior

`aiwg refresh` defaults to refreshing the project-scope deploy. To
refresh both:

```bash
aiwg refresh                      # project scope only
aiwg refresh --scope user         # user scope only (TBD — tracked in #1156)
```

Until dual-scope refresh ships, run `aiwg use` twice — once with
`--scope project` (default) and once with `--scope user`.

## When Versions Diverge

If project scope is on framework version X and user scope is on Y:

- Inside the project: X is what's used
- Outside the project (or in any other project that doesn't have
  `.claude/` populated): Y is what's used

`aiwg doctor` doesn't currently warn about version skew between
scopes. It will when the doctor `--scope user` validation gains a
cross-scope comparison pass. Tracked under #1156.

## Related

- [`user-scope-deployment.md`](./user-scope-deployment.md) — Operator
  guide to `--scope user`
- [`README.md`](./README.md) — Customization paths overview
- ADR-4 — Scope flag, path map, precedence policy
