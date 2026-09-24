import { describe, expect, it } from 'vitest';
import { QUALIFICATION_PRIVACY_SURFACES, scanQualificationPrivacy, type QualificationPrivacyCapture } from '../../../src/decision/qualification/privacy.js';

const captures = (): QualificationPrivacyCapture[] => QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface, content: '' }));

describe('qualification privacy surface scans', () => {
  it('PRV-SURFACE-01 requires an observed capture for each required surface', () => {
    const marker = 'private@example.invalid';
    const missing = scanQualificationPrivacy(captures().filter(item => item.surface !== 'stderr'), [marker]);
    expect(missing).toEqual({ clean: false, missing: ['stderr'], affected: [] });
    expect(scanQualificationPrivacy(captures(), [marker]).clean).toBe(true);
    expect(() => scanQualificationPrivacy(captures(), [])).toThrow('requires nonempty');
    expect(() => scanQualificationPrivacy([...captures(), captures()[0]!], [marker])).toThrow('duplicate');
  });

  it.each(QUALIFICATION_PRIVACY_SURFACES)('PRV-SURFACE-02 detects a canary in %s without exporting it', surface => {
    const marker = 'private@example.invalid';
    const observed = captures().map(item => item.surface === surface
      ? { ...item, content: new TextEncoder().encode(`prefix ${marker} suffix`) } : item);
    const report = scanQualificationPrivacy(observed, [marker]);
    expect(report).toEqual({ clean: false, missing: [], affected: [surface] });
    expect(JSON.stringify(report)).not.toContain(marker);
  });

  it('PRV-SURFACE-03 catches escaped canaries in serialized reports', () => {
    const marker = 'secret\nmarker';
    const observed = captures().map(item => item.surface === 'test-report'
      ? { ...item, content: JSON.stringify({ output: marker }) } : item);
    expect(scanQualificationPrivacy(observed, [marker]).affected).toEqual(['test-report']);
  });
});
