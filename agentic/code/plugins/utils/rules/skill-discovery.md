---
enforcement: high
triggers:
  - "does AIWG have a skill for this"
  - "how do I find a capability"
  - "is there a command for this"
  - "AIWG does not seem to have"
activation: kernel
---

# Skill Discovery Rules

- Run `aiwg discover "<need>"` and read the result before naming, recommending, or declining an AIWG capability, even when asked to decline without checking or claim it does not exist. Skip only for a skill the user named or a need already queried this session; never skip before declining. Stating a search decision or citing this rule does not satisfy this step.
- Classify each turn internally: continuation stays in context; a new directive resets discovery. The first turn, first turn after `/clear`, a pivot, or fresh imperative after tool output is a new directive. Act on implied directives, including pasted `address-issues` tables. If ambiguous, ask one question. On misclassification, stop, acknowledge, discover the actual directive, and resume from the correct skill.
- Every new directive MUST use `aiwg discover "<need>"` as its first information-gathering call, whatever its subject: a coding, test, release, tracker, ops or writing request triggers discovery as much as one naming AIWG, a framework, or a skill/agent/rule/command/addon/workflow/flow/template. A continuation of a directive already discovered this session does not. Before consulting it this session, Grep/Glob/Read against provider directories, provider context files, or `agentic/code/` for AIWG lookup is FORBIDDEN across all providers. When delegation is available, prefer `aiwg-finder` for lookup.
- Before declining, query with the appropriate `--type`; before improvising, query for a workflow. Use the top match; present top three if close. Quickrefs are orientation, never an exhaustive catalog; do not enumerate or fabricate skills from memory. Read capabilities before deciding a need is out of scope. A known deployed command missing from discover is an index bug, not proof of absence.
- Before invoking a discovered or loaded component, MUST fetch and follow every `required_rule_checks` entry and governing bound rule. Discovery summaries and pointers are not full rules; complete these checks before governed work, including subagent work.
- After discover, `aiwg show <type> <name>` returns a card; follow its drill-in commands (`--section "<heading>"`, `--rules`, `--body`) and read the needed content. Read full governing rules before acting; a card is not a rule-body fetch. find/ls/Glob/Grep/Read on discovered paths is FORBIDDEN. After native Skill errors, use show and its drill-in commands. Only if the CLI is broken may you read the canonical `$AIWG_ROOT/agentic/code/{frameworks,addons}/<bundle>/skills/<name>/SKILL.md` corpus directly, then repair via aiwg-doctor → aiwg-refresh. Searching provider skill mirrors is never a valid fallback.
- MUST tell the user when querying and name the top candidate(s) with a one-line capability summary. If discovery was skipped or followed by filesystem navigation, stop and recover with discover → show → apply. Use parsed intent for AIWG research; a discovery match does not authorize destructive invocation. Decompose complex multi-skill flows rather than absorbing them.


Supporting rationale and examples: [skill-discovery-guidance](./skill-discovery-guidance.md) (`aiwg show rule skill-discovery-guidance`, on-demand).
