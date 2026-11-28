// Sensitive file mentions need an action aimed at the file or its contents (#4515).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessThreat, THREAT_SURFACES } from '../../../tools/security/threat-assessment.mjs';
import { assessThreat as assessShippedThreat } from '../../../agentic/code/plugins/sdlc/tools/security/threat-assessment.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/issues/sensitive-file-policy.json', import.meta.url), 'utf8'));

describe.each([
  { name: 'source', assess: assessThreat },
  { name: 'shipped', assess: assessShippedThreat },
])('sensitive file request context: $name', ({ assess }) => {
  it.each(fixtures)('$id: $action', ({ body, action }) => {
    for (const surface of THREAT_SURFACES) {
      const report = assess({ surface, content: body });
      expect(report.decision.action, `${surface}: ${body}`).toBe(action);
      const findings = report.findings.filter(finding => finding.ruleId === 'sensitive-file-target');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some(finding => !finding.suppressed)).toBe(action !== 'proceed');
      if (action === 'proceed' && !body.startsWith('Do not') && !body.startsWith('>')) {
        expect(findings.every(finding => finding.context === 'descriptive')).toBe(true);
      }
    }
  });

  it.each(THREAT_SURFACES)('preserves explicit requested context on %s', surface => {
    const report = assess({ surface, content: fixtures[0].body, semanticContext: 'requested' });
    expect(report.decision.action).toBe('flag');
    expect(report.findings[0]).toMatchObject({ context: 'requested', suppressed: false });
  });
});
