// Runner source ownership and explicit reasons for lanes unavailable in main CI.
export const unavailableLanes = {
  'config/vitest.uat-cockpit-live.config.js': 'Requires a live agentic-sandbox executor; the offline CI image does not provide that service.',
  'config/vitest.uat-daemon.config.js': 'Requires an authenticated provider CLI/account and a real daemon with isolated sockets.',
  'config/vitest.uat-fleet-sandbox.config.js': 'Requires live fleet SSH targets and agentic-sandbox hosts; unavailable in offline CI.',
  'config/vitest.uat-live.config.js': 'Requires authenticated Claude/Codex accounts and paid live provider calls.',
  'config/vitest.uat-serve-live.config.js': 'Requires a live agentic-sandbox service for aiwg serve integration.',
  'config/vitest.uat-workers-live.config.js': 'Manual fake-CLI subprocess readiness diagnostic; kept separate from stub UAT because process-probe timing needs a dedicated runner budget.',
  'vscode-extension': 'Requires the VS Code Electron extension host and a display (xvfb on Linux); neither is provisioned in the default CI image.',
};

// Exact test-file dispositions are reported, never treated as executed tests.
export const unavailableTestFiles = {
  'test/fixtures/testing-quality/native-extension/test_native_extension.py': 'No .gitea workflow invokes pytest for this file. test/unit/addons/testing-quality-mutation.test.ts imports it through the native-extension preflight as an input fixture; its Python test body is not executed by that regression.',
};

