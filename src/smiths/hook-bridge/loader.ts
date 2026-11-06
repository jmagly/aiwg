/**
 * Canonical hook source loader.
 *
 * Reads HookSource YAML/JSON files from a known directory layout. Per the
 * orchestrator wiring in `src/cli/handlers/use.ts`, the operator opts in to
 * cross-provider hook translation via `--enable-cross-provider-hooks`; when
 * the flag is set, this loader gathers the canonical source files and the
 * `bridgeAll()` API translates them.
 *
 * Source location convention: `agentic/code/addons/aiwg-hooks/canonical/*.yaml`
 * Each file declares one HookSource per the schema in `types.ts`.
 *
 * The loader is forgiving: missing directory yields an empty source list
 * (not an error) so operators can opt in to the flag without authoring
 * any sources first.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { HookSource, HookEvent } from './types.js';

const VALID_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
]);

/**
 * Validate and normalize a parsed HookSource. Returns null if the input
 * doesn't satisfy the minimal schema. Caller logs the rejection.
 */
function normalize(input: unknown, filePath: string): { source: HookSource | null; error?: string } {
  if (!input || typeof input !== 'object') {
    return { source: null, error: `${filePath}: not an object` };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) {
    return { source: null, error: `${filePath}: missing or non-string \`id\`` };
  }
  if (typeof o.command !== 'string' || !o.command) {
    return { source: null, error: `${filePath}: missing or non-string \`command\`` };
  }
  const events = Array.isArray(o.events) ? o.events.filter((e): e is HookEvent => typeof e === 'string' && VALID_EVENTS.has(e as HookEvent)) : [];
  if (events.length === 0) {
    return { source: null, error: `${filePath}: \`events\` must be a non-empty array of valid event names` };
  }

  const source: HookSource = {
    id: o.id,
    description: typeof o.description === 'string' ? o.description : '',
    events,
    command: o.command,
    args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : undefined,
    timeout: typeof o.timeout === 'number' && Number.isFinite(o.timeout) && o.timeout > 0 ? o.timeout : undefined,
    safetyCritical: o['safety-critical'] === true || o.safetyCritical === true,
    degradeOn: Array.isArray(o['degrade-on'])
      ? (o['degrade-on'] as unknown[]).filter((p): p is string => typeof p === 'string')
      : Array.isArray(o.degradeOn)
        ? (o.degradeOn as unknown[]).filter((p): p is string => typeof p === 'string')
        : undefined,
    workingDir: typeof o['working-dir'] === 'string'
      ? o['working-dir']
      : typeof o.workingDir === 'string'
        ? o.workingDir
        : undefined,
  };

  return { source };
}

/**
 * Load all canonical hook sources from `<frameworkRoot>/agentic/code/addons/
 * aiwg-hooks/canonical/`. Returns the parsed sources plus any rejections so
 * the orchestrator can warn operators about malformed files.
 */
export async function loadHookSources(
  frameworkRoot: string,
): Promise<{ sources: HookSource[]; errors: string[] }> {
  const dir = path.join(
    frameworkRoot,
    'agentic',
    'code',
    'addons',
    'aiwg-hooks',
    'canonical',
  );
  const sources: HookSource[] = [];
  const errors: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sources, errors };
    }
    throw err;
  }

  for (const entry of entries) {
    if (!/\.(yaml|yml|json)$/i.test(entry)) continue;
    const filePath = path.join(dir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = entry.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
    } catch (err) {
      errors.push(`${filePath}: parse error — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const { source, error } = normalize(parsed, filePath);
    if (error) {
      errors.push(error);
      continue;
    }
    if (source) {
      const resolveRoot = (value: string) => value.replace(/\$AIWG_ROOT\b|\$\{AIWG_ROOT\}/g, () => frameworkRoot);
      sources.push({ ...source, command: resolveRoot(source.command), args: source.args?.map(resolveRoot) });
    }
  }

  return { sources, errors };
}
