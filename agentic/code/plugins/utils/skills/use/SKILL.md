---
namespace: aiwg
name: use
platforms: [all]
kernel: true
description: Deploy AIWG frameworks and addons to the current workspace across supported providers
---

# AIWG Use

You deploy AIWG frameworks and addons to the current workspace.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "set up sdlc" → deploy sdlc-complete framework
- "add the marketing framework" → deploy media-marketing-kit
- "activate rlm" → deploy rlm addon
- "scaffold the writing framework" → deploy voice-framework addon
- "get the ring methodology" → deploy ring-methodology addon

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Framework deploy | "use sdlc" | Run `aiwg use sdlc` |
| Addon deploy | "use the ralph addon" | Run `aiwg use ralph` |
| Provider-scoped deploy | "deploy sdlc to copilot" | Run `aiwg use sdlc --provider copilot` |
| Source deploy | "deploy from local source" | Run `aiwg use sdlc` (source installs are detected automatically) |
| Kernel surface | "deploy the kernel" | Run `aiwg use all` |

## Behavior

Any removal list requires explicit human review of the listed removals before execution.
Authorization lookup must never bypass that review, even with a receipt for other effects.

When triggered:

1. **Extract intent**:
   - Which framework or addon is requested? (resolve shorthand: "sdlc" → `sdlc-complete`, "marketing" → `media-marketing-kit`, "forensics" → `forensics-complete`, "research" → `research-complete`, "curator" → `media-curator`)
   - Is a specific provider mentioned? Default is the detected active provider.
   - Source installs are detected automatically; no development flag is needed.

2. **Resolve the target**:

   **Frameworks:**
   | Shorthand | ID |
   |-----------|-----|
   | sdlc | sdlc-complete |
   | marketing | media-marketing-kit |
   | forensics | forensics-complete |
   | research | research-complete |
   | curator | media-curator |

   **Addons:**
   | Shorthand | ID |
   |-----------|-----|
   | ralph | ralph |
   | rlm | rlm |
   | ring | ring-methodology |
   | voice | voice-framework |
   | writing | writing-quality |
   | testing | testing-quality |
   | utils | aiwg-utils |

3. **Run the appropriate command**:

   ```bash
   # Deploy a framework (default provider)
   aiwg use sdlc

   # Deploy an addon
   aiwg use ralph

   # Deploy to a specific provider
   aiwg use sdlc --provider copilot

   # Deploy the kernel surface (kernel skills, kernel and core rules, behaviors)
   aiwg use all
   ```

4. **Report the result** inline — confirm what was deployed, where, and any warnings about missing dependencies.

The canonical SDLC target is `sdlc`; `sdlc-complete` is accepted as a compatibility alias. Source checkouts are detected automatically from their `.git` entry.

Use `--dry-run` for one consolidated plan with each planned action listed once. `--copy-all` restores the full agent, command, skill and rule surface for `all`.

Unknown options fail with exit code 2; run `aiwg use --help` for usage.

## Examples

### Example 1: Deploy the SDLC framework

**User**: "use sdlc"

**Extraction**: Framework `sdlc-complete`, default provider

**Action**:
```bash
aiwg use sdlc
```

**Response**: "Deployed sdlc-complete to claude-code. Agents written to `.claude/agents/`, commands to `.claude/commands/`, rules to `.claude/rules/`. Registered in `.aiwg/frameworks/registry.json`."

### Example 2: Deploy to a specific provider

**User**: "deploy the sdlc framework to GitHub Copilot"

**Extraction**: Framework `sdlc-complete`, provider `copilot`

**Action**:
```bash
aiwg use sdlc --provider copilot
```

**Response**: "Deployed sdlc-complete to copilot. Agents written as `.github/agents/*.agent.md`, commands to `.github/prompts/`, rules to `.github/instructions/`."

### Example 3: Deploy an addon

**User**: "activate the ring methodology addon"

**Extraction**: Addon `ring-methodology`, default provider

**Action**:
```bash
aiwg use ring-methodology
```

**Response**: "Deployed ring-methodology addon to claude-code. 7 rules installed to `.claude/rules/`."

### Example 4: Deploy the kernel surface

**User**: "deploy the kernel"

**Extraction**: Kernel surface

**Action**:
```bash
aiwg use all
```

**Response**: "Deployed the kernel surface to claude-code: kernel skills, kernel and core rules, and behaviors. Full framework artifacts remain available through discovery; deploy a named framework to install its full surface."

## Clarification Prompts

If the user's intent is ambiguous:

- "Which framework would you like to deploy? Available: sdlc-complete, media-marketing-kit, forensics-complete, research-complete, media-curator"
- "Should I deploy to the current provider (claude-code) or a different one?"

## References

- @$AIWG_ROOT/src/cli/handlers/use.ts — Use command handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference
- @CLAUDE.md — Multi-platform provider table
