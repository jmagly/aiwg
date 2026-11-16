// Check branch-specific publication remedies at the SDK validation boundary.
import { describe, expect, it } from 'vitest';
import { publicationInputSchema, parsePublication } from '../../../src/mcp/tools/worker-verify-deliver-schema.mjs';

const stop = { status: 'blocked', code: 'POLICY_DENIED', blocking_rule: 'Policy denies launch.', launch_count: 0 };
const publication = { artifact_path: '/work/answer.json', deliverable_path: '/deliver/answer.json',
  checks: [{ id: 'content', command: '/usr/bin/jq', args: ['.', '/work/answer.json'] }] };
const messages = (input: object) => {
  const parsed = publicationInputSchema.safeParse(input);
  expect(parsed.success).toBe(false);
  return parsed.error!.issues.map(issue => issue.message);
};

describe('T-OG-04 publication schema refusal remedies', () => {
  it('names a missing worker run_dir without typed-stop or Zod union noise (#4203)', () => {
    expect(messages(publication)).toEqual(['PUBLICATION_INVALID: run_dir is required for a worker publication']);
    expect(() => parsePublication(publication)).toThrow('PUBLICATION_INVALID: run_dir is required for a worker publication');
  });
  it('renders each missing and unknown publication key on its own line', () => {
    expect(messages({ surprise: true, extra: true })).toEqual([
      'PUBLICATION_INVALID: run_dir is required for a worker publication',
      'PUBLICATION_INVALID: deliverable_path is required for a worker publication',
      'PUBLICATION_INVALID: checks is required for a worker publication',
      'PUBLICATION_INVALID: surprise is unknown for a worker publication',
      'PUBLICATION_INVALID: extra is unknown for a worker publication',
    ]);
  });
  it('selects typed-stop remedies and renders nested missing and unknown keys', () => {
    const { blocking_rule: _rule, ...missingRule } = stop;
    expect(messages({ deliverable_path: publication.deliverable_path, typed_stop: { ...missingRule, extra: true }, checks: [] })).toEqual([
      'TYPED_STOP_INVALID: typed_stop.blocking_rule is required for a typed stop',
      'TYPED_STOP_INVALID: typed_stop.extra is unknown for a typed stop',
      'TYPED_STOP_INVALID: checks is unknown for a typed stop',
    ]);
  });
  it.each([null, undefined])('uses typed-stop errors whenever typed_stop is present (%s)', typed_stop => {
    const findings = messages({ ...publication, typed_stop });
    expect(findings.every(message => message.startsWith('TYPED_STOP_INVALID:'))).toBe(true);
    expect(findings.some(message => message.includes('run_dir is required'))).toBe(false);
  });
  it('keeps both valid strict branches accepted', () => {
    expect(publicationInputSchema.safeParse({ ...publication, run_dir: '/runs/one' }).success).toBe(true);
    expect(publicationInputSchema.safeParse({ deliverable_path: publication.deliverable_path, typed_stop: stop }).success).toBe(true);
  });
});
