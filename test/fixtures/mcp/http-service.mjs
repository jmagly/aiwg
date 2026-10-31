// Isolated CLI HTTP service fixture; all sockets use 127.0.0.1 ephemeral ports.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '../../..');
export async function launchHttp(extra = [], { fileToken = false, idleTimeoutMs } = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-mcp-http-'));
  const project = path.join(scratch, 'project');
  const home = path.join(scratch, 'home');
  const bin = path.join(scratch, 'bin');
  await Promise.all([fs.mkdir(path.join(project, '.aiwg'), { recursive: true }), fs.mkdir(home), fs.mkdir(bin)]);
  const token = randomBytes(32).toString('hex');
  const tokenFile = path.join(scratch, 'fixture-token');
  if (fileToken) await fs.writeFile(tokenFile, token, { mode: 0o600 });
  await fs.writeFile(path.join(bin, 'aiwg'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'http-cli-proxy.mjs')).href)};\n`, { mode: 0o755 });
  const args = ['serve', '--transport=http', '--project', project, '--port', '0',
    ...(fileToken ? ['--token-file', tokenFile] : ['--token-env', 'AIWG_HTTP_FIXTURE_TOKEN']), ...extra];
  const moduleUrl = pathToFileURL(path.join(root, 'src/mcp/cli.mjs')).href;
  const script = idleTimeoutMs === undefined
    ? `const { main } = await import(${JSON.stringify(moduleUrl)}); await main(${JSON.stringify(args)});`
    : `const { startHttpServer } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/mcp/http-transport.mjs')).href)});
       const service = await startHttpServer({ projectDir: ${JSON.stringify(project)}, port: 0, tokenEnv: 'AIWG_HTTP_FIXTURE_TOKEN', idleTimeoutMs: ${idleTimeoutMs} });
       console.error('AIWG MCP HTTP listening on 127.0.0.1:' + service.listener.address().port + '/mcp');
       process.once('SIGTERM', () => service.close()); await service.closed;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: scratch,
    env: { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_STATE_HOME: path.join(home, '.local/state'), AIWG_CONFIG: path.join(home, '.aiwg'),
      AIWG_ROOT: root, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_SKIP_ACTIVITY_LOG: '1',
      AIWG_PROJECT_AIWG_DIR: path.join(project, '.aiwg'), AIWG_MCP_TOOLSETS: 'all,workers',
      AIWG_HTTP_FIXTURE_TOKEN: token, NO_UPDATE_NOTIFIER: '1', CI: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', bytes => { logs += bytes; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('HTTP fixture startup timeout: ' + logs)); }, 15_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error('HTTP fixture exited: ' + logs)); });
    child.stderr.on('data', bytes => {
      logs += bytes;
      const match = /listening on 127\.0\.0\.1:(\d+)\/mcp/.exec(logs);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}/mcp`); }
    });
  }).catch(async error => { await fs.rm(scratch, { recursive: true, force: true }); throw error; });
  return { child, scratch, project, token, tokenFile, url, exited, logs: () => logs,
    async close() {
      if (child.exitCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
      await fs.rm(scratch, { recursive: true, force: true });
    },
  };
}
