// Pack the generated peer-only surface with isolated npm state and no scripts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildFluePackage } from '../../tools/release/build-flue-package.mjs';
export function packFlue(scratch) {
  const directory = path.join(scratch, 'staged');
  const result = buildFluePackage({ outputDir: directory });
  const env = { PATH: process.env.PATH, HOME: path.join(scratch, 'home'), npm_config_cache: path.join(scratch, 'cache'),
    npm_config_userconfig: path.join(scratch, 'absent.npmrc'), npm_config_offline: 'true' };
  fs.mkdirSync(env.HOME);
  const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], { cwd: directory, env, encoding: 'utf8', timeout: 60_000 });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  const info = JSON.parse(packed.stdout)[0];
  return { ...result, info, tarball: path.join(scratch, info.filename) };
}
