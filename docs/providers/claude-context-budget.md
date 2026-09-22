# Claude Code Context Budget Rules

AIWG Claude-facing artifacts must fit standard Claude Code Sonnet usage. Do not
design skills, commands, or subagents around a 1M-context account.

This note complements the listing-budget troubleshooting guide. Listing budgets
cover the cost of skill names and descriptions at startup. This note covers two
further costs: the **aggregate startup context** Claude Code inlines on every
session, and the **runtime cost** after a skill or subagent is invoked.

The standard Claude Code Sonnet window (`claude-sonnet-5`) is **200,000
tokens**. The 1M window is a premium tier gated behind usage credits. When the
required context exceeds the standard window, Claude Code upgrades to the 1M
tier; on accounts without 1M credits that upgrade is rejected
(`Usage credits required for 1M context`), and on standard-only accounts it
surfaces as immediate `Context limit reached` after the first few actions.

## Startup Context Budget (root cause of #1672)

Claude Code inlines the following into every session before any user prompt:

- the base Claude Code system prompt and tool definitions,
- `CLAUDE.md` and its `@`-includes (`AIWG.md`, `.aiwg/AIWG.md`), plus `AGENTS.md`,
- every file in `.claude/rules/*.md` (full body),
- **each ancestor directory's `CLAUDE.md` and `.claude/rules/*.md`** — a project
  nested under a workspace with its own deployment starts with both sets,
- the name + description of each listed skill and agent.

Measured on a full `aiwg use all` deployment (June 2026), before the inline rule
budget shipped, the AIWG-controlled portion alone was **~193K tokens** against
the 200K window:

| Component | ~Tokens | Share |
|-----------|---------|-------|
| `.claude/rules/*.md` (95 files, unbudgeted) | ~170K | 88% |
| `AIWG.md` + `CLAUDE.md` + `AGENTS.md` + `.aiwg/AIWG.md` | ~24K | 12% |

With only ~7K of headroom left for the base system prompt, tool definitions, and
skill/agent listings, a fresh in-repo session exceeded the standard window before
work began — which is what produced the #1672 exhaustion, and later the
`Prompt is too long` subagent-dispatch failures of #2562.

### The inline rule budget

Rule deployment now reconciles `.claude/rules/` against a **64K-token inline
budget** after every deploy pass. HIGH rules beyond the budget move on demand —
never CRITICAL, never the generated indexes — are recorded in
`.claude/rules/.aiwg-rules-budget.json`, skipped by later passes, and listed in
`RULES-ONDEMAND.md` under "Binding rules moved on demand to fit the inline
budget" with their `aiwg show rule <name>` fetch hint. **They remain binding**;
only their delivery changes from always-on to on-demand.

| Control | Effect |
|---------|--------|
| `AIWG_RULES_INLINE_BUDGET_TOKENS=<tokens>` | Set the budget (default `64000`) |
| `AIWG_RULES_INLINE_BUDGET_TOKENS=0` | Disable budgeting; inline every always-on rule |

Bounding individual workflows remains necessary but is not sufficient on its own.
Measure the startup surface with `npm run lint:claude-context -- --startup`, and
check dispatch headroom with `aiwg doctor` — its **Subagent Dispatch** check
fails when the inlined surface leaves no room for a Task dispatch, and names the
ancestor contribution when one applies.

## Sources

- Claude Code skills: <https://code.claude.com/docs/en/skills>
- Claude Code subagents: <https://code.claude.com/docs/en/sub-agents>
- Anthropic context engineering guidance:
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Issue #1672 research spike:
  `.aiwg/research/reports/issue-1672-claude-context-exhaustion-spike.md`

## Budget Model

Claude Code uses progressive disclosure for skills: the listing exposes skill
metadata first, then the full `SKILL.md` body enters context when invoked. Once a
skill body is loaded, it becomes recurring session cost.

Subagents isolate noisy work only if they return concise summaries. A subagent
that reads broadly and returns detailed findings still pushes a large result
back into the parent conversation.

