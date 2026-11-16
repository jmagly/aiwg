// Stage and frame the shared final-output contract for raw shell handoffs.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { workerStdinBytes, workerStdinDocument } from './worker-stdin-frame.mjs';

export const shellWorkerPromptPath = finalPath => `${finalPath}.worker-brief`;
export const shellWorkerArtifactsRefusal = 'Raw shell rendering does not support worker artifacts; use the launcher with a JSON plan or MCP worker-invoke for workspace materialization and cleanup.';

// The renderer supplies its own installed package root, never a task module path.
async function runtime(root) {
  const loadRalphExternal = relative => import(pathToFileURL(path.join(root, 'tools/ralph-external', relative)).href);
  const { importImpl } = await import(pathToFileURL(path.join(root, 'tools/_resolve-impl.mjs')).href);
  const { inspectWorkerPath } = await importImpl(import.meta.url, 'serve/worker-invocation-paths.js');
  const { boundedPrivateRead, withWorkerPath } = await loadRalphExternal('lib/worker-inputs.mjs');
  const { workerPromptBrief } = await loadRalphExternal('lib/worker-prompt.mjs');
  return { importImpl, withWorkerPath, workerPromptBrief,
    read: (filename, limit) => boundedPrivateRead(filename, limit, inspectWorkerPath) };
}

export async function stageShellWorkerPrompt(root, briefPath, briefDigest, finalPath) {
  const api = await runtime(root);
  const brief = await api.read(briefPath, 262144);
  if (`sha256:${createHash('sha256').update(brief).digest('hex')}` !== briefDigest) {
    throw new Error('Worker prompt digest changed; resolve again');
  }
  const filename = shellWorkerPromptPath(finalPath);
  // Exclusive creation and pinned ancestors preserve existing files and symlinks.
  await api.withWorkerPath(filename, target => writeFile(target, api.workerPromptBrief(brief, finalPath), { flag: 'wx', mode: 0o600 }));
  return filename;
}

export async function frameShellWorkerPrompt(root, args) {
  const [filename, workspace, cli, adapterId, scopeDigest, briefDigest, storePath, storeDigest, policyJson, model, finalPath] = args;
  const api = await runtime(root);
  const brief = await api.read(filename, 262144);
  if (`sha256:${createHash('sha256').update(brief).digest('hex')}` !== briefDigest) throw new Error('Adapter stdin brief changed');
  const prompt = await api.read(shellWorkerPromptPath(finalPath), 1048576);
  if (!prompt.equals(api.workerPromptBrief(brief, finalPath))) throw new Error('Worker shell prompt changed');
  // Reuse the host-bound installation loader and the existing adapter framer.
  const { loadRecordedWorkerInstallations } = await api.importImpl(import.meta.url, 'models/worker-installation.mjs');
  const { loadProviderModelCapabilities } = await api.importImpl(import.meta.url, 'models/provider-policy.js');
  const { drivers } = await loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(),
    cwd: workspace, policy: JSON.parse(policyJson) ?? undefined, cli, storePath, storeDigest });
  const driver = drivers[cli];
  if (!driver || driver.qualification.adapterId !== adapterId
    || driver.qualification.adapter.invocation.stdin !== 'adapter-frame'
    || driver.qualification.installation?.evidence?.scopeDigest !== scopeDigest) throw new Error('Adapter stdin binding changed');
  return workerStdinBytes({ stdin: 'adapter-frame', selected: { model } }, prompt, driver);
}

export async function frameShellWorkerJson(root, args) {
  const [filename, briefDigest, finalPath, model, cwd] = args;
  const api = await runtime(root);
  const brief = await api.read(filename, 262144);
  if (`sha256:${createHash('sha256').update(brief).digest('hex')}` !== briefDigest) throw new Error('Worker prompt digest changed');
  const prompt = await api.read(shellWorkerPromptPath(finalPath), 1048576);
  if (!prompt.equals(api.workerPromptBrief(brief, finalPath))) throw new Error('Worker shell prompt changed');
  return workerStdinDocument({ brief: prompt, model, cwd });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, root, ...args] = process.argv.slice(2);
  try {
    if (mode === '--stage' && args.length === 3) await stageShellWorkerPrompt(root, ...args);
    else if (mode === '--refuse-artifacts' && args.length === 0) {
      const api = await runtime(root);
      const { WorkerPolicyError } = await api.importImpl(import.meta.url, 'models/provider-policy.js');
      throw new WorkerPolicyError('OG_ADAPTER_UNQUALIFIED', shellWorkerArtifactsRefusal);
    } else if (mode === '--brief-json' && args.length === 5) process.stdout.write(await frameShellWorkerJson(root, args));
    else if (mode === '--adapter-frame' && args.length === 11) process.stdout.write(await frameShellWorkerPrompt(root, args));
    else throw new Error('Invalid worker shell prompt request');
  } catch (error) {
    process.stderr.write(`Worker shell prompt refused: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  }
}
