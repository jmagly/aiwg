// Run the conductor with explicit filesystem grants and no user-manager bus.
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { probeVerificationIsolationCapabilities } from './verification-isolation.mjs';
import { buildSystemdClientEnv, CONNECTION_NAMES, isClientControlVariable, resolveSystemdRun } from './systemd-client.mjs';

const required = ['writeConfinement', 'homeReadIsolation', 'tmpIsolation'];
const usage = 'Usage: ralph-external --run-conductor --conductor-root ABS_DIR --deliverable ABS_PATH [--bind ABS_DIR] [--setenv NAME] -- COMMAND [ARG...]';
function safePath(value) {
  // systemd path lists interpret whitespace, colons, backslashes and specifiers.
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\s:%\\\x00-\x1f"']/.test(value) || path.normalize(value) !== value) throw new Error('Conductor grants require normalized absolute paths without systemd metacharacters');
  if (value === '/' || ['/run', '/proc', '/sys', '/dev'].some(root => value === root || value.startsWith(root + '/'))) throw new Error('Conductor grants cannot expose runtime buses or kernel interfaces');
  return value;
}
function safeEnv(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || CONNECTION_NAMES.includes(name) || isClientControlVariable(name)) throw new Error('--setenv accepts a non-bootstrap environment name only; manager connections are forbidden');
  return name;
}
export function parseConductorArgs(args) {
  const result = { binds: [], deliverables: [], envNames: [], command: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--run-conductor') continue;
    if (flag === '--') { result.command = args.slice(i + 1); break; }
    if (!['--conductor-root', '--deliverable', '--bind', '--setenv'].includes(flag)) throw new Error(`Unsupported conductor option: ${flag}`);
    const value = args[++i];
    if (flag === '--setenv') result.envNames.push(safeEnv(value));
    else {
      safePath(value);
      if (flag === '--conductor-root') {
        if (result.conductorRoot) throw new Error('Duplicate --conductor-root');
        result.conductorRoot = value;
      } else result[flag === '--bind' ? 'binds' : 'deliverables'].push(value);
    }
  }
  if (!result.conductorRoot || !result.deliverables.length || !result.command.length) throw new Error(usage);
  return result;
}
export function buildConductorArgs(options) {
  const grants = [options.conductorRoot, ...(options.binds ?? [])].map(safePath);
  const deliverables = options.deliverables.map(safePath);
  if (!deliverables.length || !options.command.length) throw new Error(usage);
  if (grants.some(grant => deliverables.some(deliverable => grant === deliverable || grant.startsWith(deliverable + '/')))) throw new Error('Writable grants cannot overlap or sit inside protected deliverables');
  const args = ['--user', '--pipe', '--wait', '--collect', '--quiet'];
  const properties = ['NoNewPrivileges=yes', 'ProtectHome=tmpfs', 'PrivateTmp=yes', 'ReadOnlyPaths=/',
    'InaccessiblePaths=/run/user /run/dbus',
    'UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS SYSTEMD_BUS_ADDRESS XDG_RUNTIME_DIR',
    `WorkingDirectory=${options.conductorRoot}`];
  for (const grant of new Set(grants)) properties.push(`BindPaths=${grant}`, `ReadWritePaths=${grant}`);
  for (const deliverable of deliverables) properties.push(`ReadOnlyPaths=${deliverable}`);
  for (const property of properties) args.push('-p', property);
  for (const name of options.envNames ?? []) args.push(`--setenv=${safeEnv(name)}`);
  // An assertion in the actual profile, before any conductor code runs. This
  // also catches accidental runtime grants if the profile changes in future.
  args.push('--', '/bin/sh', '-c',
    'if [ -n "${DBUS_SESSION_BUS_ADDRESS-}${SYSTEMD_BUS_ADDRESS-}${XDG_RUNTIME_DIR-}" ] || [ -S /run/user/$(id -u)/bus ] || /usr/bin/systemctl --user show-environment >/dev/null 2>&1; then echo "CONDUCTOR_BUS_EXPOSED: refusing conductor" >&2; exit 125; fi; exec "$@"',
    'aiwg-conductor', ...options.command);
  return args;
}
export function runConductor(options, { probe = probeVerificationIsolationCapabilities, spawn = spawnSync, resolveRun = resolveSystemdRun, env = process.env } = {}) {
  const capabilities = probe();
  const missing = required.filter(name => capabilities?.[name] !== 'enforced');
  if (capabilities?.mode !== 'systemd-unit' || missing.length) throw new Error(`ISOLATION_UNAVAILABLE: conductor requires enforced write, home-read and tmp isolation (${missing.join(', ')}); use a namespace-enabled host (#4128). No degraded mode is supported.`);
  const args = buildConductorArgs(options);
  const result = spawn(resolveRun(), args, { stdio: 'inherit', env: buildSystemdClientEnv({ env, envNames: options.envNames ?? [] }) });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}
export async function runConductorCli(args, { run = runConductor, stderr = console.error } = {}) {
  try {
    const options = parseConductorArgs(args);
    for (const grant of [options.conductorRoot, ...options.binds]) {
      if (realpathSync(grant) !== grant || !statSync(grant).isDirectory()) throw new Error('Conductor binds require existing canonical directories');
    }
    for (const deliverable of options.deliverables) {
      if (realpathSync(deliverable) !== deliverable) throw new Error('Deliverables must exist and be canonical; create the protected directory before launch');
      if (![options.conductorRoot, ...options.binds].some(grant => deliverable === grant || deliverable.startsWith(grant + '/'))) throw new Error('Deliverables must be beneath a granted directory');
    }
    return run(options);
  } catch (error) { stderr(error.message); return 1; }
}
