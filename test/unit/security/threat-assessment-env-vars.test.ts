// Environment material needs a value-directed extraction request (#4450).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessThreat } from '../../../tools/security/threat-assessment.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/issues/env-vars-policy.json', import.meta.url), 'utf8'));

describe('environment variable request context', () => {
  it.each(fixtures)('$id: $action', ({ body, action }) => {
    for (const surface of ['issue-body', 'issue-comment', 'outbound-maintainer-comment']) {
      const report = assessThreat({ surface, content: body });
      expect(report.decision.action, `${surface}: ${body}`).toBe(action);
      const findings = report.findings.filter(finding => finding.ruleId === 'credential-or-env-probing');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some(finding => !finding.suppressed)).toBe(action !== 'proceed');
    }
  });
});
