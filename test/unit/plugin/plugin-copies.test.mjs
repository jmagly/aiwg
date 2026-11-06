import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPackagedPlugins } from '../../../tools/plugin/package-plugins.mjs';

const root = process.cwd();
let temporary;
let pluginsDir;
let marketplacePath;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-plugin-copies-test-'));
  pluginsDir = path.join(temporary, 'plugins');
  marketplacePath = path.join(temporary, 'marketplace.json');
  fs.cpSync(path.join(root, 'agentic/code/plugins'), pluginsDir, { recursive: true });
  fs.copyFileSync(path.join(root, '.claude-plugin/marketplace.json'), marketplacePath);
});

afterEach(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const check = () => checkPackagedPlugins({ pluginsDir, marketplacePath });

describe('generated plugin copies', () => {
  it('matches every default plugin output, including packaging rewrites and manifests', () => {
    expect(check()).toEqual([]);
    const script = fs.readFileSync(path.join(pluginsDir, 'sdlc/skills/address-issues-threat-assess/scripts/assess.mjs'), 'utf8');
    expect(script).toContain("'../../../tools/security/threat-assessment.mjs'");
  });

  it('exits nonzero when a canonical source changes without regenerating its copy', () => {
    // Isolate the CLI's repository root; borrow read-only canonical trees and
    // copy just the addon we mutate. Never edit sources in the real checkout.
    const fixture = path.join(temporary, 'repo');
    const addons = path.join(fixture, 'agentic/code/addons');
    fs.mkdirSync(addons, { recursive: true });
    for (const name of fs.readdirSync(path.join(root, 'agentic/code/addons'))) {
      const source = path.join(root, 'agentic/code/addons', name);
      const target = path.join(addons, name);
      if (name === 'line-memory') fs.cpSync(source, target, { recursive: true });
      else fs.symlinkSync(source, target);
    }
    fs.symlinkSync(path.join(root, 'agentic/code/extensions'), path.join(fixture, 'agentic/code/extensions'));
    fs.symlinkSync(path.join(root, 'docs'), path.join(fixture, 'docs'));
    fs.symlinkSync(path.join(root, 'agentic/code/frameworks'), path.join(fixture, 'agentic/code/frameworks'));
    fs.symlinkSync(pluginsDir, path.join(fixture, 'agentic/code/plugins'));
    for (const file of ['package.json', '.claude-plugin/marketplace.json',
      'tools/_resolve-impl.mjs', 'tools/plugin/package-plugins.mjs', 'tools/plugin/plugin-links.mjs', 'tools/plugin/issue-template-copies.mjs', 'tools/security/threat-assessment.mjs']) {
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(fixture, file));
    }
    for (const tracker of ['.gitea', '.github']) {
      fs.cpSync(path.join(root, tracker, 'ISSUE_TEMPLATE'), path.join(fixture, tracker, 'ISSUE_TEMPLATE'), { recursive: true });
    }
    fs.cpSync(path.join(root, 'tools/security/threat-assessment'), path.join(fixture, 'tools/security/threat-assessment'), { recursive: true });
    const run = () => {
      // File descriptors also retain diagnostics in sandboxes that restrict
      // child-process pipes. Keep every subprocess bounded.
      const log = path.join(temporary, 'check.log');
      const fd = fs.openSync(log, 'w');
      try {
        const result = spawnSync(process.execPath, ['tools/plugin/package-plugins.mjs', '--all', '--check'], {
          cwd: fixture, stdio: ['ignore', fd, fd], timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        return { status: result.status, output: fs.readFileSync(log, 'utf8') };
      } finally {
        fs.closeSync(fd);
      }
    };
    const initial = run();
    expect(initial.status, initial.output).toBe(0);
    for (const tracker of ['.gitea', '.github']) {
      const file = `${tracker}/ISSUE_TEMPLATE/bug-report.md`;
      const target = path.join(fixture, file);
      const canonical = fs.readFileSync(target);
      fs.appendFileSync(target, '\nstale tracker copy\n');
      const drift = run();
      expect(drift.status).toBe(1);
      expect(drift.output).toContain(`Changed: ${file}`);
      expect(fs.readFileSync(target)).not.toEqual(canonical);
      fs.writeFileSync(target, canonical);
    }
    const packaged = path.join(pluginsDir, 'line-memory/commands/line-memory.mjs');
    const before = fs.readFileSync(packaged);
    fs.appendFileSync(path.join(addons, 'line-memory/commands/line-memory.mjs'), '\n// canonical change\n');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain('Changed: agentic/code/plugins/line-memory/commands/line-memory.mjs');
    expect(result.output).toContain('Run npm run package-plugins');
    expect(fs.readFileSync(packaged)).toEqual(before);
  });

  it.each([
    'utils/skills/aiwg-language-map/SKILL.md',
    'utils/templates/issues/bug-report.md',
    'utils/templates/pull-requests/description.md',
    'sdlc/templates/issue-comments/progress-update.md',
    'sdlc/tools/security/threat-assessment.mjs',
    'sdlc/tools/security/threat-assessment/negation.mjs',
    'line-memory/commands/line-memory.mjs',
    'rlm/schemas/rlm-trajectory.yaml',
    'sdlc/.claude-plugin/plugin.json',
  ])('detects stale bytes in %s without repairing the checkout', file => {
    const target = path.join(pluginsDir, file);
    fs.appendFileSync(target, '\nstale fixture\n');
    const before = fs.readFileSync(target);
    expect(check()).toEqual([`Changed: agentic/code/plugins/${file}`]);
    expect(fs.readFileSync(target)).toEqual(before);
  });

  it.each(['.gitea', '.github'])('fails the existing copy lint for a stale %s issue form', tracker => {
    const trackerRoot = path.join(temporary, 'tracker-repo');
    fs.cpSync(path.join(root, 'agentic/code/addons/aiwg-utils/templates/issues'),
      path.join(trackerRoot, 'agentic/code/addons/aiwg-utils/templates/issues'), { recursive: true });
    for (const name of ['.gitea', '.github']) {
      fs.cpSync(path.join(root, name, 'ISSUE_TEMPLATE'), path.join(trackerRoot, name, 'ISSUE_TEMPLATE'), { recursive: true });
    }
    const file = `${tracker}/ISSUE_TEMPLATE/bug-report.md`;
    fs.appendFileSync(path.join(trackerRoot, file), '\nstale copy\n');
    const before = fs.readFileSync(path.join(trackerRoot, file));
    expect(checkPackagedPlugins({ pluginsDir, marketplacePath, trackerRoot })).toEqual([`Changed: ${file}`]);
    expect(fs.readFileSync(path.join(trackerRoot, file))).toEqual(before);
  });

  it('detects missing generated files', () => {
    const file = 'marketing/skills/manifest.json';
    fs.unlinkSync(path.join(pluginsDir, file));
    expect(check()).toEqual([`Missing: agentic/code/plugins/${file}`]);
    expect(fs.existsSync(path.join(pluginsDir, file))).toBe(false);
  });

  it('detects obsolete copies in curated and manifest-backed payloads', () => {
    for (const file of ['utils/skills/obsolete.md', 'line-memory/obsolete.md']) {
      fs.writeFileSync(path.join(pluginsDir, file), 'obsolete fixture');
    }
    expect(check()).toEqual([
      'Unexpected: agentic/code/plugins/utils/skills/obsolete.md',
      'Unexpected: agentic/code/plugins/line-memory/obsolete.md',
    ]);
  });

  it('detects stale marketplace bytes without rewriting them', () => {
    fs.appendFileSync(marketplacePath, ' ');
    const before = fs.readFileSync(marketplacePath);
    expect(check()).toEqual(['Changed: .claude-plugin/marketplace.json']);
    expect(fs.readFileSync(marketplacePath)).toEqual(before);
  });

  it('preserves separately generated provider metadata and curated templates', () => {
    fs.mkdirSync(path.join(pluginsDir, 'line-memory/.cursor-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'line-memory/.cursor-plugin/plugin.json'), '{}');
    fs.writeFileSync(path.join(pluginsDir, 'sdlc/templates/provider-fixture.md'), 'fixture');
    expect(check()).toEqual([]);
  });
});
