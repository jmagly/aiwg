import { describe, expect, it } from 'vitest';

import {
  buildClaudeArgs,
  classifyClaudeStream,
  DEFAULT_REPRO_PROMPT,
} from '../../../tools/validation/claude-context-repro.mjs';

describe('validate:claude-context', () => {
  it('builds a plan-mode Claude command with mutation tools denied', () => {
    const args = buildClaudeArgs({ debugFile: '/tmp/debug.log' });

    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).toContain('--disallowedTools');
    expect(args.join(' ')).toContain('Bash(git commit*)');
    expect(args).toContain(DEFAULT_REPRO_PROMPT);
  });

  it('pins a standard-context model variant rather than a bare alias', () => {
    const args = buildClaudeArgs({ debugFile: '/tmp/debug.log' });
    const modelIndex = args.indexOf('--model');

    expect(modelIndex).toBeGreaterThan(-1);
    // Bare aliases (sonnet/opus/haiku) inherit the parent 1M-context attribute and
    // hit the usage-credit gate on 1M accounts; the harness must pin the standard variant.
    expect(args[modelIndex + 1]).toBe('claude-sonnet-5');
  });

  it('classifies missing Claude authentication', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
        error: 'authentication_failed',
      }),
    ].join('\n');

    const result = classifyClaudeStream(stdout);

    expect(result.verdict).toBe('auth-blocked');
    expect(result.authBlocked).toBe(true);
    expect(result.reachedModel).toBe(false);
  });

  it('classifies context exhaustion separately from successful model execution', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 1000 },
          content: [{ type: 'text', text: 'Context limit reached · /compact or /clear to continue' }],
        },
      }),
    ].join('\n');

    const result = classifyClaudeStream(stdout);

    expect(result.verdict).toBe('context-exhausted');
    expect(result.contextExhausted).toBe(true);
    expect(result.reachedModel).toBe(true);
  });

  it('classifies a usage-credit / 1M-context gate as credit-blocked, not model-ran', () => {
    const stdout = [
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', overageDisabledReason: 'out_of_credits' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 0 },
          content: [
            {
              type: 'text',
              text: 'API Error: Usage credits required for 1M context · turn on usage credits or use --model to switch to standard context',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        usage: { input_tokens: 0 },
        result: 'API Error: Usage credits required for 1M context',
      }),
    ].join('\n');

    const result = classifyClaudeStream(stdout);

    expect(result.verdict).toBe('credit-blocked');
    expect(result.creditBlocked).toBe(true);
    expect(result.reachedModel).toBe(false);
    expect(result.resultErrored).toBe(true);
  });

  it('does not treat an allowed base tier with disabled overage as blocked', () => {
    const stdout = [
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 1500 },
          content: [{ type: 'text', text: 'Start with git status --short to derive scope.' }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1500 } }),
    ].join('\n');

    const result = classifyClaudeStream(stdout);

    expect(result.verdict).toBe('model-ran');
    expect(result.creditBlocked).toBe(false);
    expect(result.reachedModel).toBe(true);
  });

  it('ignores marker strings that appear in tool-result file contents, not model output', () => {
    // The model reads a repo file (e.g. this harness or the spike report) whose text
    // quotes "Not logged in" and "Context limit reached". Those must NOT be read as a
    // real auth failure or context exhaustion — they are tool output, not model output.
    const stdout = [
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content:
                'File contents: const authBlocked = /Not logged in|Please run \\/login/; ... "Context limit reached · /compact or /clear"',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 4000, cache_read_input_tokens: 120000 },
          content: [{ type: 'text', text: 'Scope: 6 changed files via git diff --name-only. Dispatching two Explore agents.' }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 4000 } }),
    ].join('\n');

    const result = classifyClaudeStream(stdout);

    expect(result.authBlocked).toBe(false);
    expect(result.contextExhausted).toBe(false);
    expect(result.creditBlocked).toBe(false);
    expect(result.reachedModel).toBe(true);
    expect(result.verdict).toBe('model-ran');
    expect(result.mentionsSafeScopeDiscovery).toBe(true);
  });

  it('detects safe scope-discovery language in a model response', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 2000 },
          content: [{ type: 'text', text: 'Start with git status --short and git diff --name-only to derive scope.' }],
        },
      }),
    ].join('\n');

    const result = classifyClaudeStream(stdout);

    expect(result.verdict).toBe('model-ran');
    expect(result.mentionsSafeScopeDiscovery).toBe(true);
  });
});
