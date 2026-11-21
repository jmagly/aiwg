import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCoverageReport } from '../../../tools/manifest/check-discovery-coverage.mjs';

let root: string | null = null;

function fixture() {
  root = mkdtempSync(join(tmpdir(), 'aiwg-discovery-coverage-'));
  return root;
}

function component(repo: string, name: string, manifest: object, skill?: string) {
  const dir = join(repo, 'agentic', 'code', 'addons', name);
  mkdirSync(join(dir, 'skills', name), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  if (skill) writeFileSync(join(dir, 'skills', name, 'SKILL.md'), skill);
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('component discovery coverage', () => {
  it.each(['all', 'devin', 'windsurf'])('reports canonical provider support for a %s operational driver', platform => {
    const repo = fixture();
    component(repo, 'example', {
      id: 'example',
      type: 'addon',
      discovery: { drivers: ['skills/example/SKILL.md'], canonicalOperation: 'aiwg use example' },
    }, [
      '---',
      'name: example',
      `platforms: [${platform}]`,
      'description: Configure the example addon.',
      'triggers:',
      '  - enable example',
      '---',
      '# Example',
    ].join('\n'));

    const report = buildCoverageReport(repo);
    expect(report.ok).toBe(true);
    expect(report.components[0].drivers[0].providerSupport).toContain('devin');
    expect(report.components[0].drivers[0].providerSupport).not.toContain('windsurf');
    expect(report.components[0]).toMatchObject({
      component: 'example',
      status: 'covered',
      drivers: [{
        type: 'skill',
        name: 'example',
        triggers: ['enable example'],
        canonicalOperation: 'aiwg use example',
      }],
    });
  });

  it('fails a component without a discoverable operational driver', () => {
    const repo = fixture();
    component(repo, 'missing', { id: 'missing', type: 'addon' });

    const report = buildCoverageReport(repo);
    expect(report.ok).toBe(false);
    expect(report.counts.missing).toBe(1);
    expect(report.components[0].reason).toContain('natural-language triggers');
  });

  it('requires exemptions to name an existing public owning driver and rationale', () => {
    const repo = fixture();
    component(repo, 'owner', { id: 'owner', type: 'addon' }, [
      '---',
      'name: owner',
      'description: Own the internal component.',
      'triggers: [operate internal component]',
      '---',
      '# Owner',
    ].join('\n'));
    component(repo, 'internal', {
      id: 'internal',
      type: 'addon',
      discovery: {
        exemption: {
          rationale: 'Internal data pack operated through owner.',
          owningDriver: 'agentic/code/addons/owner/skills/owner/SKILL.md',
        },
      },
    });

    const report = buildCoverageReport(repo);
    expect(report.components.find(item => item.component === 'internal')?.status).toBe('exempt');
  });
});
