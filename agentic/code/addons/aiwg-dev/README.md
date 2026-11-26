# AIWG Developer Tools

Evidence status: design intent.

Tools for **developing and extending AIWG**: dev mode (run AIWG from a local checkout instead of the installed copy), scaffolding, validation, and source-structure checks. It is for AIWG contributors and for users who customize AIWG from their own checkout. Its rules help people building AIWG itself, AIWG addons, and AIWG extensions avoid common structural mistakes.

This addon is **intentionally excluded from `aiwg use all`** and must be installed explicitly.

> Naming note: `aiwg use dev` is a different bundle (the ops DevOps extension). Dev mode is `aiwg --use-dev <path>`; this toolkit is `aiwg use aiwg-dev`.

---

## Installation

```bash
aiwg --use-dev <path-to-aiwg-checkout>   # optional: run AIWG from your local checkout (dev mode)
aiwg use aiwg-dev                        # install the developer toolkit
```

Install it where you develop or customize AIWG. Projects that only use deployed AIWG frameworks do not need it.

---

## What It Provides

### Rules (6)

| Rule | Priority | Purpose |
|------|----------|---------|
| `skill-placement` | HIGH | Prevent accidental file placement in `.claude/` or provider dirs instead of `agentic/code/` |
| `no-circular-skill-calls` | HIGH | Prevent infinite loops from skills that call back into their own CLI command |
| `aiwg-ci-safety` | HIGH | Require explicit human authorization before changing AIWG's own CI; keep deployable CI templates in framework source |
| `component-completeness` | MEDIUM | Ensure each artifact type has all required files before sharing |
| `addon-boundaries` | MEDIUM | Enforce the `agentic/code/` vs `.aiwg/` source/output boundary |
| `aiwg-dir-reference-contract` | MEDIUM | Use manifest-derived project paths and `$AIWG_ROOT` references in distributable artifacts |

### Skills (13)

| Skill | Purpose |
|-------|---------|
| `dev-mode-init` | Switch the AIWG CLI to dev mode (local checkout), rebuild, deploy the toolkit, and run a health check |
| `dev-doctor` | Development-focused health check of the AIWG repository structure |
| `devkit-create-addon` | Alias of `scaffold-addon` — Create a standalone addon. |
| `devkit-create-agent` | Alias of `add-agent` — Create an agent inside an addon or framework. |
| `devkit-create-command` | Alias of `add-command` — Create a command inside an addon or framework. |
| `devkit-create-extension` | Alias of `scaffold-extension` — Create an extension inside a parent framework. |
| `devkit-create-framework` | Alias of `scaffold-framework` — Create a complete lifecycle framework. |
| `devkit-create-skill` | Alias of `add-skill` — Create a skill inside an addon or framework. |
| `devkit-validate` | Validate addon, framework, or extension structure and manifest |
| `devkit-test` | Test an AIWG package for structure, functionality, and deployment readiness |
| `validate-component` | Check a single skill, agent, or command for completeness and correctness |
| `validate-addon` | Check an entire addon directory for release readiness |
| `link-check` | Verify `@file` references in skills and agents against the linking contract |

---

## Why This Exists

AIWG is a dogfooding project — it uses itself to build itself. That creates some traps that regularly catch contributors:

- **Placement trap**: Creating a SKILL.md in `.claude/skills/` directly. That directory is a deployment target; files placed there are overwritten on the next `aiwg sync`. Skills must live in `agentic/code/addons/<name>/skills/`.
- **Circular skill trap**: Marking a command `executedViaSkillRunner: true` while the SKILL.md says "run `aiwg <same-command>`". The TypeScript handler is removed, so the CLI call has nowhere to land — infinite loop.
- **Boundary confusion**: Putting framework schemas or templates in `.aiwg/` because it looks like a config directory. `.aiwg/` is project output for THIS project's development; nothing in it ships to users.
- **Incomplete components**: Sharing a skill that has a SKILL.md but is not listed in the addon manifest, or a rule that has no RULES-INDEX.md entry.

The rules in this addon encode these lessons so contributors get caught by their tool before they file a broken PR.

---

## Excluded from `aiwg use all`

The `devOnly: true` flag in `manifest.json` signals to the deployment pipeline that this addon must not be included in `aiwg use all`. It is only deployed when explicitly requested:

```bash
aiwg use aiwg-dev        # Install
aiwg remove aiwg-dev     # Remove
```

Projects that only use deployed AIWG frameworks do not need this toolkit.

---

## References

- `agentic/code/addons/aiwg-utils/` — Core utilities addon (style reference)
- `docs/development/aiwg-development-guide.md` — Full contributor guide
- `docs/extensions/creating-extensions.md` — Extension creation walkthrough
- `src/extensions/types.ts` — Extension type definitions
