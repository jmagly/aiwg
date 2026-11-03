import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ProviderPreparationJob {
  order: number;
  provider: string;
  target: string;
  args: string[];
}

export interface ProviderPreparationSession {
  run<T>(work: () => Promise<T>): Promise<T>;
  commit(index: number): Promise<unknown>;
  dispose(): Promise<void>;
}

export async function prepareProviderDeployments(
  frameworkRoot: string,
  jobs: ProviderPreparationJob[],
): Promise<ProviderPreparationSession> {
  const deployerUrl = pathToFileURL(path.join(frameworkRoot, 'tools', 'agents', 'deploy-agents.mjs')).href;
  const deployer = await import(deployerUrl) as {
    main(args: string[], internal: { preflightOnly: true }): Promise<void>;
  };
  // Commands-to-skills migration is interactive and changes provider inputs.
  // Run it serially in the coordinator before the shared snapshot is created;
  // finalization then only applies post-deploy mirrors/pruning/config writes.
  for (const job of jobs) await deployer.main(job.args, { preflightOnly: true });
  const url = pathToFileURL(path.join(frameworkRoot, 'tools', 'agents', 'providers', 'provider-prepare-coordinator.mjs')).href;
  const coordinator = await import(url) as {
    prepareProviderDeployments(options: unknown): Promise<ProviderPreparationSession>;
  };
  const sourceIndex = jobs[0]?.args.findIndex(arg => arg === '--source') ?? -1;
  const srcRoot = sourceIndex >= 0 && jobs[0]?.args[sourceIndex + 1]
    ? path.resolve(jobs[0].args[sourceIndex + 1])
    : frameworkRoot;
  return coordinator.prepareProviderDeployments({ srcRoot, jobs, maxConcurrency: 2 });
}

export async function finalizePreparedProvider(frameworkRoot: string, args: string[]): Promise<void> {
  const url = pathToFileURL(path.join(frameworkRoot, 'tools', 'agents', 'deploy-agents.mjs')).href;
  const deployer = await import(url) as {
    main(args: string[], internal: { finalizeOnly: true }): Promise<void>;
  };
  await deployer.main(args, { finalizeOnly: true });
}
