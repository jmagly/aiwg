/**
 * Channel Manager
 *
 * Manages the distribution channel (stable vs edge) for AIWG.
 * - Stable: Uses the npm-installed package
 * - Edge: Uses a git clone of the main branch for bleeding-edge updates
 *
 * @module src/channel/manager
 * @version 2024.12.0
 */

import fs from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import os from 'os';
import { resolveUserConfigDir } from '../config/user-config-dir.mjs';
import { boundedExecFileSync, boundedExecSync } from '../process/bounded-child-process.mjs';
import {
  assertCanonicalInstallation,
  createInstallationIdentity,
  inferInstallationMethod,
  inspectInstallation,
  loadInstallationIdentity,
  saveInstallationIdentity,
} from '../installation/manager.mjs';

/**
 * Run a command with inherited stdio, applying a wall-clock timeout so a
 * slow or hung git fetch cannot wedge the CLI for minutes. On timeout the
 * child is SIGTERM'd and escalated to SIGKILL after 5s if it does not exit.
 * Rejects with an Error carrying `.code = 'ETIMEDOUT'` on timeout or the
 * original exit code otherwise.
 *
 * Replaces execSync() sites that had no timeout. Overridable via
 * AIWG_GIT_TIMEOUT_MS (default 60s — fetch/pull on slow networks can take
 * a while but must eventually terminate).
 */
async function runWithTimeout(cmd, args, options = {}) {
  const timeoutMs = (() => {
    const raw = process.env['AIWG_GIT_TIMEOUT_MS'];
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 60_000;
  })();

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      ...options,
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      const kill9 = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 5_000);
      kill9.unref?.();
      settled = true;
      const err = new Error(`\`${cmd} ${args.join(' ')}\` timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    timer.unref?.();

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const err = new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`);
        err.code = code ?? 1;
        reject(err);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration paths
const EDGE_INSTALL_PATH = path.join(os.homedir(), '.local', 'share', 'ai-writing-guide');
const REPO_URL = 'https://github.com/jmagly/aiwg.git';

/**
 * Default channel configuration
 */
const DEFAULT_CONFIG = {
  channel: 'stable',
  edgePath: EDGE_INSTALL_PATH,
  lastUpdateCheck: null,
  updateCheckInterval: 86400000, // 24 hours in ms
};

/**
 * Get the package root directory.
 *
 * Walks up from this file's directory looking for the nearest package.json
 * that names either the full `aiwg` distribution or the lightweight
 * `@aiwg/cli` distribution. This works whether this module runs from its
 * source location (`src/channel/manager.mjs`) or from its compiled-build copy
 * (`dist/src/channel/manager.mjs`).
 *
 * The walk is bounded to 10 levels as a safety cap.
 *
 * @returns {string} Path to package root
 */
export function getPackageRoot() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const content = JSON.parse(readFileSync(pkg, 'utf8'));
        if (content.name === 'aiwg' || content.name === '@aiwg/cli') return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to the legacy hardcoded two-up resolution.
  return path.resolve(__dirname, '..', '..');
}

/**
 * Resolve the installation root bin/aiwg.mjs actually dispatches to.
 *
 * This is the exact decision `resolveRouterPath()` in bin/aiwg.mjs makes
 * when picking which `dist/` to load the compiled router (and therefore
 * every compiled-dist module it imports, including the MCP server) from:
 * the dev-mode edge checkout when configured and present and distinct from
 * the package root, otherwise the package root itself. Shared so health
 * checks (doctor) validate the layout the launcher will actually execute
 * instead of re-deriving — and risking drifting from — the same decision
 * (#276).
 *
 * @param {string} packageRoot - This install's own package root (`getPackageRoot()`).
 * @param {{devMode?: boolean, edgePath?: string}} config - Channel config (`loadConfig()`).
 * @returns {string} The effective root whose `dist/src/...` the launcher loads from.
 */
export function resolveEffectiveInstallationRoot(packageRoot, config) {
  if (config?.devMode && config.edgePath && config.edgePath !== packageRoot) {
    return config.edgePath;
  }
  return packageRoot;
}

