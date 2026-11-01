import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

const publishedReadmes = [
  {
    packageName: '@aiwg/cli',
    path: 'packages/cli/README.md',
    title: '# @aiwg/cli',
    install: 'npm install --global @aiwg/cli',
  },
  {
    packageName: '@aiwg/cockpit',
    path: 'apps/cockpit/README.md',
    title: '# AIWG Cockpit',
    install: 'npm i -g @aiwg/cockpit',
  },
] as const;

describe('published package README quality contract', () => {
  it('aiwg retains a substantive capability reference and a complete first-use path', () => {
    const body = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const wordCount = body.trim().split(/\s+/).length;

    // Preserve the package's broad README surface. Editorial revisions should
    // improve capability coverage, not replace the reference with a short stub.
    expect(Buffer.byteLength(body)).toBeGreaterThan(25_000);
    expect(wordCount).toBeGreaterThan(2_500);
    expect(body).toMatch(/^# AIWG$/m);
    expect(body).toMatch(/^## Quick Start$/m);
    expect(body).toMatch(/^## How It Works$/m);
    expect(body).toMatch(/^## Documentation$/m);
    expect(body).toMatch(/^## Installation Troubleshooting$/m);
    for (const capability of [
      'Simple Building Blocks',
      'The Six Core Components',
      'What You Get',
      'Framework Deep Dives',
      'Configuration & Customization',
      'Issue-Driven Development',
      'Platform Support',
      'Architecture',
      'Research Foundations',
    ]) {
      expect(body, `README must retain substantive ${capability} coverage`)
        .toContain(`## ${capability}\n`);
    }
    expect(body).toMatch(/^## Voice Framework/m);
    expect(body).toMatch(/^## MCP Server/m);
    expect(body).toMatch(/^## Agent Loop/m);
    expect(body).toMatch(/^## RLM/m);
    expect(body).toContain('https://aiwg.io/setup.aiwg.yaml');
    expect(body).toContain('.aiwg/marketing/brand/audit/readme-review.md');

    for (const destination of [
      'docs/getting-started/install-connect-verify.md',
      'docs/getting-started/just-try-it.md',
      'docs/overview/capabilities.md',
      'docs/cli/install-and-repair.md',
      'docs/cli/reference.md',
      'docs/troubleshooting/index.md',
      'docs/architecture-overview.md',
      'docs/providers/provider-inventory.md',
      'docs/overview/reading-list.md',
    ]) {
      expect(body, `README must preserve access to ${destination}`).toContain(`](${destination})`);
      expect(existsSync(path.join(ROOT, destination)), destination).toBe(true);
    }
  });

  for (const published of publishedReadmes) {
    it(`${published.packageName} ships a full dedicated README`, () => {
      const body = readFileSync(path.join(ROOT, published.path), 'utf8');
      const wordCount = body.trim().split(/\s+/).length;

      expect(Buffer.byteLength(body), `${published.path} must not regress to a package stub`).toBeGreaterThan(25_000);
      expect(wordCount, `${published.path} must retain full package-level documentation`).toBeGreaterThan(2_500);
      expect(body).toContain(published.title);
      expect(body).toContain(published.install);
      expect(body).toMatch(/^## Quick Start$/m);
      expect(body).toMatch(/^## (How It Works|Architecture)$/m);
      expect(body).toMatch(/^## Installation Troubleshooting$/m);
      expect(body).toMatch(/^## (Documentation|See also)$/m);
    });
  }
});

it('@aiwg/flue documents its app-owned peer and public library exports', () => {
  const body = readFileSync(path.join(ROOT, 'packages/flue/README.md'), 'utf8');
  expect(body).toMatch(/^# @aiwg\/flue$/m);
  expect(body.trim().split(/\s+/).length).toBeGreaterThan(100);
  for (const value of ['npm install @aiwg/flue', '@flue/runtime@2.3.0', '@aiwg/flue/skills/', '@aiwg/flue/specialists', '@aiwg/flue/tools/node', '@aiwg/flue/tools']) expect(body).toContain(value);
});
