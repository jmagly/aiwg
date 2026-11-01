import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkVersionLockstep } from '../../../tools/workspace/check-marketplace-version.mjs';

let tempRoot: string | null = null;

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeRepo({
  packageVersion = '2026.5.7',
  lockVersion = packageVersion,
  lockRootVersion = packageVersion,
  marketplaceVersion = packageVersion,
  marketplacePluginVersion = packageVersion,
  pluginManifestVersion = packageVersion,
  cliVersion = packageVersion,
  cockpitVersion = packageVersion,
  cockpitLockVersion = cockpitVersion,
  cockpitLockRootVersion = cockpitVersion,
  rootVitest = '^4.1.10',
  cockpitWebVitest = rootVitest,
  cockpitWorkspaceLockVitest = '4.1.10',
  cockpitWorkspaceWebVitest = cockpitWebVitest,
  cockpitWebLockVitest = '4.1.10',
  cockpitWebLockRange = cockpitWebVitest,
}: {
  packageVersion?: string;
  lockVersion?: string;
  lockRootVersion?: string;
  marketplaceVersion?: string;
  marketplacePluginVersion?: string;
  pluginManifestVersion?: string;
  cliVersion?: string;
  cockpitVersion?: string;
  cockpitLockVersion?: string;
  cockpitLockRootVersion?: string;
  rootVitest?: string;
  cockpitWebVitest?: string;
  cockpitWorkspaceLockVitest?: string;
  cockpitWorkspaceWebVitest?: string;
  cockpitWebLockVitest?: string;
  cockpitWebLockRange?: string;
} = {}) {
  tempRoot = mkdtempSync(join(tmpdir(), 'aiwg-version-lockstep-'));
  mkdirSync(join(tempRoot, '.claude-plugin'), { recursive: true });
  mkdirSync(join(tempRoot, 'packages', 'cli'), { recursive: true });
  mkdirSync(join(tempRoot, 'packages', 'flue'), { recursive: true });
  writeJson(join(tempRoot, 'packages', 'flue', 'package.json'), { name: '@aiwg/flue', version: packageVersion });
  mkdirSync(join(tempRoot, 'apps', 'cockpit'), { recursive: true });
  mkdirSync(join(tempRoot, 'apps', 'cockpit', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'agentic', 'code', 'plugins', 'sdlc', '.claude-plugin'), { recursive: true });

  writeJson(join(tempRoot, 'package.json'), {
    name: 'aiwg',
    version: packageVersion,
    devDependencies: {
      vitest: rootVitest,
    },
  });
  writeJson(join(tempRoot, 'package-lock.json'), {
    name: 'aiwg',
    version: lockVersion,
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'aiwg',
        version: lockRootVersion,
      },
    },
  });
  writeJson(join(tempRoot, '.claude-plugin', 'marketplace.json'), {
    version: marketplaceVersion,
    plugins: [{
      name: 'sdlc',
      version: marketplacePluginVersion,
      source: './agentic/code/plugins/sdlc',
    }],
  });
  writeJson(join(tempRoot, 'agentic', 'code', 'plugins', 'sdlc', '.claude-plugin', 'plugin.json'), {
    name: 'sdlc',
    version: pluginManifestVersion,
  });
  writeJson(join(tempRoot, 'packages', 'cli', 'package.json'), {
    name: '@aiwg/cli',
    version: cliVersion,
  });
  writeJson(join(tempRoot, 'apps', 'cockpit', 'package.json'), {
    name: '@aiwg/cockpit',
    version: cockpitVersion,
  });
  writeJson(join(tempRoot, 'apps', 'cockpit', 'package-lock.json'), {
    name: '@aiwg/cockpit',
    version: cockpitLockVersion,
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@aiwg/cockpit',
        version: cockpitLockRootVersion,
      },
      'node_modules/vitest': {
        version: cockpitWorkspaceLockVitest,
      },
      web: {
        devDependencies: {
          vitest: cockpitWorkspaceWebVitest,
        },
      },
    },
  });
  writeJson(join(tempRoot, 'apps', 'cockpit', 'web', 'package.json'), {
    name: '@aiwg/cockpit-web',
    version: '0.0.0',
    devDependencies: {
      vitest: cockpitWebVitest,
    },
  });
  writeJson(join(tempRoot, 'apps', 'cockpit', 'web', 'package-lock.json'), {
    name: '@aiwg/cockpit-web',
    version: '0.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@aiwg/cockpit-web',
        version: '0.0.0',
        devDependencies: {
          vitest: cockpitWebLockRange,
        },
      },
      'node_modules/vitest': {
        version: cockpitWebLockVitest,
      },
    },
  });

  return tempRoot;
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe('checkVersionLockstep', () => {
  it('passes when package, lockfile, and marketplace versions match', () => {
    const root = makeRepo();

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(true);
    expect(result.message).toContain('match package.json');
  });

  it('accepts the legacy metadata.version location for existing marketplaces', () => {
    const root = makeRepo();
    writeJson(join(root, '.claude-plugin', 'marketplace.json'), {
      metadata: { version: '2026.5.7' },
    });

    expect(checkVersionLockstep(root).ok).toBe(true);
  });

  it('fails when package-lock.json top-level version drifts', () => {
    const root = makeRepo({ lockVersion: '2026.5.2' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('package-lock.json version');
    expect(result.message).toContain('2026.5.2');
  });

  it('fails when package-lock.json root package version drifts', () => {
    const root = makeRepo({ lockRootVersion: '2026.5.2' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('packages[""].version');
    expect(result.message).toContain('2026.5.2');
  });

  it('fails when marketplace version drifts', () => {
    const root = makeRepo({ marketplaceVersion: '2026.5.6' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('marketplace version');
    expect(result.message).toContain('2026.5.6');
  });

  it('fails when a local marketplace plugin version drifts', () => {
    const root = makeRepo({ marketplacePluginVersion: '2026.5.6' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('local marketplace plugin sdlc version');
    expect(result.message).toContain('2026.5.6');
  });

  it('fails when a local plugin manifest version drifts', () => {
    const root = makeRepo({ pluginManifestVersion: '2026.5.6' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('local plugin manifest sdlc version');
    expect(result.message).toContain('2026.5.6');
  });

  it('fails when @aiwg/cli CalVer drifts from the main package', () => {
    const root = makeRepo({ cliVersion: '2026.5.6' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('@aiwg/cli version');
    expect(result.message).toContain('2026.5.6');
  });

  it('fails when @aiwg/cockpit CalVer drifts from the main package', () => {
    const root = makeRepo({ cockpitVersion: '2026.5.6' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('@aiwg/cockpit version');
    expect(result.message).toContain('2026.5.6');
  });

  it('fails when the Cockpit lockfile top-level version drifts', () => {
    const root = makeRepo({ cockpitLockVersion: '2026.5.6' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('apps/cockpit/package-lock.json version');
    expect(result.message).toContain('2026.5.6');
  });

  it('fails when the Cockpit lockfile root package version drifts', () => {
    const root = makeRepo({ cockpitLockRootVersion: '2026.5.6' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('apps/cockpit/package-lock.json packages[""].version');
    expect(result.message).toContain('2026.5.6');
  });

  it('fails when the Cockpit web manifest uses a different Vitest major', () => {
    const root = makeRepo({ cockpitWebVitest: '^2.1.8' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('apps/cockpit/web/package.json');
    expect(result.message).toContain('Vitest major 4');
  });

  it('fails when the Cockpit workspace lock resolves a different Vitest major', () => {
    const root = makeRepo({ cockpitWorkspaceLockVitest: '2.1.9' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('apps/cockpit/package-lock.json Vitest resolution');
    expect(result.message).toContain('Vitest major 4');
  });

  it('fails when the standalone Cockpit web lock resolves a different Vitest major', () => {
    const root = makeRepo({ cockpitWebLockVitest: '2.1.9' });

    const result = checkVersionLockstep(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('apps/cockpit/web/package-lock.json Vitest resolution');
    expect(result.message).toContain('Vitest major 4');
  });

  it('allows marketplace pre-release suffix mismatch only when requested', () => {
    const root = makeRepo({
      packageVersion: '2026.5.7-rc.1',
      lockVersion: '2026.5.7-rc.1',
      lockRootVersion: '2026.5.7-rc.1',
      marketplaceVersion: '2026.5.7',
    });

    expect(checkVersionLockstep(root).ok).toBe(false);
    expect(checkVersionLockstep(root, { allowPrereleaseMismatch: true }).ok).toBe(true);
  });
});
