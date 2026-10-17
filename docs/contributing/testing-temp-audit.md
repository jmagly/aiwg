# Default lane temporary directory audit (#3018)

The pre-fix audit ran the 1,210 default-lane files in sequential batches of
100, starting with an empty private `TMPDIR` and recording the entries added
by each batch. It found **127 fixture entries** and two shared tooling-cache
entries (`node-compile-cache`, `tsx-1000`). No repository `test-temp-*` paths
existed before the audit. The initial integration batch included missing-build
failures; a repeat after building attributed the remaining integration leaks.
`aiwg-use-cli-home-*` was not reproduced: its owner already has `afterAll` cleanup.

The table groups the observed names by their owning test file; `*` represents
the generated suffix. Paths are relative to `test/`.

| Owner | Leaked names / prefixes | Entries |
| --- | --- | ---: |
| `integration/cli-startup.test.ts` | `aiwg-cli-startup-config-*` (module allocation with skipped suite) | 1 |
| `integration/deployment-completeness.test.ts` | `aiwg-deploy-completeness` (empty parent) | 1 |
| `integration/provider-file-locations.test.ts` | `aiwg-provider-tests` (empty parent) | 1 |
| `integration/uhp-fake-server.test.ts` | `aiwg-uhp-artifacts-*` | 1 |
| `integration/opencode-deployment.test.ts` | `opencode` (native CLI probe) | 1 |
| `conformance/gates-v1/gates-discovery.test.ts` | `aiwg-gate-{addon,extension,framework,invalid}-*` | 4 |
| `conformance/gates-v1/gates-provider-isolation.test.ts` | `aiwg-gates-iso-{bundle,cjs,fsx,r3,r4}-*` | 32 |
| `conformance/gates-v1/gates-p1b-findings.test.ts` | `aiwg-gates-p1b-{a1,a2,a3,a4,a4eval,a4root,a5,a6,a8,b1,b4}-*` | 22 |
| `conformance/gates-v1/gates-provider-sandbox.test.ts` | `aiwg-gates-sbx-{bundle,esc2}-*` | 18 |
| `conformance/gates-v1/gates-bundle-providers.test.ts` | `gates-{external,hang,link,noatt,reject,repin,tweak}-*`, `gates-outside-*.mjs` | 8 |
| `unit/artifacts/output-policy.test.ts` | `aiwg-artifact-output-*` | 1 |
| `unit/artifacts/move.test.ts` | `aiwg-artifacts-{attach,move}-*-private` (empty destination parents) | 2 |
| `unit/audit/operator-decision.test.ts` | `aiwg-decision-audit-*` | 1 |
| `unit/dataset/orchestration.test.ts` | `aiwg-dataset-*` | 1 |
| `unit/dataset/fortemi-live-qualification.test.ts` | `aiwg-dataset-live-*` | 1 |
| `unit/decision/driver.test.ts` | `aiwg-decision-{compact,host-policy,kind,request,setup}-*` | 5 |
| `unit/decision/compile-cache-closure.test.ts` | `decision-ccp-{llm,parity,schema}-*` | 3 |
| `unit/media-curator/transcribe-media-adapter.test.js` | `aiwg-media-adapter-*` | 1 |
| `unit/plugin/skill-command-translator.test.ts` | `.github` (provider destination outside fixture) | 1 |
| `unit/providers/deepseek-harness-deploy.test.ts` | `aiwg-dsh-{deploy,preserve,skill}-*` | 3 |
| `unit/output-modes/registry.test.ts`, `unit/writing/writing-consumer.test.ts` | `aiwg-output-modes` (shared runtime output outside fixtures) | 1 |
| `unit/resources/lockfile.test.ts` | `private-aiwg` (external destination) | 1 |
| `unit/security/context-memory-firewall.test.ts` | `aiwg-context-firewall-{clean,contained,escape,outside,root,symlink-outside,symlink-root}-*` | 7 |
| `unit/sessions/discovery-readers.test.ts` | `aiwg-reader-*`, `aiwg-reader-{invalid,million,stream,tail}-*` | 5 |
| `unit/sessions/contracts-policy.test.ts` | `aiwg-session-{outside,root}-*` | 2 |
| `unit/storage/fortemi-qualification-receipt.test.ts` | `aiwg-fortemi-receipt-*` | 1 |
| `unit/cli/handlers/dataset.test.ts` | `aiwg-dataset-binding-*` | 1 |
| `unit/cli/handlers/output-mode.test.ts` | `aiwg-output-mode-handler-*` | 1 |

Most owners lacked cleanup or removed fixtures only after successful assertions.
They now register file-scoped cleanup through `test/helpers/temp-dir.ts`.
External destination fixtures have owned parents; runtime output and native CLI
scratch are contained beneath owned roots. Embedding and invalid-metadata tests
also use the helper so assertion failures cannot bypass their existing cleanup.

`npm test` now owns a short private temp root, disables process caches, waits
for Vitest to exit, removes known tooling caches created within that root, and
fails on any remaining fixture entries even if Vitest failed. Unexpected entries
are retained with their path printed for diagnosis. It does not sweep the shared
system temp directory. See [testing requirements](testing-requirements.md#temporary-directory-cleanup).

## Validation after fixes

The resumed audit covered all 1,210 default-lane files in 102 sequential
chunks, with `nice -n 19`, `--config config/vitest.config.js`, and
`--maxWorkers=4`. Each chunk used a separate, initially empty private `TMPDIR`.
The final result is **0 remaining entries in every chunk**, compared with
127 fixture entries (129 including tooling caches) in the baseline. Repository
`test-temp-*` counts were **0 before and 0 after**.

The first writing chunk exposed a second owner of the shared
`aiwg-output-modes` prefix, hidden by the earlier shared-root baseline. After
containing its runtime output, all 500 tests in that chunk passed with no leaks.

One CLI chunk initially hit a concurrent repository scan/removal race in
`node-runtime-policy.test.ts`. Its first serial retry also scanned a cached
Yarn package in the audit scratch directory. After moving audit evidence out
of the repository, the 35-file chunk passed serially (538 tests, no leaks).
The scanner remains sensitive to unrelated repository scratch directories.

Across the final chunk results, Vitest reported 21,432 passing test executions
and 200 skipped tests. A filename filter also selects a matching framework file
in a second chunk; these execution counts include that repeat. All 33 touched test files passed separately: 493 passed, one skipped,
no leaks. An OpenCode run with a filter matching no tests also left no entries,
verifying collection-time probe cleanup. `npm run typecheck` passed.
