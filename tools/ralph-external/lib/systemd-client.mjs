import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const CONNECTION_NAMES = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_BUS_ADDRESS'];

export function isClientControlVariable(name) {
  return /^(LD_|DYLD_|GLIBC_)/.test(name) || ['NODE_OPTIONS', 'NODE_PATH'].includes(name);
}

/** Conductor PATH directories and symlink targets must be protected from
 * untrusted writers; canonicalization does not check ownership or prevent races. */
export function resolveSystemdClient(name) {
  if (!['systemd-run', 'systemctl'].includes(name)) throw new Error('Invalid systemd client');
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    // Relative/empty entries would let the working directory select the client.
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      const canonical = realpathSync(candidate);
      accessSync(canonical, constants.X_OK);
      if (statSync(canonical).isFile()) return canonical;
    } catch { /* try the next conductor PATH entry */ }
  }
  throw new Error(`${name} is unavailable on the conductor's absolute PATH`);
}

export function resolveSystemdRun() { return resolveSystemdClient('systemd-run'); }

/** Reject bootstrap controls before the client loader can act on them. */
export function unitEnvironmentNames(envNames) {
  for (const name of envNames) {
    if (isClientControlVariable(name)) throw new Error('Worker environment cannot alter trusted transport bootstrap');
  }
  return envNames.filter(name => !CONNECTION_NAMES.includes(name));
}

/** Import caller values for bare --setenv; connections belong only to the conductor. */
export function buildSystemdClientEnv({ env = process.env, envNames = ['PATH', 'HOME'] } = {}) {
  const clientEnv = {};
  for (const name of ['PATH', 'HOME', ...CONNECTION_NAMES]) {
    if (process.env[name] !== undefined) clientEnv[name] = process.env[name];
  }
  for (const name of envNames) {
    if (CONNECTION_NAMES.includes(name) || isClientControlVariable(name)) continue;
    if (env?.[name] === undefined) delete clientEnv[name];
    else clientEnv[name] = env[name];
  }
  return clientEnv;
}
