// Bind Muse catalog refresh to the configured CLI runtime and account label.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMuseCatalogModels, runModelDiscoveryCommand,
  type ModelDiscoveryOptions, type ProviderModelDiscovery } from './model-discovery.js';
import { loadProviderModelCapabilities } from './provider-policy.js';
import { normalizeWorkerVersionBanner, workerVersionProbeEnvironment } from './worker-installation.mjs';

export async function discoverProjectMuseModels(options: ModelDiscoveryOptions): Promise<ProviderModelDiscovery> {
  const clis = Object.entries(options.parallelism?.clis ?? {}).filter(([id, cli]) =>
    cli.enabled !== false && !cli.localModels && (cli.adapter ?? `providers:${id}`) === 'providers:muse');
  const cli = clis.length === 1 ? clis[0][1] : undefined;
  let version = options.muse?.runtimeVersion;
  if (!version) {
    try {
      const probe = await (options.runner ?? runModelDiscoveryCommand)(cli?.executable ?? 'muse', ['--version'],
        { cwd: tmpdir(), timeoutMs: 5000, env: workerVersionProbeEnvironment() });
      if (probe.exitCode === 0) {
        const provider = loadProviderModelCapabilities().providers.muse!;
        const invocation = (provider.workerAdapter ?? provider.workerHealthAdapter)!.invocation;
        if (invocation.kind === 'process') version = normalizeWorkerVersionBanner(probe.stdout.trim(), invocation.versionPattern, 'muse');
      }
    } catch { /* Missing or malformed runtime evidence remains unknown. */ }
  }
  return discoverMuseCatalogModels({ ...options.muse,
    catalogDir: options.muse?.catalogDir ?? join(options.homeDir ?? homedir(), '.local/share/muse/model-catalog'),
    runtimeVersion: version, accountBinding: options.muse?.accountBinding ?? cli?.accountScope, now: options.now });
}
