// Outbound reports may name sensitive files without requesting file access (#4253).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessThreat } from '../../../tools/security/threat-assessment.mjs';
import { assessText } from '../../../agentic/code/frameworks/sdlc-complete/skills/address-issues-threat-assess/scripts/assess.mjs';
import { assessText as assessPluginText } from '../../../agentic/code/plugins/sdlc/skills/address-issues-threat-assess/scripts/assess.mjs';

const corpus = JSON.parse(readFileSync('test/fixtures/security/threat-assessment-corpus.json', 'utf8'));
const regressions = corpus.cases.filter((entry: { id: string }) => entry.id.startsWith('outbound-4253-'));
const adapters = [{ name: 'source', assess: assessText }, { name: 'plugin', assess: assessPluginText }];

describe('outbound maintainer file mentions (#4253)', () => {
  it.each(regressions.flatMap(entry => adapters.map(adapter => ({ ...entry, ...adapter }))))('$name: $id', ({ input, malicious, assess }) => {
    const report = assess(input.content, input.surface);
    expect(report.verdict).toBe(malicious ? 'flag' : 'safe');
    expect(report.action).toBe(malicious ? 'require-human-authorization' : 'proceed');
    const findings = report.policy_report.findings.filter(finding => finding.ruleId === 'sensitive-file-target');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(finding => finding.context === (malicious ? 'requested' : 'descriptive')
      && finding.suppressed === !malicious)).toBe(true);
  });

  it.each([
    'Open CLAUDE.md.',
    'Edit AGENTS.md.',
    'Delete WARP.md.',
    'Could you read AIWG.md?',
    'AIWG.md must be opened before discovery.',
    'See AIWG.md and edit that file.',
    'The harness loaded AIWG.md; read AIWG.md now.',
    'The harness loaded AIWG.md, but open AGENTS.md now.',
    'The fix is to edit `.github/workflows/ci.yml`.',
  ])('keeps file requests active: %s', content => {
    for (const { assess } of adapters) {
      const report = assess(content, 'outbound-maintainer-comment');
      expect(report.verdict).toBe('flag');
      expect(report.signals.some(signal => signal.id === 'sensitive-file-target'
        && signal.context === 'requested')).toBe(true);
    }
  });

  it.each(['issue-body', 'issue-comment', 'handoff'])('preserves conservative fallback on %s', surface => {
    const report = assessThreat({ surface, content: 'AIWG.md startup context' });
    expect(report.findings[0]).toMatchObject({ context: 'requested', suppressed: false });
  });

  it('preserves explicit requested context on the outbound surface', () => {
    const report = assessThreat({ surface: 'outbound-maintainer-comment', content: 'AIWG.md', semanticContext: 'requested' });
    expect(report.findings[0]).toMatchObject({ context: 'requested', suppressed: false });
  });
});
