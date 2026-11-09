// Checks lookup-before-ask instructions at each rule/skill authorization boundary.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const addon = 'agentic/code/addons/aiwg-utils';
const sdlc = 'agentic/code/frameworks/sdlc-complete/skills';
const read = (path: string) => readFileSync(path, 'utf8');
const command = 'aiwg config authorization check --action-file "$ACTION_FILE" --target "$TARGET_REPO"';
const processes = [
  ['human-authorization-guidance', `${addon}/rules/human-authorization-guidance.md`],
  ['native-ux-tools', `${addon}/rules/native-ux-tools.md`],
  ['subagent-scoping', `${addon}/rules/subagent-scoping.md`],
  ['issue-create', `${sdlc}/issue-create/SKILL.md`],
  ['address-issues', `${sdlc}/address-issues/SKILL.md`],
  ['aiwg-issue', `${addon}/skills/aiwg-issue/SKILL.md`],
  ['aiwg-pr', `${addon}/skills/aiwg-pr/SKILL.md`],
  ['commit-and-push', `${addon}/skills/commit-and-push/SKILL.md`],
] as const;

describe('lookup-before-ask guidance (#4003 part A)', () => {
  it.each(processes)('%s requires the exact action check before asking', (_name, path) => {
    const text = read(path);
    expect(text).toMatch(/before asking[^\n]*authoriz/i);
    expect(text).toContain(command);
    expect(text).toMatch(/only[^\n]*`auto-authorized`[^\n]*receipt/i);
    expect(text).toContain('`escalate`');
    expect(text).toContain('`deny`');
    expect(text).toMatch(/missing receipt|missing\/invalid[^\n]*receipt/i);
    expect(text).toContain('Platform prompts are never bypassed');
  });

  it('offers native durable capture without promoting text answers into grants', () => {
    const text = read(`${addon}/rules/native-ux-tools.md`);
    expect(text).toContain('offer to remember');
    expect(text).toContain('aiwg_authorization_grant_request');
    expect(text).toMatch(/only[^\n]*MCP form[^\n]*confirm/i);
    expect(text).toMatch(/never[^\n]*record[^\n]*text reply/i);
    expect(text).toMatch(/declin[^\n]*cancel[^\n]*unsupported[^\n]*no grant/i);
  });

  it('passes resolvable references and requires workers to recheck in the same workspace', () => {
    const text = read(`${addon}/rules/subagent-scoping.md`);
    expect(text).toContain('`grantId`');
    expect(text).toMatch(/never[^\n]*raw approval text/i);
    expect(text).toContain('same canonical workspace');
    expect(text).toMatch(/worker[^\n]*recheck/i);
    expect(text).toMatch(/expired[^\n]*revoked[^\n]*exhausted/i);
  });

  it.each(['issue-create', 'address-issues'])('%s retains honest tracker categories and override review', name => {
    const text = read(`${sdlc}/${name}/SKILL.md`);
    expect(text).toContain('`tracker.write`');
    expect(text).toContain('scoped durable grant');
    expect(text).toContain('`threat.override`');
    expect(text).toContain('cannot be auto-authorized');
    expect(text).not.toContain('Write only the six descriptor fields');
  });

  it.each(['aiwg-refresh', 'use'])('%s keeps removal lists under explicit review', name => {
    const text = read(`${addon}/skills/${name}/SKILL.md`);
    expect(text).toMatch(/removal list[^\n]*explicit human review/i);
    expect(text).toMatch(/lookup[^\n]*never[^\n]*bypass/i);
  });

  it('documents every rule and skill process in the authorization guide', () => {
    const text = read('docs/configuration/hitl-authorization.md');
    expect(text).toContain('## Lookup-before-ask processes');
    for (const [name] of processes) expect(text).toContain(`| \`${name}\` |`);
  });
});
