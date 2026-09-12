import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resolveUserConfigDir } from '../config/user-config-dir.mjs';
import { executeManagerCommand } from './manager-command.mjs';

export const INSTALLATION_IDENTITY_VERSION = 1;
export const INSTALLATION_FILE = 'installation.json';
const METHODS = new Set(['npm', 'web', 'source']);
const RUN_MODES = new Set(['normal', 'development']);
const CHANNELS = new Set(['stable', 'next', 'nightly', 'edge']);
const STRATEGIES = new Set(['npm-global', 'signed-web', 'source-git']);

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

function packageName(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name ?? null;
  } catch {
    return null;
  }
}

export function inferInstallationMethod(root) {
  if (packageName(root) === '@aiwg/cli') return 'web';
  if (existsSync(path.join(root, '.git'))) return 'source';
  return 'npm';
}

function resolveExecutable(name, options = {}) {
  const env = options.env ?? process.env;
  const explicit = options.managerExecutable ?? env.AIWG_PACKAGE_MANAGER_EXECUTABLE;
  if (explicit) return canonicalPath(explicit);
  if (name === 'npm' && env.npm_execpath) return canonicalPath(env.npm_execpath);

  const besideNode = path.join(path.dirname(process.execPath), process.platform === 'win32' ? `${name}.cmd` : name);
  if (existsSync(besideNode)) return canonicalPath(besideNode);
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const found = execFileSync(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/, 1)[0]?.trim();
    return found ? canonicalPath(found) : null;
  } catch {
    return null;
  }
}

function strategyFor(method) {
  if (method === 'web') return 'signed-web';
  if (method === 'source') return 'source-git';
  return 'npm-global';
}

function executableIsUsable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function validateIdentity(value, file) {
  const invalid = !value || typeof value !== 'object'
    || value.schemaVersion !== INSTALLATION_IDENTITY_VERSION
    || !METHODS.has(value.method)
    || !RUN_MODES.has(value.runMode)
    || !CHANNELS.has(value.channel)
    || typeof value.root !== 'string'
    || !path.isAbsolute(value.root)
    || !STRATEGIES.has(value.updateStrategy)
    || value.updateStrategy !== strategyFor(value.method)
    || (value.managerExecutable !== null
      && (typeof value.managerExecutable !== 'string' || !path.isAbsolute(value.managerExecutable)));
  if (invalid) {
    const error = new Error(`Invalid AIWG installation identity at ${file}. Run \`aiwg installation adopt\` to replace it.`);
    error.code = 'AIWG_INSTALLATION_INVALID';
    throw error;
  }
  return value;
}

export function installationFile(options = {}) {
  return path.join(resolveUserConfigDir(options), INSTALLATION_FILE);
}

export function createInstallationIdentity(options) {
  if (!options?.actualRoot) throw new Error('actualRoot is required to create an installation identity');
  const root = canonicalPath(options.root ?? options.actualRoot);
  const method = options.method ?? inferInstallationMethod(root);
  const runMode = options.runMode ?? (method === 'source' ? 'development' : 'normal');
  const requestedChannel = options.channel ?? (runMode === 'development' ? 'edge' : 'stable');
  const channel = requestedChannel === 'latest'
    ? 'stable'
    : ['alpha', 'beta', 'rc'].includes(requestedChannel) ? 'next' : requestedChannel;
  const executableName = method === 'npm' ? 'npm' : method === 'source' ? 'git' : null;
  return {
    schemaVersion: INSTALLATION_IDENTITY_VERSION,
    runMode,
    method,
    root,
    updateStrategy: options.updateStrategy ?? strategyFor(method),
    managerExecutable: executableName ? resolveExecutable(executableName, options) : null,
    channel,
    edgePath: options.edgePath ? canonicalPath(options.edgePath) : (runMode === 'development' ? root : null),
    checkOnStartup: options.checkOnStartup ?? true,
    lastUpdateCheck: options.lastUpdateCheck ?? null,
    updateCheckInterval: options.updateCheckInterval ?? 86_400_000,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  };
}

export function saveInstallationIdentity(identity, options = {}) {
  const file = installationFile(options);
  const validated = validateIdentity(identity, file);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
  return validated;
}