/**
 * Resolve the absolute path to the MCP server entrypoint the production
 * launcher actually loads: `bin/aiwg.mjs` always dispatches to the
 * *compiled* router (`resolveRouterPath()`, never an uncompiled `src/`
 * tree), whose MCP handler imports `../../mcp/cli.mjs` relative to its own
 * compiled location, which in turn imports `./server.mjs` relative to
 * itself — i.e. always `<effective root>/dist/src/mcp/server.mjs`, in every
 * layout (npm install, source checkout, dev-mode edge checkout). There is
 * no runtime path that falls back to `src/mcp/server.mjs` directly, so a
 * health check that also accepts that source path can report OK for a
 * layout where `aiwg mcp serve` will actually fail (#276).
 *
 * @param {string} packageRoot - This install's own package root (`getPackageRoot()`).
 * @param {{devMode?: boolean, edgePath?: string}} config - Channel config (`loadConfig()`).
 * @returns {string} Absolute path to the compiled MCP server entrypoint.
 */
export function resolveMcpServerEntrypointPath(packageRoot, config) {
  const root = resolveEffectiveInstallationRoot(packageRoot, config);
  return path.join(root, 'dist', 'src', 'mcp', 'server.mjs');
}

/**
 * Load channel configuration
 * @returns {Promise<object>} Channel configuration
 */
export async function loadConfig(options = {}) {
  const configDir = resolveUserConfigDir(options);
  const configFile = path.join(configDir, 'channel.json');
  let legacy = {};
  try {
    const data = await fs.readFile(configFile, 'utf8');
    legacy = JSON.parse(data);
  } catch {
    // Legacy state is optional. The canonical identity below is authoritative.
  }
  const actualRoot = options.actualRoot ?? getPackageRoot();
  const identity = loadInstallationIdentity({ ...options, actualRoot, legacyConfig: legacy });
  if (!identity) return { ...DEFAULT_CONFIG, ...legacy };
  return {
    ...DEFAULT_CONFIG,
    ...legacy,
    channel: identity.channel,
    edgePath: identity.edgePath ?? legacy.edgePath ?? EDGE_INSTALL_PATH,
    devMode: identity.runMode === 'development',
    lastUpdateCheck: identity.lastUpdateCheck,
    updateCheckInterval: identity.updateCheckInterval,
    checkOnStartup: identity.checkOnStartup,
    installation: identity,
  };
}

/**
 * Save channel configuration
 * @param {object} config - Configuration to save
 */
export async function saveConfig(config, options = {}) {
  const configDir = resolveUserConfigDir(options);
  const configFile = path.join(configDir, 'channel.json');
  await fs.mkdir(configDir, { recursive: true });
  const { installation: _installation, ...legacyConfig } = config;
  await fs.writeFile(configFile, `${JSON.stringify(legacyConfig, null, 2)}\n`);

  const actualRoot = options.actualRoot ?? getPackageRoot();
  const previous = loadInstallationIdentity({ ...options, actualRoot, legacyConfig: config });
  if (previous) {
    const development = config.devMode === true;
    const root = development && config.edgePath ? config.edgePath : previous.root;
    const method = development ? 'source' : previous.method;
    saveInstallationIdentity(createInstallationIdentity({
      ...options,
      actualRoot,
      root,
      method,
      runMode: development ? 'development' : 'normal',
      channel: config.channel ?? previous.channel,
      edgePath: config.edgePath ?? previous.edgePath,
      managerExecutable: development ? undefined : previous.managerExecutable,
      updateStrategy: development ? 'source-git' : previous.updateStrategy,
      lastUpdateCheck: config.lastUpdateCheck ?? previous.lastUpdateCheck,
      updateCheckInterval: config.updateCheckInterval ?? previous.updateCheckInterval,
      checkOnStartup: config.checkOnStartup ?? previous.checkOnStartup,
      recordedAt: previous.recordedAt,
    }), options);
  }
}

/**
 * Get the current channel
 * @returns {Promise<string>} 'stable' or 'edge'
 */
export async function getChannel() {
  const config = await loadConfig();
  return config.channel;
}

/**
 * Get the framework root path based on current channel
 * @returns {Promise<string>} Path to framework root
 */
