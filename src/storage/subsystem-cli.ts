/**
 * Generic subsystem CLI runner.
 *
 * Provides path/list/get/put/delete/append-log subcommands for any
 * storage subsystem. Used by `aiwg memory` (#966), `aiwg reflections`
 * (#967), and any future per-subsystem CLI wrappers — keeping the
 * shared logic in one place rather than duplicating it.
 *
 * Each subsystem-specific CLI is a 5-line wrapper:
 *
 *   import { runSubsystemCli } from '../storage/subsystem-cli.js';
 *   export async function main(args: string[]): Promise<void> {
 *     await runSubsystemCli('memory', args);
 *   }
 *
 * @design @docs/storage/overview.md
 * @issue #934
 * @issue #966
 * @issue #967
 */

import { getLoadedConfig, resolveStorage, type SubsystemKey } from './index.js';
import { resolveSubsystemRootRuntime } from './config.js';
import { projectAiwgPath, resolveProjectAiwgDir } from '../config/project-artifacts.js';

/**
 * Display name for the subsystem when printed in `aiwg <subsystem> path`
 * output and usage strings. Defaults to the subsystem key.
 */
export interface SubsystemCliOptions {
  /** Override printed-name in error messages and usage. Default: subsystem key. */
  displayName?: string;
}

export async function runSubsystemCli(
  subsystem: SubsystemKey,
  args: string[],
  opts: SubsystemCliOptions = {}
): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);
  const display = opts.displayName ?? subsystem;

  switch (subcommand) {
    case 'path':
      await handlePath(subsystem, display, subArgs);
      break;
    case 'list':
      await handleList(subsystem, display, subArgs);
      break;
    case 'get':
      await handleGet(subsystem, display, subArgs);
      break;
    case 'put':
      await handlePut(subsystem, display, subArgs);
      break;
    case 'delete':
      await handleDelete(subsystem, display, subArgs);
      break;
    case 'append-log':
      await handleAppendLog(subsystem, display, subArgs);
      break;
    default:
      printUsage(subsystem, display);
      if (subcommand) {
        throw new Error(`Unknown ${display} subcommand: ${subcommand}`);
      }
  }
}

async function handlePath(subsystem: SubsystemKey, display: string, args: string[]): Promise<void> {
  const subpath = args.find((a) => !a.startsWith('--'));
  const json = args.includes('--json');
  const projectRoot = process.cwd();
  const config = await getLoadedConfig(projectRoot);

  const backend = config?.backends?.[subsystem]?.type ?? 'fs';
  if (backend !== 'fs') {
    if (json) {
      console.log(
        JSON.stringify(
          {
            backend,
            note: `${display} subsystem uses backend "${backend}" — physical filesystem path is not applicable. Use \`aiwg ${display} get/list\` instead.`,
          },
          null,
          2
        )
      );
    } else {
      console.log(`${display} backend: ${backend}`);
      console.log(`  (filesystem path not applicable for this backend; use \`aiwg ${display} get/list\`)`);
    }
    return;
  }

  const root = await resolveSubsystemRootRuntime(subsystem, projectRoot, config);
  const fullPath = subpath ? `${root}/${subpath}` : root;
  if (json) {
    console.log(JSON.stringify({ backend, root, path: fullPath }, null, 2));
  } else {
    console.log(fullPath);
  }
}

async function handleList(subsystem: SubsystemKey, display: string, args: string[]): Promise<void> {
  let prefix = '';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prefix') prefix = args[++i] ?? '';
    else if (args[i] === '--json') json = true;
  }
  const adapter = await resolveStorage(subsystem);
  const entries = await adapter.list(prefix);
  if (json) {
    console.log(
      JSON.stringify(
        entries.map((e) => ({
          path: e.path,
          size: e.size,
          modifiedAt: e.modifiedAt?.toISOString(),
        })),
        null,
        2
      )
    );
    return;
  }
  if (entries.length === 0) {
    console.log(`No ${display} entries${prefix ? ` matching prefix "${prefix}"` : ''}.`);
    return;
  }
  for (const e of entries) console.log(e.path);
}