Custom subagents can also load extra context at startup. Treat a `skills:` field
in a subagent definition as a preload: it can inject full skill bodies before the
subagent does any work.

## Required Rules

1. Keep Claude-facing skill bodies concise. Use supporting files for long
   examples, templates, checklists, and domain reference material.
2. Start workflows with cheap scope discovery: `git status --short`,
   `git diff --name-only`, `git diff --cached --name-only`, `rg --files`, and
   targeted `find` commands.
3. Do not launch broad parallel subagent waves before scope is known.
4. Cap subagent concurrency. Default to two workers for broad repository work and
   never exceed four without a specific reason.
5. Cap subagent returns. For audit-style workflows, return at most 10 findings
   and 600 words to the parent context; write detailed evidence to files.
6. Avoid subagent `skills:` preloads unless the cost is justified in the file.
7. Prefer built-in Explore/Plan or a forked/isolated skill context for broad
   reconnaissance when the parent session only needs a summary.
8. Keep commit, release, and blog synthesis as handoffs between bounded steps.
   Do not chain broad doc sync, monthly history review, and commit/push into one
   unbounded skill body.

## Artifact Patterns

### Skill Entry Point

The main `SKILL.md` should contain:

- purpose and trigger phrases,
- required inputs,
- scope-discovery commands,
- bounded workflow steps,
- output contract,
- links to supporting files.

Move these out of the main body:

- large examples,
- exhaustive tables,
- reusable templates,
- long checklists,
- provider matrices,
- historical notes.

### Subagent Prompt

Every broad subagent prompt should include:

```text
Inspect only these paths: ...
Return at most 10 findings and 600 words.
Write detailed evidence to .aiwg/working/<workflow>/...
Do not load additional skills unless explicitly instructed.
```

### Release or Blog Workflows

For requests like "docSync code2doc, make sure the blog covers the month, then
commit-and-push":

1. Run doc sync on changed or scoped files first.
2. Treat blog/release coverage as one bounded lane using changed files plus
   month-bounded git history.
3. Return a handoff summary for `commit-and-push`.
4. Commit only after the user or surrounding workflow confirms the review gate.

## Checks

Use:

```bash
npm run lint:claude-context              # startup budget + per-artifact inventory
npm run lint:claude-context -- --startup # startup budget only
npm run lint:context-firewall            # cross-provider trust, drift, and memory gate
```

The check reports the aggregate startup-context budget (memory files + deployed
`.claude/rules/*`) against the 200K standard window, then inventories
Claude-facing skills and agents by approximate token size and startup behavior.
It flags:

- startup context over (or near) the standard Sonnet budget,
- oversized skill bodies,
- subagent `skills:` preloads,
- broad parallel-dispatch wording,
- unbounded or detailed output instructions.

`--strict` exits non-zero on per-artifact violations or when startup context is
over budget.

The context firewall complements this Claude-specific size check. It reports
memory, rules, skill listings, agents, generated bridges, and project-local
context independently; compares deployed bytes with packaged source bytes; and
requires reviewed trust labels in strict mode. See the
[context/memory firewall guide](../security/context-memory-firewall.md).

For the live #1672 repro gate, use:

```bash
npm run validate:claude-context
```

The harness runs the exact issue prompt in a disposable copy with remotes removed
and mutation tools denied. It pins the standard-context variant
(`claude-sonnet-5`) rather than a bare `sonnet` alias, because a bare alias
inherits the parent session's 1M-context attribute and is rejected by the
usage-credit gate before the model runs. It requires an authenticated Claude Code
account and returns distinct exit codes:

| Exit | Meaning |
|------|---------|
| 0 | model ran without context exhaustion |
| 1 | other failure |
| 2 | authentication missing (`/login`) |
| 3 | context exhaustion (`Context limit reached`) |
| 4 | blocked by a credit/rate-limit gate (environment cannot validate) |

Exit 4 is itself a signal: if the harness is credit-blocked on a tiny prompt
inside the repo, the startup context is forcing the 1M upgrade — run
`--startup` to confirm and reduce the deployed standing context.
