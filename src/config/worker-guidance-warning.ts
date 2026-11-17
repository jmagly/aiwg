// Reports guidance refresh steps after direct parallelism edits.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeProviderDefinitionId } from '../providers/provider-definitions.js';
import type { AiwgConfig } from './aiwg-config.js';
export function warnStaleParallelism(cfg: AiwgConfig, projectDir: string, key: string, before: unknown): void {
  if (key !== 'parallelism' && !key.startsWith('parallelism.')) return;
  if (isDeepStrictEqual(before, getDottedPath(cfg as unknown as Record<string, unknown>, key))) return;
  const configured = (cfg.providers ?? []).map(normalizeProviderDefinitionId).filter((id): id is NonNullable<typeof id> => !!id);
  const recorded = Object.values(cfg.installed ?? {}).flatMap(entry => Object.keys(entry.deployedTo ?? {}))
    .map(normalizeProviderDefinitionId).filter((id): id is NonNullable<typeof id> => !!id).sort();
  const providers = [...new Set([...configured, ...recorded])];
  const targets = providers.length ? providers : ['<provider>'];
  const lines = [
    `WARNING: ${key} changed project configuration; generated workspace/provider guidance may now be stale.`,
    `From project root ${path.resolve(projectDir)}, preview and refresh every configured or recorded provider context:`,
    ...targets.flatMap(provider => [
      `  aiwg regenerate --workspace --provider ${provider} --dry-run`,
      `  aiwg regenerate --workspace --provider ${provider}`,
    ]),
    '  aiwg workspace-context doctor',
    ...(qualificationInputsChanged(cfg, key, before)
      ? ['Worker routing or qualification inputs changed; recheck approval after fixing wiring:', '  aiwg doctor --probe-workers --qualify'] : []),
    `Shared parallelism defaults and labels use primary provider '${cfg.providers?.[0] ?? 'unknown'}' (providers[0]); --provider selects the adapter/context target.`,
  ];
  console.error(lines.join('\n'));
}

function getDottedPath(value: any, key: string): unknown { return key.split('.').reduce((node, part) => node?.[part], value); }

function qualificationInputsChanged(cfg: AiwgConfig, key: string, before: unknown): boolean {
  const fields = ['clis', 'groups', 'groupTemplates', 'worker_dispatch', 'worker_mode'] as const;
  if (key === 'parallelism') return fields.some(field =>
    !isDeepStrictEqual((before as AiwgConfig['parallelism'])?.[field], cfg.parallelism?.[field]));
  return fields.some(field => key === `parallelism.${field}` || key.startsWith(`parallelism.${field}.`));
}
