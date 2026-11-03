// Run synthetic project deployments in independent processes sharing a fake HOME.
import path from 'node:path';
import { main as deploy } from '../../../tools/agents/deploy-agents.mjs';
import { prepareProviderDeployments } from '../../../tools/agents/providers/provider-prepare-coordinator.mjs';

const [mode, source, target] = process.argv.slice(2);
const providers = mode === 'prepared' ? ['codex', 'hermes', 'claude'] : ['muse', 'codex', 'hermes', 'claude'];
const jobs = providers.map((provider, order) => ({ order, provider, target: path.resolve(target),
  args: ['--source', source, '--target', target, '--provider', provider, '--mode', 'all',
    '--deploy-skills', '--deploy-commands', '--deploy-rules', '--skip-commands-migration', '--quiet',
    ...(mode === 'deferred' ? ['--kernel-only', '--defer-rule-projection'] : [])] }));
process.send({ ready: true });
process.once('message', async () => {
  let session;
  try {
    if (mode === 'prepared') session = await prepareProviderDeployments({ srcRoot: source, jobs });
    const run = async () => {
      for (const job of jobs) {
        if (session) await session.commit(job.order);
        const code = await deploy(job.args, session ? { finalizeOnly: true } : {});
        if (code) throw new Error(`${job.provider} deployment exited ${code}`);
      }
    };
    if (session) await session.run(run); else await run();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await session?.dispose();
    process.disconnect();
  }
});
