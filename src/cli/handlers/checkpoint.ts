// Create, list, and inspect lightweight workflow checkpoints in the configured artifact root.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedExecFileSync } from '../../process/bounded-child-process.mjs';
import { resolveProjectAiwgDirForWrite } from '../../config/project-artifacts.js';
import type { CommandHandler, HandlerResult } from './types.js';

interface Checkpoint {
  id: string;
  name?: string;
  createdAt: string;
  cwd: string;
  gitHead?: string;
  phase?: string;
  step?: string;
  artifacts: string[];
  note?: string;
}

const usage = [
  'aiwg checkpoint — Save or inspect a workflow resume position',
  '',
  'Usage:',
  '  aiwg checkpoint create [--name N] [--phase P] [--step S] [--artifact <path>]... [--note N]',
  '  aiwg checkpoint list [--json]',
  '  aiwg checkpoint recover [<id|name>] [--json]',
  '',
  'Recover reports the saved record without changing the repository.',
  'Duplicate names select the newest matching checkpoint.',
].join('\n');

function parse(args: string[]) {
  const [action, ...rest] = args;
  if (!['create', 'list', 'recover'].includes(action)) throw new Error(`Unknown checkpoint action: ${action ?? '(missing)'}\n${usage}`);
  const values: Record<string, string> = {};
  const artifacts: string[] = [];
  let lookup: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json' && action !== 'create') { json = true; continue; }
    if (action === 'create' && /^--(name|phase|step|artifact|note)(=|$)/.test(arg)) {
      const eq = arg.indexOf('=');
      const key = arg.slice(2, eq < 0 ? undefined : eq);
      const value = eq < 0 ? rest[++i] : arg.slice(eq + 1);
      if (!value || (eq < 0 && value.startsWith('-'))) throw new Error(`--${key} requires a value`);
      if (key === 'artifact') artifacts.push(value);
      else {
        if (key in values) throw new Error(`--${key} may be given once`);
        values[key] = value;
      }
    } else if (action === 'recover' && !arg.startsWith('-') && lookup === undefined) {
      lookup = arg;
    } else throw new Error(`Unexpected checkpoint argument: ${arg}`);
  }
  return { action, values, artifacts, lookup, json };
}

async function records(dir: string): Promise<Checkpoint[]> {
  let files: string[];
  try { files = await readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result = await Promise.all(files.filter(file => file.endsWith('.json')).map(async file => {
    const record: Checkpoint = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (!record || typeof record.id !== 'string' || typeof record.cwd !== 'string'
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
      || !Array.isArray(record.artifacts) || !record.artifacts.every(path => typeof path === 'string')
      || ['name', 'gitHead', 'phase', 'step', 'note'].some(key => {
        const value = record[key as keyof Checkpoint];
        return value !== undefined && typeof value !== 'string';
      })) throw new Error(`Invalid checkpoint record: ${file}`);
    return record;
  }));
  return result.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
}

function resumeText(record: Checkpoint): string {
  return [
    `Checkpoint: ${record.id}${record.name ? ` (${record.name})` : ''}`,
    `Created: ${record.createdAt}`,
    `Resume in: ${record.cwd}`,
    `Phase: ${record.phase ?? '(unspecified)'}`,
    `Step: ${record.step ?? '(unspecified)'}`,
    ...(record.gitHead ? [`Git HEAD: ${record.gitHead}`] : []),
    `Artifacts: ${record.artifacts.length ? record.artifacts.join(', ') : '(none)'}`,
    ...(record.note !== undefined ? [`Note: ${record.note}`] : []),
  ].join('\n');
}

export const checkpointHandler: CommandHandler = {
  id: 'checkpoint',
  name: 'Workflow Checkpoints',
  description: 'Create, list, or recover a saved workflow position',
  category: 'workspace',
  aliases: [],
  async help() { return { exitCode: 0, message: usage, rawOutput: true }; },
  async execute(ctx): Promise<HandlerResult> {
    if (ctx.args.includes('--help') || ctx.args.includes('-h') || ctx.args[0] === 'help') {
      return { exitCode: 0, message: usage, rawOutput: true };
    }
    try {
      const { action, values, artifacts, lookup, json } = parse(ctx.args);
      const dir = join(resolveProjectAiwgDirForWrite(ctx.cwd), 'checkpoints');
      if (action === 'create') {
        if (ctx.dryRun) return { exitCode: 0, message: `Would create checkpoint in ${dir}`, rawOutput: true };
        let gitHead: string | undefined;
        try {
          gitHead = String(boundedExecFileSync('git', ['rev-parse', '--verify', 'HEAD'], 'quick', {
            cwd: ctx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
          })).trim();
        } catch { /* Checkpoints also work outside git repositories. */ }
        const record: Checkpoint = {
          id: `ckpt_${randomUUID()}`, ...values, createdAt: new Date().toISOString(),
          cwd: ctx.cwd, ...(gitHead ? { gitHead } : {}), artifacts,
        };
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
        return { exitCode: 0, message: record.id, rawOutput: true };
      }
      const all = await records(dir);
      if (action === 'list') {
        return {
          exitCode: 0, rawOutput: true,
          message: json ? JSON.stringify(all, null, 2) : all.length
            ? ['ID\tName\tCreated\tPhase / Step', ...all.map(record =>
              `${record.id}\t${record.name ?? '(unnamed)'}\t${record.createdAt}\t${record.phase ?? '-'} / ${record.step ?? '-'}`)].join('\n')
            : 'No checkpoints found.',
        };
      }
      const record = lookup === undefined ? all[0]
        : all.find(record => record.id === lookup) ?? all.find(record => record.name === lookup);
      if (!record) throw new Error(lookup === undefined ? 'No checkpoints found.' : `Checkpoint not found: ${lookup}`);
      return { exitCode: 0, message: json ? JSON.stringify(record, null, 2) : resumeText(record), rawOutput: true };
    } catch (error) {
      return { exitCode: 1, message: error instanceof Error ? error.message : String(error) };
    }
  },
};

export const checkpointHandlers: CommandHandler[] = [checkpointHandler];
