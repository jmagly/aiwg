// Regressions for the agy 1.5.10 direct-worker contract (#4348).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AntigravityAdapter, buildAntigravityStdinFrame, ANTIGRAVITY_SUPPORTED_VERSIONS }
  from '../../../tools/ralph-external/lib/antigravity-adapter.mjs';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';

const adapter = new AntigravityAdapter();
const args = (model: string, effort: string) => adapter.buildWorkerArgs({ brief: 'brief', cwd: '/work',
  selected: { model, effort: { value: effort } } }, null, { sandbox: 'read-only' });

describe('agy 1.5.10 direct-worker regression', () => {
  it('frames a candidate structured user message as one escaped NDJSON line and EOF', () => {
    const brief = 'first\n{"event":"user"}\r\n"quoted" café';
    const bytes = buildAntigravityStdinFrame(Buffer.from(brief));
    expect(bytes.toString()).toBe(JSON.stringify({ event: 'user', message: { content: brief } }) + '\n');
    expect(bytes.toString().split('\n')).toHaveLength(2);
    expect(buildAntigravityStdinFrame(new Uint8Array(Buffer.from('brief'))))
      .toEqual(buildAntigravityStdinFrame('brief'));
  });
  it.each(['', '\0', 42, new Uint8Array([0xff])])('refuses malformed brief %j', brief => {
    expect(() => buildAntigravityStdinFrame(brief as any)).toThrow();
  });
  for (const family of ['neon', 'argon', 'hydrogen']) {
    it.each(['low', 'medium', 'high', 'xhigh'])(`maps ${family} effort %s into the model id without --effort`, effort => {
      const expected = ['--input-format', 'stream-json', '--output-format', 'stream-json',
        '--model', `gemini-4-${family}-${effort}`, '--sandbox', '--disable-slash-commands'];
      expect(args(`gemini-4-${family}`, effort)).toEqual(expected);
      expect(args(`gemini-4-${family}-low`, effort)).toEqual(expected);
    });
  }
  it.each(['gemini-3-pro', 'gemini-pro-orchestrator-neon', 'unknown-model', 'gemini-4-neon-max'])
    ('refuses unevidenced effort support for %s', model => {
      expect(() => args(model, 'low')).toThrow(/model.*effort|effort.*model/i);
    });
  it('refuses max rather than silently downgrading the selected effort', () => {
    expect(() => args('gemini-4-neon-low', 'max')).toThrow(/effort/i);
  });
  it('pins the 1.5.10 release line without claiming dispatch qualification', () => {
    const registry = loadProviderModelCapabilities().providers.antigravity.workerHealthAdapter!;
    expect(ANTIGRAVITY_SUPPORTED_VERSIONS).toEqual(['>=1.5.10 <1.6.0']);
    expect(registry.supportedVersions).toBe('>=1.5.10 <1.6.0');
    expect(registry.invocationProfiles!['direct-shell'].supportedVersions).toBe('>=1.5.10 <1.6.0');
    expect(registry.invocation.argv).not.toContain('--effort');
    expect(registry.qualification.status).toBe('unqualified');
    const catalog = JSON.parse(readFileSync('agentic/code/providers/model-catalog.v1.json', 'utf8'));
    expect(Object.values(catalog.providers.antigravity.roles).map((role: any) => role.id))
      .toEqual(['gemini-4-neon-high', 'gemini-4-argon-medium', 'gemini-4-hydrogen-low']);
  });
});
