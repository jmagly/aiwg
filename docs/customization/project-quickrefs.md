---
title: Project Quickrefs
description: Define, generate, deploy, and validate a project-specific always-visible orientation skill.
---

# Project Quickrefs

A project quickref is a short orientation artifact for critical local
processes. It tells an agent which project workflow takes precedence and gives
it the stable IDs needed to search for and load the authoritative skill, agent,
command, or rule. It does not copy full workflow bodies into startup context.

## Managed discovery and operator input

By default, AIWG discovers validated bundles under
`.aiwg/{extensions,addons,frameworks,plugins,providers}/` and synthesizes one
bounded routing entry per bundle. This project-only skill remains separate from
the base `aiwg-utils-quickref`; repository capabilities never expand the base
quickref.

Commit `.aiwg/quickref.config.json` only when the inferred project identity or
generated routes need operator overrides:

```json
{
  "version": "1",
  "project": {
    "id": "acme-console",
    "name": "Acme Console",
    "description": "Repository-specific orientation for Acme Console."
  },
  "precedence": "Use listed project processes before generic AIWG workflows when they apply.",
  "entries": [
    {
      "title": "Issue handling",
      "summary": "Use the repository issue workflow before generic issue tooling.",
      "discover": ["project issue handling"],
      "show": [{ "type": "skill", "name": "project-issue-workflow" }]
    }
  ],
  "discovery": {
    "enabled": true,
    "excludeBundles": ["internal-experiment"],
    "overrides": {
      "team-tools": {
        "title": "Team workflows",
        "discover": ["repository team workflow"],
        "order": -10
      }
    }
  }
}
```

Operator configuration is never rewritten. AIWG writes the resolved definition
to `generated/project-quickref/definition.json` and the generated skill beside
it. Discovery fails closed: an invalid or colliding manifest does not replace a
last known-good generated or deployed quickref with partial output.

### Legacy v1 migration

Existing `.aiwg/quickref.json` files remain supported as complete legacy v1
definitions and take precedence over managed discovery. To migrate, rename the
operator-owned settings to `.aiwg/quickref.config.json`, retain `project`,
`precedence`, and curated `entries`, then add a `discovery` block. Preview the
merged result with `aiwg quickref generate --project --dry-run` before removing
the legacy file.

The `project.id` is kebab-case and forms the globally collision-resistant skill
name `aiwg-project-<id>-quickref`. Choose an organization-qualified id when a
provider uses a user-global skill root. Deployment refuses to replace an
operator-owned directory or a quickref with the same id owned by another local
project.

Each entry must include at least one `discover` phrase or `show` hint. Show
types are `skill`, `agent`, `command`, and `rule`.

## Generate and deploy

```bash
aiwg quickref generate --project --dry-run  # deterministic preview, no writes
aiwg quickref generate --project            # write expendable generated skill
aiwg quickref deploy --project              # all configured providers
aiwg quickref deploy --project --provider warp
```

Generation writes `generated/project-quickref/definition.json` and
`generated/project-quickref/<skill-name>/SKILL.md` under the configured artifact
root. Repeated generation is byte-identical for unchanged discovery and
configuration. `aiwg new-bundle` refreshes generated state, and
`aiwg use <project-local-bundle>` refreshes the selected provider copy.

Deployment resolves each target through the provider definition:

- project-scoped providers use their project kernel skill directory;
- user-global providers use their home kernel directory and the project id in
  the skill name prevents ambiguous unqualified names;
- aggregated providers such as Warp and Devin Desktop use their supported kernel
  skill target;
- providers without a kernel target use their defined skill surface as an
  explicit emulation target.

Every deployed directory includes an AIWG ownership marker. Redeployment may
prune stale quickrefs only when that marker identifies the same source project.
Files without the marker are operator-owned and are never deleted or replaced.

## Validation and precedence

`aiwg doctor --project-local` re-runs discovery without writing, validates
operator input, and compares the resolved definition with generated output and
configured-provider copies. Missing or changed copies are reported as drift.

Keep the quickref small. Its job is to make important local processes visible,
state explicit precedence, and point to indexed assets. Put detailed steps in
project-local skills or rules so startup context grows with the number of
critical routing decisions, not with the size of every workflow.

Managed generation caps the quickref at 50 bundle/curated entries and selects
at most eight supported `skill`, `agent`, `command`, or `rule` show hints per
bundle. The complete inventory remains available through the agent's indexed
capability search and asset loader; truncation is reported as a generation
diagnostic.
