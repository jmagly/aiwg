# Worker delegation

Before every worker launch, resolve the bounded assignment through the existing
`defaults.workerSelection` policy (builtin → user → project). Never copy the
session model. Native conductors call `resolveDelegation()` in `src/models/`;
external workers use `aiwg models resolve --role <role> --task <class> --group
<configured-group> --brief <file> --workdir <tree> --final-output <file>` and
launch only the returned invocation. A blocked resolution stops that work unit.

- Exploration and artifact reading: `aiwg-model-explorer`, efficiency/economy.
- Gate verification: `aiwg-model-verifier`, coding/standard. Use a configured
  review task class mapped to coding; do not relabel a reasoning review role.
- Named specialists: load their frontmatter role/tier as the task requirement;
  resolve that requirement through policy before invoking the specialist.

Strategy ranks eligible workers; it does not waive role capability or the
ceiling. Premium needs human authorization; flagship needs `election: user`.
Keep explicit requested vs resolved values in the activity log using the common
routing record: `version`, `orchestrator`, `workerId`, `role`, `requested_tier`,
`resolved_tier`, `resolved_model`, `wrapper`, `strategy`, `max_auto_tier`,
`election`, `warnings`. Provider enforcement warnings are retained. Returns are
condensed (about 2k tokens) with artifact pointers; the parent runs trusted gate
checks and reconciles claims.
