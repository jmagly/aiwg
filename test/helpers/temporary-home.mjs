// Own the HOME and resolver overrides shared by isolated test lanes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Git trusts a checkout owned by another user only through `safe.directory` in protected
// config, and CI containers record it in the real HOME's global config (actions/checkout).
// Carry those entries into the temporary HOME so tests that run git in the checkout keep
// working; nothing else from the operator's git config is copied.
function inheritedSafeDirectories() {
  try {
    return execFileSync('git', ['config', '--global', '--get-all', 'safe.directory'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function createTemporaryHome(prefix, directory = os.tmpdir()) {
  const home = mkdtempSync(path.join(directory, prefix));
  const safe = inheritedSafeDirectories();
  if (safe.length) {
    writeFileSync(path.join(home, '.gitconfig'), `[safe]\n${safe.map(dir => `\tdirectory = ${dir}\n`).join('')}`);
  }
  const env = {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
    AIWG_CONFIG: path.join(home, '.aiwg'), npm_config_cache: path.join(home, '.npm'),
  };
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
