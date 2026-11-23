import { defineConfig } from 'vitest/config';
import path from 'path';
import DurationSequencer from '../tools/testing/duration-sequencer.mjs';
import { artifactIndexFiles, packagingFiles, discoveryFiles, deploymentFiles, releaseSlowFiles, wasmFiles, nodeFiles, d29SlowFiles, d17SlowFiles, orchestrationConformanceFiles } from './test-lanes.mjs';

// Watch-service tests use polling so host-wide inotify quotas cannot make the
// suite nondeterministic on shared development and CI machines.
process.env.CHOKIDAR_USEPOLLING ??= '1';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..'),
  test: {
    globalSetup: ['./test/helpers/default-home-setup.mjs', './test/helpers/prebuilt-relations-setup.mjs', './test/helpers/deployment-cache-setup.mjs'],
    setupFiles: ['./test/helpers/default-home-isolation.mjs', './test/helpers/deployment-cache-isolation.mjs'],
    // Test file patterns
    include: [
      'test/**/*.test.ts',
      'test/**/*.spec.ts',
      'test/**/*.test.js',
      'test/unit/**/*.test.mjs',
      'agentic/code/frameworks/*/test/**/*.test.ts',
      'agentic/code/frameworks/*/test/**/*.spec.ts'
    ],

    // Build shipped tables once; fresh worker HOMEs use the same immutable corpus.

    // Runner ownership follows imported APIs, not the .mjs extension.
    // Node unit tests and all UAT tests have their own required lanes.
    // UAT tests run in their own vitest config to avoid thread-pool conflicts
    // caused by ESM dynamic imports in the stub UAT fixtures.
    // CI runs stub UAT separately via: npm run uat
    //
    // The tools/ralph-external/*.test.mjs and test/unit/ralph/*.test.mjs
    // files also use the node:test runner — see `npm run test:node`.
    // They're outside vitest's include globs already, but listing them
    // here makes the separation explicit (#1210).
    //
    // vscode-extension has its own test runner (`node ./test/runTests.js`)
    // and depends on the `vscode` module which only resolves inside the
    // VS Code Extension Test Runner — never let vitest discover it (#1210).
    exclude: [
      // Required serial packaging and corpus lanes run separately in CI.
      ...packagingFiles, ...artifactIndexFiles, ...discoveryFiles, ...deploymentFiles, ...releaseSlowFiles, ...nodeFiles, ...d29SlowFiles, ...d17SlowFiles, ...orchestrationConformanceFiles,
      // PGlite/WASM must use vitest.wasm.config.js: V8 can abort on thread
      // teardown (UnregisterWasmAllocation, #3073); no test can catch it.
      ...wasmFiles,
      'test/uat/**',
      // The offline conformance lane owns this TypeScript suite too.
      'test/conformance/network-analysis-v1/**',
      // Evidence traces use their dedicated single-fork lane and change cwd.
      'test/evidence/**',
      'tools/ralph-external/**',
      'test/unit/ralph/**',
      'vscode-extension/**',
      'node_modules/**',
      'dist/**',
      // Tier-3 integration suite (#1174) — spawns aiwg serve via bin/aiwg.mjs
      // which requires dist/. Run via `npm run test:integration:serve` against
      // the dedicated config/vitest.integration.config.js.
      'test/integration/serve-sandbox-fake.test.ts',
      'test/integration/serve-pty-bridge.test.ts'
    ],

    // Environment configuration
    environment: 'node',

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',

      // Per-directory thresholds (#1176 cycle 3). The serve seam is the most
      // load-bearing surface in the integration story — stricter thresholds
      // here catch regressions before they reach the live UAT. tools/daemon/
      // sits below the seam and gets slightly looser thresholds because it
      // includes legacy adapter shims still being modernized.
      thresholds: {
        lines: 80, functions: 80, branches: 70, statements: 80,
        'src/serve/**': {
          lines: 85,
          branches: 80,
          functions: 85,
          statements: 85,
        },
        'tools/daemon/**': {
          lines: 75,
          branches: 65,
          functions: 75,
          statements: 75,
        },
      },

      // Include/exclude patterns
      include: ['src/**/*.ts', 'tools/daemon/**/*.mjs'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/index.ts',
        'node_modules/**',
        'dist/**',
        'coverage/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/**',
        '**/fixtures/**'
      ],

      // Fail build if coverage thresholds not met
      skipFull: false
    },

    // Test execution configuration
    globals: false, // Use explicit imports for better tree-shaking
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,

    // Timeout configuration
    testTimeout: 30000,
    hookTimeout: 30000,

    // Keep native --shard, assigning longest measured files to the lightest shard.
    sequence: { sequencer: DurationSequencer },

    // Parallel execution for speed
    // Native os.homedir() in threads reads the parent process HOME, ignoring
    // the thread-local process.env set by per-file home isolation.
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 8,
    minWorkers: 1,

    // Reporter configuration.
    //
    // On CI, two extra reporters cover the two halves of the silent three-hour
    // hang in #2521, which the default reporter cannot describe at all:
    //
    // - hanging-process: the run finished but the process will not exit.
    //   Vitest's own exit guard fires there but says nothing about what is
    //   holding the loop; this names the open handle.
    // - hang-watchdog: the run never finished because a worker is wedged.
    //   The default reporter prints a file only once it completes, so a wedged
    //   file is invisible — which is why run 59128 produced no attribution at
    //   all. This names the modules still in flight and their phase.
    //
    // Both cost nothing on a clean run.
    reporters: process.env.CI
      ? ['default', 'hanging-process', './tools/ci/hang-watchdog-reporter.mjs']
      : ['default'],
    outputFile: {
      json: './test-results/test-results.json'
    }
  },

  // TypeScript support and path aliases
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '../src'),
      '@sdlc': path.resolve(import.meta.dirname, '../agentic/code/frameworks/sdlc-complete/src'),
      '@global': path.resolve(import.meta.dirname, '../src')
    },
    extensions: ['.ts', '.js', '.json']
  }
});
