import { mkdtemp } from '../../helpers/temp-dir.js';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultArtifactOutputs, recordArtifactOutputProvenance, resolveArtifactOutputs, validateArtifactOutputs } from '../../../src/artifacts/output-policy.js';

describe('artifact output policy', () => {
  it('defaults legacy projects to canonical AIWG and explicit-only provider output', () => {
    expect(defaultArtifactOutputs()).toEqual({ canonical: 'aiwg', provider_native: 'explicit-only', destinations: {} });
    expect(resolveArtifactOutputs({ supportedDestinations: ['claude-code.design'], providerDefaults: ['claude-code.design'] })).toMatchObject({ canonical: 'aiwg', presentations: [] });
  });

  it.each(['ordinary SDLC plan', 'review artifact'])('keeps an %s canonical with no implicit presentation', () => {
    expect(resolveArtifactOutputs({ supportedDestinations: ['claude-code.design'] })).toMatchObject({
      canonical: 'aiwg', presentations: [], authority: {},
    });
  });

  it('allows explicit Claude Design while retaining canonical persistence', () => {
    const result = resolveArtifactOutputs({
      project: { canonical: 'aiwg', provider_native: 'explicit-only', destinations: { 'claude-code.design': { enabled: true, use_when: 'user-requested' } } },
      explicitDestinations: ['claude-code.design'], supportedDestinations: ['claude-code.design'],
    });
    expect(result).toMatchObject({ canonical: 'aiwg', presentations: ['claude-code.design'], authority: { 'claude-code.design': 'explicit-task' } });
  });

  it('fails safe for unknown destinations and simulated provider-default changes', () => {
    const result = resolveArtifactOutputs({ providerDefaults: ['claude-code.future-canvas'], supportedDestinations: ['claude-code.design'] });
    expect(result.presentations).toEqual([]);
    expect(result.diagnostics[0]).toMatch(/unknown or unsupported/);
  });

  it('resolves project ceiling, explicit task, user preference, then provider default deterministically', () => {
    const project = {
      canonical: 'aiwg' as const,
      provider_native: 'project-default' as const,
      destinations: {
        'claude-code.design': { enabled: true, use_when: 'project-default' as const },
        'claude-code.canvas': { enabled: true, use_when: 'project-default' as const },
      },
    };
    const userPreference = {
      provider_native: 'project-default' as const,
      destinations: { 'claude-code.design': { enabled: true, use_when: 'project-default' as const } },
    };
    const result = resolveArtifactOutputs({
      project, userPreference,
      explicitDestinations: ['claude-code.canvas'],
      providerDefaults: ['claude-code.design', 'claude-code.canvas'],
      supportedDestinations: ['claude-code.design', 'claude-code.canvas'],
    });
    expect(result.authority).toEqual({
      'claude-code.design': 'user-preference',
      'claude-code.canvas': 'explicit-task',
    });
  });

  it('lets project policy disable even an explicit request', () => {
    const result = resolveArtifactOutputs({
      project: { provider_native: 'disabled' }, explicitDestinations: ['claude-code.design'], supportedDestinations: ['claude-code.design'],
    });
    expect(result.presentations).toEqual([]);
    expect(result.diagnostics[0]).toMatch(/disabled by project policy/);
  });

  it('validates the project schema contract', () => {
    expect(validateArtifactOutputs({ canonical: 'aiwg', provider_native: 'explicit-only' })).toEqual([]);
    expect(validateArtifactOutputs({ provider_native: 'surprise' as never })).toContain('artifact_outputs.provider_native must be disabled, explicit-only, or project-default');
  });

  it('records dual-output provenance with one canonical source of truth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-artifact-output-'));
    const path = await recordArtifactOutputProvenance(root, {
      canonicalPath: '/project/.aiwg/planning/plan.md', presentationDestination: 'claude-code.design',
      presentationReference: 'design://artifact/123', authority: 'explicit-task',
    });
    const record = JSON.parse((await readFile(path, 'utf8')).trim());
    expect(record).toMatchObject({ schemaVersion: 'aiwg.artifact-output-provenance.v1', canonicalPath: '/project/.aiwg/planning/plan.md', presentationDestination: 'claude-code.design' });
  });
});
