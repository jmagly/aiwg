# Flow: `aiwg run skill <name>`

[Architecture](index.md) · [Authoring an executable skill](extending-cli.md)

Script dispatch is entirely driven by the indexed `script` frontmatter. There are
no issue-audit or aiwg-pr path exceptions. Their declared wrapper scripts bridge
to the installed native owners in the same way any other Node skill can.

```mermaid
sequenceDiagram
  actor A as Operator or harness
  box Local CLI process boundary
    participant H as runHandler
    participant M as skills/run main
    participant R as runSkill
    participant I as Artifact metadata readers
    participant T as Runtime registry
  end
  box Child process boundary: user's permissions
    participant C as Declared script interpreter
  end
  A->>H: run skill name -- args
  H->>H: extractOutputModes and resolveOutputModes
  H->>M: main(parsed args, output mode environment)
  M->>M: parse kind, name, --cwd and argument separator
  M->>R: runSkill(cwd, name, args, override, env)
  R->>I: findSkillEntry across framework, project, codebase
  I-->>R: matching entry and script metadata
  alt Unknown skill or no script declaration
    R-->>A: diagnostic and exit 1
  else Script-bearing skill
    R->>R: resolveSkillDir; check script.entrypoint exists
    R->>T: resolveRuntime(runtime, entrypointPath)
    T-->>R: interpreter and prefixArgs, or unsupported runtime
    R->>R: choose CWD and AIWG_* environment
    R->>C: spawn(interpreter, prefixArgs + entrypoint + args)
    C-->>A: inherited stdin, stdout and stderr
    C-->>R: exit code, signal or spawn error
    R-->>H: normalized exit status
    H-->>A: handler result
  end
```

Drawn from:

- [`src/cli/handlers/run.ts`](../../../src/cli/handlers/run.ts): `runHandler.execute`, `extractOutputModes`.
- [`src/skills/run.ts`](../../../src/skills/run.ts): `main`, `runSkill`, `findSkillEntry`, `resolveSkillDir`.
- [`src/skills/runtime.ts`](../../../src/skills/runtime.ts): `resolveRuntime`, `supportedRuntimes`.
- [`src/artifacts/fortemi-core-query-adapter.ts`](../../../src/artifacts/fortemi-core-query-adapter.ts): `loadFortemiCoreMetadataEntries`.
- [`src/artifacts/index-reader.ts`](../../../src/artifacts/index-reader.ts): metadata loading exports.
- [`agentic/code/frameworks/sdlc-complete/skills/issue-audit/scripts/audit.mjs`](../../../agentic/code/frameworks/sdlc-complete/skills/issue-audit/scripts/audit.mjs): native audit bridge.
- [`agentic/code/addons/aiwg-utils/skills/aiwg-pr/scripts/deliver.mjs`](../../../agentic/code/addons/aiwg-utils/skills/aiwg-pr/scripts/deliver.mjs): native delivery bridge.

Framework paths beginning `agentic/code/` resolve against `AIWG_ROOT`; project
paths resolve against the caller's project. Stable artifact IDs, indexed names,
paths and skill-directory names can select a skill. When matches share a name,
the runner prefers one with a script declaration.

`script.cwd` defaults to `project-root`; alternatives are `skill-dir` and
`aiwg-root`. `--cwd <path>` overrides it. The child receives `AIWG_SKILL_DIR`,
`AIWG_PROJECT_ROOT`, `AIWG_ROOT` when known, and resolved output-mode policy.
Runtimes include Node, Python, Bash, sh, PowerShell, Ruby and extension/shebang
selection via `auto`. A spawn failure returns 127. The child process is an
execution boundary, not a permissions sandbox.
