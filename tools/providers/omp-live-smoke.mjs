#!/usr/bin/env node
/** Opt-in hosted smoke. Reports booleans/counts only; never serializes provider output. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmpRpcClient } from './omp-transport.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function smokeEnvironment(env, sandbox, withCredential = false) {
  const child = { PATH: env.PATH || '/usr/bin:/bin', NO_COLOR: '1', TERM: 'dumb',
    PI_CONFIG_DIR: relative(homedir(), join(sandbox, 'config-root')), PI_CODING_AGENT_DIR: join(sandbox, 'agent'), XDG_CONFIG_HOME: join(sandbox, 'config'),
    XDG_CACHE_HOME: join(sandbox, 'cache'), XDG_DATA_HOME: join(sandbox, 'data'), XDG_STATE_HOME: join(sandbox, 'state') };
  if (process.platform === 'win32' && env.SystemRoot) child.SystemRoot = env.SystemRoot;
  if (withCredential) child.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  return child;
}
export async function verifyBinary(binary, env, sandbox) {
  await mkdir(join(sandbox, 'data/omp'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, 'test/fixtures/providers/omp-conformance/manifest.json'), 'utf8'));
  const pin = manifest.release.platforms[`${process.platform}-${process.arch}`];
  if (!pin) return { binaryPinned: false, versionMatched: false };
  await access(binary, constants.X_OK);
  const hash = createHash('sha256'); for await (const bytes of createReadStream(binary)) hash.update(bytes);
  if (hash.digest('hex') !== pin.sha256) return { binaryPinned: false, versionMatched: false };
  const version = spawnSync(binary, ['--version'], { cwd: sandbox, env: smokeEnvironment(env, sandbox), encoding: 'utf8', timeout: 15000, maxBuffer: 16384, killSignal: 'SIGKILL' });
  return { binaryPinned: true, versionMatched: version.status === 0 && [manifest.release.version, `omp/${manifest.release.version}`].includes(version.stdout.trim()) };
}
export async function runLiveSmoke(options, dependencies = {}) {
  const env = options.env || process.env;
  const checks = { optedIn: env.AIWG_OMP_LIVE_SMOKE === '1', credentialPresent: Boolean(env.OPENROUTER_API_KEY?.trim()),
    modelSelected: typeof options.model === 'string' && /^openrouter\/[^\s\0]+$/.test(options.model), binaryProvided: Boolean(options.binary),
    binaryPinned: false, versionMatched: false, completion: false, context: false, readTool: false, sessionPersisted: false };
  const report = { schemaVersion: 1, mode: options.check ? 'check' : 'live', status: 'not-ready', reason: 'PREREQUISITES_MISSING', checks, promptSubmissions: 0, ...(options.check ? { modelCalls: 0 } : {}) };
  if (!options.binary || !checks.modelSelected) return report;
  if (!options.check && (!checks.optedIn || !checks.credentialPresent)) return report;
  const timeoutMs = options.timeoutMs ?? 90000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180000) { report.reason = 'INVALID_TIMEOUT'; return report; }
  let sandbox; let client; let timer;
  try {
    sandbox = await mkdtemp(join(tmpdir(), 'aiwg-omp-live-smoke-'));
    Object.assign(checks, await (dependencies.verifyBinary || verifyBinary)(resolve(options.binary), env, sandbox));
    if (!checks.binaryPinned || !checks.versionMatched) { report.reason = 'BINARY_VERIFICATION_FAILED'; return report; }
    if (options.check) { report.status = checks.optedIn && checks.credentialPresent ? 'ready' : 'not-ready'; report.reason = report.status === 'ready' ? 'PREREQUISITES_VERIFIED_NO_MODEL_CALLS' : 'PREREQUISITES_MISSING'; return report; }
    const project = join(sandbox, 'project'); const agent = join(sandbox, 'agent'); const sessions = join(sandbox, 'sessions');
    for (const dir of [project, agent, sessions, join(project, '.omp')]) await mkdir(dir, { recursive: true });
    const contextCanary = `CONTEXT_${randomUUID()}`; const fileCanary = `FILE_${randomUUID()}`;
    await writeFile(join(project, '.omp/AGENTS.md'), `The context marker for the smoke test is ${contextCanary}.\n`);
    await writeFile(join(project, 'fixture.txt'), fileCanary);
    await writeFile(join(agent, 'config.yml'), 'disabledProviders: [claude, claude-md, claude-plugins, codex, gemini, windsurf, agent-plugins, vscode, cursor, ssh-json, opencode, omp-plugins, cline, mcp-json, github, agents, agents-md]\nmarketplace:\n  autoUpdate: false\n');
    const sessionFile = join(sessions, 'smoke.jsonl');
    const factory = dependencies.clientFactory || (config => new OmpRpcClient(config));
    client = factory({ binary: resolve(options.binary), cwd: project, env: smokeEnvironment(env, sandbox, true), timeoutMs,
      eventLimit: 2 * 1024 * 1024, args: ['--model', options.model, '--tools', 'read', '--no-lsp', '--no-title', '--no-extensions', '--no-skills', '--no-rules', '--session', sessionFile] });
    const abort = new AbortController(); timer = setTimeout(() => { abort.abort(); void client?.close(); }, timeoutMs);
    await client.connect();
    report.promptSubmissions++;
    const completion = await client.prompt('Reply with exactly AIWG_OMP_COMPLETION_OK.', { signal: abort.signal });
    checks.completion = completion.success === true && completion.text.trim() === 'AIWG_OMP_COMPLETION_OK';
    if (!checks.completion) { report.status = 'failed'; report.reason = 'COMPLETION_CHECK_FAILED'; return report; }
    report.promptSubmissions++;
    const result = await client.prompt('Use the read tool to read fixture.txt. Reply with the context marker from your loaded instructions, then the file contents. Do not invent either marker.', { signal: abort.signal });
    checks.context = result.success === true && result.text.includes(contextCanary) && result.text.includes(fileCanary);
    checks.readTool = result.events.some(event => event.type === 'tool_execution_end' && event.toolName === 'read' && !event.isError);
    await client.close(); client = undefined;
    try { checks.sessionPersisted = (await readFile(sessionFile)).length > 0; } catch { checks.sessionPersisted = false; }
    report.status = checks.context && checks.readTool && checks.sessionPersisted ? 'passed' : 'failed';
    report.reason = report.status === 'passed' ? 'LIVE_CHECKS_PASSED' : 'CONTEXT_TOOL_OR_SESSION_CHECK_FAILED';
  } catch { report.status = 'failed'; report.reason = 'SMOKE_EXECUTION_FAILED'; }
  finally { clearTimeout(timer); if (client) await client.close().catch(() => {}); if (sandbox) await rm(sandbox, { recursive: true, force: true }); }
  return report;
}
export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--binary','--model','--timeout-ms','--output','--check']); const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!allowed.has(flag)) { process.stdout.write('{"status":"failed","reason":"INVALID_ARGUMENTS"}\n'); return 1; }
    if (flag === '--check') { options.check = true; continue; }
    const value = args[++index]; if (!value || value.startsWith('--')) { process.stdout.write('{"status":"failed","reason":"INVALID_ARGUMENTS"}\n'); return 1; }
    options[flag.slice(2)] = value;
  }
  const report = await runLiveSmoke({ binary: options.binary, model: options.model, check: options.check, timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : undefined });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) { const dest = resolve(options.output); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, output, { mode: 0o600 }); }
  process.stdout.write(output); return ['passed','ready'].includes(report.status) ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(() => { process.stdout.write('{"status":"failed","reason":"REPORT_WRITE_FAILED"}\n'); process.exitCode = 1; });
