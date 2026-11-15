/**
 * `aiwg run skill <name>` — execute a script-bearing skill (#1227).
 *
 * Resolves the skill via the artifact index (the same one `aiwg discover`
 * and `aiwg show` use), reads its `script:` declaration, and dispatches
 * the entrypoint through the runtime registry.
 *
 * Critical CWD invariant: by default, the script runs from the CALLING
 * project's root, not the skill's source directory. Skill scripts live
 * at `$AIWG_ROOT/agentic/code/...` but operate on the user's project, so
 * relative paths inside the script (`.aiwg/`, `src/`, `package.json`)
 * must resolve into the user's tree. The manifest can override via
 * `cwd: skill-dir` for the rare case of a script that bundles its own
 * relative assets, or `cwd: aiwg-root` as an escape hatch.
 *
 * Env vars exported to the script:
 *   AIWG_SKILL_DIR    absolute path to the skill's source directory
 *   AIWG_PROJECT_ROOT absolute path to the calling project's root
 *   AIWG_ROOT         absolute path to the AIWG install root
 *
 * Stdin streams in, stdout/stderr stream out, the script's exit code is
 * the CLI's exit code. No magic wrapping.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveRuntime, supportedRuntimes } from './runtime.js';
import type { ArtifactIndex, GraphType, MetadataEntry } from '../artifacts/types.js';
import { recordTypeForEntry, stableRecordId } from '../artifacts/browser-export.js';
import { loadFortemiCoreMetadataEntries } from '../artifacts/fortemi-core-query-adapter.js';

interface IndexLoader {
  loadGraphIndexFile<T>(cwd: string, filename: string, graph?: GraphType): T | null;
  loadMetadataIndex(cwd: string): ArtifactIndex | null;
}

interface ChannelManager {
  getFrameworkRoot?: () => Promise<string | null>;
}

/**
 * Resolve the AIWG installation root. Prefers `$AIWG_ROOT` env, falls
 * back to the channel manager's framework-root resolver.
 */
