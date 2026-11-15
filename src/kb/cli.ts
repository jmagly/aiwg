/**
 * Knowledge Base CLI — `aiwg kb <subcommand>`
 *
 * Thin storage wrapper for the knowledge-base subsystem. Routes all
 * persistence through `resolveStorage('kb')` so the KB honors
 * `.aiwg/storage.config` redirection (Obsidian vault, Logseq graph, S3
 * prefix, etc.) without each kb skill hardcoding `.aiwg/kb/`.
 *
 * Subcommands:
 *   path [<subpath>]    Print resolved physical path to the KB root or a sub-entry
 *   list [--prefix p]   List entries, optionally filtered
 *   get <path>          Read an entry's content to stdout
 *   put <path>          Write stdin contents to an entry (creates parents)
 *   delete <path>       Delete an entry (no-op if missing)
 *
 * @design @docs/storage/overview.md
 * @issue #934
 * @issue #965
 */

import { getLoadedConfig, resolveStorage } from '../storage/index.js';
import { resolveSubsystemRoot } from '../storage/config.js';

export async function main(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'path':
      await handlePath(subArgs);
      break;
    case 'list':
      await handleList(subArgs);
      break;
    case 'get':
      await handleGet(subArgs);
      break;
    case 'put':
      await handlePut(subArgs);
      break;
    case 'delete':
      await handleDelete(subArgs);
      break;
    default:
      printUsage();
      if (subcommand) {
        throw new Error(`Unknown kb subcommand: ${subcommand}`);
      }
  }
}

async function handlePath(args: string[]): Promise<void> {
  const subpath = args.find((a) => !a.startsWith('--'));
  const json = args.includes('--json');

  const projectRoot = process.cwd();
  const config = await getLoadedConfig(projectRoot);

  // For non-fs backends, "path" is meaningless in the filesystem sense —
  // tell the user, but still report the configured backend.
  const backend = config?.backends?.['kb']?.type ?? 'fs';
  if (backend !== 'fs') {
    if (json) {
      console.log(
        JSON.stringify(
          {
            backend,
            note: `kb subsystem uses backend "${backend}" — physical filesystem path is not applicable. Use "aiwg kb get/list" instead.`,
          },
          null,
          2
        )
      );
    } else {
      console.log(`kb backend: ${backend}`);
      console.log(`  (filesystem path not applicable for this backend; use \`aiwg kb get/list\`)`);
    }
    return;
  }

  const root = resolveSubsystemRoot('kb', projectRoot, config);
  const fullPath = subpath ? `${root}/${subpath}` : root;

  if (json) {
    console.log(JSON.stringify({ backend, root, path: fullPath }, null, 2));
  } else {
    console.log(fullPath);
  }
}

async function handleList(args: string[]): Promise<void> {
  let prefix = '';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prefix') {
      prefix = args[++i] ?? '';
    } else if (args[i] === '--json') {
      json = true;
    }
  }

  const adapter = await resolveStorage('kb');
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
    console.log(`No entries${prefix ? ` matching prefix "${prefix}"` : ''}.`);
    return;
  }

  for (const e of entries) {
    console.log(e.path);
  }
}

async function handleGet(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) {
    throw new Error('Usage: aiwg kb get <path>');
  }
  const adapter = await resolveStorage('kb');
  const content = await adapter.read(path);
  if (content === null) {
    throw new Error(`KB entry not found: ${path}`);
  }
  process.stdout.write(content);
}

async function handlePut(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) {
    throw new Error(
      `Usage: aiwg kb put <path>\n` +
        `  Reads content from stdin. Creates parent directories. Overwrites existing.\n` +
        `  Examples:\n` +
        `    echo "# foo" | aiwg kb put entities/foo.md\n` +
        `    cat draft.md | aiwg kb put concepts/bar.md`
    );
  }

  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const content = Buffer.concat(chunks).toString('utf-8');

  const adapter = await resolveStorage('kb');
  await adapter.write(path, content);
  console.log(`Wrote ${content.length} bytes to kb:${path}`);
}

async function handleDelete(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) {
    throw new Error('Usage: aiwg kb delete <path>');
  }
  const adapter = await resolveStorage('kb');
  await adapter.delete(path);
  console.log(`Deleted kb:${path} (no-op if missing)`);
}

function printUsage(): void {
  console.log(`Usage: aiwg kb <subcommand>

Subcommands:
  path [<subpath>]      Print resolved physical path (fs backend only)
  list [--prefix <p>]   List entries (optionally filtered by prefix)
  get <path>            Read an entry's content to stdout
  put <path>            Write stdin contents to an entry
  delete <path>         Delete an entry (no-op if missing)

Flags:
  --json                Machine-readable output (path, list)

Examples:
  aiwg kb path                          # /home/user/proj/.aiwg/kb
  aiwg kb path entities/foo.md          # ...absolute path
  aiwg kb list --prefix entities/
  aiwg kb get entities/foo.md
  echo "# foo" | aiwg kb put entities/foo.md
  aiwg kb delete entities/old.md

The KB persists at .aiwg/kb/ on the default fs backend. Configure
.aiwg/storage.config to redirect (#934). For non-fs backends (obsidian,
logseq, etc.), \`aiwg kb path\` reports the backend rather than a
filesystem path — use \`get\`/\`list\` to interact through the adapter.`);
}
