// Desktop provider selection must still audit pre-buyout native directories.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanContextMemoryFirewall } from '../../../tools/security/context-memory-firewall.mjs';

describe('Desktop context audit compatibility', () => {
  it.each(['devin', 'windsurf'])('audits the retained native paths through %s', async selector => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-devin-audit-'));
    try {
      await mkdir(join(root, '.windsurf/rules'), { recursive: true });
      await writeFile(join(root, '.windsurf/rules/legacy.md'), '# Local project rule');
      const result = await scanContextMemoryFirewall({ rootDir: root, packageRoot: root, providers: [selector] });
      expect(result.providers).toEqual(['devin']);
      expect(result.records.some(record => record.path === '.windsurf/rules/legacy.md')).toBe(true);
      expect(result.warnings.some(warning => warning.code === 'provider-not-supported')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