export async function getFrameworkRoot(options = {}) {
  const config = await loadConfig(options);

  if (config.channel === 'edge') {
    // Check if edge installation exists
    try {
      await fs.access(config.edgePath);
      return config.edgePath;
    } catch {
      // Edge path doesn't exist, fall back to stable
      console.warn('Edge installation not found, using stable channel');
      return getPackageRoot();
    }
  }

  return config.installation?.root ?? getPackageRoot();
}

/**
 * Switch to edge (bleeding edge) channel
 * Clones or updates the git repository for latest main branch
 */
export async function switchToEdge() {
  const config = await loadConfig();
  if (typeof config.edgePath !== 'string' || !path.isAbsolute(config.edgePath)) {
    throw new Error('Edge installation path must be absolute');
  }

  console.log('Switching to edge channel (bleeding edge from main branch)...');
  console.log('');

  // Check if edge installation exists
  const edgeExists = await fs.access(config.edgePath).then(() => true).catch(() => false);

  if (edgeExists) {
    // Update existing installation
    console.log(`Updating edge installation at ${config.edgePath}...`);
    try {
      await runWithTimeout('git', ['fetch', '--all'], { cwd: config.edgePath });
      await runWithTimeout('git', ['checkout', 'main'], { cwd: config.edgePath });
      await runWithTimeout('git', ['pull', '--ff-only'], { cwd: config.edgePath });
      // Ensure sparse checkout excludes .aiwg/ on existing installs
      try {
        const sparseConfig = path.join(config.edgePath, '.git', 'info', 'sparse-checkout');
        const hasSparse = await fs.access(sparseConfig).then(() => true).catch(() => false);
        if (!hasSparse) {
          boundedExecSync('git sparse-checkout init --cone', 'quick', { cwd: config.edgePath, stdio: 'pipe' });
          boundedExecSync('git sparse-checkout set --no-cone "/*" "!/.aiwg"', 'quick', { cwd: config.edgePath, stdio: 'pipe' });
        }
      } catch {
        // Sparse checkout is optional — older git may not support it
      }
      console.log('Edge installation updated successfully.');
    } catch (error) {
      console.error('Failed to update edge installation:', error.message);
      console.log('Try removing the directory and running again:');
      console.log(`  rm -rf ${config.edgePath}`);
      console.log('  aiwg --use-main');
      process.exit(1);
    }
  } else {
    // Clone fresh
    console.log(`Cloning repository to ${config.edgePath}...`);
    await fs.mkdir(path.dirname(config.edgePath), { recursive: true });
    try {
      // Cloning the full repository; long tier (#3062).
      boundedExecFileSync('git', ['clone', '--branch', 'main', '--', REPO_URL, config.edgePath], 'long', { stdio: 'inherit' });
      // Exclude dogfooding artifacts from edge clones — users want framework source only
      try {
        boundedExecSync('git sparse-checkout init --cone', 'quick', { cwd: config.edgePath, stdio: 'pipe' });
        boundedExecSync('git sparse-checkout set --no-cone "/*" "!/.aiwg"', 'quick', { cwd: config.edgePath, stdio: 'pipe' });
      } catch {
        // Sparse checkout is optional — older git versions may not support it
        console.log('Note: sparse checkout not available, .aiwg/ will be present in edge install.');
      }
      console.log('Edge installation created successfully.');
    } catch (error) {
      console.error('Failed to clone repository:', error.message);
      process.exit(1);
    }
  }

  // Update config
  config.channel = 'edge';
  await saveConfig(config);

  console.log('');
  console.log('Switched to edge channel.');
  console.log('You are now using the latest code from the main branch.');
  console.log('');
  console.log('To update edge installation: aiwg -update');
  console.log('To switch back to stable:   aiwg --use-stable');
}

/**
 * Switch to dev mode (use local repo as both framework source and CLI)
 *
 * In dev mode, the CLI entry point delegates to the dev repo's facade,
 * so all code (including `aiwg index`, `aiwg use`, etc.) runs from the
 * local build rather than the npm-installed package.
 *
 * @param {string} devPath - Path to the local development repository
 */
