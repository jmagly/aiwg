import { describe, expect, it } from 'vitest';
// @ts-expect-error untyped launcher helper
import { workerRunDirectoryRefusal } from '../../../tools/ralph-external/lib/worker-run-directory-refusal.mjs';

describe('worker run directory refusal', () => {
  it('names the remedy when an empty directory was pre-created', () => {
    expect(workerRunDirectoryRefusal([])).toBe('Worker run directory must be fresh, empty, private and owned. '
      + 'Pass a run_dir path that does not exist yet (its parent may be missing); the launcher creates it with mode 0700, so do not pre-create it.');
  });
  it('lists at most five unexpected entries, sorted', () => {
    const message = workerRunDirectoryRefusal(['g', 'f', 'e', 'd', 'c', 'b', 'a']);
    expect(message).toContain('Unexpected entries: "a", "b", "c", "d", "e" (+2 more)');
    expect(message).toContain('pass a new run dir');
  });
});
