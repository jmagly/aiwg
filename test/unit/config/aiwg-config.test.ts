/**
 * Unit tests for project-level aiwg.config management
 *
 * @source @src/config/aiwg-config.ts
 * @implements #621
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  emptyConfig,
  getConfigPath,
  readAiwgConfig,
  writeAiwgConfig,
  updateInstalled,
  ensureProviderListed,
  hashManifest,
  resolveRemotes,
  resolveRemoteProvider,
  resolveDelivery,
  normalizeForcePushPolicy,
  FORCE_PUSH_POLICY_ALIAS_NOTE,
  resolveParallelism,
  resolveIssueLabels,
  validateExternalLinks,
  validateIssueLabels,
  validateWorkspaceConfig,
  getProviderParallelismDefaults,
  PROVIDER_PARALLELISM_DEFAULTS,
} from '../../../src/config/aiwg-config.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aiwg-config-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('aiwg-config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── emptyConfig ────────────────────────────────────────────────────────────

  describe('emptyConfig', () => {
    it('returns a valid config with default claude provider', () => {
      const cfg = emptyConfig();
      expect(cfg.version).toBe('1');
      expect(cfg.providers).toEqual(['claude']);
      expect(cfg.installed).toEqual({});
      expect(cfg.scripts).toEqual({});
    });

    it('accepts custom providers', () => {
      const cfg = emptyConfig(['claude', 'copilot']);
      expect(cfg.providers).toEqual(['claude', 'copilot']);
    });

    it('includes $schema', () => {
      const cfg = emptyConfig();
      expect(cfg.$schema).toMatch(/aiwg\.io/);
    });

    it('ships an explicit delivery block defaulting to pr-required', () => {
      // New projects should see the policy written down so they can change
      // it via `aiwg config set --project delivery.mode <mode>` or via the
      // AIWG Steward agent without first having to discover the field.
      const cfg = emptyConfig();
      expect(cfg.delivery).toBeDefined();
      expect(cfg.delivery!.mode).toBe('pr-required');
      expect(cfg.delivery!.default_branch).toBe('main');
      expect(cfg.delivery!.require_ci_green).toBe(true);
      expect(cfg.delivery!.auto_close_issues).toBe(true);
      expect(cfg.delivery!.force_push_policy).toBe('never');
    });

    it('ships the safe artifact output policy (#2122)', () => {
      expect(emptyConfig().artifact_outputs).toEqual({ canonical: 'aiwg', provider_native: 'explicit-only', destinations: {} });
    });

    it('ships an explicit parallelism block with provider defaults (#1359)', () => {
      const cfg = emptyConfig(); // default provider = claude
      expect(cfg.parallelism).toBeDefined();
      expect(cfg.parallelism!.max_parallel_subagents).toBe(4);
      expect(cfg.parallelism!.max_parallel_ralph_loops).toBe(2);
      expect(cfg.parallelism!.max_parallel_mc_missions).toBe(4);
      expect(cfg.parallelism!.rationale).toMatch(/claude/);
    });

    it('uses codex defaults when codex is the primary provider', () => {
      const cfg = emptyConfig(['codex']);
      expect(cfg.parallelism!.max_parallel_subagents).toBe(10);
      expect(cfg.parallelism!.max_parallel_ralph_loops).toBe(3);
      expect(cfg.parallelism!.max_parallel_mc_missions).toBe(6);
      expect(cfg.parallelism!.rationale).toMatch(/codex/);
    });

    it('uses conservative experimental defaults for muse (#235)', () => {
      const cfg = emptyConfig(['muse']);
      expect(cfg.parallelism!.max_parallel_subagents).toBe(4);
      expect(cfg.parallelism!.max_parallel_ralph_loops).toBe(2);
      expect(cfg.parallelism!.max_parallel_mc_missions).toBe(4);
      expect(cfg.parallelism!.rationale).toMatch(/muse/);
    });

    it('falls back to conservative defaults for an unknown primary provider', () => {
      const cfg = emptyConfig(['mystery-llm']);
      expect(cfg.parallelism!.max_parallel_subagents).toBe(4);
      expect(cfg.parallelism!.max_parallel_ralph_loops).toBe(2);
      expect(cfg.parallelism!.max_parallel_mc_missions).toBe(4);
      expect(cfg.parallelism!.rationale).toMatch(/unknown provider/i);
    });
  });

  // ── getConfigPath ──────────────────────────────────────────────────────────

  describe('getConfigPath', () => {
    it('returns .aiwg/aiwg.config inside the project dir', () => {
      const p = getConfigPath('/some/project');
      expect(p).toBe(resolve('/some/project', '.aiwg', 'aiwg.config'));
    });

    it('keeps the config in the local control plane when the corpus is external', () => {
      const previous = process.env.AIWG_ARTIFACTS_PATH;
      process.env.AIWG_ARTIFACTS_PATH = '../aiwg-web-release-ops/corpus/.aiwg';
      try {
        const p = getConfigPath('/some/project');
        expect(p).toBe(resolve('/some/project', '.aiwg', 'aiwg.config'));
      } finally {
        if (previous === undefined) {
          delete process.env.AIWG_ARTIFACTS_PATH;
        } else {
          process.env.AIWG_ARTIFACTS_PATH = previous;
        }
      }
    });
  });

  // ── readAiwgConfig / writeAiwgConfig ───────────────────────────────────────

  describe('readAiwgConfig', () => {
    it('returns null when config does not exist', async () => {
      const result = await readAiwgConfig(tmpDir);
      expect(result).toBeNull();
    });

    it('reads and parses a valid config', async () => {
      const cfg = emptyConfig(['claude', 'cursor']);
      await writeAiwgConfig(tmpDir, cfg);

      const read = await readAiwgConfig(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.providers).toEqual(['claude', 'cursor']);
      expect(read!.version).toBe('1');
    });

    it('fills in missing optional fields for forward-compat', async () => {
      const dir = join(tmpDir, '.aiwg');
      mkdirSync(dir, { recursive: true });
      // Write minimal config without optional fields
      writeFileSync(join(dir, 'aiwg.config'), JSON.stringify({ version: '1' }));

      const read = await readAiwgConfig(tmpDir);
      expect(read!.providers).toEqual(['claude']);
      expect(read!.installed).toEqual({});
      expect(read!.scripts).toEqual({});
    });

    it('round-trips scripts intact', async () => {
      const cfg = emptyConfig();
      cfg.scripts = { deploy: 'aiwg use all', doctor: 'aiwg doctor' };
      await writeAiwgConfig(tmpDir, cfg);

      const read = await readAiwgConfig(tmpDir);
      expect(read!.scripts).toEqual({ deploy: 'aiwg use all', doctor: 'aiwg doctor' });
    });

    it('round-trips multiple validated external links', async () => {
      const cfg = emptyConfig();
      cfg.externalLinks = {
        project_docs: {
          label: 'Project documentation',
          url: 'https://example.com/docs',
          category: 'docs',
        },
        status_page: {
          label: 'Service status',
          url: 'https://status.example.com/',
          audience: 'operators',
        },
      };
      await writeAiwgConfig(tmpDir, cfg);

      const read = await readAiwgConfig(tmpDir);
      expect(read?.externalLinks).toEqual(cfg.externalLinks);
    });

    it('writes the local control config and mirrors an existing external control copy', async () => {
      const externalAiwgDir = join(tmpDir, 'renamed-aiwg-corpus');
      mkdirSync(externalAiwgDir, { recursive: true });
      const previous = process.env.AIWG_ARTIFACTS_PATH;
      process.env.AIWG_ARTIFACTS_PATH = externalAiwgDir;
      try {
        await writeAiwgConfig(tmpDir, emptyConfig(['codex']));
        expect(existsSync(join(externalAiwgDir, 'aiwg.config'))).toBe(true);
        expect(existsSync(join(tmpDir, '.aiwg', 'aiwg.config'))).toBe(true);

        const read = await readAiwgConfig(tmpDir);
        expect(read?.providers).toEqual(['codex']);
      } finally {
        if (previous === undefined) {
          delete process.env.AIWG_ARTIFACTS_PATH;
        } else {
          process.env.AIWG_ARTIFACTS_PATH = previous;
        }
      }
    });

    it('falls back to a legacy external config when the local control copy is missing', async () => {
      const externalAiwgDir = join(tmpDir, 'legacy-external-aiwg');
      mkdirSync(externalAiwgDir, { recursive: true });
      writeFileSync(join(externalAiwgDir, 'aiwg.config'), JSON.stringify(emptyConfig(['codex'])));
      const previous = process.env.AIWG_ARTIFACTS_PATH;
      process.env.AIWG_ARTIFACTS_PATH = externalAiwgDir;
      try {
        expect((await readAiwgConfig(tmpDir))?.providers).toEqual(['codex']);
      } finally {
        if (previous === undefined) delete process.env.AIWG_ARTIFACTS_PATH;
        else process.env.AIWG_ARTIFACTS_PATH = previous;
      }
    });

    it('clearly rejects malformed external links while preserving unrelated fields on disk', async () => {
      const dir = join(tmpDir, '.aiwg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'aiwg.config'), JSON.stringify({
        version: '1',
        providers: ['codex'],
        installed: {},
        scripts: { verify: 'npm test' },
        externalLinks: {
          broken: { label: 'Broken', url: 'not a url' },
        },
      }));

      await expect(readAiwgConfig(tmpDir)).rejects.toThrow(
        'externalLinks.broken.url: must be a valid absolute URL',
      );
      expect(JSON.parse(readFileSync(join(dir, 'aiwg.config'), 'utf8')).scripts)
        .toEqual({ verify: 'npm test' });
    });
  });

  describe('validateExternalLinks', () => {
    it('rejects missing fields, unsupported protocols, embedded credentials, and unstable keys', () => {
      expect(validateExternalLinks({
        'Bad.Key': { url: 'ftp://user:pass@example.com/file' },
        missing_url: { label: 'Missing URL' },
      })).toEqual(expect.arrayContaining([
        expect.stringContaining('key must start with a lowercase letter'),
        expect.stringContaining('.label: required'),
        expect.stringContaining('protocol must be http or https'),
        expect.stringContaining('embedded credentials are not allowed'),
        expect.stringContaining('externalLinks.missing_url.url: required'),
      ]));
    });
  });

  describe('validateWorkspaceConfig', () => {
    it('accepts mixed relative and absolute members with explicit capabilities', () => {
      expect(validateWorkspaceConfig(
        { name: 'home', root: '~/dev' },
        [
          { name: 'child', path: './child', allowed: ['read', 'write'] },
          { name: 'external', path: '/srv/external', allowed: ['read'], provider: 'gitea' },
        ],
      )).toEqual([]);
    });

    it('rejects malformed authorization, duplicates, and ambiguous back-references', () => {
      expect(validateWorkspaceConfig(
        { name: 'home', member_of: '..' },
        [
          { name: 'same', path: '.', allowed: ['read', 'teleport'] },
          { name: 'same', path: '.', allowed: [] },
        ],
      )).toEqual(expect.arrayContaining([
        expect.stringContaining('must not also declare repos'),
        expect.stringContaining("invalid operation 'teleport'"),
        expect.stringContaining('duplicate member name'),
        expect.stringContaining('duplicate member path'),
        expect.stringContaining('must be a non-empty array'),
      ]));
    });
  });

  describe('writeAiwgConfig', () => {
    it('creates .aiwg/ directory if it does not exist', async () => {
      const nested = join(tmpDir, 'subproject');
      mkdirSync(nested);

      await writeAiwgConfig(nested, emptyConfig());

      const read = await readAiwgConfig(nested);
      expect(read).not.toBeNull();
    });

    it('writes pretty-printed JSON with trailing newline', async () => {
      await writeAiwgConfig(tmpDir, emptyConfig());
      const { readFileSync } = await import('fs');
      const raw = readFileSync(getConfigPath(tmpDir), 'utf-8');
      expect(raw).toMatch(/^\{/);
      expect(raw.endsWith('\n')).toBe(true);
      // Ensure it's multi-line (pretty-printed)
      expect(raw.split('\n').length).toBeGreaterThan(3);
    });
  });

  // ── updateInstalled ────────────────────────────────────────────────────────

  describe('updateInstalled', () => {
    it('adds a new entry when none exists', () => {
      const cfg = emptyConfig();
      const updated = updateInstalled(cfg, 'sdlc', 'claude', { agents: 5, commands: 3, skills: 2, rules: 1 }, {
        version: '2026.3.4',
        source: 'bundled',
      });

      expect(updated.installed['sdlc']).toBeDefined();
      expect(updated.installed['sdlc'].version).toBe('2026.3.4');
      expect(updated.installed['sdlc'].source).toBe('bundled');
      expect(updated.installed['sdlc'].deployedTo['claude']).toEqual({ agents: 5, commands: 3, skills: 2, rules: 1 });
    });

    it('updates existing entry with new counts', () => {
      const cfg = emptyConfig();
      updateInstalled(cfg, 'sdlc', 'claude', { agents: 5, commands: 3, skills: 2, rules: 1 }, {
        version: '2026.3.4',
        source: 'bundled',
      });

      const updated = updateInstalled(cfg, 'sdlc', 'copilot', { agents: 5, commands: 3, skills: 2, rules: 1 }, {
        version: '2026.3.5',
        source: 'bundled',
      });

      expect(updated.installed['sdlc'].deployedTo['claude']).toBeDefined();
      expect(updated.installed['sdlc'].deployedTo['copilot']).toBeDefined();
      expect(updated.installed['sdlc'].version).toBe('2026.3.5');
    });

    it('stores manifestHash when provided', () => {
      const cfg = emptyConfig();
      const updated = updateInstalled(cfg, 'sdlc', 'claude', { agents: 5, commands: 3, skills: 2, rules: 1 }, {
        version: '2026.3.4',
        source: 'bundled',
        manifestHash: 'sha256:abc123',
      });

      expect(updated.installed['sdlc'].manifestHash).toBe('sha256:abc123');
    });

    it('does not overwrite manifestHash when not provided in opts', () => {
      const cfg = emptyConfig();
      updateInstalled(cfg, 'sdlc', 'claude', { agents: 5, commands: 3, skills: 2, rules: 1 }, {
        version: '2026.3.4',
        source: 'bundled',
        manifestHash: 'sha256:original',
      });

      const updated = updateInstalled(cfg, 'sdlc', 'copilot', { agents: 5, commands: 3, skills: 2, rules: 1 }, {
        version: '2026.3.5',
        source: 'bundled',
        // no manifestHash
      });

      // Should keep original since new opts didn't provide one
      expect(updated.installed['sdlc'].manifestHash).toBe('sha256:original');
    });


    it('appends a missing provider to providers[] (#247)', () => {
      const cfg = emptyConfig(['cursor']);
      const updated = updateInstalled(cfg, 'sdlc', 'grokbot', { agents: 1, commands: 0, skills: 2, rules: 0 }, {
        version: '2026.9.16',
        source: 'bundled',
      });
      expect(updated.providers).toEqual(['cursor', 'grokbot']);
    });

    it('promotes explicit provider to primary without wiping others (#247)', () => {
      const cfg = emptyConfig(['cursor', 'claude']);
      const updated = updateInstalled(cfg, 'sdlc', 'grokbot', { agents: 1, commands: 0, skills: 2, rules: 0 }, {
        version: '2026.9.16',
        source: 'bundled',
        asPrimary: true,
      });
      expect(updated.providers).toEqual(['grokbot', 'cursor', 'claude']);
    });

    it('ensureProviderListed is idempotent when already primary', () => {
      const cfg = emptyConfig(['grokbot', 'cursor']);
      ensureProviderListed(cfg, 'grokbot', { asPrimary: true });
      expect(cfg.providers).toEqual(['grokbot', 'cursor']);
    });

    // Project-local (#1035)
    describe('project-local entries', () => {
      it('writes localPath/localType/manifestVersion when source=project-local', () => {
        const cfg = emptyConfig();
        const updated = updateInstalled(cfg, 'foo', 'claude', { agents: 0, commands: 0, skills: 2, rules: 1 }, {
          version: '1.0.0',
          source: 'project-local',
          localPath: '.aiwg/addons/foo/',
          localType: 'addon',
          manifestVersion: '1',
        });

        const entry = updated.installed['foo'];
        expect(entry.source).toBe('project-local');
        expect(entry.localPath).toBe('.aiwg/addons/foo/');
        expect(entry.localType).toBe('addon');
        expect(entry.manifestVersion).toBe('1');
      });

      it('refuses source=project-local without localPath', () => {
        const cfg = emptyConfig();
        expect(() => updateInstalled(cfg, 'foo', 'claude', { agents: 0, commands: 0, skills: 0, rules: 0 }, {
          version: '1.0.0',
          source: 'project-local',
          localType: 'addon',
        })).toThrow(/requires localPath and localType/);
      });

      it('refuses source=project-local without localType', () => {
        const cfg = emptyConfig();
        expect(() => updateInstalled(cfg, 'foo', 'claude', { agents: 0, commands: 0, skills: 0, rules: 0 }, {
          version: '1.0.0',
          source: 'project-local',
          localPath: '.aiwg/addons/foo/',
        })).toThrow(/requires localPath and localType/);
      });

      it('clears project-local fields when overwriting with source=bundled', () => {
        const cfg = emptyConfig();
        // First write project-local
        updateInstalled(cfg, 'foo', 'claude', { agents: 0, commands: 0, skills: 1, rules: 0 }, {
          version: '1.0.0',
          source: 'project-local',
          localPath: '.aiwg/addons/foo/',
          localType: 'addon',
          manifestVersion: '1',
        });
        // Now overwrite with bundled
        const updated = updateInstalled(cfg, 'foo', 'claude', { agents: 0, commands: 0, skills: 1, rules: 0 }, {
          version: '2.0.0',
          source: 'bundled',
        });
        expect(updated.installed['foo'].source).toBe('bundled');
        expect(updated.installed['foo'].localPath).toBeUndefined();
        expect(updated.installed['foo'].localType).toBeUndefined();
        expect(updated.installed['foo'].manifestVersion).toBeUndefined();
      });
    });
  });

  // ── hashManifest ───────────────────────────────────────────────────────────

  describe('hashManifest', () => {
    it('returns a sha256 hash for an existing file', async () => {
      const manifestPath = join(tmpDir, 'manifest.json');
      writeFileSync(manifestPath, '{"name":"test","version":"1.0"}');

      const hash = await hashManifest(manifestPath);
      expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it('returns undefined for a missing file', async () => {
      const hash = await hashManifest(join(tmpDir, 'nonexistent.json'));
      expect(hash).toBeUndefined();
    });

    it('returns different hashes for different content', async () => {
      const path1 = join(tmpDir, 'a.json');
      const path2 = join(tmpDir, 'b.json');
      writeFileSync(path1, '{"version":"1"}');
      writeFileSync(path2, '{"version":"2"}');

      const h1 = await hashManifest(path1);
      const h2 = await hashManifest(path2);
      expect(h1).not.toBe(h2);
    });

    it('returns the same hash for identical content', async () => {
      const p = join(tmpDir, 'stable.json');
      writeFileSync(p, '{"version":"1"}');

      const h1 = await hashManifest(p);
      const h2 = await hashManifest(p);
      expect(h1).toBe(h2);
    });
  });

  describe('resolveRemotes', () => {
    it('returns origin defaults when remotes is undefined', () => {
      const r = resolveRemotes(undefined);
      expect(r).toEqual({
        primary: 'origin',
        issue_tracker: 'origin',
        issue_provider: undefined,
        ci: 'origin',
        tracker_actor: undefined,
        customer_issue_tracker: undefined,
        customer_issue_provider: undefined,
        customer_tracker_actor: undefined,
        transport: undefined,
        secondary: [],
      });
    });

    it('returns origin defaults for an empty block', () => {
      const r = resolveRemotes({});
      expect(r.primary).toBe('origin');
      expect(r.issue_tracker).toBe('origin');
      expect(r.issue_provider).toBeUndefined();
      expect(r.ci).toBe('origin');
      expect(r.tracker_actor).toBeUndefined();
      expect(r.customer_issue_tracker).toBeUndefined();
      expect(r.transport).toBeUndefined();
      expect(r.secondary).toEqual([]);
    });

    it('inherits issue_tracker and ci from primary when unset', () => {
      const r = resolveRemotes({ primary: 'gitea' });
      expect(r.primary).toBe('gitea');
      expect(r.issue_tracker).toBe('gitea');
      expect(r.ci).toBe('gitea');
    });

    it('keeps explicit issue_tracker and ci values', () => {
      const r = resolveRemotes({
        primary: 'origin',
        issue_tracker: 'gitea',
        issue_provider: 'gitea',
        ci: 'jenkins',
      });
      expect(r.issue_tracker).toBe('gitea');
      expect(r.issue_provider).toBe('gitea');
      expect(r.ci).toBe('jenkins');
    });

    it('preserves tracker actor identity metadata', () => {
      const r = resolveRemotes({
        primary: 'origin',
        tracker_actor: {
          login: 'roctinam',
          via: 'tea',
          forbid_actors: ['roctibot'],
        },
      });
      expect(r.tracker_actor).toEqual({
        login: 'roctinam',
        via: 'tea',
        forbid_actors: ['roctibot'],
      });
    });

    it('preserves a distinct customer tracker and actor', () => {
      const r = resolveRemotes({
        primary: 'origin',
        issue_tracker: 'origin',
        customer_issue_tracker: 'github',
        customer_issue_provider: 'github',
        customer_tracker_actor: {
          login: 'customer-maintainer',
          via: 'gh',
          forbid_actors: ['release-bot'],
        },
      });
      expect(r.customer_issue_tracker).toBe('github');
      expect(r.customer_issue_provider).toBe('github');
      expect(r.customer_tracker_actor).toEqual({
        login: 'customer-maintainer',
        via: 'gh',
        forbid_actors: ['release-bot'],
      });
      expect(r.issue_tracker).toBe('origin');
    });

    it('preserves primary remote transport identity metadata', () => {
      const r = resolveRemotes({
        transport: {
          login: 'roctinam',
          protocol: 'ssh',
          helper: 'tools/git/push-origin-as-roctinam.sh',
          key_fingerprint: 'SHA256:project-key',
        },
      });
      expect(r.transport).toEqual({
        login: 'roctinam',
        protocol: 'ssh',
        helper: 'tools/git/push-origin-as-roctinam.sh',
        key_fingerprint: 'SHA256:project-key',
      });
    });

    it('preserves secondary remotes', () => {
      const r = resolveRemotes({
        secondary: [
          { name: 'github', purpose: 'public-mirror', push_on_release: true },
        ],
      });
      expect(r.secondary).toHaveLength(1);
      expect(r.secondary[0]).toMatchObject({
        name: 'github',
        purpose: 'public-mirror',
        push_on_release: true,
      });
    });
  });

  // ── resolveRemoteProvider (#997) ───────────────────────────────────────────

  describe('resolveRemoteProvider', () => {
    it('returns unknown for an empty URL', () => {
      expect(resolveRemoteProvider('')).toBe('unknown');
    });

    it('detects github.com over https', () => {
      expect(resolveRemoteProvider('https://github.com/jmagly/aiwg.git')).toBe('github');
    });

    it('detects github.com over ssh', () => {
      expect(resolveRemoteProvider('git@github.com:jmagly/aiwg.git')).toBe('github');
    });

    it('detects gitlab.com', () => {
      expect(resolveRemoteProvider('https://gitlab.com/group/repo.git')).toBe('gitlab');
    });

    it('detects self-hosted gitlab', () => {
      expect(resolveRemoteProvider('https://gitlab.example.com/group/repo.git')).toBe('gitlab');
    });

    it('detects gitea by hostname substring', () => {
      expect(resolveRemoteProvider('https://gitea.example.org/owner/repo.git')).toBe('gitea');
      expect(resolveRemoteProvider('git@gitea.local:owner/repo.git')).toBe('gitea');
    });

    it('returns unknown for self-hosted instances without telling hostname', () => {
      expect(resolveRemoteProvider('https://git.example.com/owner/repo.git')).toBe('unknown');
    });

    it('does not misclassify github fork urls in a path segment', () => {
      // Path-only "github" (without being the host) should not match
      expect(resolveRemoteProvider('https://example.com/github/repo.git')).toBe('unknown');
    });
  });

  // ── resolveDelivery (#995) ─────────────────────────────────────────────────

  describe('resolveDelivery', () => {
    it('normalizes the deprecated main-only-blocked force-push alias (#2532)', () => {
      expect(resolveDelivery({ force_push_policy: 'main-only-blocked' } as never).force_push_policy)
        .toBe('own-branch-only');
      const normalized = normalizeForcePushPolicy('main-only-blocked');
      expect(normalized.policy).toBe('own-branch-only');
      expect(normalized.deprecatedFrom).toBe('main-only-blocked');
      // The rename narrowed the permission, so the note must say so.
      expect(FORCE_PUSH_POLICY_ALIAS_NOTE).toContain('narrowed');
    });

    it('passes current force-push values through unchanged (#2532)', () => {
      for (const policy of ['never', 'own-branch-only', 'allowed'] as const) {
        expect(normalizeForcePushPolicy(policy)).toEqual({ policy });
      }
      expect(normalizeForcePushPolicy(undefined).policy).toBeUndefined();
    });

    it('returns conservative defaults when delivery is undefined', () => {
      const r = resolveDelivery(undefined);
      expect(r.mode).toBe('pr-required');
      expect(r.default_branch).toBe('main');
      expect(r.merge_style).toBe('rebase-merge');
      expect(r.delete_branch_on_merge).toBe(true);
      expect(r.require_ci_green).toBe(true);
      expect(r.require_signed_commits).toBe(false);
      expect(r.committer).toBeUndefined();
      expect(r.signing).toBeUndefined();
      expect(r.release_signing).toBeUndefined();
      expect(r.force_push_policy).toBe('never');
      expect(r.auto_close_issues).toBe(true);
      expect(r.issue_comment_on_cycle).toBe(true);
    });

    it('preserves explicit overrides', () => {
      const r = resolveDelivery({
        mode: 'direct',
        default_branch: 'develop',
        merge_style: 'squash',
        require_signed_commits: true,
        committer: { name: 'AIWG Bot', email: 'aiwg@example.test' },
        signing: { format: 'openpgp', key: 'ABC123', enforce: 'commits' },
        release_signing: { format: 'openpgp', key: 'DEF456', enforce: 'tags' },
        force_push_policy: 'own-branch-only',
      });
      expect(r.mode).toBe('direct');
      expect(r.default_branch).toBe('develop');
      expect(r.merge_style).toBe('squash');
      expect(r.require_signed_commits).toBe(true);
      expect(r.committer).toEqual({ name: 'AIWG Bot', email: 'aiwg@example.test' });
      expect(r.signing).toEqual({ format: 'openpgp', key: 'ABC123', enforce: 'commits' });
      expect(r.release_signing).toEqual({ format: 'openpgp', key: 'DEF456', enforce: 'tags' });
      expect(r.force_push_policy).toBe('own-branch-only');
    });

    it('merges custom branch_naming overrides with the default set', () => {
      const r = resolveDelivery({
        branch_naming: {
          prefix_by_type: { feat: 'feature/{slug}' },
        },
      });
      // Override applied
      expect(r.branch_naming.prefix_by_type.feat).toBe('feature/{slug}');
      // Defaults still present for other types
      expect(r.branch_naming.prefix_by_type.fix).toBe('fix/{issue}-{slug}');
      expect(r.branch_naming.prefix_by_type.docs).toBe('docs/{slug}');
    });

    it('returns the default branch_naming map when delivery has no branch_naming', () => {
      const r = resolveDelivery({ mode: 'pr-required' });
      expect(r.branch_naming.prefix_by_type.feat).toBe('feat/{issue}-{slug}');
      expect(r.branch_naming.prefix_by_type.chore).toBe('chore/{slug}');
    });

    it('explicit false values override the default true', () => {
      const r = resolveDelivery({
        delete_branch_on_merge: false,
        require_ci_green: false,
        auto_close_issues: false,
        issue_comment_on_cycle: false,
      });
      expect(r.delete_branch_on_merge).toBe(false);
      expect(r.require_ci_green).toBe(false);
      expect(r.auto_close_issues).toBe(false);
      expect(r.issue_comment_on_cycle).toBe(false);
    });
  });

  describe('readAiwgConfig with delivery block', () => {
    it('round-trips a config containing delivery', async () => {
      const cfg = emptyConfig();
      cfg.delivery = {
        mode: 'pr-required',
        default_branch: 'main',
        merge_style: 'rebase-merge',
        require_ci_green: true,
      };
      await writeAiwgConfig(tmpDir, cfg);
      const read = await readAiwgConfig(tmpDir);
      expect(read?.delivery?.mode).toBe('pr-required');
      expect(read?.delivery?.default_branch).toBe('main');
      expect(read?.delivery?.merge_style).toBe('rebase-merge');
    });
  });

  describe('readAiwgConfig with remotes block', () => {
    it('round-trips a config containing remotes', async () => {
      const cfg = emptyConfig();
      cfg.remotes = {
        primary: 'origin',
        secondary: [{ name: 'github', purpose: 'public-mirror' }],
      };
      await writeAiwgConfig(tmpDir, cfg);

      const read = await readAiwgConfig(tmpDir);
      expect(read?.remotes?.primary).toBe('origin');
      expect(read?.remotes?.secondary?.[0]?.name).toBe('github');
    });
  });

  describe('issue label taxonomy (#1789)', () => {
    const issues = {
      labels: {
        human_required: {
          name: 'hitl',
          provider_names: { github: 'human-required', local: 'needs-human' },
          category: 'human-interaction' as const,
          description: 'Work cannot continue until a human responds',
          requires_human: true,
          blocks_automation: true,
          resume_when: 'requested human input is recorded',
        },
        feature: {
          name: 'feature',
          category: 'type' as const,
          description: 'Feature work',
          requires_human: false,
          blocks_automation: false,
        },
      },
    };

    it('maps one semantic role to Gitea, GitHub, and local label strings', () => {
      expect(resolveIssueLabels(issues, 'gitea').labels.human_required.resolved_name).toBe('hitl');
      expect(resolveIssueLabels(issues, 'github').labels.human_required.resolved_name).toBe('human-required');
      expect(resolveIssueLabels(issues, 'local').labels.human_required.resolved_name).toBe('needs-human');
    });

    it('warns clearly when existing projects use legacy fallback behavior', () => {
      const result = resolveIssueLabels(undefined, 'gitea');
      expect(result.labels).toEqual({});
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'fallback', severity: 'warning' }),
      ]));
    });

    it('reports missing, duplicate, conflicting, and unavailable labels without provisioning', () => {
      const diagnostics = validateIssueLabels({
        labels: {
          blocked: {
            name: 'workflow',
            category: 'blocked-reason',
            description: 'Blocked',
            requires_human: false,
            blocks_automation: true,
          },
          duplicate: {
            name: 'workflow',
            category: 'lifecycle',
            description: 'Duplicate native name',
            requires_human: false,
            blocks_automation: false,
            transition_to: 'missing-role',
          },
        },
      }, { provider: 'gitea', availableLabels: ['other'] });

      expect(diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
        'missing', 'duplicate', 'conflict', 'unavailable',
      ]));
    });
  });

  // ── resolveParallelism (#1359) ─────────────────────────────────────────────

  describe('resolveParallelism', () => {
    it('returns provider defaults when parallelism is undefined', () => {
      const r = resolveParallelism(undefined, 'claude');
      expect(r.max_parallel_subagents).toBe(4);
      expect(r.max_parallel_ralph_loops).toBe(2);
      expect(r.max_parallel_mc_missions).toBe(4);
    });

    it('returns codex defaults for codex provider', () => {
      const r = resolveParallelism(undefined, 'codex');
      expect(r.max_parallel_subagents).toBe(10);
      expect(r.max_parallel_ralph_loops).toBe(3);
      expect(r.max_parallel_mc_missions).toBe(6);
    });

    it('returns conservative defaults when provider is unknown', () => {
      const r = resolveParallelism(undefined, 'mystery-llm');
      expect(r.max_parallel_subagents).toBe(4);
      expect(r.max_parallel_ralph_loops).toBe(2);
      expect(r.max_parallel_mc_missions).toBe(4);
    });

    it('returns conservative defaults when no provider is supplied', () => {
      const r = resolveParallelism(undefined, undefined);
      expect(r.max_parallel_subagents).toBe(4);
    });

    it('preserves explicit operator overrides over provider defaults', () => {
      const r = resolveParallelism(
        { max_parallel_subagents: 12, rationale: 'Team plan bump' },
        'claude',
      );
      expect(r.max_parallel_subagents).toBe(12);
      // Unset fields still come from provider defaults
      expect(r.max_parallel_ralph_loops).toBe(2);
      expect(r.rationale).toBe('Team plan bump');
    });

    it('every known provider has a complete defaults entry', () => {
      for (const [name, defs] of Object.entries(PROVIDER_PARALLELISM_DEFAULTS)) {
        expect(defs.max_parallel_subagents, `${name}.max_parallel_subagents`).toBeGreaterThan(0);
        expect(defs.max_parallel_ralph_loops, `${name}.max_parallel_ralph_loops`).toBeGreaterThan(0);
        expect(defs.max_parallel_mc_missions, `${name}.max_parallel_mc_missions`).toBeGreaterThan(0);
      }
    });

    it('getProviderParallelismDefaults returns fallback for unknown', () => {
      const r = getProviderParallelismDefaults('totally-unknown');
      expect(r.max_parallel_subagents).toBe(4);
    });

    it('getProviderParallelismDefaults returns grokbot=4 (#249)', () => {
      const r = getProviderParallelismDefaults('grokbot');
      expect(r.max_parallel_subagents).toBe(4);
    });
  });

  describe('readAiwgConfig with parallelism block (#1359)', () => {
    it('round-trips a config containing parallelism', async () => {
      const cfg = emptyConfig();
      cfg.parallelism = {
        max_parallel_subagents: 6,
        max_parallel_ralph_loops: 2,
        max_parallel_mc_missions: 4,
        rationale: 'bumped after Claude Team upgrade',
      };
      await writeAiwgConfig(tmpDir, cfg);
      const read = await readAiwgConfig(tmpDir);
      expect(read?.parallelism?.max_parallel_subagents).toBe(6);
      expect(read?.parallelism?.rationale).toBe('bumped after Claude Team upgrade');
    });
  });
});
