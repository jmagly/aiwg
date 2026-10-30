# Composable output modes

Output modes are provider-neutral instructions for changing the language or presentation of generated content at runtime. They are sometimes called output masks. The implementation and CLI use the term **output mode**.

With no selected mode, the effective stack is `unaltered`: AIWG adds no instructions and performs no post-processing.

## Quick start

Inspect the available modes, select one for the current session, and verify the effective stack:

```bash
aiwg output-mode list
aiwg output-mode show wittgenstein-inspired
aiwg output-mode enable wittgenstein-inspired --scope session
aiwg output-mode status
```

Run one script-bearing skill with an invocation-only stack:

```bash
aiwg run skill <name> \
  --output-mode wittgenstein-inspired \
  --output-mode asd-ste \
  -- <skill-arguments>
```

Clean up session state when it is no longer wanted:

```bash
aiwg output-mode disable wittgenstein-inspired --scope session
aiwg output-mode clear --scope session
```

## Built-in modes

| ID | Kind | Purpose | Assurance |
|---|---|---|---|
| `unaltered` | presentation | Explicit no-op; the empty stack behaves the same way | advisory |
| `wittgenstein-inspired` | voice | Concise propositions, terms clarified in use, and category errors exposed | advisory |
| `asd-ste` | controlled language | Adapter for operator-supplied ASD-STE rules and terminology | advisory until a licensed ruleset and validator are configured |

Existing voice-framework profiles also appear in `aiwg output-mode list` through voice adapters.

The Wittgenstein-inspired mode is original general style guidance. It does not imitate Ludwig Wittgenstein and must not attribute generated text to him. The built-in ASD-STE mode does not contain or redistribute the standard.

## Scopes

| Scope | Lifetime | Storage | Typical use |
|---|---|---|---|
| invocation | one `aiwg run` call | not persisted | experiment or one-off deliverable |
| session | current workspace/session identity | temporary runtime directory | consistent output during a working session |
| project | until disabled | `.aiwg/output-modes.yaml` | shared project writing policy |

For the same mode ID, invocation selection takes precedence over session selection, which takes precedence over project selection. Profile definitions have a separate precedence order: project, user, adapted voice profile, then built-in.

Project profiles live in `.aiwg/output-modes/`. User profiles live in the `output-modes/` directory below the path reported by `aiwg config path`. This respects `AIWG_CONFIG` and AIWG's active user configuration rather than assuming a fixed home-directory path.

## What selection actually does

Output-mode processing has four distinct steps:

1. The registry loads and validates profiles.
2. Project, session, and invocation selections resolve into one ordered stack.
3. `aiwg run` exports that stack as `AIWG_OUTPUT_MODES` and `AIWG_OUTPUT_MODES_JSON`.
4. A participating skill, script, or provider adapter applies each profile's `instructions` and any configured validator.

Selecting a mode does not transparently intercept every terminal command or every response from an arbitrary AI provider. A consumer that ignores the runtime contract will not change its output. See [Integrating output modes](./output-mode-integration.md) when building or diagnosing a consumer.

## Composition and precedence

Modes execute deterministically by stage:

1. semantic
2. voice
3. controlled language
4. structure
5. presentation

Numeric `order`, then stable ID, break ties within a stage. Two selected modes of the same non-voice kind are rejected. Multiple voice modes require an explicit `weighted-voice` merge strategy. Explicit conflicts and missing requirements also stop resolution before state is saved or a child process starts.

Output modes are lower authority than user instructions, project policy, safety, factuality, accuracy, and citation requirements. They should change expression, not evidence or meaning.

## Protected content

A profile may protect these literal classes:

- `code`
- `commands`
- `citations`
- `quoted-text`
- `identifiers`
- `machine-readable-blocks`

The runtime replaces protected spans with opaque tokens before transformation and restores them afterward. Removing or duplicating a token fails closed. Protected-content masking is a guardrail, not a parser for every programming or markup language; consumers should add domain-specific tests for unusual formats.

## Continue

- [Author a custom syntax or house style](./custom-output-modes.md)
- [Integrate output modes into a script or provider adapter](./output-mode-integration.md)
- [Troubleshoot output modes](./output-mode-troubleshooting.md)
- [Output-mode profile schema](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/voice-framework/schemas/output-mode-profile.schema.json)
- [Voice framework overview](./overview.md)
