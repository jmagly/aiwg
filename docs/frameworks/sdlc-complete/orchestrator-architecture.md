# SDLC Orchestrator Architecture

## Purpose

AIWG maps natural-language SDLC requests to canonical skills, then coordinates the work with the active provider's native capabilities. The architecture is provider-neutral: no deployed command directory or provider-specific agent tool defines workflow behavior.

## Authority Model

```text
User intent
  -> sdlc-quickref (always-loaded routing)
  -> aiwg discover "<capability>"
  -> aiwg show skill <name> --body
  -> canonical SKILL.md
  -> referenced playbook/templates/rules
  -> provider-native execution
  -> .aiwg/ artifacts and gate evidence
```

Authority descends from the canonical skill into explicitly referenced executable playbooks, templates, and rules. Generated slash commands are adapters or compatibility shims. A deployed command may invoke a workflow but does not supersede its skill.

## Discovery and Selection

1. Apply `sdlc-right-sizing` so small work does not accidentally expand into a full lifecycle flow.
2. Consult the kernel-resident `sdlc-quickref` for common capability domains.
3. When the exact skill is not already identified, run `aiwg discover "<need>"`.
4. Surface the selected result and fetch it with `aiwg show skill <name> --body`.
5. Read the complete skill and required referenced resources before execution.

Do not enumerate the workflow catalog from memory and do not inspect `.claude/commands/flow-*.md` as the primary source.

## Natural-Language Mapping

| User intent | Discovery phrase |
|---|---|
| Transition to Elaboration | `SDLC transition to Elaboration` |
| Run a security review | `SDLC security review cycle` |
| Create an architecture baseline | `SDLC architecture baseline` |
| Run an iteration | `SDLC iteration dual track` |
| Assess current project progress | `project status` |

Explicit adapter input such as `/flow-inception-to-elaboration` maps to the same-named canonical skill and follows that skill's current contract.

## Execution Model

The selected skill declares inputs, outputs, gates, constraints, and references. Some skills reference a machine-readable playbook that carries executable sequence and gate semantics. Providers should honor that contract using their available primitives.

For collaborative artifact work, a skill may use this logical pattern:

```text
Primary Author -> Separate Initial Reviews -> Synthesizer -> Baseline/Archive
```

The mechanics vary by provider. Claude may expose a `Task`-style API, Codex may expose collaboration primitives, and other providers may execute or emulate the pattern differently. Steward/provider guidance determines the mechanism. Independent work can run concurrently within configured caps; dependent work remains sequential.

## Evaluator evidence

Agreement is not proof, including same-vendor and cross-vendor agreement. Consequential claims require an executable check or accountable human acceptance. Prefer independent voting, or structured review with diverse initial answers and calibrated confidence, over plain debate. Record observed evaluator model/vendor/family, acceptance criteria reference, generator/evaluator disagreements and a re-review link after material fixes. Do not claim reduced human-review time. See `$AIWG_ROOT/docs/decision/evaluator-calibration.md` for calibration and REF-2922, REF-2923, REF-2919/2921 public sources.

## Artifacts and Gates

- Stage temporary work under the locations declared by the skill, commonly `.aiwg/working/<workflow>/`.
- Write final artifacts to their appropriate `.aiwg/` category.
- Maintain requirements-to-code-to-test-to-deployment traceability.
- Preserve human-authorization requirements and phase gates.
- Report progress, decisions, blockers, verification evidence, and final artifact paths.

## Adapter Contract

Provider adapters must:

1. Resolve to the corresponding canonical skill.
2. Preserve declared parameters such as `--guidance` or `--interactive` only when the skill supports them.
3. Avoid embedding divergent workflow behavior.
4. Be regenerated or corrected when they conflict with the canonical skill.

Adapters may be retained for convenience and backward compatibility. They are not the authoring surface for new workflow behavior.

## Maintenance Checks

When changing orchestration behavior:

- Update the canonical skill or referenced playbook first.
- Keep `sdlc-quickref`, discovery metadata, and rules aligned.
- Regenerate assembled project context and provider adapters.
- Verify `aiwg discover` and `aiwg show skill` expose the intended contract.
- Search active assets for command-first or provider-specific guidance that contradicts the authority model.

## References

- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/sdlc-quickref/SKILL.md`
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/orchestrate-project/SKILL.md`
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/sdlc-orchestration.md`
- `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/skill-discovery.md`
- `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/steward/SKILL.md`