function readLegacy(options = {}) {
  const file = path.join(resolveUserConfigDir(options), 'channel.json');
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Load the canonical record, migrating legacy channel.json on first access. */
export function loadInstallationIdentity(options = {}) {
  const file = installationFile(options);
  if (existsSync(file)) {
    try { return validateIdentity(JSON.parse(readFileSync(file, 'utf8')), file); }
    catch (error) {
      if (error?.code === 'AIWG_INSTALLATION_INVALID') throw error;
      const wrapped = new Error(`Cannot read AIWG installation identity at ${file}: ${error.message}`);
      wrapped.code = 'AIWG_INSTALLATION_INVALID';
      throw wrapped;
    }
  }
  if (options.createIfMissing === false || process.env.AIWG_CLI_DRY_RUN === '1') return null;
  if (!options.actualRoot) return null;

  const legacy = options.legacyConfig ?? readLegacy(options) ?? {};
  const development = legacy.devMode === true;
  const root = development && legacy.edgePath ? legacy.edgePath : options.actualRoot;
  const method = options.method ?? (development ? 'source' : inferInstallationMethod(root));
  const identity = createInstallationIdentity({
    ...options,
    root,
    method,
    runMode: development ? 'development' : undefined,
    channel: legacy.channel ?? options.channel,
    edgePath: legacy.edgePath,
    lastUpdateCheck: legacy.lastUpdateCheck,
    updateCheckInterval: legacy.updateCheckInterval,
    checkOnStartup: legacy.checkOnStartup,
  });
  return saveInstallationIdentity(identity, options);
}

export function inspectInstallation(options = {}) {
  const actualRoot = canonicalPath(options.actualRoot);
  const actualMethod = options.actualMethod ?? inferInstallationMethod(actualRoot);
  const identity = options.identity ?? loadInstallationIdentity({ ...options, actualRoot });
  if (!identity) {
    return {
      state: 'unrecorded',
      identity: null,
      actualRoot,
      actualMethod,
      frameworkRoot: actualRoot,
      launcher: null,
      drift: ['installation identity is not recorded'],
    };
  }

  const drift = [];
  const canonicalRoot = canonicalPath(identity.root);

  // Edge/customize mode deliberately separates the *launcher* (the executable
  // that ran, typically an npm-global install) from the *framework root* (the
  // local clone named by `edgePath`). Comparing the launcher's package root
  // against the canonical root then reports the supported configuration as
  // drift, and does so only for the commands that happen to run from the
  // npm-global copy — `aiwg doctor`, loaded through the redirect, saw the
  // clone and reported aligned for the same workspace (#2505).
  //
  // The redirect is only trusted when the identity actually declares it: the
  // channel is `edge` and `edgePath` resolves to the canonical root.
  const edgePath = identity.edgePath ? canonicalPath(identity.edgePath) : null;
  const rootsDiffer = canonicalRoot !== actualRoot;
  const launcherRedirect = identity.channel === 'edge' && edgePath !== null && edgePath === canonicalRoot && rootsDiffer;
  const launcher = launcherRedirect ? { root: actualRoot, method: actualMethod } : null;
  // The framework root is what AIWG actually reads its corpus from, and it is
  // the single value that drives `state`.
  const frameworkRoot = launcherRedirect ? canonicalRoot : actualRoot;

  if (!existsSync(canonicalRoot)) drift.push(`canonical root does not exist: ${canonicalRoot}`);
  if (rootsDiffer && !launcherRedirect) drift.push(`actual root ${actualRoot} differs from canonical root ${canonicalRoot}`);
  if (identity.method !== actualMethod && !launcherRedirect) {
    drift.push(`actual method ${actualMethod} differs from canonical method ${identity.method}`);
  }
  if (identity.method !== 'web' && !identity.managerExecutable) {
    drift.push(`canonical ${identity.method} installation has no recorded manager executable`);
  }
  if (identity.managerExecutable && !executableIsUsable(identity.managerExecutable)) {
    drift.push(`recorded manager executable is missing or not executable: ${identity.managerExecutable}`);
  }
  let managerProbe = null;
  if (
    options.probeManager === true &&
    identity.managerExecutable &&
    executableIsUsable(identity.managerExecutable)
  ) {
    try {
      executeManagerCommand(identity.managerExecutable, ['--version'], {
        ...options,
        execute: options.executeManager,
        execOptions: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
      });
      managerProbe = { state: 'usable' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      managerProbe = { state: 'failed', error: message };
      drift.push(`recorded manager executable cannot be invoked: ${message}`);
    }
  }
  return {
    state: drift.length === 0 ? 'aligned' : (existsSync(canonicalRoot) ? 'mismatch' : 'stale'),
    identity,
    canonicalRoot,
    actualRoot,
    actualMethod,
    /** Where the corpus is read from. Equals actualRoot unless a launcher redirect applies. */
    frameworkRoot,
    /** Non-null only in edge/customize mode: the executable's own package root. */
    launcher,
    drift,
    managerProbe,
  };
}

export function formatInstallationDiagnostic(status) {
  if (status.state === 'aligned') return 'Canonical installation is aligned.';
  return [
    'AIWG installation identity drift detected; update and refresh are blocked.',
    ...status.drift.map((item) => `- ${item}`),
    'Inspect: aiwg installation show',
    'Adopt this installation: aiwg installation adopt',
    'Switch deliberately: aiwg installation switch --root <path> --method <npm|web|source> [--manager <absolute-path>]',
  ].join('\n');
}

export function assertCanonicalInstallation(options = {}) {
  const status = inspectInstallation(options);
  // A strict dry-run may inspect an installation that has not yet recorded
  // identity, but must not create installation.json merely to authorize a
  // read-only preview. Callers must opt into this narrow exception.
  if (options.allowUnrecorded === true && status.state === 'unrecorded') return status;
  if (status.state !== 'aligned') {
    const error = new Error(formatInstallationDiagnostic(status));
    error.code = 'AIWG_INSTALLATION_DRIFT';
    error.status = status;
    throw error;
  }
  return status;
}

export function adoptInstallation(options) {
  const inferred = inferInstallationMethod(options.actualRoot);
  if (options.method && options.method !== inferred) {
    throw new Error(`Cannot adopt ${options.actualRoot} as ${options.method}; package contents identify it as ${inferred}.`);
  }
  const identity = createInstallationIdentity({ ...options, root: options.actualRoot });
  saveInstallationIdentity(identity, options);
  return inspectInstallation({ ...options, actualRoot: identity.root, identity });
}

export function switchInstallation(options) {
  if (!options?.root || !options?.method) throw new Error('switch requires root and method');
  if (!existsSync(path.resolve(options.root))) throw new Error(`Installation root does not exist: ${path.resolve(options.root)}`);
  const inferred = inferInstallationMethod(options.root);
  if (options.method !== inferred) {
    throw new Error(`Cannot switch ${options.root} as ${options.method}; package contents identify it as ${inferred}.`);
  }
  const identity = createInstallationIdentity({ ...options, actualRoot: options.root });
  saveInstallationIdentity(identity, options);
  return inspectInstallation({ ...options, actualRoot: identity.root, identity });
}
