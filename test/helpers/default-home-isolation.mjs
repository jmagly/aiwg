// Give each test file private user state before its modules or hooks run.
import { afterAll, inject } from 'vitest';
import { createTemporaryHome } from './temporary-home.mjs';

// Nest under the run-owned fallback so global teardown also cleans homes left
// by a failed worker. Immutable corpus caches remain outside this private HOME.
const laneHome = inject('defaultLaneHome');
// Packaging and artifact-index lanes own their independent HOME policies.
if (laneHome) {
  const { env, cleanup } = createTemporaryHome('file-', laneHome);
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  delete env.CODEX_HOME;
  Object.assign(process.env, env);
  // A set CODEX_HOME is a provider-detection signal; keep the fallback behavior.
  delete process.env.CODEX_HOME;

  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup();
  });
}
