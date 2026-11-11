// Generated context reports every configured provider without claiming a live runtime check.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../../fixtures/model-wrappers/enforcement.json';
import { buildParallelismSection } from '../../../src/smiths/context-pipeline/parallelism-section.js';
import type { AiwgConfig } from '../../../src/config/aiwg-config.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function report(providers: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-wrapper-report-'));
  roots.push(root);
  return buildParallelismSection(root, { readConfig: async () => ({
    version: '1', providers, installed: {}, scripts: {},
  } as AiwgConfig) });
}

describe('per-provider wrapper enforcement report', () => {
  it.each(Object.entries(fixture))('%s states the fixture-proven default enforcement', async (provider, row) => {
    const text = await report([provider]);
    expect(text).toContain(`Tier enforcement (generated wrapper defaults): ${row.state};`);
    expect(text).toContain('not a live resolved-model audit');
    const effort = row.state === 'pinned' && 'effort' in row ? `pinned via ${row.effort}` : 'not enforced per wrapper';
    expect(text).toContain(`effort: ${effort}`);
    expect(text).toContain('**Direct worker dispatch**: off');
  });

  it('reports every configured provider, including Grok gating and Claude environment precedence', async () => {
    const text = await report(['claude', 'codex', 'grok-build', 'hermes']);
    expect(text.match(/Tier enforcement \(generated wrapper defaults\):/g)).toHaveLength(4);
    expect(text).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 can override pins');
    expect(text).toContain('Grok Build 1.0.77: frontmatter model is ignored; agents inherit the session model');
    expect(text).toContain('role/tier intent is informational');
    expect(text).toContain('global-only');
    expect(text).toContain('Explicit operator pins are preserved where supported');
  });

  it('leaves an unknown provider inherited and unverified', async () => {
    const text = await report([]);
    expect(text).toContain('defaults): inherited;');
    expect(text).toContain('Provider wrapper controls are unverified');
  });
});
