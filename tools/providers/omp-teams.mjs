import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, unlink, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openSync, writeFileSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { OmpRpcClient } from './omp-transport.mjs';
import { importImpl } from '../_resolve-impl.mjs';

/** One shared admission gate across team calls; HTTP concurrency is unrelated. */
export class OmpTaskGate {
  constructor(...limits) { const values = limits.filter(v => v !== undefined); if (!values.length || values.some(v => !Number.isInteger(v) || v < 1)) throw new Error('Task limits must be positive integers'); this.limit = Math.min(...values); this.active = 0; this.queue = []; }
  acquire(signal) {
    return new Promise((resolveSlot, reject) => {
      const item = { run: () => { signal?.removeEventListener('abort', abort); this.active++; let released = false; resolveSlot(() => { if (released) return; released = true; this.active--; this.drain(); }); } };
      const abort = () => { this.queue = this.queue.filter(i => i !== item); reject(new Error('OMP queued task cancelled')); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true }); this.queue.push(item); this.drain();
    });
  }
  drain() { while (this.active < this.limit && this.queue.length) this.queue.shift().run(); }
}
const workspaceGates = new Map();
export function getOmpTaskGate(cwd, ...limits) {
  const key = resolve(cwd); const requested = new OmpTaskGate(...limits);
  const gate = workspaceGates.get(key);
  if (gate) { gate.limit = Math.min(gate.limit, requested.limit); return gate; }
  workspaceGates.set(key, requested); return requested;
}

