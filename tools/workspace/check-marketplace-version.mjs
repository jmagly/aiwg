#!/usr/bin/env node
/**
 * Verify release version metadata matches package.json version.
 *
 * PUW-038 (#1139): package lockfiles, separately published packages, and the
 * marketplace manifest's top-level version must move in lockstep
 * with package.json on every release; otherwise installs and plugin surfaces
 * can report stale versions while npm ships the new one.
 *
 * Exits 0 when versions match. For marketplace metadata only, pre-release
 * suffixes may differ when `--allow-prerelease-mismatch` is passed; package
 * lockfiles must always match package.json exactly.
 *
 * Usage:
 *   node tools/workspace/check-marketplace-version.mjs
 *   node tools/workspace/check-marketplace-version.mjs --allow-prerelease-mismatch
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function strip(version) {
  // Drop pre-release/build suffix (-rc.1, -alpha.2, +build.42, etc.)
  return version.replace(/[-+].*$/, '');
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

function versionMajor(version) {
  const match = String(version ?? '').match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

export function checkVersionLockstep(
  root = REPO_ROOT,
  { allowPrereleaseMismatch = false } = {},
) {
  const pkg = readJson(root, 'package.json');
  const lock = readJson(root, 'package-lock.json');
  const cli = readJson(root, 'packages/cli/package.json');
  const flue = readJson(root, 'packages/flue/package.json');
  if (flue.version !== pkg.version) return { ok: false, message: `FAIL: @aiwg/flue version (${flue.version}) must match ${pkg.version}`, fix: `Update packages/flue/package.json to ${pkg.version}.` };
  const cockpit = readJson(root, 'apps/cockpit/package.json');
  const cockpitLock = readJson(root, 'apps/cockpit/package-lock.json');
  const cockpitWeb = readJson(root, 'apps/cockpit/web/package.json');
  const cockpitWebLock = readJson(root, 'apps/cockpit/web/package-lock.json');
  const marketplace = JSON.parse(
    readFileSync(resolve(root, '.claude-plugin/marketplace.json'), 'utf8'),
  );

  const pkgVersion = pkg.version;
  const lockVersion = lock.version;
  const lockRootVersion = lock?.packages?.['']?.version;
  const marketplaceVersion = marketplace?.version ?? marketplace?.metadata?.version;
  const cliVersion = cli?.version;
  const cockpitVersion = cockpit?.version;
  const cockpitLockVersion = cockpitLock?.version;
  const cockpitLockRootVersion = cockpitLock?.packages?.['']?.version;
  const rootVitest = pkg?.devDependencies?.vitest;
  const cockpitVitestSurfaces = [
    {
      label: 'apps/cockpit/web/package.json devDependencies.vitest',
      value: cockpitWeb?.devDependencies?.vitest,
    },
    {
      label: 'apps/cockpit/package-lock.json packages["web"].devDependencies.vitest',
      value: cockpitLock?.packages?.web?.devDependencies?.vitest,
    },
    {
      label: 'apps/cockpit/package-lock.json Vitest resolution',
      value: cockpitLock?.packages?.['node_modules/vitest']?.version,
    },
    {
      label: 'apps/cockpit/web/package-lock.json root devDependencies.vitest',
      value: cockpitWebLock?.packages?.['']?.devDependencies?.vitest,
    },
    {
      label: 'apps/cockpit/web/package-lock.json Vitest resolution',
      value: cockpitWebLock?.packages?.['node_modules/vitest']?.version,
    },
  ];
  const localMarketplacePlugins = (marketplace?.plugins ?? []).filter((plugin) => (
    typeof plugin?.source === 'string' && plugin.source.startsWith('./agentic/code/plugins/')
  ));

  if (!pkgVersion) {
    return {
      ok: false,
      message: 'FAIL: package.json has no version field',
    };
  }
  if (!lockVersion) {
    return {
      ok: false,
      message: 'FAIL: package-lock.json has no top-level version field',
    };
  }
  if (!lockRootVersion) {
    return {
      ok: false,
      message: 'FAIL: package-lock.json packages[""].version missing',
    };
  }
  if (!marketplaceVersion) {
    return {
      ok: false,
      message: 'FAIL: .claude-plugin/marketplace.json version missing',
    };
  }
  if (!cliVersion) {
    return {
      ok: false,
      message: 'FAIL: packages/cli/package.json has no version field',
    };
  }
  if (!cockpitVersion) {
    return {
      ok: false,
      message: 'FAIL: apps/cockpit/package.json has no version field',
    };
  }
  if (!cockpitLockVersion) {
    return {
      ok: false,
      message: 'FAIL: apps/cockpit/package-lock.json has no top-level version field',
    };
  }
  if (!cockpitLockRootVersion) {
    return {
      ok: false,
      message: 'FAIL: apps/cockpit/package-lock.json packages[""].version missing',
    };
  }

  const expectedVitestMajor = versionMajor(rootVitest);
  if (expectedVitestMajor === null) {
    return {
      ok: false,
      message: 'FAIL: package.json devDependencies.vitest is missing or invalid',
    };
  }

  for (const surface of cockpitVitestSurfaces) {
    if (versionMajor(surface.value) !== expectedVitestMajor) {
      return {
        ok: false,
        message:
          `FAIL: ${surface.label} (${surface.value ?? 'missing'}) does not match ` +
          `Vitest major ${expectedVitestMajor} from package.json (${rootVitest}).`,
        fix: 'Fix: regenerate both Cockpit lockfiles after aligning the web Vitest dependency.',
      };
    }
  }

  if (cliVersion !== pkgVersion) {
    return {
      ok: false,
      message:
        `FAIL: @aiwg/cli version (${cliVersion}) does not match ` +
        `package.json (${pkgVersion}).`,
      fix: `Fix: update packages/cli/package.json version to ${pkgVersion}.`,
    };
  }

  if (lockVersion !== pkgVersion) {
    return {
      ok: false,
      message:
        `FAIL: package-lock.json version (${lockVersion}) does not match ` +
        `package.json (${pkgVersion}).`,
      fix: `Fix: update package-lock.json version to ${pkgVersion}.`,
    };
  }

  if (lockRootVersion !== pkgVersion) {
    return {
      ok: false,
      message:
        `FAIL: package-lock.json packages[""].version (${lockRootVersion}) does not match ` +
        `package.json (${pkgVersion}).`,
      fix: `Fix: update package-lock.json packages[""].version to ${pkgVersion}.`,
    };
  }

  if (cockpitVersion !== pkgVersion) {
    return {
      ok: false,
      message:
        `FAIL: @aiwg/cockpit version (${cockpitVersion}) does not match ` +
        `package.json (${pkgVersion}).`,
      fix: `Fix: update apps/cockpit/package.json version to ${pkgVersion}.`,
    };
  }

  if (cockpitLockVersion !== cockpitVersion) {
    return {
      ok: false,
      message:
        `FAIL: apps/cockpit/package-lock.json version (${cockpitLockVersion}) does not match ` +
        `@aiwg/cockpit (${cockpitVersion}).`,
      fix: `Fix: update apps/cockpit/package-lock.json version to ${cockpitVersion}.`,
    };
  }

  if (cockpitLockRootVersion !== cockpitVersion) {
    return {
      ok: false,
      message:
        `FAIL: apps/cockpit/package-lock.json packages[""].version (${cockpitLockRootVersion}) ` +
        `does not match @aiwg/cockpit (${cockpitVersion}).`,
      fix:
        `Fix: update apps/cockpit/package-lock.json packages[""].version ` +
        `to ${cockpitVersion}.`,
    };
  }

  for (const plugin of localMarketplacePlugins) {
    if (plugin.version !== pkgVersion) {
      return {
        ok: false,
        message:
          `FAIL: local marketplace plugin ${plugin.name} version (${plugin.version ?? 'missing'}) ` +
          `does not match package.json (${pkgVersion}).`,
        fix: `Fix: update ${plugin.name} in .claude-plugin/marketplace.json to ${pkgVersion}.`,
      };
    }

    const pluginManifest = readJson(root, `${plugin.source}/.claude-plugin/plugin.json`);
    if (pluginManifest?.version !== pkgVersion) {
      return {
        ok: false,
        message:
          `FAIL: local plugin manifest ${plugin.name} version ` +
          `(${pluginManifest?.version ?? 'missing'}) does not match package.json (${pkgVersion}).`,
        fix:
          `Fix: update ${plugin.source}/.claude-plugin/plugin.json version to ${pkgVersion}.`,
      };
    }
  }

  const exactMatch = pkgVersion === marketplaceVersion;
  const stableMatch = strip(pkgVersion) === strip(marketplaceVersion);

  if (exactMatch) {
    return {
      ok: true,
      message:
        `OK package lockfiles, @aiwg/cli, @aiwg/cockpit, @aiwg/flue, marketplace, and ` +
        `${localMarketplacePlugins.length} local plugin version(s) ` +
        `(${marketplaceVersion}) match package.json (${pkgVersion})`,
    };
  }

  if (allowPrereleaseMismatch && stableMatch) {
    return {
      ok: true,
      message:
        `OK package-lock.json matches package.json (${pkgVersion}); ` +
        `marketplace version (${marketplaceVersion}) matches stable line ` +
        'with pre-release suffix difference allowed by --allow-prerelease-mismatch',
    };
  }

  return {
    ok: false,
    message:
      `FAIL: marketplace version (${marketplaceVersion}) does not match ` +
      `package.json (${pkgVersion}). PUW-038 (#1139) requires lockstep bumps.`,
    fix: `Fix: update .claude-plugin/marketplace.json version to ${pkgVersion}.`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const allowPrereleaseMismatch = args.includes('--allow-prerelease-mismatch');
  const result = checkVersionLockstep(REPO_ROOT, { allowPrereleaseMismatch });

  if (result.ok) {
    console.log(result.message);
    process.exit(0);
  }

  console.error(result.message);
  if (result.fix) {
    console.error('');
    console.error(result.fix);
  }
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