// Paths are relative to the owning package. A package script alone never owns
// all its sources: files must match one of these patterns or an existing lane.
export const packageRunnerLanes = [
  { id: 'cockpit-web', runner: 'vitest', package: 'apps/cockpit/web', script: 'test', files: ['src/**/*.test.{ts,tsx}'] },
  { id: 'vscode-extension', runner: 'mocha', package: 'vscode-extension', script: 'test', files: ['test/**/*.ts'] },
];
export const packagingFiles = [
  'test/integration/relations-prebuilt-packaging.test.ts',
  'test/integration/artifacts/aiwg-tracking.test.ts',
  'test/smoke/cockpit-base-footprint.test.js',
  'test/integration/network-analysis-addon.test.ts',
  'test/integration/cli-package-webmode.test.ts',
  'test/integration/worker-adapter-package.test.ts',
  'test/integration/global-install-native-policy.test.ts',
  'test/integration/tarball-allowlist-packaging.test.ts',
  'test/integration/dataset-contract-packaging.test.ts',
  'test/integration/mission-contract-packaging.test.ts',
  'test/integration/sessions-muse-package.test.ts',
  'test/integration/sessions-coverage-package.test.ts',
  'test/integration/decision-engine-clean-install.test.ts',
  'test/integration/tools-packed-relative-imports.test.ts',
];
export const artifactIndexFiles = [
  'test/unit/artifacts/relations-corpus.test.ts',
  'test/integration/artifacts/dependency-graph.test.ts',
  'test/integration/artifacts/incremental-build.test.ts',
  'test/integration/artifacts/multi-graph.test.ts',
];
export const discoveryFiles = ['test/integration/artifacts/discover-fortemi-corpus.test.ts'];
// Full-corpus provider deployment owns one shared immutable source cache and
// runs serially so multiple child CLIs do not compete inside the default lane.
export const deploymentFiles = [
  'test/integration/use-all-deployment.test.ts',
  'test/integration/hermes-deployment.test.ts',
  'test/integration/guided-setup-walkthrough.test.ts',
];
// Exhaustive provider deployment matrices run before releases, while focused
// CLI contracts and a small provider smoke matrix remain in the default lane.
// These do not overlap the required post-merge deploymentFiles lane above.
export const releaseSlowFiles = [
  'test/integration/provider-file-locations.test.ts',
  'test/integration/kernel-deployment-conformance.test.ts',
  'test/integration/deployment-completeness.test.ts',
  'test/integration/factory-deployment.test.ts',
  'test/integration/opencode-deployment.test.ts',
  'test/integration/cursor-deployment.test.ts',
];
// Offline release-only configs have an explicit manual workflow owner instead
// of requiring execution on every merge in the canonical CI workflow.
export const releaseLaneWorkflows = {
  'config/vitest.release-slow.config.js': '.gitea/workflows/release-slow.yml',
};
// PGlite's WebAssembly JIT teardown can abort V8 in worker threads (#3073,
// runs 81094/90363). Required forks lane; keep coverage and the TMPDIR gate.
// Runtime inventory: docs/contributing/testing-wasm-lane.md.
export const wasmFiles = [
  'test/unit/artifacts/fortemi-shard-export.test.ts',
];
// Shared S0 infrastructure and frozen contracts run in the existing offline
// conformance lane. Mechanism suites retain their source owner's unit lane.
export const orchestrationConformanceFiles = [
  'test/conformance/orchestration-v1/**/*.test.ts',
  'test/conformance/mission-v1/**/*.test.ts',
];
// Workspace package test ownership (#3729). Every `test`/`test:*` script in
// nested package.json must be invoked by a main CI job, owned by a reasoned
// unavailable lane, or listed in optInPackageTests with a non-empty reason.
// Non-test harness scripts may also
// be listed to document a manual-only classification; listed scripts must exist
// and must NOT be CI-invoked (no redundant entries).
// Cockpit harness classification: the four smoke harnesses run in CI because
// each is deterministic and offline (mock-executor: ephemeral loopback port;
// bridge: in-process servers on ephemeral ports with a fake CLI fixture;
// shell-core: isolated mkdtemp HOME; vscode: stubbed vscode module + fetch).
// The two poc harnesses stay manual-only (see entries below).
export const optInPackageTests = [
  { package: 'droid-mcp-server', script: 'test', reason: 'Focused package alias; root test:node already executes test/bridge.test.mjs via the CI-owned addon Node pattern.' },
  { package: '@aiwg/cockpit', script: 'test', reason: 'Local aggregate chaining CI-owned smoke with manual-only poc harnesses; CI invokes test:web and smoke directly.' },
  { package: '@aiwg/cockpit', script: 'poc', reason: 'Manual-only PoCs: kill-bridge-isolation.mjs needs fixed ports plus SIGKILL timing (flake-prone on shared runners); security-checks.mjs reads/writes the real $HOME runtime file (non-hermetic).' },
];
export const nodeFiles = [
  'tools/ralph-external/*.test.mjs', 'test/unit/ralph/*.test.mjs',
  'tools/experiments/conformal/prototype.test.mjs',
  'tools/eval/test/*.test.mjs',
  'agentic/code/addons/droid-bridge/test/*.test.mjs',
  'test/unit/providers/grok-build-qualification.test.mjs',
  'test/contract/agentic-publication-source.test.mjs',
  'test/contract/setup-manifest-site-dispatch.test.mjs',
  'test/contract/site-manifest-release-dispatch.test.mjs',
  'test/contract/socket-post-publish-workflow.test.mjs',
];
// Heavy D29 suites: multi-seed structure scans, positive controls, repeated
// audits and full-corpus reproductions. They run in their own CI job
// (test:d29-slow) so they never push the shared test:ci step past its cap;
// test/unit/decision/d29-synthetic-v8-smoke.test.mjs keeps fast single-seed
// coverage in the default lane.
// Heavy D17 staged-calibration suite: full 1,800-row preparation, 1,200-row calibrated
// scoring, seal re-derivation and promotion-route replays (about 30 s of one worker).
// It runs in the same slow job; the D17 diagnostic, corpus, artifact and statistics
// files keep fast coverage in the default lane.
export const d17SlowFiles = [
  'test/unit/decision/ensemble-study-staged.test.ts',
  'test/unit/decision/ensemble-staged-lattice.test.ts',
  // D17-MF probe (#2850): full 5,772-row preparation, shortcut audit, bundle planning and calibrated scoring (about 22 s).
  'test/unit/decision/d17-multifact.test.ts',
];
export const d29SlowFiles = [
  'test/unit/decision/d29-synthetic-v8.test.mjs',
  'test/unit/decision/d29-study.test.mjs',
  'test/unit/decision/d29-synthetic-v6.test.mjs',
  'test/unit/decision/d29-synthetic-v7.test.mjs',
  'test/unit/decision/d29-gates-regression.test.mjs',
  'test/unit/decision/d29-v8-review.test.mjs',
];

