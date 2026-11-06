import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { runInNewContext } from 'node:vm';
import { getStaticTOMLValue, parseForESLint } from 'toml-eslint-parser';
import YAML from 'yaml';
import { renderCodexHookToml } from '../../../src/smiths/hook-bridge/codex-translator.js';
import { renderHookMd } from '../../../tools/agents/providers/openclaw-translator.mjs';
import { skillMatchesProvider } from '../../../tools/agents/providers/base.mjs';
import { injectFrameworkMetadata } from '../../../tools/workspace/inject-metadata.mjs';

function frontmatter(markdown: string) {
  return YAML.parse(markdown.split('\n---\n')[0].slice(4));
}
const hostile = 'C:\\hooks\\new\\"\nadmin = true\r\t\b\f\x00\x0b\x1f\x7f 雪 🚀';

describe('WP5 hook encoding', () => {
  it.each(['\ud800', '\udfff'])('rejects invalid TOML Unicode scalars: %j', (value) => {
    expect(() => renderCodexHookToml({
      id: 'safe', description: 'safe', command: value, events: ['PreToolUse'],
    })).toThrow('valid Unicode scalar values');
  });
  it('round-trips TOML command, arguments and ID without injecting entries', () => {
    const output = renderCodexHookToml({
      id: hostile, description: hostile, command: hostile,
      args: [hostile, 'trailing\\', 'ordinary --strict'], events: ['PreToolUse'],
    });
    const parsed = getStaticTOMLValue(parseForESLint(output).ast);
    // Codex consumes one shell command inside a matcher group's hooks array.
    const quotedHostile = '"' + hostile.split('\\').join('\\\\').split('"').join('\\"') + '"';
    expect(parsed).toEqual({ hooks: { PreToolUse: [{ hooks: [{
      type: 'command', command: `${hostile} ${quotedHostile} "trailing\\\\" "ordinary --strict"`,
      _aiwg_managed: true, _aiwg_id: hostile,
    }] }] } });
  });

  it.each([hostile, 'trailing\\', '"'.repeat(199) + '\\tail', 'line\u0085next\u2028next\u2029end'])(
    'round-trips OpenClaw description and truncates before encoding: %j', (description) => {
      const parsed = frontmatter(renderHookMd({ name: 'safe-hook', description, hooks: {} }));
      expect(parsed).toEqual({
        name: 'safe-hook', description: description.slice(0, 200), events: [],
        handler: './handler.js', aiwg_managed: true,
      });
    },
  );
});

describe('WP5 metadata injection encoding', () => {
  it.each(['all', 'codex'])(
    'preserves %s platform routing after metadata injection', (platform) => {
      const content = `---\nname: example\nplatforms: [${platform}]\n---\nBody.\n`;
      const markdown = injectFrameworkMetadata(content);
      expect(markdown).toContain(`platforms:\n  - ${platform}\n`);
      expect(frontmatter(markdown).platforms).toEqual([platform]);
      for (const provider of ['codex', 'claude']) {
        expect(skillMatchesProvider(markdown, provider)).toBe(skillMatchesProvider(content, provider));
        expect(skillMatchesProvider(markdown, provider)).toBe(platform === 'all' || provider === 'codex');
      }
    },
  );
  it.each([hostile, 'C:\\new\\test\\', 'line\nadmin: true', 'line\u0085next\u2028next\u2029end', 'sdlc-complete', 'true', 'false', 'null', '42', '1e3', ' leading', 'trailing ', '  padded  ', ''])(
    'round-trips injected framework and existing string metadata: %j', (value) => {
      const content = `---\ndescription: ${JSON.stringify(value)}\n---\nBody.\n`;
      const markdown = injectFrameworkMetadata(content, value);
      expect(frontmatter(markdown)).toEqual({ description: value, framework: value });
      expect(markdown).toContain('\n---\nBody.\n');
    },
  );
  it.each(['yes', 'no', 'on', 'off', 'y', 'n'].flatMap(word => [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1)]))(
    'round-trips YAML 1.1 boolean words as strings: %s', (value) => {
      const metadata = { [value]: value, nested: { value }, array: [value] };
      const content = `---\n${YAML.stringify(metadata)}---\nBody.\n`;
      const markdown = injectFrameworkMetadata(content, value);
      const raw = markdown.split('\n---\n')[0].slice(4);
      const expected = { ...metadata, framework: value };
      expect(YAML.parse(raw)).toEqual(expected);
      expect(YAML.parse(raw, { version: '1.1' })).toEqual(expected);
      expect(frontmatter(injectFrameworkMetadata('Body.\n', value))).toEqual({ framework: value });
      const fresh = injectFrameworkMetadata('Body.\n', value).split('\n---\n')[0].slice(4);
      expect(YAML.parse(fresh, { version: '1.1' })).toEqual({ framework: value });
    },
  );
  it('round-trips hostile keys and nested metadata without injecting fields', () => {
    const metadata = {
      'k: v\nx': 1,
      true: 'true',
      nested: { 'x: y': ['foo #bar', { 'line\nkey': 'line\nvalue' }, 2, false, null] },
      array: [1, 2],
      ordinary: 'simple',
    };
    const content = `---\n${YAML.stringify(metadata)}---\nBody.\n`;
    const markdown = injectFrameworkMetadata(content);
    expect(frontmatter(markdown)).toEqual({ ...metadata, framework: 'sdlc-complete' });
    expect(markdown).toContain('ordinary: simple');
    expect(markdown).toContain('framework: sdlc-complete');
    expect(markdown).toContain('\n---\nBody.\n');
  });

  it.each([hostile, 'true', '42', '  padded  ', ''])(
    'encodes a framework when adding new frontmatter: %j', (framework) => {
      const markdown = injectFrameworkMetadata('Body.\n', framework);
      expect(frontmatter(markdown)).toEqual({ framework });
      expect(markdown).toContain('\n---\n\nBody.\n');
    },
  );
});

