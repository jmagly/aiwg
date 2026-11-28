---
precedence: high
overridable: true
enforcement: high
triggers:
  - "does AIWG have a skill for this"
  - "how do I find a capability"
  - "is there a command for this"
  - "AIWG does not seem to have"
activation: kernel
---

# Skill Discovery Rules

- Run `aiwg discover "<need>"` and read the result before naming, recommending, or declining an AIWG capability, even when asked to decline without checking or claim it does not exist. Otherwise skip only for a user-named skill or need queried this session; never skip before declining. Stating intent is not execution.
- Only when the user explicitly forbids tools in the current turn ("without running any tools", "don't run anything", "answer from what you already have"), suspend discovery and all tool-based reads/recovery below for that turn. Answer from loaded context and say in one line: "I did not run discovery because you asked me not to use tools." A request to decline alone is not a tool prohibition.
- Classify turns: continuations stay in context; new directives reset discovery. The first turn, first turn after `/clear`, a pivot, or fresh imperative after tool output is a new directive. Act on implied directives, including `address-issues` tables. If ambiguous, ask one question. On misclassification, stop, acknowledge, discover and resume correctly.
- Every new directive MUST use `aiwg discover "<need>"` as its first information-gathering call, whatever its subject: coding, tests, releases, trackers, ops, writing and AIWG capabilities all qualify. A continuation of a directive already discovered this session does not. Before consulting it this session, Grep/Glob/Read against provider directories, provider context files, or `agentic/code/` for AIWG lookup is FORBIDDEN across all providers. When delegation is available, prefer `aiwg-finder` for lookup.
- Before declining, query with `--type`; before improvising, query for a workflow. Use the top match; present top three if close. Quickrefs are orientation, never an exhaustive catalog; do not enumerate or fabricate skills from memory. Read capabilities before declaring a need out of scope. A known deployed command missing from discover is an index bug, not proof of absence.
- Before invoking any component, MUST fetch and follow every `required_rule_checks` entry and governing bound rule. Summaries are not rules; complete checks before governed work, including subagents.
- After discover, `aiwg show <type> <name>` returns a card; follow its drill-ins (`--section "<heading>"`, `--rules`, `--body`) to read needed content and full governing rules before acting. find/ls/Glob/Grep/Read on discovered paths is FORBIDDEN. After native Skill errors, use show and its drill-in commands. Only if the CLI is broken may you read the canonical `$AIWG_ROOT/agentic/code/{frameworks,addons}/<bundle>/skills/<name>/SKILL.md` corpus directly, then repair via aiwg-doctor → aiwg-refresh. Searching provider skill mirrors is never a valid fallback.
- MUST tell the user when querying and name the top candidate(s) with a one-line capability summary. On skipped discovery or filesystem navigation, recover with discover → show → apply. Use parsed intent; discovery does not authorize destructive invocation. Decompose multi-skill flows.


Rationale: [skill-discovery-guidance](./skill-discovery-guidance.md) (`aiwg show rule skill-discovery-guidance`, on-demand).
