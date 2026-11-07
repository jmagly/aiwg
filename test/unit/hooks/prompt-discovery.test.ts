// Exercise prompt-time discovery through the real standalone hook process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { deployPromptDiscovery } from '../../../tools/agents/providers/muse-prompt-discovery.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceHook = path.join(root, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs');
let hook: string;
let temporary: string;
beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'aiwg-prompt-'));
  const directory = path.join(temporary, 'dist/src/artifacts');
  await mkdir(directory, { recursive: true });
  await copyFile(path.join(root, 'test/fixtures/hooks-prompt-discovery.mjs'), path.join(directory, 'query-engine-discover.js'));
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

async function invoke(prompt: unknown, env: Record<string, string> = {}, raw?: string) {
  const started = performance.now();
  return new Promise<{ code: number | null; stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [hook], {
      cwd: temporary,
      env: { ...process.env, AIWG_ROOT: temporary, AIWG_PROMPT_DISCOVERY: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, elapsed: performance.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(raw ?? JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }));
  });
}

describe.each(['Claude', 'Muse'])('%s prompt discovery', provider => {
  beforeEach(() => {
    hook = sourceHook;
    if (provider === 'Muse') {
      deployPromptDiscovery(temporary);
      hook = path.join(temporary, '.muse/hooks/aiwg-prompt-discovery.cjs');
    }
  });
  it('injects the top three candidates and show/rule bodies/apply guidance', async () => {
    const result = await invoke('Review the authentication code for security issues');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    expect(output.hookEventName).toBe('UserPromptSubmit');
    expect(output.additionalContext).toContain('skill security-review (0.92): Review code');
    expect(output.additionalContext).toContain('agent security-auditor (0.85)');
    expect(output.additionalContext).toContain('rule security-gate (0.70): Apply security requirements');
    expect(output.additionalContext).toContain('Review code for security issues with actionable fixes');
    expect(output.additionalContext).not.toContain('**');
    expect(output.additionalContext).not.toContain('fourth');
    expect(output.additionalContext).toContain('First call: aiwg show <type> <name> (best fit)');
    expect(output.additionalContext).toContain('--rules --with-rule-bodies; --body) -> apply');
    expect(output.additionalContext).toContain('If none fit, run aiwg discover; never decline without it.');
    expect(output.additionalContext.length).toBeLessThan(600);
  });

  it('shares the context budget across long names and 100-character capabilities', async () => {
    const result = await invoke('Review long capabilities for security issues');
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context.length).toBeLessThan(600);
    const rows = context.split('\n').slice(1, 4);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const capability = row.split(': ')[1];
      expect(capability.length).toBeGreaterThan(44);
      expect(capability.length).toBeLessThanOrEqual(100);
      expect(capability).toContain('Detailed capability');
      expect(capability).not.toMatch(/[*_]/);
    }
    expect(context).toContain('-> apply.');
  });

  it.each(['template hints', 'long template hints', 'unsafe template hints', 'weak template hints',
    'weak long template hints ' + '"$`\\'.repeat(100)])('bounds and validates %s', async phrase => {
    const result = await invoke(`Show ${phrase} for an issue update`);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context.length).toBeLessThan(600);
    if (phrase.includes('unsafe')) expect(context).not.toContain('Template ');
    else expect(context).toContain(`Template ${phrase.includes('long') ? 't'.repeat(70) : 'progress-update'}: aiwg show template`);
    expect(context).not.toContain('second-template');
    expect(context).not.toContain('touch');
    if (phrase.includes('weak')) expect(context).toContain('Before any other tool call or answer, run: aiwg discover');
  });

  it.each(['', ' ', 'yes', 'ok', 'go', '1', 'sounds good', 'please do', '/help', '/review authentication', '/aiwg:review authentication'])('skips continuation or harness command %j', async prompt => {
    expect(await invoke(prompt)).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it.each(['review security', 'fix auth', 'please explain this', '/src/auth.ts needs a review'])('keeps short imperative %j', async prompt => {
    expect((await invoke(prompt)).stdout).toContain('additionalContext');
  });

  it.each(['synchronous timeout in discovery', 'asynchronous timeout in discovery'])('bounds %s', async prompt => {
    const result = await invoke(prompt, { AIWG_PROMPT_DISCOVERY_TIMEOUT_MS: '150' });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.elapsed).toBeLessThan(1200);
  });

  it.each(['empty result from discovery', 'weak result from discovery',
    'Is there an AIWG skill that turns Jira CSV exports into flame graphs?'])('requires discover before answering or declining for %s', async prompt => {
    const result = await invoke(prompt);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain(`run: aiwg discover --stdin${prompt.includes('skill') ? ' --type skill' : ''} <<'AIWG_REQUEST'`);
    expect(context).toContain(`Request: ${prompt}`);
    expect(context).not.toContain(`aiwg discover "`);
    expect(context).toContain('then answer from its result. Answering or declining without running it violates the skill-discovery rule.');
    expect(context).not.toMatch(/candidates|rag\.prompt|dataset-trace|Low relevance/);
    expect(context.length).toBeLessThan(600);
    if (prompt.includes('skill')) expect(context).toContain('--type skill');
    else expect(context).not.toContain('--type');
  });

  it.each(['agent', 'command', 'rule', 'template', 'schema', 'flow', 'runbook', 'behavior', 'hook',
    'decision-definition', 'decision-ruleset', 'decision-binding', 'gate-pack', 'workflow'])('preserves a named %s type in the discover instruction', async type => {
    const result = await invoke(`Find AIWG ${type}s for Jira CSV flame graphs`);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain(`--stdin --type ${type === 'workflow' ? 'flow' : type} <<'AIWG_REQUEST'`);
    expect(context).not.toContain('AIWG candidates');
  });

  it('does not restrict the type when a type word only appears in the request (#3952)', async () => {
    const result = await invoke('weak result from discovery: running aiwg refresh removes every managed Claude hook and rule');
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain("run: aiwg discover --stdin <<'AIWG_REQUEST'");
    expect(context).not.toContain('--type');
  });

  it.each([0.69, 0.70])('uses the strong threshold at boundary score %s', async score => {
    const result = await invoke(`Discover boundary score ${score}`);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    if (score < 0.70) {
      expect(context).toMatch(/^Before any other tool call or answer, run: aiwg discover/);
      expect(context).not.toContain('Threshold candidate');
    } else {
      expect(context).toContain('skill boundary (0.70): Threshold candidate');
      expect(context).toContain('If none fit, run aiwg discover; never decline without it.');
    }
  });

  it('bounds a long need with shell metacharacters and routes it through a quoted heredoc', async () => {
    const result = await invoke('Find Jira CSV ' + '"$`\\'.repeat(200));
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain("Before any other tool call or answer, run: aiwg discover --stdin <<'AIWG_REQUEST'");
    expect(context).toContain('Request: Find Jira CSV "$`\\');
    expect(context).not.toContain('aiwg discover "');
    expect(context.length).toBeLessThan(600);
  });

  it('keeps command substitution and the heredoc terminator out of the rendered request (#3946)', async () => {
    const result = await invoke('weak result from discovery: running `aiwg refresh` after $(aiwg use all) AIWG_REQUEST breaks hooks');
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain("<<'AIWG_REQUEST' with the request on the next line");
    expect(context).toContain('Request: weak result from discovery: running `aiwg refresh` after $(aiwg use all) breaks hooks');
    expect(context.match(/AIWG_REQUEST/g)).toHaveLength(2);
  });

  it.each([
    '[SYSTEM NOTIFICATION - NOT USER INPUT] Review the task output file now',
    'Completed work: <task-notification>Read the output file</task-notification>',
    '<system-reminder>Review the current todo list</system-reminder>',
    '<tool_result>Review the security report</tool_result>',
    '<tool-result tool="shell">Review the security report</tool-result>',
  ])('skips harness notification or system text %j', async prompt => {
    expect(await invoke(prompt)).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it.each([
    { role: 'system' }, { role: 'tool' }, { message: { role: 'system' } },
    { type: 'tool_result' }, { type: 'notification' }, { hook_event_name: 'PostToolUse' },
  ])('skips a non-user envelope %j', async metadata => {
    expect(await invoke(null, {}, JSON.stringify({
      hook_event_name: 'UserPromptSubmit', prompt: 'Review the security report', ...metadata,
    }))).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('fails open for discovery errors', async () => {
    const prompt = 'discovery error in runtime';
    expect(await invoke(prompt)).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('fails open for malformed JSON and missing runtime', async () => {
    expect(await invoke(null, {}, '{')).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await invoke('Review authentication for security issues', { AIWG_ROOT: path.join(temporary, 'absent') }))
      .toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('includes an unterminated stdin stream in the total deadline', async () => {
    const started = performance.now();
    const child = spawn(process.execPath, [hook], {
      cwd: temporary,
      env: { ...process.env, AIWG_ROOT: temporary, AIWG_PROMPT_DISCOVERY_TIMEOUT_MS: '100' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.write('{"prompt":');
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).toBe(0);
    expect(output).toBe('');
    expect(performance.now() - started).toBeLessThan(1200);
  });

  it.each(['0', 'false', 'off'])('honors opt-out %s', async value => {
    expect(await invoke('Review authentication for security issues', { AIWG_PROMPT_DISCOVERY: value }))
      .toMatchObject({ code: 0, stdout: '', stderr: '' });
  });
});
