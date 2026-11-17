// Qualification repair hints belong beside configuration regeneration hints.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { warnStaleParallelism } from '../../../src/config/worker-guidance-warning.js';

afterEach(() => vi.restoreAllMocks());
describe('worker qualification configuration hints (#4262)', () => {
  it('prints the requalification command for a changed worker CLI policy', () => {
    const cfg = emptyConfig();
    cfg.parallelism = { clis: { cursor: { adapter: 'providers:cursor', enabled: true, accountScope: 'local', quotaScope: 'local' } } };
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnStaleParallelism(cfg, '/synthetic/project', 'parallelism.clis.cursor.enabled', false);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('aiwg doctor --probe-workers --qualify'));
  });
  it('reports nested worker edits and whole-block routing changes, while ignoring no-ops', () => {
    const cfg = emptyConfig(); cfg.parallelism = { worker_dispatch: true };
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnStaleParallelism(cfg, '/synthetic/project', 'parallelism', {});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('aiwg doctor --probe-workers --qualify'));
    warning.mockClear();
    warnStaleParallelism(cfg, '/synthetic/project', 'parallelism.worker_dispatch', true);
    expect(warning).not.toHaveBeenCalled();
    warnStaleParallelism(cfg, '/synthetic/project', 'parallelism.worker_dispatch', false);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('aiwg doctor --probe-workers --qualify'));
  });
  it.each(['parallelism', 'parallelism.max_parallel_subagents', 'setup.worker_dispatch_offer'])('omits requalification for unrelated %s', key => {
    const cfg = emptyConfig(); cfg.parallelism = { max_parallel_subagents: 4 };
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnStaleParallelism(cfg, '/synthetic/project', key, 2);
    expect(warning.mock.calls.flat().join('\n')).not.toContain('aiwg doctor --probe-workers --qualify');
  });
});