async function handleGet(subsystem: SubsystemKey, display: string, args: string[]): Promise<void> {
  const path = args[0];
  if (!path) throw new Error(`Usage: aiwg ${display} get <path>`);
  const adapter = await resolveStorage(subsystem);
  const content = await adapter.read(path);
  if (content === null) throw new Error(`${display} entry not found: ${path}`);
  process.stdout.write(content);
}

async function handlePut(subsystem: SubsystemKey, display: string, args: string[]): Promise<void> {
  const path = args[0];
  if (!path) {
    throw new Error(
      `Usage: aiwg ${display} put <path>\n` +
        `  Reads content from stdin. Creates parent directories. Overwrites existing.`
    );
  }
  const content = await readStdin();
  const adapter = await resolveStorage(subsystem);
  await adapter.write(path, content);
  console.log(`Wrote ${content.length} bytes to ${display}:${path}`);
}

async function handleDelete(subsystem: SubsystemKey, display: string, args: string[]): Promise<void> {
  const path = args[0];
  if (!path) throw new Error(`Usage: aiwg ${display} delete <path>`);
  const adapter = await resolveStorage(subsystem);
  await adapter.delete(path);
  console.log(`Deleted ${display}:${path} (no-op if missing)`);
}

async function handleAppendLog(
  subsystem: SubsystemKey,
  display: string,
  args: string[]
): Promise<void> {
  const logPath = args[0];
  if (!logPath) {
    throw new Error(
      `Usage: aiwg ${display} append-log <log-path>\n` +
        `  Reads a single JSON object from stdin and appends it as one JSONL line.`
    );
  }

  const stdinContent = (await readStdin()).trim();
  if (stdinContent.length === 0) {
    throw new Error('append-log: stdin must contain a single JSON object (got empty input)');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinContent);
  } catch (err) {
    throw new Error(`append-log: stdin must be valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('append-log: stdin must be a single JSON object (not an array, not a primitive)');
  }

  const line = JSON.stringify(parsed) + '\n';
  const adapter = await resolveStorage(subsystem);

  if (typeof adapter.append === 'function') {
    const existing = (await adapter.read(logPath)) ?? '';
    if (existing.length > 0 && !existing.endsWith('\n')) {
      await adapter.append(logPath, '\n');
    }
    await adapter.append(logPath, line);
  } else {
    const existing = (await adapter.read(logPath)) ?? '';
    const trailing = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await adapter.write(logPath, existing + trailing + line);
  }

  console.log(`Appended JSONL event to ${display}:${logPath}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function printUsage(subsystem: SubsystemKey, display: string): void {
  const projectRoot = process.cwd();
  const subsystemPath = projectAiwgPath(projectRoot, subsystem);
  const configPath = projectAiwgPath(projectRoot, 'storage.config');
  console.log(`Usage: aiwg ${display} <subcommand>

Subcommands:
  path [<subpath>] [--json]      Resolved physical path (fs backend)
  list [--prefix <p>] [--json]   List entries through the adapter
  get <path>                     Read entry to stdout
  put <path>                     Write stdin to entry
  delete <path>                  Delete entry (no-op if missing)
  append-log <log-path>          Append a JSON object from stdin as JSONL
                                 (atomic when the backend supports adapter.append)

Examples:
  aiwg ${display} path
  aiwg ${display} list --prefix some/
  aiwg ${display} get some/page.md
  echo "# page" | aiwg ${display} put some/page.md
  echo '{"event":"x"}' | aiwg ${display} append-log some/log.jsonl

The ${display} subsystem persists at ${subsystemPath} on the default fs backend
(artifact root: ${resolveProjectAiwgDir(projectRoot)}).
Configure ${configPath} to redirect (#934).`);
}
