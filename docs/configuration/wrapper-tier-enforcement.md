# Wrapper tier enforcement

The parallelism section reports **generated wrapper defaults** for every
configured provider. This is an offline artifact contract, not an observation
of a running worker. Provider or account policy can substitute a model.

| Provider | Default model enforcement | Native effort on wrappers |
|---|---|---|
| Claude | pinned catalog model | `effort` |
| Codex | pinned catalog model | `model_reasoning_effort` |
| Factory | pinned catalog model | `reasoningEffort` |
| Copilot, Cursor, OpenCode | pinned catalog model | not enforced |
| OMP | inherited until exact role models are configured | `thinkingLevel` with a model pin |
| Antigravity | inherited; wrapper mirrors do not project CLI flags | not enforced |
| OpenClaw | inherited; Markdown mirrors do not set `subagents.model` | not enforced |
| OpenHuman | inherited/dynamic; user wrappers use hints, project wrappers omit model | not enforced |
| Windsurf | inherited from the UI session | not enforced |
| Pi, DeepSeek Harness | inherited; agent references do not set runtime controls | not enforced |
| Warp | global-only, run/profile model selection | not enforced |
| Hermes | global-only, delegation configuration | not enforced |
| Grokbot | global-only; no verified AIWG-owned model setting | not enforced |
| Muse | global-only, session `--model` or `settings.json` `model` | not enforced |
| Grok Build | inherited: Grok Build 1.0.77 ignores agent frontmatter `model:`; select worker models with `-m` | not enforced |

The native wrapper fields above are distinct from headless CLI invocation
flags. A provider can support explicit CLI models without consuming model
metadata in a deployed wrapper. AIWG does not change global provider settings
or environment variables to fill these gaps.

Claude orchestrators should select an AIWG wrapper or supply an explicit
invocation model. Unpinned built-in `general-purpose` agents can inherit a
flagship session. `CLAUDE_CODE_SUBAGENT_MODEL` supplies a fallback;
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` can override even explicit pins. Inspect
the resolved model when such environment or account policy is active.

All five pin-capable wrappers use catalog tiers. Cursor's `auto` economy
selector falls back to the concrete standard tier for both efficiency wrappers.
OMP's `configured/*` catalog entries are placeholders, so its default remains
reported as inherited; exact operator role overrides enable native pins.
Unsupported model/effort fields are not invented. Grok's configured selectors
remain available, but do not establish enforced catalog tiers under #2577.

Explicit `model-override`, role CLI/config pins, and exact source `model` IDs
are kept. Bare `opus`/`sonnet`/`haiku` values remain role intent. Existing
flagship election safeguards still reject unelected flagship overrides.

Reproduction before changes: existing wrapper/Codex tests passed (33 tests),
and new regression fixtures exposed wrapper-specific failures. Ordinary Codex unknown pins
were preserved already; canonical wrappers overwrote source-level pins.
Claude and OMP omitted effort, and Cursor's efficiency worker dropped `auto`
without a concrete fallback. The fixtures use translators and temporary
deployments, never paid calls. No Claude/Codex live dispatch was performed.
