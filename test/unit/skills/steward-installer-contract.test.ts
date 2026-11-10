import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';
import type { CapabilityMatrix } from '../../../src/providers/capability-matrix.js';
import { formatProvider } from '../../../src/cli/handlers/steward-format.js';

const stewardInstructions = [
  'agentic/code/addons/aiwg-utils/agents/aiwg-steward.md',
  'agentic/code/plugins/utils/agents/aiwg-steward.md',
  'agentic/code/agents/personas/aiwg-steward.md',
  'agentic/code/addons/aiwg-utils/skills/steward/SKILL.md',
  'agentic/code/plugins/utils/skills/steward/SKILL.md',
];

const installerInstructions = [
  'agentic/code/addons/agentic-installer/agents/installer-agent.md',
  'agentic/code/plugins/agentic-installer/agents/installer-agent.md',
];

describe('self-verifying steward installer guidance (#2075)', () => {
  it('routes every steward surface through the one-command readiness result', async () => {
    for (const file of stewardInstructions) {
      const body = await readFile(file, 'utf8');
      expect(body, file).toContain('https://aiwg.io/setup.aiwg.yaml');
      expect(body, file).toMatch(/self-verifying `aiwg use`|self-verifying\n`aiwg use all`/);
      expect(body, file).not.toContain('then verify with `aiwg status --probe --json` and `aiwg doctor`');
      expect(body, file).not.toContain('verify with `aiwg status --probe --json` plus `aiwg doctor`');
    }
  });

  it('keeps canonical and generated steward copies synchronized', async () => {
    const canonicalAgent = await readFile(stewardInstructions[0], 'utf8');
    const pluginAgent = await readFile(stewardInstructions[1], 'utf8');
    const canonicalSkill = await readFile(stewardInstructions[3], 'utf8');
    const pluginSkill = await readFile(stewardInstructions[4], 'utf8');
    expect(pluginAgent).toBe(canonicalAgent);
    expect(pluginSkill).toBe(canonicalSkill);
  });

  it('keeps installer-agent fast paths aligned while preserving standalone recovery routes', async () => {
    for (const file of installerInstructions) {
      const body = await readFile(file, 'utf8');
      expect(body, file).toContain('interview, review, and apply stages');
      expect(body, file).toContain('aiwg.setup.apply.v1');
      expect(body, file).toContain('`aiwg setup --review`');
      expect(body, file).toContain('`aiwg setup --apply`');
      expect(body, file).toContain('audit and recovery routes');
      expect(body, file).toContain('Do not pass the public manifest to `aiwg setup-run`');
    }
  });
});

describe('steward BYOK guidance (#4054)', () => {
  const settings = {
    copilot: ['COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1',
      'COPILOT_PROVIDER_TYPE=openai', 'COPILOT_MODEL=qwen/qwen3.8-27b',
      'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_API_KEY_COMMAND'],
    hermes: ['--provider openrouter -m qwen/qwen3.8-27b', 'OPENROUTER_API_KEY'],
    opencode: ['openrouter/qwen/qwen3.8-27b', 'OPENROUTER_API_KEY'],
    factory: ['custom:', 'reasoning_effort none'],
    codex: ['model_providers', 'env_key'],
    muse: ['unverified'],
  };

  it.each(Object.entries(settings))('surfaces %s settings and verification through existing capabilities', async (id, required) => {
    const matrix = loadYaml(await readFile('agentic/code/providers/capability-matrix.yaml', 'utf8')) as CapabilityMatrix;
    const output = formatProvider(id, matrix.providers[id], matrix);
    for (const setting of required) expect(output, id).toContain(setting);
    expect(output).toContain('Reply with exactly: byok-ok');
    expect(output).toMatch(/log|session/);
    expect(output).toContain('resolved model');
    expect(output).toContain('token-security');
    expect(output).toContain("bill the user's key");
    expect(output).toContain('explicit operator approval');
  });

  it('routes key/provider/harness requests before generic subcommand selection', async () => {
    const body = await readFile(stewardInstructions[3], 'utf8');
    expect(body).toContain('use my OpenRouter key with Hermes');
    expect(body).toContain('bring your own key');
    expect(body).toContain('aiwg show rule token-security --body');
    expect(body).toContain('capabilities --provider <harness>');
    expect(body.indexOf('## Bring Your Own Key')).toBeLessThan(body.indexOf('## Behavior'));
    for (const word of ['argv', 'deployed AIWG files', 'logs', 'receipts']) expect(body).toContain(word);
  });

  it.each(['hermes', 'opencode', 'factory', 'copilot'])('%s docs give a prompt before settings and model verification', async id => {
    const body = await readFile(`docs/providers/${id}-direct.md`, 'utf8');
    const section = body.split('## Bring your own key')[1]?.split('\n## ')[0];
    expect(section, id).toBeDefined();
    expect(section).toMatch(/^\s*> .*key/);
    expect(section).toContain('token-security');
    expect(section).toContain('explicit operator approval');
    expect(section).toContain('Reply with exactly: byok-ok');
    expect(section).toContain('resolved model');
    expect(section).toMatch(/log|session/);
    if (id !== 'factory') expect(section).toContain('qwen/qwen3.8-27b');
    if (id === 'factory') {
      expect(section).toContain('reasoning_effort none');
      expect(section).toContain('custom:');
      expect(section).toContain('environment');
    }
    expect(body).not.toContain('there is no\nOpenRouter key to inject');
  });

  it('keeps steward and BYOK guidance free of literal key examples and key argv flags', async () => {
    const files = [stewardInstructions[3], stewardInstructions[4],
      'agentic/code/providers/capability-matrix.yaml', 'docs/providers/capability-matrix.md',
      ...['hermes', 'opencode', 'factory', 'copilot'].map(id => `docs/providers/${id}-direct.md`)];
    for (const file of files) {
      const body = await readFile(file, 'utf8');
      expect(body, file).not.toMatch(/\bsk-(?:or-)?/i);
      expect(body, file).not.toMatch(/--(?:api-key|provider-api-key|openrouter-api-key)(?:[=\s])/i);
      expect(body, file).not.toMatch(/["']apiKey["']\s*:\s*["'][^"']+/);
    }
  });
});
