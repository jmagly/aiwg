// Synthetic long CLI call for protocol cancellation; other calls use the real CLI.
import fs from 'node:fs';
import path from 'node:path';

if (process.argv[2] === 'discover' && process.argv[3] === '__wait_for_cancel__') {
  fs.writeFileSync(path.join(process.cwd(), 'cli-started'), String(process.pid));
  process.once('SIGTERM', () => {
    fs.writeFileSync(path.join(process.cwd(), 'cli-cancelled'), 'cancelled');
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  await import('../../../bin/aiwg.mjs');
}
