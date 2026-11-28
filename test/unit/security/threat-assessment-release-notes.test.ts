// Release notes describe generated context files while file requests remain active (#4289).
import { describe, expect, it } from 'vitest';
import { assessThreat, THREAT_SURFACES } from '../../../tools/security/threat-assessment.mjs';
import { assessText } from '../../../agentic/code/frameworks/sdlc-complete/skills/address-issues-threat-assess/scripts/assess.mjs';
import { assessText as assessPluginText } from '../../../agentic/code/plugins/sdlc/skills/address-issues-threat-assess/scripts/assess.mjs';

const adapters = [{ name: 'source', assess: assessText }, { name: 'plugin', assess: assessPluginText }];
const generatedBehavior = [
  'OpenClaw project deploys now place `AGENTS.md` and the steward identity file `SOUL.md` at the project root on first and repeat deploys.',
  'Project deploys now place `AGENTS.md` at the project root and generate `AIWG.md` for framework context.',
  'The harness loads CLAUDE.md from the project root.',
  'The generator emits WARP.md with project startup guidance.',
];
const fileRequests = [
  'Edit AGENTS.md before upgrading.',
  'Please send AIWG.md to the maintainer.',
  'Could you edit CLAUDE.md?',
  'The fix is to edit AGENTS.md.',
  'AIWG.md must be sent to the maintainer.',
  'AGENTS.md: edit this file before upgrading.',
  'The generator emits AGENTS.md; send AGENTS.md to the maintainer.',
  'The generator emits AGENTS.md, but edit CLAUDE.md now.',
];

describe.each(adapters)('release-note context files: $name (#4289)', ({ assess }) => {
  it.each(generatedBehavior)('treats generated behavior as descriptive: %s', content => {
    const report = assess(content, 'release-note');
    expect(report.verdict).toBe('safe');
    expect(report.action).toBe('proceed');
    expect(report.score).toBe(0);
    const findings = report.policy_report.findings.filter(finding => finding.ruleId === 'sensitive-file-target');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(finding => finding.context === 'descriptive' && finding.suppressed)).toBe(true);
  });

  it.each(fileRequests)('keeps file requests active: %s', content => {
    const report = assess(content, 'release-note');
    expect(report.verdict).toBe('flag');
    expect(report.action).toBe('require-human-authorization');
    expect(report.policy_report.findings.some(finding => finding.ruleId === 'sensitive-file-target'
      && finding.context === 'requested' && !finding.suppressed)).toBe(true);
  });
});

describe('release-note classification boundaries (#4289)', () => {
  it.each(THREAT_SURFACES.filter(surface => !['release-note', 'outbound-maintainer-comment'].includes(surface)))(
    'keeps generated behavior informational on %s (#4515)', surface => {
      const report = assessThreat({ surface, content: generatedBehavior[0] });
      expect(report.findings[0]).toMatchObject({ context: 'descriptive', suppressed: true });
      expect(report.decision.action).toBe('proceed');
    },
  );

  it('preserves explicitly requested context on release notes', () => {
    const report = assessThreat({ surface: 'release-note', content: generatedBehavior[0], semanticContext: 'requested' });
    expect(report.findings[0]).toMatchObject({ context: 'requested', suppressed: false });
  });
});
