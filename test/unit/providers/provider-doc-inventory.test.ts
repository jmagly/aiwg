import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listProviderDefinitions } from '../../../src/providers/provider-definitions.js';

const projectRoot = resolve(import.meta.dirname, '../../..');

describe('public provider inventory', () => {
  it('matches the named built-in provider registry exactly', () => {
    const namedProviders = listProviderDefinitions().filter(({ id }) => id !== 'generic');
    const inventory = readFileSync(resolve(projectRoot, 'docs/providers/provider-inventory.md'), 'utf8');
    const documentedIds = [...inventory.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);

    expect(namedProviders).toHaveLength(18);
    expect(listProviderDefinitions()).toHaveLength(19);
    expect(documentedIds).toEqual(namedProviders.map(({ id }) => id));
    expect(inventory).toContain(`**${namedProviders.length} named provider integrations**`);
    expect(inventory).toMatch(/`generic`\s+adapter is a nineteenth registry entry/);
    for (const provider of namedProviders) {
      const status = provider.status[0].toUpperCase() + provider.status.slice(1);
      expect(inventory, provider.id).toMatch(
        new RegExp('^\\| `' + provider.id + '` \\| .* \\| ' + status + '(?: | \\|)', 'm'),
      );
    }
  });

  it('keeps primary public surfaces on the same count and includes Grok Build, DeepSeek Harness, OMP, and Pi', () => {
    const publicFiles = [
      'README.md',
      'docs/config.json',
      'docs/welcome.html',
      'docs/overview/what-is-aiwg.md',
      'docs/overview/executive-brief.md',
      'docs/integrations/cross-platform-overview.md',
      'docs/cli/reference.md',
    ];

    for (const relativePath of publicFiles) {
      const content = readFileSync(resolve(projectRoot, relativePath), 'utf8');
      expect(content, relativePath).toMatch(/18 (?:named )?provider integrations/i);
      expect(content, relativePath).toMatch(/Antigravity/i);
      expect(content, relativePath).toMatch(/Pi Coding Agent/i);
      expect(content, relativePath).toMatch(/Oh My Pi/i);
      expect(content, relativePath).toMatch(/DeepSeek Harness/i);
      expect(content, relativePath).toMatch(/Grok Bot/i);
      expect(content, relativePath).toMatch(/Grok Build/i);
      expect(content, relativePath).toMatch(/Muse Code/i);
    }
  });

  it('publishes OMP in setup navigation and maintained provider handoffs', () => {
    const docsManifest = JSON.parse(readFileSync(resolve(projectRoot, 'docs/_manifest.json'), 'utf8'));
    const integrationManifest = JSON.parse(
      readFileSync(resolve(projectRoot, 'docs/integrations/_manifest.json'), 'utf8'),
    );
    const sectionIds = docsManifest.sections.map(({ id }: { id: string }) => id);

    expect(new Set(docsManifest.order).size).toBe(docsManifest.order.length);
    expect(docsManifest.order).toContain('integrations/omp-quickstart');
    expect(docsManifest.order).toContain('integrations/deepseek-harness-quickstart');
    expect(integrationManifest.order).toContain('omp-quickstart');
    expect(integrationManifest.order).toContain('deepseek-harness-quickstart');
    expect(sectionIds).toContain('integrations/omp-quickstart');
    expect(sectionIds).toContain('integrations/deepseek-harness-quickstart');
    expect(sectionIds).toContain('providers/deepseek-harness');
    expect(sectionIds).toContain('providers/deepseek-harness-sessions');
    expect(sectionIds).toContain('providers/omp');
    expect(sectionIds).toContain('providers/omp-verification');
    expect(sectionIds).toContain('providers/omp-sessions');

    for (const relativePath of [
      'docs/getting-started/README.md',
      'docs/getting-started/install-connect-verify.md',
      'docs/getting-started/provider-handoff.md',
      'docs/agents/providers/README.md',
      'docs/cli/capability-routing.md',
    ]) {
      const content = readFileSync(resolve(projectRoot, relativePath), 'utf8');
      expect(content, relativePath).toMatch(/Oh My Pi/i);
      expect(content, relativePath).toMatch(/Pi Coding Agent/i);
    }
  });

  it('keeps the public homepage list aligned with named deployment providers', () => {
    const homepage = readFileSync(resolve(projectRoot, 'docs/welcome.html'), 'utf8');
    const providerLinks = [...homepage.matchAll(/href="#integrations\/([^"]+-quickstart)"/g)]
      .map((match) => match[1]);

    expect(providerLinks).toEqual([
      'claude-code-quickstart',
      'codex-quickstart',
      'copilot-quickstart',
      'cursor-quickstart',
      'deepseek-harness-quickstart',
      'factory-quickstart',
      'grokbot-quickstart',
      'muse-quickstart',
      'hermes-quickstart',
      'opencode-quickstart',
      'openclaw-quickstart',
      'openhuman-quickstart',
      'omp-quickstart',
      'pi-quickstart',
      'warp-terminal-quickstart',
      'windsurf-quickstart',
    ]);
    expect(homepage).toContain('href="#integrations/omp-quickstart">Oh My Pi</a>');
    expect(homepage).toContain('href="#integrations/pi-quickstart">Pi Coding Agent (pi.dev)</a>');
    expect(homepage).toContain('href="#integrations/deepseek-harness-quickstart">DeepSeek Harness</a>');
    expect(homepage).toContain('href="#integrations/grokbot-quickstart">Grok Bot</a>');
    expect(homepage).toContain('href="#integrations/muse-quickstart">Muse Code</a>');
    expect(homepage).not.toMatch(/Local\/Ollama/);
  });
});
