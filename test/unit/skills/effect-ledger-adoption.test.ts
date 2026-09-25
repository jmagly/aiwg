/**
 * address-issues and issue-close adopt the effect ledger (#2722): the skills
 * reference `aiwg effect` at the named phases, allow the command, keep their
 * generated plugin copies in step with the canonical sources, and render the
 * `aiwg-effect` marker the tracker verifier matches.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  renderCycleComment,
  validateCycleComment,
} from '../../../agentic/code/frameworks/sdlc-complete/skills/address-issues/scripts/cycle-comment.mjs';
import { effectId, parseEffectMarkers } from '../../../src/effects/index.js';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const SOURCE = 'agentic/code/frameworks/sdlc-complete/skills';
const COPIES = ['agentic/code/plugins/sdlc/skills', 'agentic/code/plugins/codex-sdlc/skills'];

function frontmatter(markdown: string): Record<string, any> {
  return parseYaml(markdown.split(/^---$/m)[1] ?? '') as Record<string, any>;
}

/** The text of a markdown section from `heading` to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)![0].length;
  const lines = markdown.slice(start + heading.length).split('\n');
  let fenced = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('```')) fenced = !fenced;
    const depth = /^(#+) /.exec(line)?.[1].length;
    if (!fenced && depth !== undefined && depth <= level) break;
    out.push(line);
  }
  return out.join('\n');
}

describe('address-issues effect-ledger adoption', () => {
  const skill = read(`${SOURCE}/address-issues/SKILL.md`);

  it('Phase 2 Step 2 records the cycle comment with lookup, reconcile, intent and record --kind tracker.comment', () => {
    const step = section(skill, '#### Step 2: Post Cycle Status Comment');
    expect(step).toContain('--kind tracker.comment');
    for (const command of ['aiwg effect id', 'aiwg effect lookup', 'aiwg effect reconcile', 'aiwg effect intent', 'aiwg effect record']) {
      expect(step, command).toContain(command);
    }
    expect(step).toContain('--verify');
    expect(step).toContain('<!-- aiwg-effect: <id> -->');
  });

  it('Phase 3.5 step 1 confirms the merge with an intent, reconcile or probe for tracker.pr.merged', () => {
    const phase = section(skill, '### Phase 3.5: Verify Merged Fix and Close');
    const step1 = phase.slice(phase.indexOf('1. **Confirm merge state**'), phase.indexOf('2. **Re-run verification**'));
    expect(step1).toContain('aiwg effect intent --kind tracker.pr.merged');
    expect(step1).toContain('aiwg effect reconcile --kind tracker.pr.merged');
    expect(step1).toContain('aiwg effect probe --kind tracker.pr.merged');
    for (const code of ['`0`', '`3`', '`4`']) expect(step1).toContain(`Exit ${code}`);
    expect(step1).not.toContain('merged_at');
  });

  it('lists aiwg effect in Integration Points and allows Bash', () => {
    expect(section(skill, '## Integration Points')).toMatch(/\| `aiwg effect` \|/);
    const tools = String(frontmatter(skill).commandHint.allowedTools).split(/,\s*/);
    expect(tools.some(tool => tool === 'Bash' || tool === 'Bash(aiwg effect *)')).toBe(true);
  });
});

describe('issue-close effect-ledger adoption', () => {
  const skill = read(`${SOURCE}/issue-close/SKILL.md`);

  it('allows Bash(aiwg effect *)', () => {
    expect(String(frontmatter(skill).commandHint.allowedTools).split(/,\s*/)).toContain('Bash(aiwg effect *)');
  });

  it('Step 6 guards the closing comment with lookup and records the comment and the closure', () => {
    const step = section(skill, '### Step 6: Close Issue with Summary');
    const guard = step.indexOf('aiwg effect lookup');
    const post = step.indexOf('gh issue close');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(post);
    expect(step).toContain('aiwg effect reconcile');
    expect(step).toContain('--kind tracker.comment');
    expect(step).toContain('--kind tracker.issue.closed');
    expect(step.match(/aiwg effect record/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('generated plugin copies', () => {
  for (const file of ['address-issues/SKILL.md', 'address-issues/scripts/cycle-comment.mjs', 'issue-close/SKILL.md']) {
    for (const copy of COPIES) {
      it(`${copy}/${file} matches the canonical source`, () => {
        expect(read(`${copy}/${file}`)).toBe(read(`${SOURCE}/${file}`));
      });
    }
  }
});

describe('cycle comment effect marker', () => {
  const id = effectId({ scope: { tenant: 'local', project: 'owner/repo', subsystem: 'delivery' }, kind: 'tracker.comment',
    target: 'gitea:owner/repo#12', context: { issue: 12, action: 'cycle', cycle: 2 } });
  const input = { cycle: 2, status: 'Progress', actions: '- Did work.', checklist: '- [x] Work.', blockers: 'None.',
    openQuestions: 'None.', nextSteps: 'Continue.' };

  it('renders the marker the tracker verifier matches and still validates', () => {
    const rendered = renderCycleComment({ ...input, effectId: id });
    expect(parseEffectMarkers(rendered)).toEqual([id]);
    expect(validateCycleComment(rendered)).toEqual({ valid: true, errors: [] });
    expect(parseEffectMarkers(renderCycleComment(input))).toEqual([]);
    expect(() => renderCycleComment({ ...input, effectId: 'not-an-effect-id' })).toThrow(/effectId/);
  });
});
