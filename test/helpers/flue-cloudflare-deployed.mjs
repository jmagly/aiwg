// Own the explicitly authorized disposable Worker, tunnel, D9 service and result journal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchHttp } from '../fixtures/mcp/http-service.mjs';
import { buildCloudflare, cloudflareVersions, prepareCloudflare, verifyCloudflareDependencies } from './flue-cloudflare.mjs';
import { createRedactor, processRunner, requireDeployedOptIn, startTunnel, workerName } from './flue-cloudflare-deployed-process.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const aiwgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function deployedCheck({ env = process.env, prepare = prepareCloudflare, serve = launchHttp,
  build = buildCloudflare, verify = verifyCloudflareDependencies, request = fetch, log = console.info, signals = process } = {}) {
  // Gate before creating directories, starting children, or looking up dependencies.
  requireDeployedOptIn(env);
  const name = workerName();
  const redact = createRedactor([env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, 'synthetic-wrong-token']);
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-cf-results-'));
  const resultsPath = path.join(resultsDir, 'results.json');
  const results = { worker: name, startedAt: new Date().toISOString(), restart: 'Redeploy the same built script under the same Worker name; no remote workerd process restart is available.',
    versions: { node: process.version, aiwg: aiwgVersion, '@aiwg/flue': aiwgVersion, ...cloudflareVersions }, cases: [], teardown: {} };
  let app, service, tunnel, runner, wrangler, config, attemptedDeploy = false, closing, starting, interrupted = false;
  const active = () => { if (interrupted) throw new Error('Deployed check interrupted'); };
  function write() { fs.writeFileSync(resultsPath, redact(JSON.stringify(results, null, 2)) + '\n', { mode: 0o600 }); }
  function record(caseName, status, durationMs, error) {
    const entry = { name: caseName, status, durationMs, ...(error ? { error: redact(String(error)) } : {}) };
    const index = results.cases.findIndex(item => item.name === caseName);
    if (index < 0) results.cases.push(entry); else results.cases[index] = entry;
    write();
  }
  async function command(args, options) {
    return runner.run(process.execPath, [wrangler, ...args], options);
  }
  async function ready(origin) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      active();
      try {
        const response = await request(`${origin}/agents/assistant/readiness`, { signal: AbortSignal.timeout(5000) });
        if (response.ok) return;
      } catch { /* Bounded propagation wait after upload or secret rotation. */ }
      await delay(500);
    }
    throw new Error('workers.dev readiness timeout (60s)');
  }
  async function deploy() {
    active();
    attemptedDeploy = true; // Even an upload that fails can leave a Worker behind.
    const output = await command(['deploy', '--config', config, '--name', name]);
    const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev(?=[\s/]|$)/i.exec(output)?.[0];
    if (!origin || new URL(origin).hostname.split('.')[0] !== name) throw new Error(`Expected unique Worker workers.dev URL in deploy output:\n${output}`);
    return origin;
  }
  async function secret(key, value) {
    active();
    redact.add(value);
    await command(['secret', 'put', key, '--config', config, '--name', name], { input: value + '\n' });
  }
  async function start() {
    try {
      const dependencyProject = env.AIWG_FLUE_CF_DEPENDENCIES || path.join(root, 'examples/flue-cloudflare');
      verify(dependencyProject);
      app = await prepare(dependencyProject); active();
      service = await serve();
      redact.add(service.token); active();
      const artifact = path.join(service.project, '.aiwg/reviews/cloudflare.md');
      const commandEnv = { ...app.env, PATH: env.PATH, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true' };
      runner = processRunner({ cwd: app.project, env: commandEnv, redact });
      const cloudflared = env.AIWG_CLOUDFLARED || 'cloudflared';
      results.versions.cloudflared = (await runner.run(cloudflared, ['--version'])).trim(); active();
      tunnel = await startTunnel(runner, cloudflared, service.url);
      redact.add(tunnel.url); redact.add(new URL(tunnel.url).origin); active();
      // Only non-secret scripted-model inputs go in the temporary build config.
      const sourceConfig = path.join(app.project, 'wrangler.jsonc');
      const authored = JSON.parse(fs.readFileSync(sourceConfig, 'utf8'));
      fs.writeFileSync(sourceConfig, JSON.stringify({ ...authored, name, workers_dev: true,
        vars: { FLUE_MODEL: 'aiwg-cf-test/scripted', AIWG_EXPECTED_ARTIFACT: artifact } }, null, 2));
      const built = await build(app); active();
      // Vite writes its deploy redirect to the built Worker config (including DO bindings).
      const redirectFile = path.join(app.project, '.wrangler/deploy/config.json');
      const redirect = JSON.parse(fs.readFileSync(redirectFile, 'utf8'));
      config = path.resolve(path.dirname(redirectFile), redirect.configPath);
      wrangler = path.join(app.project, 'node_modules/wrangler/bin/wrangler.js');
      let origin = await deploy();
      await secret('AIWG_MCP_URL', tunnel.url);
      await secret('AIWG_MCP_TOKEN', service.token);
      await ready(origin);
      return { app, service, artifact, ...built, origin, redact, record,
        failureDetails: snapshot => redact(JSON.stringify(snapshot)),
        async restart() { origin = await deploy(); await ready(origin); },
        async setToken(token) { await secret('AIWG_MCP_TOKEN', token); await ready(origin); },
      };
    } catch (error) {
      results.error = redact(String(error));
      try { throw new Error(results.error); } finally { await close(); }
    }
  }
  function close() {
    if (closing) return closing;
    closing = (async () => {
      const summary = results.teardown;
      async function cleanup(key, action) {
        try { await action(); summary[key] = 'ok'; }
        catch (error) { summary[key] = redact(String(error)); }
      }
      try {
        if (attemptedDeploy) await cleanup('worker', async () => {
          try { await command(['delete', name, '--force'], { timeout: 90_000 }); }
          catch (error) {
            // Use the original, provisioned example's CLI: the temporary copy is removed below.
            const executable = path.resolve(env.AIWG_FLUE_CF_DEPENDENCIES || path.join(root, 'examples/flue-cloudflare'), 'node_modules/wrangler/bin/wrangler.js');
            summary.manualCleanup = `${quote(process.execPath)} ${quote(executable)} delete ${name} --force`;
            log(`Manual cleanup (with the same CLOUDFLARE_* environment): ${summary.manualCleanup}`);
            throw error;
          }
        });
        else summary.worker = 'not attempted';
      } finally {
        await cleanup('tunnel', async () => { try { await tunnel?.stop(); } finally { await runner?.stopAll(); } });
        await cleanup('server', async () => { await service?.close(); });
        await cleanup('app', async () => { await app?.close(); });
        for (const entry of results.cases) if (entry.status === 'pending') {
          Object.assign(entry, { status: 'fail', error: 'Case did not complete: setup failed or run interrupted.' });
        }
        results.finishedAt = new Date().toISOString();
        signals.removeListener('SIGINT', onInt);
        signals.removeListener('SIGTERM', onTerm);
        write();
        log(redact(`Teardown: ${JSON.stringify(summary)}\nResults JSON (retained): ${resultsPath}`));
      }
      if (Object.entries(summary).some(([key, value]) => key !== 'manualCleanup' && !['ok', 'not attempted'].includes(value))) {
        throw new Error('Deployed teardown failed; see teardown summary and results JSON.');
      }
    })();
    return closing;
  }
  async function signal(code) {
    if (interrupted) return;
    interrupted = true;
    if (!closing) await runner?.stopAll();
    try { await starting; } catch { /* start owns failure cleanup */ }
    try { await close(); } finally { process.exit(code); }
  }
  const onInt = () => { void signal(130); };
  const onTerm = () => { void signal(143); };
  signals.on('SIGINT', onInt);
  signals.on('SIGTERM', onTerm);
  write();
  log(`Results JSON: ${resultsPath}`);
  return { name, resultsPath, results, redact, record, close, start() { return starting ??= start(); } };
}