export async function switchToDev(devPath) {
  const config = await loadConfig();

  const resolvedPath = path.resolve(devPath);

  console.log('Switching to dev mode (local repository source)...');
  console.log('');

  // Verify the path looks like an AIWG repo
  try {
    await fs.access(path.join(resolvedPath, 'agentic', 'code', 'frameworks'));
  } catch {
    console.error(`Error: ${resolvedPath} does not appear to be an AIWG repository.`);
    console.error('Expected to find agentic/code/frameworks/ directory.');
    process.exit(1);
  }

  // Verify compiled router exists (dev-mode dispatch imports from dist/).
  // Accept repos that have never been built by emitting a clear build hint
  // rather than hard-failing here — the first `aiwg` invocation will re-check
  // and print the same hint. This lets `aiwg --use-dev /path/to/fresh/clone`
  // succeed followed by `npm run build`.
  const distRouter = path.join(resolvedPath, 'dist', 'src', 'cli', 'router.js');
  const distExists = await fs.access(distRouter).then(() => true).catch(() => false);

  config.channel = 'edge';
  config.edgePath = resolvedPath;
  config.devMode = true;
  await saveConfig(config);

  console.log('Switched to dev mode.');
  console.log(`Dev repo:    ${resolvedPath}`);
  console.log(`Router:      ${distRouter}`);
  if (!distExists) {
    console.log('');
    console.log('NOTE: dist/ is not built yet. Before running aiwg commands:');
    console.log(`  (cd ${resolvedPath} && npm run build)`);
  }
  console.log('');
  console.log('The aiwg command now runs the compiled router from your local repo.');
  console.log('After making changes, run: npm run build');
  console.log('');
  console.log('Commands:');
  console.log('  aiwg use all          Deploy from local source');
  console.log('  aiwg version          Verify dev mode active');
  console.log('  aiwg --use-stable     Switch back to npm package');
}

/**
 * Switch to next (alpha/beta/RC) channel
 * Installs the latest pre-release from the `next` dist-tag
 */
export async function switchToNext() {
  const config = await loadConfig();
  const status = assertCanonicalInstallation({ actualRoot: getPackageRoot() });
  if (status.identity.method !== 'npm' || !status.identity.managerExecutable) {
    throw new Error('The next channel requires a canonical npm installation with a recorded package-manager executable.');
  }

  console.log('Switching to next channel (alpha/beta/RC — latest pre-release)...');
  console.log('');

  try {
    boundedExecFileSync(status.identity.managerExecutable, ['install', '--global', 'aiwg@next'], 'long', { stdio: 'inherit' });
  } catch (error) {
    console.error('Failed to install aiwg@next:', error.message);
    console.error('Check that npm is available and you have write access to the global prefix.');
    process.exit(1);
  }

  config.channel = 'next';
  config.devMode = false;
  await saveConfig(config);

  console.log('');
  console.log('Switched to next channel.');
  console.log('You are now running the latest alpha/beta/RC release.');
  console.log('');
  console.log('To see what version you installed: aiwg version');
  console.log('To switch back to stable:          aiwg sync --channel latest');
}

/**
 * Switch to nightly channel
 * Installs the latest nightly snapshot from the `nightly` dist-tag
 */
export async function switchToNightly() {
  const config = await loadConfig();
  const status = assertCanonicalInstallation({ actualRoot: getPackageRoot() });
  if (status.identity.method !== 'npm' || !status.identity.managerExecutable) {
    throw new Error('The nightly channel requires a canonical npm installation with a recorded package-manager executable.');
  }

  console.log('Switching to nightly channel (latest automated snapshot)...');
  console.log('');

  try {
    boundedExecFileSync(status.identity.managerExecutable, ['install', '--global', 'aiwg@nightly'], 'long', { stdio: 'inherit' });
  } catch (error) {
    console.error('Failed to install aiwg@nightly:', error.message);
    console.error('Check that npm is available and you have write access to the global prefix.');
    process.exit(1);
  }

  config.channel = 'nightly';
  config.devMode = false;
  await saveConfig(config);

  console.log('');
  console.log('Switched to nightly channel.');
  console.log('You are now running the latest automated nightly snapshot.');
  console.log('');
  console.log('To see what version you installed: aiwg version');
  console.log('To switch back to stable:          aiwg sync --channel latest');
}

/**
 * Switch to stable (npm) channel
 */
