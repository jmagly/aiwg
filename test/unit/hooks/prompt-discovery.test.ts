// Exercise prompt-time discovery through the real standalone hook process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hook = path.join(root, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs');
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

describe('prompt discovery', () => {
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
    expect(output.additionalContext).toContain('aiwg show <type> <name> -> fetch required rule bodies');
    expect(output.additionalContext).toContain('--rules --with-rule-bodies; --body) -> apply');
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

  it.each(['discovery error in runtime', 'empty result from discovery', 'weak result from discovery'])('fails open for %s', async prompt => {
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
