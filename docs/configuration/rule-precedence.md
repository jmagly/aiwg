# Rule precedence

Rule frontmatter separates instruction ordering from delivery and severity:

| Field | Values | Default |
| --- | --- | --- |
| `precedence` | `critical`, `high`, `medium`, `low` (the `RULE_PIN_TIERS` vocabulary) | `medium` |
| `overridable` | boolean | `true` |
| `enforcement` | `critical`, `high`, `medium`, `low` | optional |

Every shipped kernel/core rule declares both ordering fields. `no-attribution`,
`anti-laziness` and `human-authorization` ship critical precedence and
`overridable: false`. The former `block` enforcement spelling on civic-action
and network-analysis rules is normalized to `critical`; their directives remain
in their source bodies.

A skill follows its bound rules. Between rules, higher precedence wins; at equal
precedence, narrower scope wins. When resolving a conflict, name the rule followed.
Platform constraints stay absolute and the general context layer order is unchanged.
Precedence is instruction-level guidance; it does not execute rules or resolve
arbitrary semantic contradictions at runtime.

Optional project ordering lives in `.aiwg/aiwg.config`, under the existing
`rules` object:

```json
{
  "rules": {
    "precedence": {
      "citation-policy": { "tier": "high" },
      "project-style": { "tier": "low", "project_context": true }
    }
  }
}
```

Each non-empty override object accepts `tier`, `project_context`, or both.
`project_context: true` lets WORKSPACE.md project context outrank that named rule;
`false` retains the normal rule ceiling. IDs must resolve to exactly one rule,
using its slug, source name, or stable discovery ID. Unknown or ambiguous rules
are errors. Duplicate aliases for the same rule in one scope are errors.
An override of a non-overridable rule always fails with its name, even when
assigning its existing tier or setting `project_context: false`.

```bash
aiwg config set --project rules.precedence.citation-policy '{"tier":"high"}'
aiwg config get --project rules.precedence
aiwg show rule citation-policy
aiwg discover "citation policy" --type rule
aiwg rules list --scope workspace
```

The same existing user config surface supports `rules.precedence`. User entries
apply first; project fields override user fields for the same rule. An omitted
field retains the lower layer's value. `precedence_source` identifies the last
scope contributing an override (`rule`, `user`, or `project`). Ordering changes
never alter activation or pinning. Regenerate context after changes to refresh
the configured ordering listed in WORKSPACE.md. Both generated WORKSPACE.md and
AIWG.md describe the rule/skill resolution policy.

Rule lint validates all three metadata fields. Its conflict warning is deliberately
conservative: rules must declare matching `subject` or `subjects` metadata and
contain literal opposite directives, such as `Always add attribution.` and
`Never add attribution.`, at equal effective precedence. Other semantic conflicts
still require review; no warning is not proof of consistency.
