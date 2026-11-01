// Own the explicitly authorized disposable Worker, tunnel, D9 service and result journal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchHttp } from '../fixtures/mcp/http-service.mjs';
import { buildCloudflare, cloudflareVersions, prepareCloudflare, verifyCloudflareDependencies } from './flue-cloudflare.mjs';
import { randomBytes } from 'node:crypto';
import { createRedactor, processRunner, requireDeployedOptIn, startTunnel, tailEvents, tailObjects, tunnelUrl, workerName } from './flue-cloudflare-deployed-process.mjs';

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
  let app, service, tunnel, runner, wrangler, config, tail, attemptedDeploy = false, closing, starting, interrupted = false;
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
    // An unused conversation id has no stream, so Flue answers 404 with JSON.
    // Any Flue JSON answer proves the Worker serves; edge HTML pages do not.
    const deadline = Date.now() + 180_000;
    let last = 'no response';
    while (Date.now() < deadline) {
      active();
      try {
        const response = await request(`${origin}/agents/assistant/readiness`, { signal: AbortSignal.timeout(5000) });
        const type = response.headers?.get?.('content-type') || '';
        if (response.ok || (response.status < 500 && type.includes('json'))) return;
        last = `HTTP ${response.status} ${type || 'no content-type'}`;
      } catch (error) { last = String(error?.cause?.code || error?.name || error); }
      await delay(1000);
    }
    throw new Error(`workers.dev readiness timeout (180s); last: ${redact(last)}`);
  }
  // Secret rotation creates a version that reaches the edge gradually, and live Durable
  // Objects may keep the previous one. Probe fresh object ids until three in a row are
  // served by the deployment's 100% version.
  async function servingVersion(origin) {
    const status = JSON.parse(await command(['deployments', 'status', '--json', '--name', name, '--config', config]));
    const version = status.versions?.find(entry => entry.percentage === 100)?.version_id;
    if (!version) throw new Error('No single active Worker version after rotation');
    const deadline = Date.now() + 180_000;
    let streak = 0, last = 'none';
    while (Date.now() < deadline) {
      active();
      const id = `version-${randomBytes(6).toString('hex')}`;
      try { await request(`${origin}/agents/assistant/${id}`, { signal: AbortSignal.timeout(5000) }); } catch { /* counted as a miss */ }
      await delay(1500);
      const served = tailEvents(tail?.output() || '').filter(event => event.url.includes(`/${id}`)).map(event => event.version);
      if (served.length && served.every(value => value === version)) { if (++streak === 3) return version; }
      else { streak = 0; last = served.length ? served.join(',') : 'no tail event'; }
    }
    throw new Error(`Worker version ${version} not serving after 180s; last: ${last}`);
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
      // Worker logs explain internal errors; saved redacted beside results.json.
      tail = runner.start(process.execPath, [wrangler, 'tail', name, '--format', 'json', '--config', config]);
      await ready(origin);
      return { app, service, artifact, ...built, origin, redact, record,
        // Deployed settlements carry only a generic internal_error; the cause is in
        // the Worker log for the same submission id, so wait briefly for tail lag.
        async failureDetails(snapshot) {
          const ids = (snapshot?.settlements || []).map(entry => entry.submissionId).filter(Boolean);
          const deadline = Date.now() + 60_000;
          let lines = [];
          while (Date.now() < deadline) {
            lines = tailObjects(tail?.output() || '').map(entry => entry.raw).filter(raw => ids.some(id => raw.includes(id)));
            if (lines.some(raw => /SdkHttpError|"level": *"error"/i.test(raw))) break;
            await delay(500);
          }
          return redact(`${JSON.stringify(snapshot)}\n${lines.join('\n')}`);
        },
        async restart() { origin = await deploy(); await ready(origin); },
        async setToken(token) { await secret('AIWG_MCP_TOKEN', token); await ready(origin); await servingVersion(origin); },
      };
    } catch (error) {
      // A tunnel that failed after printing its URL leaves that URL in the error text.
      const leaked = tunnelUrl(String(error));
      if (leaked) redact.add(leaked);
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
        if (tail) fs.writeFileSync(path.join(resultsDir, 'worker-tail.jsonl'), redact(tail.output()) + '\n', { mode: 0o600 });
      } catch (error) { summary.tail = redact(String(error)); }
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