async function getAiwgRoot(): Promise<string | null> {
  if (process.env.AIWG_ROOT) return process.env.AIWG_ROOT;
  try {
    const mod: ChannelManager = await import('../channel/manager.mjs');
    if (typeof mod.getFrameworkRoot === 'function') {
      const r = await mod.getFrameworkRoot();
      return r || null;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Find a skill entry by name across the framework / project / codebase
 * graphs. Mirrors the lookup `aiwg show` uses — basename match against
 * the skill's directory name (skills/<name>/SKILL.md).
 */
async function findSkillEntry(
  cwd: string,
  name: string,
): Promise<MetadataEntry | null> {
  const reader: IndexLoader = await import('../artifacts/index-reader.js');
  const entries: MetadataEntry[] = [];
  for (const g of ['framework', 'project', 'codebase'] as GraphType[]) {
    const canonical = loadFortemiCoreMetadataEntries(cwd, g);
    if (canonical.entries.length > 0) {
      entries.push(...canonical.entries);
    } else {
      const idx = reader.loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', g);
      if (idx) entries.push(...Object.values(idx.entries));
    }
  }
  if (entries.length === 0) {
    const legacy = reader.loadMetadataIndex(cwd);
    if (legacy) entries.push(...Object.values(legacy.entries));
  }
  const skills = entries.filter(e => e.type === 'skill' || e.type === 'aiwg.skill');
  const needle = name.trim();
  // Basename match — skills are conventionally `<dir>/SKILL.md`
  const matches = skills.filter(e => {
    const dir = path.basename(path.dirname(e.path));
    const stem = path.basename(e.path).replace(/\.[^.]+$/, '');
    const id = stableRecordId(recordTypeForEntry({ ...e, type: 'skill' }, 'v2'), e.path);
    return id === needle || e.name === needle || dir === needle || stem === needle || e.path === needle;
  });
  if (matches.length === 0) return null;
  // Prefer one with a script declaration over one without
  const withScript = matches.find(m => m.script);
  return withScript ?? matches[0];
}

/**
 * Resolve the skill's source directory to an absolute path. Framework
 * entries are stored relative to AIWG_ROOT; project entries relative to
 * the project cwd.
 */
function resolveSkillDir(
  entry: MetadataEntry,
  cwd: string,
  aiwgRoot: string | null,
): string {
  const skillFile = path.isAbsolute(entry.path)
    ? entry.path
    : entry.path.startsWith('agentic/code/') && aiwgRoot
      ? path.join(aiwgRoot, entry.path)
      : path.join(cwd, entry.path);
  return path.dirname(skillFile);
}

export interface RunSkillOptions {
  cwd: string;
  name: string;
  args: string[];
  /** Override the script's CWD policy from the CLI (e.g., --cwd <path>) */
  cwdOverride?: string;
  /** Additional resolved runtime policy exported by the CLI wrapper. */
  env?: Record<string, string>;
}

/**
 * Run a skill's script entrypoint. Returns the exit code; the caller
 * decides whether to `process.exit()` with it.
 */
export async function runSkill(opts: RunSkillOptions): Promise<number> {
  const aiwgRoot = await getAiwgRoot();
  const entry = await findSkillEntry(opts.cwd, opts.name);
  if (!entry) {
    console.error(`Error: no skill matching "${opts.name}" found in the artifact index.`);
    console.error('Try `aiwg discover "<phrase>"` to find the right name, or run `aiwg index build --graph framework` if the index is stale.');
    return 1;
  }
  if (!entry.script) {
    console.error(`Error: skill "${opts.name}" is instructional only — it has no script entrypoint to run.`);
    console.error(`Read its instructions with: aiwg show skill ${opts.name} --first`);
    console.error('If you need an executable skill, run `aiwg discover "<phrase>" --json` and choose an entry with "executable": true.');
    return 1;
  }
  const skillDir = resolveSkillDir(entry, opts.cwd, aiwgRoot);
  const entrypointPath = path.resolve(skillDir, entry.script.entrypoint);
  try {
    await fs.access(entrypointPath);
  } catch {
    console.error(`Error: skill entrypoint not found: ${entrypointPath}`);
    console.error('The skill manifest declares this entrypoint but the file is missing. Check the skill source.');
    return 1;
  }
  const invocation = await resolveRuntime(entry.script.runtime, entrypointPath);
  if (!invocation) {
    console.error(`Error: unknown runtime "${entry.script.runtime}" for skill "${opts.name}".`);
    console.error(`Supported runtimes: ${supportedRuntimes().join(', ')}`);
    return 1;
  }
  // Resolve CWD per the policy: project-root (default), skill-dir, aiwg-root,
  // or an explicit CLI override.
  let runCwd: string;
  if (opts.cwdOverride) {
    runCwd = path.resolve(opts.cwdOverride);
  } else {
    switch (entry.script.cwd ?? 'project-root') {
      case 'skill-dir':
        runCwd = skillDir;
        break;
      case 'aiwg-root':
        runCwd = aiwgRoot ?? opts.cwd;
        break;
      case 'project-root':
      default:
        runCwd = opts.cwd;
        break;
    }
  }
  const env = {
    ...process.env,
    AIWG_SKILL_DIR: skillDir,
    AIWG_PROJECT_ROOT: opts.cwd,
    ...(aiwgRoot ? { AIWG_ROOT: aiwgRoot } : {}),
    ...opts.env,
  };
  const fullArgs = [...invocation.prefixArgs, entrypointPath, ...opts.args];
  return new Promise<number>((resolve) => {
    const child = spawn(invocation.command, fullArgs, {
      cwd: runCwd,
      env,
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error(`Error: failed to spawn ${invocation.command}: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        // Match shell convention: signal-killed → 128 + signal number
        const signalNum = (process as unknown as { binding?: (n: string) => Record<string, number> }).binding?.('constants')?.[signal] ?? 0;
        resolve(128 + signalNum);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

/**
 * CLI entrypoint for `aiwg run skill <name> [-- args...]`.
 *
 * Argument convention:
 *   aiwg run skill <name> [--cwd <path>] [-- <args forwarded to script>]
 *
 * Anything after `--` is verbatim-forwarded. If no `--`, all args after
 * the skill name are forwarded.
 */
export async function main(args: string[], env?: Record<string, string>): Promise<number> {
  // First positional must be the kind ("skill" — reserved for future kinds).
  if (args.length === 0) {
    printUsage();
    return 1;
  }
  const kind = args[0];
  if (kind === '--help' || kind === '-h') {
    printUsage();
    return 0;
  }
  if (kind !== 'skill') {
    console.error(`Error: unknown kind "${kind}". Only "skill" is supported.`);
    printUsage();
    return 1;
  }
  if (args.length < 2) {
    console.error('Error: missing skill name.');
    printUsage();
    return 1;
  }
  const name = args[1];
  // #1231 — `aiwg run skill --help` should print usage, not search the
  // index for a skill named "--help".
  if (name === '--help' || name === '-h') {
    printUsage();
    return 0;
  }
  // Split remaining args at the first `--` separator if present.
  const rest = args.slice(2);
  let cwdOverride: string | undefined;
  let scriptArgs: string[];
  const sepIndex = rest.indexOf('--');
  let head: string[];
  if (sepIndex >= 0) {
    head = rest.slice(0, sepIndex);
    scriptArgs = rest.slice(sepIndex + 1);
  } else {
    head = [];
    scriptArgs = rest;
  }
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '--cwd' && i + 1 < head.length) {
      cwdOverride = head[i + 1];
      i++;
    } else {
      // Unknown flag before `--` — treat as script arg only when no `--`
      // separator was provided, otherwise error out so typos surface.
      if (sepIndex >= 0) {
        console.error(`Error: unknown flag "${head[i]}" before \`--\`.`);
        printUsage();
        return 1;
      }
    }
  }
  return runSkill({
    cwd: process.cwd(),
    name,
    args: scriptArgs,
    cwdOverride,
    env,
  });
}

function printUsage(): void {
  console.log('Usage: aiwg run skill <stable-id-or-name> [--cwd <path>] [-- <args...>]');
  console.log('');
  console.log('Examples:');
  console.log('  aiwg run skill voice-apply -- --voice technical-authority --input draft.md');
  console.log('  aiwg run skill template-engine -- render adr-template.md --vars vars.yaml');
  console.log('  aiwg run skill ai-pattern-detection -- --path docs/');
  console.log('');
  console.log('The script runs from the project root by default. Use `--cwd <path>` to override.');
  console.log('Tip: `aiwg discover "<phrase>" --json` shows which skills have an "executable: true" flag.');
}
