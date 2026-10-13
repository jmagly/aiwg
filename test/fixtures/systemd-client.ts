import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** POSIX executable shim, quoting Node paths that may contain spaces. */
export function systemdClientFixture(nodePath = process.execPath) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aiwg-systemd-client-')));
  const binary = path.join(root, 'systemd-run');
  const systemctl = path.join(root, 'systemctl');
  const script = path.join(root, 'client.js');
  writeFileSync(script, `console.log(JSON.stringify({ source: 'conductor', env: process.env, args: process.argv.slice(2) }));\n`);
  const launcher = `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(script)} "$@"\n`;
  for (const executable of [binary, systemctl]) writeFileSync(executable, launcher, { mode: 0o700 });
  return { root, binary, systemctl };
}
