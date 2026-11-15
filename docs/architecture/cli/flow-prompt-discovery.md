# Flow: prompt-time discovery hook

[Architecture](index.md) · [Discovery internals](discovery.md)

The managed hook injects a short discovery instruction at prompt time. It calls
the compiled discovery API in a worker thread, without launching the CLI. Hook
availability and event translation depend on the provider installer.

```mermaid
sequenceDiagram
  actor H as AI harness
  box Hook subprocess boundary
    participant P as aiwg-prompt-discovery.cjs main
    participant G as Input filters and runtimeModule
    participant B as Budget timer and finish
    participant C as contextFor
  end
  box Worker thread boundary: same user permissions
    participant W as Worker
    participant Q as discoverCapability
    participant I as Local metadata and relations
  end
  H->>P: stdin JSON user prompt event
  P->>B: start total deadline before reading stdin
  P->>G: check opt-out, event/role, size and shouldDiscover
  G-->>P: eligible prompt and compiled runtime URL, or no-op
  P->>W: create worker with prompt and project cwd
  W->>Q: promptContext=true, offline=true, local, limit=3
  Q->>I: read available graphs and shipped relations without building
  I-->>Q: capability candidates
  Q-->>W: JSON discovery envelope
  W-->>P: parentPort message; stdout/stderr captured
  alt Result before deadline
    P->>C: validate scores and identifiers; build bounded context
    C-->>P: strong candidates or explicit discovery instruction
    P-->>H: provider-shaped context JSON
    P->>B: finish; terminate worker and exit 0
  else Timeout, worker error or malformed input
    B->>W: terminate if started
    B-->>H: exit 0 without blocking prompt submission
  end
```

Drawn from:

- [`agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs`](../../../agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs): `main`, `runtimeModule`, `shouldDiscover`, `contextFor`, `finish`.
- [`src/artifacts/query-engine-discover.ts`](../../../src/artifacts/query-engine-discover.ts): `discoverCapability` and `readOnly` branch.
- [`src/extensions/claude-hooks-installer.ts`](../../../src/extensions/claude-hooks-installer.ts): `managedClaudeHooks`, `installAiwgHooks`.
- [`src/extensions/muse-managed-hooks.ts`](../../../src/extensions/muse-managed-hooks.ts): `promptDiscoveryHook`, `managedMuseHooks`.
- [`src/smiths/hook-bridge/hermes-prompt-discovery.ts`](../../../src/smiths/hook-bridge/hermes-prompt-discovery.ts): Hermes bridge generation.
- [`src/smiths/hook-bridge/factory-translator.ts`](../../../src/smiths/hook-bridge/factory-translator.ts): `installFactoryPromptDiscovery`.

The default budget is **1500 ms**, configurable with
`AIWG_PROMPT_DISCOVERY_TIMEOUT_MS` and capped at **10000 ms**. It covers stdin,
module lookup, imports, index reads, scoring and output. Input is capped at 1 MiB.
`AIWG_PROMPT_DISCOVERY=0`, `false` or `off` disables the hook. Slash-command inputs,
non-user messages and notification-shaped text are filtered before discovery.

`promptContext` forces the local read-only query branch: no graph builds or web
resource lookup. The worker forwards JSON envelopes through `parentPort`, keeping
its stdout/stderr out of the harness response. Strong candidates require score
≥0.70; otherwise the context requests explicit `aiwg discover --stdin`. Context
is bounded to 599 characters. Claude-style output uses `hookSpecificOutput` for
`UserPromptSubmit`; Hermes `pre_llm_call` uses `{context}`.

Errors and deadlines fail open with exit zero. This is a hinting mechanism;
governing rule bodies still need explicit retrieval. A worker thread limits
latency and output handling, not filesystem permissions.