/** Cross-process slots bound native children from concurrent AIWG team runs. */
export async function acquireOmpWorkspaceSlot(cwd, limit, signal) {
  const dir = join(cwd, '.aiwg', 'runtime', 'omp-slots');
  await mkdir(dir, { recursive: true });
  for (;;) {
    if (signal?.aborted) throw new Error('OMP queued task cancelled');
    for (let index = 0; index < limit; index++) {
      const file = join(dir, `${index}.json`);
      try {
        const fd = openSync(file, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
        let released = false;
        return async () => { if (!released) { released = true; await unlink(file).catch(() => {}); } };
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      try {
        const owner = JSON.parse(await readFile(file, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid OMP slot owner; remove stale slot explicitly');
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') throw new Error(`Stale OMP admission slot ${file}; confirm no owned worker remains, then remove it before retrying`); }
      } catch (error) {
        if (error instanceof SyntaxError) { const age = Date.now() - (await stat(file).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs; if (age > 5000) throw new Error(`Incomplete OMP admission slot ${file}; review stale ownership before retrying`); }
        else if (error.code !== 'ENOENT') throw error;
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

/**
 * Native tasks are leaf workers. Native recursive spawning is disabled because
 * OMP's per-session semaphore cannot enforce AIWG's workspace-wide ceiling.
 * Nested AIWG task requests are flattened into the same admission gate instead.
 * Ownership/read-only declarations are instructions, never a filesystem sandbox.
 */
export async function runOmpTeam({ tasks, cwd = process.cwd(), outputDir = join(cwd, '.aiwg', 'team-results'), maxParallel = 4, providerLimit = 4, signal, model, modelRoles = {}, workerTier, election, premiumAuthorized, profile, clientFactory = options => new OmpRpcClient(options) }) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('OMP team requires tasks');
  const ids = new Set();
  for (const task of tasks) {
    if (!/^[a-zA-Z0-9_-]+$/.test(task.id) || ids.has(task.id) || !task.agent || !task.prompt || !Array.isArray(task.ownership) || !Array.isArray(task.tools) || task.tools.some(t => ['task', '*'].includes(t))) throw new Error('OMP tasks require unique safe ids, agents, prompt, ownership and explicit leaf tools');
    ids.add(task.id);
  }
  for (const task of tasks) if (task.parentId && !ids.has(task.parentId)) throw new Error('Unknown OMP parent task');
  // Detect cycles while flattening parent ownership, with no held parent slots.
  for (const task of tasks) { const ancestors = new Set([task.id]); let p = task.parentId; while (p) { if (ancestors.has(p)) throw new Error('Cyclic OMP task graph'); ancestors.add(p); p = tasks.find(t => t.id === p)?.parentId; } }
  const { resolveDelegation } = await importImpl(import.meta.url, 'models/delegation.js');
  const routes = new Map();
  for (const task of tasks) {
    const pin = task.model ?? modelRoles[task.role ?? 'coding'] ?? model;
    const { record } = await resolveDelegation({ orchestrator: 'team', workerId: task.agent, assignment: task.prompt,
      provider: 'omp', cwd, role: task.role ?? 'coding', requestedTier: task.workerTier ?? workerTier,
      model: pin, election: task.election ?? election, premiumAuthorized: task.premiumAuthorized ?? premiumAuthorized });
    routes.set(task.id, record);
  }
  await mkdir(outputDir, { recursive: true });
  let workspaceLimit = 4;
  try { const config = JSON.parse(await readFile(join(cwd, '.aiwg', 'aiwg.config'), 'utf8')); workspaceLimit = config.parallelism?.max_parallel_subagents ?? 4; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const gate = getOmpTaskGate(cwd, maxParallel, providerLimit, workspaceLimit);
  const results = await Promise.all(tasks.map(async task => {
    const routing = routes.get(task.id);
    const roleModel = routing.resolved_model;
    if (!roleModel) throw new Error('Unknown OMP role; supply explicit task.model or modelRoles mapping');
    const record = { id: task.id, parentId: task.parentId ?? null, agent: task.agent, role: task.role ?? 'coding', model: roleModel, routing, ownership: task.ownership, tools: task.tools, status: 'queued', output: join(outputDir, `${task.id}.json`) };
    const inheritedSignals = [signal, task.signal];
    let ancestor = task.parentId;
    while (ancestor) { const parent = tasks.find(t => t.id === ancestor); inheritedSignals.push(parent.signal); ancestor = parent.parentId; }
    const taskSignal = AbortSignal.any(inheritedSignals.filter(Boolean));
    let release, releaseWorkspace, client, agentFile;
    try {
      release = await gate.acquire(taskSignal); releaseWorkspace = await acquireOmpWorkspaceSlot(cwd, gate.limit, taskSignal); record.status = 'running';
      // A dedicated task semaphore of one plus depth=1 makes each admission
      // exactly one native child. Reject extra native calls in the event stream.
      const nativeAgent = `aiwg-${task.id}-${randomUUID()}`;
      record.nativeAgent = nativeAgent;
      const agentsDir = join(cwd, '.omp', 'agents');
      await mkdir(agentsDir, { recursive: true });
      agentFile = join(agentsDir, `${nativeAgent}.md`);
      const frontmatter = { name: nativeAgent, description: `AIWG ${task.agent} leaf worker`, tools: task.tools, spawns: false, blocking: true, model: roleModel };
      await writeFile(agentFile, '---\n' + Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n' + (task.instructions ?? task.prompt) + '\n', { flag: 'wx' });
      const config = join(outputDir, `${nativeAgent}.config.json`);
      await writeFile(config, JSON.stringify({ tools: { xdev: false }, task: { maxConcurrency: 1, maxRecursionDepth: 1, batch: false, agentModelOverrides: { [nativeAgent]: roleModel } } }));
      const guardFile = join(outputDir, `${nativeAgent}.guard.mjs`);
      const workerInstruction = JSON.stringify({ taskId: task.id, parentId: task.parentId ?? null, ownership: task.ownership, tools: task.tools, readOnly: Boolean(task.readOnly), instruction: task.prompt, constraints: 'Do not spawn descendants. Ownership and read-only intent are instructions, not a filesystem sandbox.' });
      await writeFile(guardFile, `export default function(pi) {
        let root = false, calls = 0;
        const workerTools = ${JSON.stringify(task.tools)};
        const allowed = () => root ? ['task'] : workerTools;
        pi.on('session_start', async () => { root = pi.getActiveTools().includes('task'); await pi.setActiveTools(allowed()); });
        pi.on('before_agent_start', async () => { await pi.setActiveTools(allowed()); });
        pi.on('tool_call', event => {
          if (!allowed().includes(event.toolName)) return { block: true, reason: 'Tool outside AIWG task declaration' };
          if (root) { if (++calls > 1) return { block: true, reason: 'AIWG admits one native child per slot' };
            return { input: { agent: ${JSON.stringify(nativeAgent)}, name: ${JSON.stringify(task.id)}, task: ${JSON.stringify(workerInstruction)} } }; }
        });
      }\n`);
      record.controlArtifacts = { config, guard: guardFile, retained: true, purpose: 'Reviewable per-run controls; not auto-discovered extension installation' };
      const args = ['--no-extensions', '--extension', guardFile, '--tools', 'task', '--config', config];
      if (profile) args.push('--profile', profile);
      args.push('--model', roleModel);
      client = clientFactory({ cwd, args }); await client.connect();
      const prompt = `Execute exactly one native task tool call using agent ${JSON.stringify(nativeAgent)} and name ${JSON.stringify(task.id)}. Do not execute the work yourself. Await its completion and report its output. Worker instruction: ${JSON.stringify({ taskId: task.id, parentId: task.parentId ?? null, ownership: task.ownership, tools: task.tools, readOnly: Boolean(task.readOnly), resultReference: record.output, instruction: task.prompt, constraints: 'Do not spawn descendants. Ownership and read-only are instructions, not a filesystem sandbox.' })}`;
      const result = await client.prompt(prompt, { signal: taskSignal });
      const starts = result.events.filter(e => e.type === 'tool_execution_start' && e.toolName === 'task');
      const ends = result.events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'task');
      const nativeResults = ends[0]?.result?.details?.results;
      if (starts.length !== 1 || ends.length !== 1 || starts[0].args?.agent !== nativeAgent || ends[0].isError || !result.success || !Array.isArray(nativeResults) || nativeResults.length !== 1 || nativeResults[0].id !== task.id || nativeResults[0].exitCode !== 0 || nativeResults[0].aborted || nativeResults[0].truncated || ends[0].result.details.async?.state === 'running') throw new Error('OMP native task did not produce one verified successful worker result');
      record.status = 'completed'; record.result = ends[0].result; record.summary = result.text;
    } catch (error) { record.status = taskSignal.aborted ? 'cancelled' : 'failed'; record.error = error.message; }
    finally {
      for (const cleanup of [() => client?.close(), () => agentFile && unlink(agentFile), () => releaseWorkspace?.(), () => release?.()]) {
        try { await cleanup(); } catch (error) { record.status = taskSignal.aborted ? 'cancelled' : 'failed'; record.error = record.error ?? `OMP cleanup failed: ${error.message}`; }
      }
    }
    await writeFile(record.output, JSON.stringify(record, null, 2) + '\n'); return record;
  }));
  const manifest = { provider: 'omp', nativeTasks: true, maxParallel: gate.limit, recursion: 'flattened AIWG graph; native recursion disabled', filesystemSandbox: false, results };
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function ompTeamMain(args = process.argv.slice(2)) {
  const usage = 'Public command: aiwg team run --provider omp --body-file tasks.json [--cwd DIR] [--output-root DIR] [--max-parallel N] [--model provider/model] [--profile NAME]';
  if (args.includes('--help')) { console.log(usage); return; }
  const options = {};
  const allowed = new Set(['--body-file', '--cwd', '--output-root', '--max-parallel', '--model', '--worker-tier', '--profile']);
  for (let i = 0; i < args.length; i += 2) { if (!allowed.has(args[i]) || !args[i + 1]) throw new Error(usage); options[args[i]] = args[i + 1]; }
  if (!options['--body-file']) throw new Error(usage);
  const payload = JSON.parse(await readFile(options['--body-file'], 'utf8'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await runOmpTeam({ tasks: payload.tasks, cwd: options['--cwd'], outputDir: options['--output-root'], maxParallel: options['--max-parallel'] ? Number(options['--max-parallel']) : 4, model: options['--model'], workerTier: options['--worker-tier'], election: options['--model'] ? 'user' : undefined, premiumAuthorized: Boolean(options['--model']), profile: options['--profile'], signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    if (result.results.some(task => task.status !== 'completed')) process.exitCode = 1;
    return result;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  ompTeamMain().catch(error => { console.error(error.message); process.exitCode = 1; });
}
