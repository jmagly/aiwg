# Protect local-only conductor inputs

Declare literal project-relative files or directory subtrees in the existing
`models.json` worker data policy before starting a cloud conductor:

```json
{
  "defaults": {
    "workerSelection": {
      "dataClasses": {
        "local-only": {
          "allowedProcessing": ["local"],
          "localOnlyPaths": ["eval-work/local.txt", "private-inputs"]
        }
      }
    }
  }
}
```

`dataPolicy.localOnlyPaths` also works without a named data class. Parallelism
groups and group templates accept the same field in their existing `dataPolicy`.
Paths are literal, slash-separated, project-relative names using letters, digits,
`_ . @ + , -`. Absolute paths, globs, spaces and `.`/`..` components are rejected.
Files and all descendants of declared directory paths are protected.

Deploy the project's Claude or Codex provider with the normal `aiwg use` workflow
**before opening task inputs**, then inspect worker readiness in `aiwg doctor`.
Deployment collects the union of base, named-class, group and template paths,
including inherited model policy. An empty project list cannot remove inherited
paths. All declarations apply regardless of the current task's selected class;
the deployer does not guess a conductor's processing locality from its model name.
Local workers that need these inputs must use separately configured local contexts.
Changes require redeployment and a provider session that loads the new settings.
Existing Claude denies are retained conservatively; removing all declarations
retains previously deployed guards until an operator removes them explicitly.

Claude deployment merges absolute `Read(...)` deny rules into
`.claude/settings.json` and installs a project-local PreToolUse hook. The hook
refuses explicit file/path tool arguments and literal Bash references, including
compound commands such as `ls && cat eval-work/local.txt | head`. It resolves
relative paths against the tool event's cwd and checks existing symlink aliases
without reading protected contents. It also matches unquoted Bash glob components
(`*`, `?`, `[...]` and `**`) against protected path names and subtrees, including
loops such as `for f in eval-work/*.txt; do cat "$f"; done`. Common recursive
ancestor searches (`grep -r`, `rg` and `find`, including `find ... -exec cat`)
are refused, with the event cwd used for implicit search roots. A plain
`ls eval-work`, an unrelated literal file and a glob such as `eval-work/*.json`
that cannot match a protected `eval-work/local.txt` remain allowed. Quoted or
escaped wildcard characters are literal. Operator permissions and hooks are
preserved; malformed hook events are refused.

Worker execution checks are **opt-in**, defaulting to `false`. Enable them in
the shared project policy (`models.json`) through the existing guards object:

```json
{
  "defaults": {
    "workerSelection": {
      "guards": { "denyConductorWorkerExecution": true }
    }
  }
}
```

Worker trees qualified separately need this guard flag in their project policy
too. Qualification binds the full worker-selection policy: after a change, align
the conductor and worker policies, then run
`aiwg doctor --probe-workers --qualify` in each separately qualified worker tree.
Qualifying only the conductor cannot refresh worker-tree approvals. Passing
invocation checks in a worker tree does not establish a match with the
conductor's policy.

Redeploy Claude with the normal `aiwg use` workflow. This installs the same hook
even without local-only declarations; `parallelism.worker_dispatch` alone does
not enable execution checks. Inherited explicit restrictions cannot be relaxed.
Setting the flag to `false` or removing it and redeploying disables a previous
execution opt-in while retaining local-only read protections. When on,
it denies conductor commands that
execute or import worker output and directs them to
`aiwg ralph-external --verify-worker`. Worker trees are discovered per event from
the repository's existing Git worktree metadata (excluding this conductor tree)
and the existing `.aiwg/working/worktrees` directory. Registered trees remain
untrusted after the worker stops; other registered checkouts are conservatively
treated as worker trees too, so enable this only where that matches the project
policy for other checkouts. A host calling `conductorToolDenial` directly can
supply its active worker tree paths as the optional fourth argument, including
custom snapshot/copy locations. No launch record or worker claim authorizes code
execution by the conductor.

The execution check recognizes common runtimes and test runners, literal `cd`
changes, inline shell commands, and process/resource wrappers such as `nice` and
`systemd-run`. It refuses inline Node/Python imports referencing worker paths and
copy-then-execute commands within the same tool event. Resource-only systemd
scopes are not isolation and receive no exemption. Normal `git diff`, source
reads and digest inspection remain allowed unless a local-only rule forbids the
read. The installed verifier entry point stays allowed; its protected check and
isolation policy govern execution.

Codex deployment writes `.codex/rules/aiwg-local-only.rules` with forbidden
`prefix_rule` entries for explicit `cat`, `head`, `tail`, `less`, `more`, `sed`,
`awk`, `grep` and `rg` commands whose first argument is a declared relative,
`./`-relative or absolute path. These require a Codex version/session that loads
trusted project rules. They do not restrict native file-reading tools. Options
before the path, descendant arguments and shell wrappers are outside these exact
prefix rules; do not treat their presence as filesystem containment.

These guards prevent the reported explicit reads and worker execution patterns,
with glob, common recursive search and execution coverage in Claude only. They
are not a sandbox; strong enforcement requires the harness boundary to prevent
direct execution/import of worker output outside trusted verification. Variable-built
paths, other shell indirection (including brace expansion and command substitution),
wildcard symlink aliases, hardlink aliases, encoded programs, unrecognized recursive
readers or tools, disabled hooks/rules, policy tampering and filesystem races can
bypass them. The hook checks names and filesystem metadata, never protected file
contents, and does not interpret a full shell program. Local-only read checks do
not follow changes of directory within it. Custom unregistered snapshot/copy
locations and code copied in an earlier tool event are outside automatic worker
discovery. Even Claude's hook can conservatively refuse a benign command that
merely mentions a protected path or searches an ancestor with exclusion filters.
Keep sensitive data outside the cloud conductor's accessible filesystem when
comprehensive containment is needed.
A task label or `allowedProcessing: ["local"]` alone cannot identify filesystem
paths; declare those paths before exploration instead of opening files to classify
them.

Existing implementation owners:

- `src/models/worker-selection-policy.ts`: validates data policy/classes and merges
  inherited restrictions; `src/models/provider-policy.ts` applies class restrictions
  to worker processing facts during selection, after conductor exploration.
- `src/config/worker-parallelism.ts`: existing per-group data policy;
  `src/config/worker-group-templates.ts`: inheritance and group narrowing.
- `tools/agents/providers/claude-post-deploy.mjs`: existing settings/context owner,
  extracted from `claude.mjs`; `src/mcp/tool-filters.mjs`: existing Claude deny merges.
- `tools/agents/providers/codex.mjs`: conventional project rules deployment;
  `conductor-data-guard.mjs`: compiles the new explicit command-prefix restrictions.
