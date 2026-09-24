import { describe, expect, it } from 'vitest';
import { captureQualificationLifetime } from '../../../src/decision/qualification/capture.js';
import { withQualificationPrivacyScan } from '../../../src/decision/qualification/runner.js';
import { QUALIFICATION_PRIVACY_SURFACES } from '../../../src/decision/qualification/privacy.js';
import type { QualificationRunManifest } from '../../../src/decision/qualification/types.js';

const manifest: QualificationRunManifest = { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'capture',
  generatedAt: '2026-09-24T00:00:00.000Z', sourceCommit: 'abc', dirty: false, cases: [], evidence: [],
  evidenceFlags: { 'privacy-scan-clean': false } };

describe('decision qualification lifetime capture', () => {
  it('PRV-LIFETIME-02 records stream writes and console output, then restores the original sinks', async () => {
    const write = process.stdout.write;
    const log = console.log;
    const captured = await captureQualificationLifetime(async () => {
      process.stdout.write('stream-line\n');
      console.log('console %s', 'line');
      console.error('to-stderr');
      return 7;
    });
    expect(captured).toMatchObject({ result: 7, threw: false });
    const bySurface = Object.fromEntries(captured.captures.map(item => [item.surface, item.content]));
    expect(bySurface.stdout).toContain('stream-line');
    expect(bySurface.stdout).toContain('console line');
    expect(bySurface.stderr).toContain('to-stderr');
    expect(bySurface['thrown-error']).toBe('');
    expect(process.stdout.write).toBe(write);
    expect(console.log).toBe(log);
  });

  it('PRV-LIFETIME-03 captures a thrown error, including its cause, without rethrowing', async () => {
    const captured = await captureQualificationLifetime(async () => {
      throw new Error('outer', { cause: new Error('inner-marker') });
    });
    expect(captured.threw).toBe(true);
    expect(captured.result).toBeUndefined();
    expect(captured.captures.find(item => item.surface === 'thrown-error')?.content).toContain('inner-marker');
  });

  it('PRV-LIFETIME-04 derives the privacy flag only from a complete, clean scan', () => {
    const clean = QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface, content: '' }));
    expect(withQualificationPrivacyScan(manifest, clean, ['canary']).evidenceFlags['privacy-scan-clean']).toBe(true);
    expect(withQualificationPrivacyScan(manifest, clean.slice(1), ['canary']).evidenceFlags['privacy-scan-clean']).toBe(false);
    expect(withQualificationPrivacyScan(manifest, clean.map(item => item.surface === 'trace' ? { ...item, content: 'x canary' } : item),
      ['canary']).evidenceFlags['privacy-scan-clean']).toBe(false);
    expect(withQualificationPrivacyScan(manifest, clean, []).evidenceFlags['privacy-scan-clean']).toBe(false);
  });
});
