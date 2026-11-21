# AIWG Framework Context

Framework for AI-augmented software development with structured agents, workflows, and artifact management.

## Active Framework

SDLC Complete — agents, commands, skills, and rules for full lifecycle coverage.

## Key Commands

- `aiwg status` — Show workspace health
- `aiwg use sdlc --provider devin` — Deploy SDLC framework for Devin Desktop
- `aiwg new-bundle <name> --type extension` — Scaffold a project-local bundle
- `aiwg doctor --project-local` — Health check project-local artifacts
- `aiwg promote <name>` — Graduate project-local bundle to upstream

## Customize Per Project

Author project-specific content bundles under `.aiwg/{extensions,addons,frameworks}/<name>/`. Use `.aiwg/plugins/<name>/` only for marketplace delivery wrappers. Discovered automatically by `aiwg use`.

```bash
aiwg new-bundle my-rules --type extension --starter rule
aiwg use my-rules
aiwg doctor --project-local
aiwg promote my-rules                           # graduate to upstream
aiwg promote my-rules --to corpus ~/my-corpus/  # or to private corpus
```

The bundle is byte-identical in shape to its upstream form, so `aiwg promote` is a hash-verified copy with no rewrite. See `docs/customization/README.md` for Path A (project-local), B (fork), C (corpus).

## Artifacts

All SDLC artifacts stored in `.aiwg/`.

## Rules

- No AI attribution in commits, PRs, or code
- CalVer versioning: YYYY.M.PATCH (no leading zeros)
- Never delete tests to make them pass
- Execute tests before returning code