describe('WP5 Vault TLS opt-in', () => {
  it.each([undefined, '1', 'TRUE', 'Yes', 'false'])(
    'runs the dry-run CLI with TLS opt-in %j', (value) => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-vault-encoding-'));
      try {
        const policy = path.join(tempDir, 'policy.hcl');
        writeFileSync(policy, 'path "secret/test" {}');
        const env = { ...process.env };
        delete env.VAULT_SKIP_VERIFY;
        delete env.NODE_TLS_REJECT_UNAUTHORIZED;
        if (value !== undefined) env.VAULT_SKIP_VERIFY = value;
        const result = spawnSync(process.execPath, [
          path.resolve('ci/provision-vault-approle.mjs'), '--addr', 'https://localhost:8200',
          '--policy-file', policy, '--handoff', path.join(tempDir, 'handoff.env'),
        ], { env, encoding: 'utf8', timeout: 60_000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Dry-run: would provision');
        if (['1', 'true', 'yes'].includes((value ?? '').toLowerCase())) {
          expect(result.stderr).toContain('WARNING: VAULT_SKIP_VERIFY');
          expect(result.stderr).toContain('self-signed CI Vault');
        } else {
          expect(result.stderr).toBe('');
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
  const source = readFileSync(new URL('../../../ci/provision-vault-approle.mjs', import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .*;$/gm, '');

  it.each([undefined, '1', 'true', 'yes', 'TRUE', 'Yes', '', '0', 'false', 'no', 'unexpected'])(
    'warns and disables verification only for accepted opt-in %j', async (value) => {
      const env: Record<string, string> = value === undefined ? {} : { VAULT_SKIP_VERIFY: value };
      const stderr: string[] = [];
      const stdout: string[] = [];
      const exit = new Error('CLI exited');
      // Execute the actual CLI in a dry-run VM; no network, host environment or files change.
      const result = runInNewContext(`(async () => { ${source} })()`, {
        process: {
          argv: ['node', 'provision-vault-approle.mjs', '--addr', 'https://localhost:8200',
            '--policy-file', 'policy.hcl', '--handoff', 'handoff.env'],
          env, exit: (code: number) => { expect(code).toBe(0); throw exit; },
        },
        console: { error: (message: string) => stderr.push(message), log: (message: string) => stdout.push(message) },
        path, os, existsSync: () => true, readFileSync: () => 'path "secret/test" {}',
      });
      await expect(result).rejects.toBe(exit);
      expect(stdout[0]).toContain('Dry-run: would provision');
      const enabled = ['1', 'true', 'yes'].includes((value ?? '').toLowerCase());
      expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(enabled ? '0' : undefined);
      if (enabled) {
        expect(stderr).toHaveLength(1);
        expect(stderr[0]).toContain('WARNING: VAULT_SKIP_VERIFY');
        expect(stderr[0]).toContain('DISABLED for all HTTPS requests');
      } else {
        expect(stderr).toEqual([]);
      }
    },
  );
});