export async function switchToStable() {
  const config = await loadConfig();

  console.log('Switching to the stable channel...');
  console.log('');

  config.channel = 'stable';
  config.devMode = false;
  await saveConfig(config);
  const actualRoot = getPackageRoot();
  saveInstallationIdentity(createInstallationIdentity({
    actualRoot,
    root: actualRoot,
    method: inferInstallationMethod(actualRoot),
    runMode: 'normal',
    channel: 'stable',
    edgePath: config.edgePath,
    lastUpdateCheck: config.lastUpdateCheck,
    updateCheckInterval: config.updateCheckInterval,
    checkOnStartup: config.checkOnStartup,
  }));

  console.log('Switched to stable channel.');
  console.log('You are now using the canonical installed package.');
  console.log('');
  console.log('To update: aiwg refresh --channel latest');
  console.log('To switch to edge: aiwg --use-main');
}

/**
 * Get version information based on current channel
 * @returns {Promise<object>} Version info
 */
/**
 * Normalize a package.json `repository` field (string or `{ url }`) into a clean
 * `host/owner/repo` display form for version stamps — stripping the `git+`
 * prefix, URL scheme, and `.git` suffix. Returns '' if none is declared.
 *
 * @param {string | { url?: string } | undefined} repository
 * @returns {string}
 */
function normalizeRepoUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url || '';
  return raw
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

export async function getVersionInfo() {
  const config = await loadConfig();
  const packageRoot = getPackageRoot();
  const installation = inspectInstallation({ actualRoot: packageRoot, identity: config.installation });

  // Read package.json version
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

  // Detect pre-release channel from version string when channel.json says 'stable'
  // This handles the case where a user ran `npm install -g aiwg@next` directly —
  // npm updates the binary but channel.json stays as 'stable'.
  let channel = config.channel;
  const version = packageJson.version;
  if (!config.devMode && channel === 'stable') {
    if (version.includes('-rc.')) {
      channel = 'rc';
    } else if (version.includes('-beta.')) {
      channel = 'beta';
    } else if (version.includes('-alpha.')) {
      channel = 'alpha';
    } else if (version.includes('-nightly.')) {
      channel = 'nightly';
    }
  }

  const info = {
    version,
    channel,
    packageRoot,
    installation,
    devMode: config.devMode || false,
    // Public-facing URLs — single source of truth is package.json, so user-visible
    // stamps/links never hardcode the internal build origin. The published package
    // declares the public repository/homepage/bugs; read them here rather than
    // duplicating literals across the CLI.
    repoUrl: normalizeRepoUrl(packageJson.repository),       // e.g. github.com/jmagly/aiwg
    homepage: packageJson.homepage || '',                    // e.g. https://aiwg.io
    issuesUrl: packageJson.bugs?.url || '',                  // e.g. https://github.com/jmagly/aiwg/issues
  };

  if (config.channel === 'edge') {
    // Get git info for edge channel
    try {
      const gitHash = boundedExecSync('git rev-parse --short HEAD', 'quick', {
        cwd: config.edgePath,
        encoding: 'utf8',
      }).trim();
      const gitBranch = boundedExecSync('git branch --show-current', 'quick', {
        cwd: config.edgePath,
        encoding: 'utf8',
      }).trim();
      info.edgePath = config.edgePath;
      info.gitHash = gitHash;
      info.gitBranch = gitBranch;
    } catch {
      // Git info not available
    }
  }

  return info;
}

/**
 * Update the edge installation from git
 */
export async function updateEdge() {
  const config = await loadConfig();

  if (config.channel !== 'edge') {
    console.log('Not in edge channel. Use `aiwg update` for the canonical installed channel.');
    return;
  }

  console.log('Updating edge installation...');

  try {
    await runWithTimeout('git', ['fetch', '--all'], { cwd: config.edgePath });
    await runWithTimeout('git', ['pull', '--ff-only'], { cwd: config.edgePath });
    console.log('');
    console.log('Edge installation updated successfully.');
  } catch (error) {
    console.error('Update failed:', error.message);
    console.log('');
    console.log('If you have local changes, try:');
    console.log(`  cd ${config.edgePath}`);
    console.log('  git stash');
    console.log('  git pull');
    console.log('  git stash pop');
    process.exit(1);
  }
}
