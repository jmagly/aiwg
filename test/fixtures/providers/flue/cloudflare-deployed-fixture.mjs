// Supply isolated fake lifecycle resources while exercising real subprocess supervision.
import fs from 'node:fs';
import path from 'node:path';
export function fakeDeployedOptions(scratch, mode = 'deploy-fail') {
  const appRoot = path.join(scratch, 'app');
  const serverRoot = path.join(scratch, 'server');
  const trace = path.join(scratch, 'trace');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(import.meta.dirname, 'cloudflare-cli.mjs');
  fs.copyFileSync(cli, path.join(bin, 'cloudflared'));
  fs.chmodSync(path.join(bin, 'cloudflared'), 0o755);
  const env = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    AIWG_FLUE_CF_DEPLOY: '1', CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-api-token',
    CLOUDFLARE_ACCOUNT_ID: 'synthetic-cloudflare-account-id', AIWG_FLUE_CF_DEPENDENCIES: appRoot };
  const childEnv = { PATH: env.PATH, HOME: path.join(scratch, 'home'), NO_UPDATE_NOTIFIER: '1',
    FAKE_CF_TRACE: trace, FAKE_CF_MODE: mode, WRANGLER_SEND_METRICS: 'false' };
  const stopped = value => fs.appendFileSync(trace, value + '\n');
  return { env, verify() {}, request: async () => ({ ok: true }),
    async prepare() {
      fs.mkdirSync(path.join(appRoot, 'node_modules/wrangler/bin'), { recursive: true });
      fs.copyFileSync(cli, path.join(appRoot, 'node_modules/wrangler/bin/wrangler.js'));
      fs.writeFileSync(path.join(appRoot, 'package.json'), '{"type":"module"}');
      fs.writeFileSync(path.join(appRoot, 'wrangler.jsonc'), '{"name":"checked-in-example"}');
      return { project: appRoot, env: childEnv, async close() {
        stopped('app removed'); fs.rmSync(appRoot, { recursive: true, force: true });
      } };
    },
    async serve() {
      fs.mkdirSync(serverRoot);
      return { project: serverRoot, token: 'synthetic-mcp-token', url: 'http://127.0.0.1:12345/mcp', async close() {
        stopped('server stopped'); fs.rmSync(serverRoot, { recursive: true, force: true });
      } };
    },
    async build() {
      const dir = path.join(appRoot, '.wrangler/deploy');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), '{"configPath":"../../wrangler.jsonc"}');
      return { buildLog: 'built in 1ms', buildMs: 1 };
    },
  };
}
