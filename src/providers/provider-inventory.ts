import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { resolveActiveProvider } from '../cli/provider-resolution.js';
import {
  listProviderDefinitions,
  normalizeProviderDefinitionId,
  resolveProviderPathValue,
} from './provider-definitions.js';
import type { Platform } from '../agents/types.js';

const PROVIDER_EXECUTABLES: Partial<Record<Platform, string[]>> = {
  antigravity: ['agy'],
  claude: ['claude'],
  codex: ['codex'],
  copilot: ['github-copilot-cli', 'copilot'],
  cursor: ['cursor'],
  'deepseek-harness': ['dsh'],
  factory: ['droid'],
  // Grok Bot has no verified CLI executable name; omit rather than invent.
  // Muse Code's documented CLI binary is `muse`; the bare process name is
  // deliberately NOT a detection signal (fail-closed per ADR).
  'grok-build': ['grok'],
  muse: ['muse'],
  hermes: ['hermes'],
  opencode: ['opencode'],
  openclaw: ['openclaw'],
  openhuman: ['openhuman'],
  pi: ['pi'],
  omp: ['omp'],
  warp: ['warp'],
  windsurf: ['windsurf'],
};

export type ProviderEvidenceKind =
  | 'project-config'
  | 'user-config'
  | 'deployment-record'
  | 'runtime-env'
  | 'process'
  | 'executable'
  | 'provider-config';

export interface ProviderEvidence {
  kind: ProviderEvidenceKind;
  scope: 'project' | 'user' | 'runtime';
  value: string;
}

export interface ProviderInventoryEntry {
  id: Platform;
  displayName: string;
  configured: boolean;
  deployed: boolean;
  detected: boolean;
  available: boolean;
  active: boolean;
  evidence: ProviderEvidence[];
  reasons: string[];
}

export interface ProviderInventory {
  generatedAt: string;
  projectDir: string;
  providers: ProviderInventoryEntry[];
  activeProvider: Platform | null;
  activeSource: string;
}

export interface ProviderInventoryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pathExists?: (filePath: string) => Promise<boolean>;
  findExecutable?: (names: string[], env: NodeJS.ProcessEnv) => Promise<string | null>;
  detectProcess?: boolean;
  now?: () => Date;
}

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultFindExecutable(
  names: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of names) {
    if (isAbsolute(name) && await defaultPathExists(name)) return name;
    for (const dir of pathDirs) {
      const candidate = join(dir, name);
      if (await defaultPathExists(candidate)) return candidate;
    }
  }
  return null;
}

async function readConfigProviders(
  projectDir: string,
  userDir: string,
): Promise<{
  project: Set<Platform>;
  user: Set<Platform>;
  deployed: Map<Platform, string[]>;
}> {
  const project = new Set<Platform>();
  const user = new Set<Platform>();
  const deployed = new Map<Platform, string[]>();
  const collect = async (dir: string, target: Set<Platform>, scope: string) => {
    try {
      const config = await readAiwgConfig(dir);
      for (const raw of config?.providers ?? []) {
        const provider = normalizeProviderDefinitionId(raw);
        if (provider) target.add(provider);
      }
      for (const [bundle, entry] of Object.entries(config?.installed ?? {})) {
        for (const raw of Object.keys(entry.deployedTo ?? {})) {
          const provider = normalizeProviderDefinitionId(raw);
          if (!provider) continue;
          const values = deployed.get(provider) ?? [];
          values.push(`${scope}:${bundle}`);
          deployed.set(provider, values);
        }
      }
    } catch {
      // Missing or malformed config contributes no evidence.
    }
  };
  await collect(projectDir, project, 'project');
  await collect(userDir, user, 'user');
  return { project, user, deployed };
}

export async function collectProviderInventory(
  projectDir: string,
  options: ProviderInventoryOptions = {},
): Promise<ProviderInventory> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const pathExists = options.pathExists ?? defaultPathExists;
  const findExecutable = options.findExecutable ?? defaultFindExecutable;
  const configs = await readConfigProviders(projectDir, homeDir);
  const active = await resolveActiveProvider({
    cwd: projectDir,
    env,
    detectProcess: options.detectProcess ?? true,
  });
  const providers: ProviderInventoryEntry[] = [];

  for (const definition of listProviderDefinitions()) {
    if (definition.id === 'generic') continue;
    const evidence: ProviderEvidence[] = [];
    if (configs.project.has(definition.id)) {
      evidence.push({ kind: 'project-config', scope: 'project', value: '.aiwg/aiwg.config' });
    }
    if (configs.user.has(definition.id)) {
      evidence.push({ kind: 'user-config', scope: 'user', value: '~/.aiwg/aiwg.config' });
    }
    for (const deployment of configs.deployed.get(definition.id) ?? []) {
      evidence.push({ kind: 'deployment-record', scope: deployment.startsWith('user:') ? 'user' : 'project', value: deployment });
    }
    for (const marker of definition.detection.env) {
      if (env[marker]) evidence.push({ kind: 'runtime-env', scope: 'runtime', value: marker });
    }
    if (active.source === 'process' && active.provider === definition.id) {
      evidence.push({ kind: 'process', scope: 'runtime', value: active.reason });
    }
    if (
      (active.source === 'env' || active.source === 'runtime-env') &&
      active.provider === definition.id
    ) {
      evidence.push({
        kind: 'runtime-env',
        scope: 'runtime',
        value: active.source === 'env' ? 'AIWG_PROVIDER/CLAUDECODE_PROVIDER' : active.reason,
      });
    }
    const executable = await findExecutable(PROVIDER_EXECUTABLES[definition.id] ?? [], env);
    if (executable) {
      let value = executable;
      try {
        value = `${executable}@${(await stat(executable)).mtimeMs}`;
      } catch {
        // A custom detector may return a synthetic path; the path remains useful evidence.
      }
      evidence.push({ kind: 'executable', scope: 'runtime', value });
    }

    const providerSpecificConfig = definition.paths.configFile
      && !['AGENTS.md', 'README.md'].includes(definition.paths.configFile);
    const configPath = providerSpecificConfig
      ? resolveProviderPathValue(
        definition.paths.configFile!.replace(/^~(?=\/|$)/, homeDir),
        projectDir,
      )
      : '';
    if (configPath && await pathExists(resolve(configPath))) {
      evidence.push({ kind: 'provider-config', scope: configPath.startsWith(homeDir) ? 'user' : 'project', value: configPath });
    }

    const configured = evidence.some(item => item.kind === 'project-config' || item.kind === 'user-config');
    const deployed = evidence.some(item => item.kind === 'deployment-record');
    const detected = evidence.some(item =>
      item.kind === 'runtime-env' ||
      item.kind === 'process' ||
      item.kind === 'executable' ||
      item.kind === 'provider-config'
    );
    const available = evidence.some(item =>
      item.kind === 'runtime-env' ||
      item.kind === 'process' ||
      item.kind === 'executable'
    );
    const reasons = available
      ? []
      : [
        `No runtime marker or provider executable (${(PROVIDER_EXECUTABLES[definition.id] ?? []).join(', ') || 'none'}) was detected.`,
        configured
          ? 'The provider is configured but configuration alone does not prove it is installed.'
          : 'Configure or install the provider, then rerun `aiwg runtime-info --providers`.',
      ];

    providers.push({
      id: definition.id,
      displayName: definition.displayName,
      configured,
      deployed,
      detected,
      available,
      active: active.provider === definition.id,
      evidence,
      reasons,
    });
  }

  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    projectDir: resolve(projectDir),
    providers,
    activeProvider: active.provider,
    activeSource: active.source,
  };
}
