import base from './vitest.config.js';

// Three audited local sources, not whole-repository or subprocess coverage.
// Per-file thresholds prevent one source from masking regressions in the other.
export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'test/unit/testing/conformance-example-state.test.mjs',
      'test/unit/sessions/import-lease.test.ts',
      'test/unit/cli/watch-service.test.ts',
    ],
    coverage: {
      enabled: true, provider: 'v8',
      include: ['tools/testing/conformance-example-state.mjs', 'src/sessions/import-lease.ts', 'src/cli/watch-service.ts'],
      exclude: [],
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './test-results/audit-foundations-coverage',
      thresholds: { perFile: true, lines: 80, statements: 80, branches: 70, functions: 80 },
    },
  },
};