// Root gate-script exceptions: one explicit owner/reason per non-main invocation.
// `unwired` is census debt for the release conductor, not an approved manual policy.
export const scriptLaneExemptions = [
  { script: 'lint:rule-triggers', kind: 'manual', owner: 'discovery-maintainers', reason: 'Advisory trigger coverage report; source explicitly defers --fail-on-missing until coverage closes.' },
  { script: 'lint:tarball', kind: 'release-only', owner: 'release-maintainers', reason: 'Release candidate routine/full profiles invoke the tarball audit in tools/release/release-candidate.mjs.' },
  { script: 'lint:test-process-timeouts:report', kind: 'manual', owner: 'testing-maintainers', reason: 'Advisory full timeout report; main invokes the --enforce-product variant.' },
  { script: 'lint:tmpdir-leaks', kind: 'manual', owner: 'testing-maintainers', reason: 'Standalone diagnostic; the default lane wrapper imports and enforces its leak checks.' },
  { script: 'test:ci', kind: 'manual', owner: 'testing-maintainers', reason: 'Local aggregate alias; main invokes the default and offline UAT lanes separately.' },
  { script: 'test:conformance:audit', kind: 'manual', owner: 'testing-maintainers', reason: 'Creates timestamped census artifacts in the configured artifact store; review workflow rather than a main CI suite.' },
  { script: 'test:conformance:graph', kind: 'release-only', owner: 'storage-maintainers', reason: 'Tag/manual conformance.yml owns this alias; the default lane also selects the fast graph test.' },
  { script: 'test:conformance:network-analysis', kind: 'manual', owner: 'testing-maintainers', reason: 'Focused developer alias for a suite already selected by test:conformance.' },
  { script: 'test:conformance:storage:server', kind: 'live', owner: 'storage-maintainers', reason: 'Requires live PostgreSQL/PostgREST servers; manual storage-server-conformance workflow.' },
  { script: 'test:coverage', kind: 'manual', owner: 'testing-maintainers', reason: 'Whole-default-lane coverage diagnostic; main enforces named coverage profiles instead.' },
  { script: 'test:durations', kind: 'manual', owner: 'testing-maintainers', reason: 'Refreshes checked-in timing data; not a read-only main gate.' },
  { script: 'test:fortemi:live', kind: 'live', owner: 'storage-maintainers', reason: 'Requires a live Fortemi service; manual storage-server-conformance workflow.' },
  { script: 'test:grok-build:qualification', kind: 'manual', owner: 'provider-maintainers', reason: 'Focused alias; test:node already runs the same offline qualification test file.' },
  { script: 'test:integration', kind: 'manual', owner: 'testing-maintainers', reason: 'Focused startup/performance alias; default lane selects these files.' },
  { script: 'test:integration:serve:flake-gate', kind: 'manual', owner: 'testing-maintainers', reason: '50-run diagnostic before harness changes; routine CI runs test:integration:serve once.' },
  { script: 'test:leaks', kind: 'manual', owner: 'testing-maintainers', reason: 'Opt-in async leak diagnostic for the default suite.' },
  { script: 'test:mission-protocol', kind: 'manual', owner: 'testing-maintainers', reason: 'Focused developer alias; unit and mission conformance files have existing main lanes.' },
  { script: 'test:node:ralph-external', kind: 'manual', owner: 'testing-maintainers', reason: 'Focused alias for the Ralph subset already invoked by test:node.' },
  { script: 'test:perf', kind: 'manual', owner: 'testing-maintainers', reason: 'Focused alias for cli-perf.test.ts already selected by the default lane.' },
  { script: 'test:release-slow', kind: 'release-only', owner: 'release-maintainers', reason: 'Exhaustive provider deployment matrices; release-slow.yml and publication own this separately from main CI.' },
  { script: 'test:release:routine-deployment', kind: 'release-only', owner: 'release-maintainers', reason: 'Routine release profile adds self-verification to test:release-slow.' },
  { script: 'test:security:artifact-verification', kind: 'manual', owner: 'security-maintainers', reason: 'Focused developer alias for artifact verification files selected by the default lane.' },
  { script: 'test:sessions:feature-install', kind: 'release-only', owner: 'release-maintainers', reason: 'Feature installation smoke owned by npm publication and release-candidate profiles.' },
  { script: 'test:uhp:live', kind: 'live', owner: 'provider-maintainers', reason: 'Live UHP qualification requires external services and credentials.' },
  { script: 'test:uhp:offline', kind: 'manual', owner: 'testing-maintainers', reason: 'Focused developer alias; unit, fake-server and conformance files have existing main lanes.' },
  { script: 'test:ui', kind: 'manual', owner: 'testing-maintainers', reason: 'Interactive Vitest UI.' },
  { script: 'test:watch', kind: 'manual', owner: 'testing-maintainers', reason: 'Interactive Vitest watch mode.' },
];
