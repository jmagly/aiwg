import { expect } from 'vitest';

// Share the real, unchanged corpus only in deployment integration tests.
// Index/query unit tests and use-self-verification assert cold, stale, or
// replaced indexes and must keep their private HOME/XDG framework cache.
const file = (expect.getState().testPath || '').replaceAll('\\', '/');
// The path-keyed binding snapshot is safe only for these immutable real-corpus
// tests; fixture and mutation tests must own their binding cache lifecycle.
if (!/\/test\/integration\/(?:use-all-deployment|hermes-deployment|guided-setup-walkthrough|bundle-reconciliation-cli)\.test\.ts$/.test(file)) {
  delete process.env.AIWG_RULE_BINDING_INDEX_CACHE;
}
if (!/\/test\/integration\/(?:[^/]*deployment|guided-setup-walkthrough|bundle-reconciliation-cli|project-local-deploy|model-worker-provider-matrix|kernel-deployment-conformance)\.test\.ts$/.test(file)) {
  delete process.env.AIWG_FRAMEWORK_INDEX_CACHE;
  delete process.env.AIWG_FRAMEWORK_INDEX_CACHE_SOURCE;
}
