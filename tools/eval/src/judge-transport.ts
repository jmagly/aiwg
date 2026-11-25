// Resolve CLI invocations verbatim and capture optional OpenRouter responses without credentials.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { observeCli } from './judge-cli-observation.js';
import type { CollectOptions, JudgeConfiguration, Observation } from './judge-types.js';

async function execute(file: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ stdout, stderr, code }));
  });
}
const unavailable = (): Observation => ({ raw: '', content: '', flags: [], tokens: 'unknown', cost: 'unknown',
  observed_model: 'unknown', observed_vendor: 'unknown', observed_family: 'unknown', revision: 'unknown', settings: {} });
export function httpPayload(config: JudgeConfiguration, prompt: string) {
  return { model: config.model, messages: [{ role: 'user', content: prompt }], temperature: 0,
    max_tokens: config.max_tokens, stream: false, usage: { include: true } };
}
export async function invokeJudge(config: JudgeConfiguration, prompt: string, attemptDir: string, options: CollectOptions): Promise<Observation> {
  const observation = unavailable();
  await writeFile(path.join(attemptDir, 'brief.txt'), prompt);
  if (config.transport === 'cli') {
    const brief = path.join(attemptDir, 'brief.txt'), final = path.join(attemptDir, 'final.json');
    const workdir = path.join(attemptDir, 'workspace');
    await mkdir(workdir, { recursive: true }); await writeFile(brief, prompt);
    const resolver = options.resolver ?? { file: 'aiwg', args: [] };
    const args = [...resolver.args, 'models', 'resolve', '--role', config.role!, '--task', 'review', '--group', config.group!,
      '--brief', brief, '--workdir', workdir, '--final-output', final, '--transport', 'shell', '--format', 'shell'];
    const rendered = await execute(resolver.file, args, workdir);
    await writeFile(path.join(attemptDir, 'resolver.stdout'), rendered.stdout);
    await writeFile(path.join(attemptDir, 'resolver.stderr'), rendered.stderr);
    observation.settings = { transport: 'cli', group: config.group, role: config.role, task: 'review',
      resolver: { file: resolver.file, args }, command: rendered.stdout, defaults: 'unknown' };
    if (rendered.code !== 0 || !rendered.stdout.trim()) {
      observation.status = 'provider-error'; observation.raw = JSON.stringify(rendered); observation.flags.push('resolver-error'); return observation;
    }
    // Pass exactly the resolver stdout as the shell program, including its final newline.
    const result = await execute('/bin/sh', ['-c', rendered.stdout], workdir);
    await writeFile(path.join(attemptDir, 'stdout'), result.stdout);
    await writeFile(path.join(attemptDir, 'stderr'), result.stderr);
    let finalText = ''; try { finalText = await readFile(final, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    observation.raw = JSON.stringify({ ...result, final: finalText }); observation.content = finalText;
    if (result.code !== 0) { observation.status = 'provider-error'; observation.flags.push('nonzero-exit'); }
    else if (!finalText) observation.status = 'missing';
    await observeCli(config, result.stdout, observation);
    return observation;
  }
  const endpoint = options.httpEndpoint ?? 'https://openrouter.ai/api/v1/chat/completions';
  if (options.httpEndpoint && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(endpoint)) throw new Error('HTTP fixture override must be loopback');
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is required');
  const payload = httpPayload(config, prompt);
  observation.settings = { transport: 'openrouter', endpoint, payload, defaults: 'unknown', max_call_usd: config.max_call_usd };
  let httpFailed = false;
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) });
    httpFailed = !response.ok;
    // Retain received bytes even if the provider disconnects partway through a body.
    const reader = response.body?.getReader(), decoder = new TextDecoder();
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      observation.raw += decoder.decode(chunk.value, { stream: true });
    }
    observation.raw += decoder.decode();
    // Redact even an error server that echoes the authorization value.
    observation.raw = observation.raw.split(key).join('[REDACTED]');
    if (!response.ok) { observation.status = 'provider-error'; observation.flags.push(`http-${response.status}`); return observation; }
    if (!observation.raw) { observation.status = 'missing'; return observation; }
    let body: any;
    try { body = JSON.parse(observation.raw); } catch { observation.status = 'partial'; return observation; }
    if (body.error) { observation.status = 'provider-error'; observation.flags.push('provider-error-event'); return observation; }
    const choice = body.choices?.[0];
    observation.content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    observation.observed_model = typeof body.model === 'string' && body.model ? body.model : 'unknown';
    if (Number.isInteger(body.usage?.total_tokens) && body.usage.total_tokens >= 0) observation.tokens = body.usage.total_tokens;
    if (typeof body.usage?.cost === 'number' && Number.isFinite(body.usage.cost) && body.usage.cost >= 0) observation.cost = body.usage.cost;
    if (!observation.content) observation.status = 'missing';
    else if (choice.finish_reason !== 'stop') { observation.status = 'partial'; observation.flags.push('incomplete-finish'); }
  } catch { observation.status = observation.raw && !httpFailed ? 'partial' : 'provider-error'; observation.flags.push('http-transport-error'); }
  finally { observation.raw = observation.raw.split(key).join('[REDACTED]'); }
  return observation;
}
