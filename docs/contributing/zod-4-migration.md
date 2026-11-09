# Native Zod 4 migration (#3577 part 2)

Validated 2026-10-25. AIWG uses native Zod 4.6.7 through the requested `^4.6.6` range. There are no AIWG `zod/v3` imports or direct legacy JSON Schema converter calls. All original 55 import sites were reviewed, including type-only imports. Tools/apps contain no direct runtime Zod imports; the executable OpenCode addon template uses compatible native APIs and needs no edit.

The collection fix is documented in [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). API differences were checked against the [official migration guide](https://zod.dev/v4/changelog) and installed implementations.

## Dependency changes

Removed the original shared/hardlinked node_modules directory before installation. The shell guard rejected `rm -rf`; `rm -r node_modules` removed it without modifying linked files. Installed with `npm install --min-release-age=0`. The configured release-age policy is unchanged.

Every changed lock entry:

| Package location | Before | After |
| --- | --- | --- |
| `node_modules/zod` | 3.25.76 | 4.6.7 |
| `node_modules/@fortemi/core/node_modules/zod` | absent (previously shared root) | 3.25.76 |

Only the Zod package changed. No other locked package version, integrity, or dependency declaration changed. Fortemi's exact 2026.7.15 pin and reviewed-version policy remain intact; no override was added.

```text
aiwg@2026.10.5 <repo>
├─┬ @fortemi/core@2026.7.15
│ └── zod@3.25.76
├─┬ @modelcontextprotocol/sdk@1.32.1
│ ├─┬ zod-to-json-schema@3.25.2
│ │ └── zod@4.6.7 deduped
│ └── zod@4.6.7 deduped
└── zod@4.6.7
```

## Behavior reviewed and preserved

| Native v4 difference | Preservation |
| --- | --- |
| Records require key/value schemas | Explicit string keys at all previously one-argument record calls. |
| Enum records become exhaustive | Existing manifest capability maps, model policy maps and memory cost maps use `partialRecord`. |
| Error `.errors` removed | Source owners and indirect CLI/plugin consumers use `.issues`. |
| Error customization renamed | Existing required/custom messages use `error`; missing skill descriptions retain their custom message. |
| Object factories | `strictObject`/`looseObject` preserve rejection and passthrough behavior; ordinary stripping objects still strip. |
| Defaults short circuit; nested mutable defaults can be shared | `prefault` reparses object defaults and relevant array defaults; nested recommendation thresholds materialize and mutable default arrays remain independent. Primitive defaults remain unchanged. No Zod `.catch()` schema sites required migration. |
| Unknown properties infer as required | Explicit `.optional()` preserves previously omittable provider payloads, legacy writer attachments/templates and MCP decision fields. Native `z.infer` and recursive/generic types compile. |
| `.int()` adds safe-integer bounds | Shared native checks retain represented integers outside the safe range, reject fractions and preserve existing explicit bounds and integer JSON Schema. |
| Bare numbers reject infinity | Shared native checks preserve infinite measurements where previously allowed, reject NaN/non-numbers and retain explicit finite/bounded constraints. |
| Datetime grammar narrows | Native checks retain minute precision, optional fractional seconds, colonless numeric offsets, offset-enabled grammar and leap-year/calendar checks. |
| URL parsing rewrites input | Native URL checks validate using `new URL` while retaining original spelling, whitespace and control characters in returned values. |
| UUID grammar narrows | Worker invocation IDs retain the existing broad hexadecimal UUID grammar. |
| Union errors use branch arrays and relative paths | Session diagnostics traverse native branches, prepend parent locations and retain empty discriminator failures. |
| Enum/literal/string issue codes change | Session diagnostic codes remain `invalid_enum_value`, `invalid_literal`, `invalid_string`, and `invalid_union_discriminator`; application error codes remain stable. |
| Received-value metadata disappears | Generic session diagnostics inspect only the failing original field under the existing header-only echo policy; event values remain redacted. Manifest owners pass original input solely for type classification, without retaining raw input in error issues. Partial capability-map errors still identify individual invalid keys. |
| SDK native JSON Schema representation changes | Existing MCP registration owner retains object additional-property contracts and suppresses redundant unconstrained key schemas through native metadata. Integer/date/URI/UUID metadata preserves advertised contracts. |
| `.superRefine`, defaults and schema introspection | Existing refinements, error paths, provider shape/options/literal introspection and domain tests remain valid. |

The 88-tool baseline was captured before dependency replacement. The contract tests compare actual SDK `tools/list` input/output schemas against that fixture, checking all validation keywords. Comparison normalizes only local reference inlining and equivalent nullable primitive `anyOf` versus type-array notation; JSON bytes are consequently not promised identical. Raw shapes and registered objects consistently contain native v4 schemas.

## Collection regressions

Existing test owners cover MCP choices (256 against 255), quickref/config entries (51 against 50), manifest keywords (51 against 50), writer exemplar tags (101 against 100), output provenance sources (257 against 256), and supersedes/conflicts (129 against 128). Each counts element-validator calls, proves the counter with a valid positive control, then asserts zero calls and collection rejection for the bounded oversized synthetic input. Output-registration tests extend the actual request schema with instrumented elements while retaining its collection bounds; other tests instrument the actual registered/owned element validators. No memory exhaustion, network, or paid model calls are used.

## Fortemi version boundary and remaining audit

Reviewed every runtime Fortemi entry point in AIWG:

- `src/artifacts/fortemi-core-query-adapter.ts`: plain index/query data through `aiwg-index`.
- `src/artifacts/fortemi-shard-export.ts`: plain index data, archive bytes and conversion receipts through `aiwg-index-shard`.
- `src/sessions/fortemi-export-mapping.ts`: structural type imports and plain record construction.
- `src/sessions/fortemi-shard-recovery.ts` and `fortemi-shard-blobs.ts`: archive bytes, JSON records and structural types.
- `src/cli/handlers/sessions.ts`: plain session index export into the shard converter.
- `src/marketplace/provenance.ts`: plain index records, archive bytes and receipt data.
- `tools/ci/verify-aiwg-fortemi-shard-receipt.mjs`: data/bytes/receipt verification.

No AIWG Zod schema is passed into Fortemi, and no Fortemi schema is passed into an AIWG validator or MCP registration. Fortemi's internal v3 schema converter and published schema types remain upstream-owned.

`npm audit --omit=dev` exits 1: **4 vulnerabilities (2 moderate, 2 high)**. Root Zod is no longer flagged. Remaining findings:

- Fortemi's nested `zod@3.25.76`: GHSA-mrhx-c7xc-m3w5; Fortemi itself is also counted as an affected dependent (two high audit nodes).
- `fast-uri`: GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp (moderate).
- `ip-address`: GHSA-rxp7-6hxx-x8q5 (moderate).

Removing the nested advisory requires an upstream Fortemi release with patched native v4 and a separately reviewed dependency-pin/policy update. Existing unbounded arrays/records remain unbounded; the patched library's pre-traversal rejection applies to constrained collections and does not establish application ingress limits.

## Verification

All final commands below ran after source changes were complete. CLI-dependent tests ran after `build:cli` finished.

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS, zero errors |
| `npm run build:cli` | PASS, version checks and compilation; 123 runtime/declaration/resource files copied |
| Affected-domain Vitest command below | PASS, 271 files; 7,133 passed, 1 skipped, 0 failed |
| `npx vitest run --config config/vitest.config.js test/unit/sessions` | PASS, 49 files / 1,397 tests, including the 1 GiB import test |
| `npx vitest run --config config/vitest.config.js test/unit/mcp/worker-contracts.test.ts` | PASS, 1 file / 24 tests, including all 88 advertised schemas |
| `npm run test:contract` | PASS, Vitest 3 files / 15 tests; Node 16 tests; zero failures/skips |
| `node --test test/unit/providers/grok-build-qualification.test.mjs` | PASS, 5 tests |
| `npm run lint:test-registration` | PASS, 1,507 source files assigned |
| `npm run lint:test-process-timeouts` | PASS, zero unbounded non-allowlisted test/product calls |
| `git diff --check` | PASS |
| `npm audit --omit=dev` | Exit 1, expected remaining 4 vulnerabilities detailed above |

```bash
npx vitest run --config config/vitest.config.js \
  test/unit/contributors test/unit/discovery test/unit/extensions \
  test/unit/mcp test/unit/memory test/unit/models test/unit/providers \
  test/unit/sessions test/unit/writing test/unit/jobs test/unit/output-modes \
  test/unit/plugin/metadata-validator.test.ts \
  test/unit/plugin/behavior-metadata-validation.test.ts \
  test/unit/cli/handlers/skill-lint.test.ts
```

The final broad run's sole skip was the existing 1 GiB session-import memory test's temporary-filesystem capacity/free-space guard (requires 1.2 GiB available). That test passed in the separate complete sessions run and an earlier broad run. No EPERM, EROFS, or network failures remained in final validation.

An initial broad attempt overlapped the final build and produced 19 provider subprocess failures against partially updated compiled imports. The affected pair passed in isolation (72 tests); the complete build-then-test rerun above passed all 271 files. This was corrected execution sequencing, with no product workaround.

## Acceptance status and open questions

- **Met:** root range `^4.6.6`, latest available 4.x resolution (4.6.7), clean installation and Zod-only lock changes.
- **Met:** native-v4 source migration across all requested domains, code addons reviewed, existing owners retained, behavior-preserving regressions and passing typecheck/build.
- **Met:** all 88 MCP JSON Schema validation contracts, with equivalent reference/nullable notation normalized.
- **Met:** counted pre-traversal regressions at all five requested boundaries.
- **Met:** required unit, contract, MCP contract and lint verification; final resource-guard skip covered by the separate passing sessions run.
- **Met:** Fortemi remains nested v3 without overrides; schema crossings audited and none found.
- **Met:** AIWG's root advisory removed and production audit findings reported.
- **Deferred upstream:** removal of Fortemi's nested vulnerable Zod; unrelated fast-uri/ip-address updates remain outside this migration.

Open question: which Fortemi release will provide patched native-v4 schemas and pass AIWG's dependency review? No commits, pushes, branches, refs, stashes, or tracker writes were made.

## Files changed by domain

### Report

- `docs/contributing/zod-4-migration.md` (this file) — Migration inventory, compatibility and verification record.

### Dependencies

- [package-lock.json](../../package-lock.json) — Native Zod range and minimal lockfile update.
- [package.json](../../package.json) — Native Zod range and minimal lockfile update.

### cli

- [src/cli/handlers/skill-lint.ts](../../src/cli/handlers/skill-lint.ts) — Consume native skill validation issues.

### contributors

- [src/contributors/validation.ts](../../src/contributors/validation.ts) — Native records and issue handling.

### discovery

- [src/discovery/plan-validation.ts](../../src/discovery/plan-validation.ts) — Native recursive plan validation.

### extensions

- [src/extensions/manifest.ts](../../src/extensions/manifest.ts) — Native schemas, defaults and manifest diagnostics.
- [src/extensions/project-local-discovery.ts](../../src/extensions/project-local-discovery.ts) — Native schemas, defaults and manifest diagnostics.
- [src/extensions/project-quickref.ts](../../src/extensions/project-quickref.ts) — Native schemas, defaults and manifest diagnostics.
- [src/extensions/validation.ts](../../src/extensions/validation.ts) — Native schemas, defaults and manifest diagnostics.

### jobs

- [src/jobs/flow.ts](../../src/jobs/flow.ts) — Native flow objects and URL/integer validation.

### mcp

- [src/mcp/server.mjs](../../src/mcp/server.mjs) — Native tool schemas and preserved advertised contracts.
- [src/mcp/tools/agentic-sandbox.mjs](../../src/mcp/tools/agentic-sandbox.mjs) — Native tool schemas and preserved advertised contracts.
- [src/mcp/tools/command-run.mjs](../../src/mcp/tools/command-run.mjs) — Native tool schemas and preserved advertised contracts.
- [src/mcp/tools/decision.mjs](../../src/mcp/tools/decision.mjs) — Native tool schemas and preserved advertised contracts.
- [src/mcp/tools/discovery.mjs](../../src/mcp/tools/discovery.mjs) — Native tool schemas and preserved advertised contracts.
- [src/mcp/tools/orchestration.mjs](../../src/mcp/tools/orchestration.mjs) — Native tool schemas and preserved advertised contracts.
- [src/mcp/tools/subsystems.mjs](../../src/mcp/tools/subsystems.mjs) — Native tool schemas and preserved advertised contracts.
- [src/mcp/tools/worker-invoke.mjs](../../src/mcp/tools/worker-invoke.mjs) — Native tool schemas and preserved advertised contracts.
- [src/mcp/tools/writer-profiles.mjs](../../src/mcp/tools/writer-profiles.mjs) — Native tool schemas and preserved advertised contracts.

### memory

- [src/memory/audit.ts](../../src/memory/audit.ts) — Native memory schemas and preserved maps/defaults.
- [src/memory/canonical-context.ts](../../src/memory/canonical-context.ts) — Native memory schemas and preserved maps/defaults.
- [src/memory/cost.ts](../../src/memory/cost.ts) — Native memory schemas and preserved maps/defaults.
- [src/memory/maintenance-contract.ts](../../src/memory/maintenance-contract.ts) — Native memory schemas and preserved maps/defaults.
- [src/memory/maintenance-record.ts](../../src/memory/maintenance-record.ts) — Native memory schemas and preserved maps/defaults.
- [src/memory/recommend.ts](../../src/memory/recommend.ts) — Native memory schemas and preserved maps/defaults.
- [src/memory/taxonomy.ts](../../src/memory/taxonomy.ts) — Native memory schemas and preserved maps/defaults.

### models

- [src/models/provider-policy.ts](../../src/models/provider-policy.ts) — Partial maps and numeric/timestamp compatibility.

### output-modes

- [src/output-modes/registry.ts](../../src/output-modes/registry.ts) — Native strict mode schemas.

### plugin

- [src/plugin/metadata-validator.ts](../../src/plugin/metadata-validator.ts) — Consume native validation issues.

### providers

- [src/providers/provider-definitions.ts](../../src/providers/provider-definitions.ts) — Explicit record keys and compatible scalar validation.

### schema

- [src/schema/zod-validation.d.mts](../../src/schema/zod-validation.d.mts) — Shared native validation compatibility helpers/types.
- [src/schema/zod-validation.mjs](../../src/schema/zod-validation.mjs) — Shared native validation compatibility helpers/types.

### sessions

- [src/sessions/adapters/claude.ts](../../src/sessions/adapters/claude.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/codex.ts](../../src/sessions/adapters/codex.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/copilot.ts](../../src/sessions/adapters/copilot.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/cursor.ts](../../src/sessions/adapters/cursor.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/deepseek-harness.ts](../../src/sessions/adapters/deepseek-harness.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/factory.ts](../../src/sessions/adapters/factory.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/generic.ts](../../src/sessions/adapters/generic.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/grokbot.ts](../../src/sessions/adapters/grokbot.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/hermes.ts](../../src/sessions/adapters/hermes.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/muse.ts](../../src/sessions/adapters/muse.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/omp.ts](../../src/sessions/adapters/omp.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/openclaw.ts](../../src/sessions/adapters/openclaw.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/opencode.ts](../../src/sessions/adapters/opencode.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/openhuman.ts](../../src/sessions/adapters/openhuman.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/pi.ts](../../src/sessions/adapters/pi.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/adapters/windsurf.ts](../../src/sessions/adapters/windsurf.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/analytics.ts](../../src/sessions/analytics.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/candidates.ts](../../src/sessions/candidates.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/contracts.ts](../../src/sessions/contracts.ts) — Native provider/session schemas and preserved diagnostics.
- [src/sessions/output-registration.ts](../../src/sessions/output-registration.ts) — Native provider/session schemas and preserved diagnostics.

### writing

- [src/writing/exemplar-selection.ts](../../src/writing/exemplar-selection.ts) — Native writer schema; expose existing descriptor for boundary regression.
- [src/writing/voice-evaluation.ts](../../src/writing/voice-evaluation.ts) — Native writer schemas and compatible scalar/default behavior.
- [src/writing/writer-migration.ts](../../src/writing/writer-migration.ts) — Native writer schemas and compatible scalar/default behavior.
- [src/writing/writer-profile.ts](../../src/writing/writer-profile.ts) — Native writer schemas and compatible scalar/default behavior.
- [src/writing/writing-brief.ts](../../src/writing/writing-brief.ts) — Native writer schemas and compatible scalar/default behavior.
- [src/writing/writing-receipt.ts](../../src/writing/writing-receipt.ts) — Native writer schemas and compatible scalar/default behavior.

### Tests and fixtures

- [test/fixtures/mcp/tool-json-schema.v3.json](../../test/fixtures/mcp/tool-json-schema.v3.json) — Pre-migration baseline for 88 MCP tools, plus the additive native-confirmation grant tool (#4002).
- [test/unit/extensions/manifest.test.ts](../../test/unit/extensions/manifest.test.ts) — Manifest traversal and diagnostic regressions.
- [test/unit/extensions/project-quickref.test.ts](../../test/unit/extensions/project-quickref.test.ts) — Quickref traversal and default independence regressions.
- [test/unit/extensions/zod-validation.test.ts](../../test/unit/extensions/zod-validation.test.ts) — Numeric, timestamp and URL behavior regressions.
- [test/unit/mcp/decision-ask-ledger.test.ts](../../test/unit/mcp/decision-ask-ledger.test.ts) — Registered MCP collection traversal regression.
- [test/unit/mcp/worker-contracts.test.ts](../../test/unit/mcp/worker-contracts.test.ts) — Actual SDK schema-contract comparison.
- [test/unit/memory/recommend.test.ts](../../test/unit/memory/recommend.test.ts) — Nested recommendation defaults regression.
- [test/unit/sessions/contracts-policy.test.ts](../../test/unit/sessions/contracts-policy.test.ts) — Session codes, values, timestamps and defaults regressions.
- [test/unit/sessions/output-registration.test.ts](../../test/unit/sessions/output-registration.test.ts) — Three output collection traversal regressions.
- [test/unit/writing/exemplar-selection.test.ts](../../test/unit/writing/exemplar-selection.test.ts) — Writer collection traversal regression.
