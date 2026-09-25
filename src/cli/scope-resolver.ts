/**
 * Scope resolver — `--scope user|project` per ADR-4.
 *
 * The CLI flag `--scope user` redirects deploys to home-rooted paths
 * (`~/.<provider>/...`) instead of project-relative paths. This module
 * holds the per-provider user-scope path map and the helper to detect
 * the flag in command-line args.
 *
 * Per ADR-4 §2 path map. Per ADR-4 §1: `--scope user` and `--scope
 * project` are mutually exclusive; default is `project`.
 */

import { resolveOmpPaths } from '../providers/omp-paths.mjs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { resolveHermesHome, resolveHermesHomePath } from '../providers/hermes-home.js';
import { resolveGrokbotSkillsDir } from '../providers/grokbot-paths.js';
import { resolveGrokHome } from '../providers/grok-build-paths.js';
import { resolveMuseXdgSkillsDir } from '../providers/muse-paths.js';

export const hermesHome = resolveHermesHome;

export type Scope = 'project' | 'user';

function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(homedir(), '.pi', 'agent');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/')) return path.join(homedir(), configured.slice(2));
  return configured;
}

/**
 * User-scope deploy paths per provider per ADR-4 §2. Each path is absolute
 * (rooted in os.homedir()) so the orchestrator's existing path-join logic
 * (which calls `path.join(target, relativePath)`) treats them as authoritative
 * and bypasses the project-relative join.
 *
 * `.agents/skills/` and `~/.agents/skills/` deliberately appear for multiple
 * providers — that's the cross-provider canonical user-scope target. Per
 * ADR-4 §5 reference counting prevents one provider's removal from breaking
 * another's deploy at the shared path.
 */
export const USER_SCOPE_PATHS: Record<string, { agents: string; skills: string; commands: string; rules: string; behaviors: string }> = {
  claude: {
    agents: path.join(homedir(), '.claude', 'agents'),
    skills: path.join(homedir(), '.claude', 'skills'),
    commands: path.join(homedir(), '.claude', 'commands'),
    rules: path.join(homedir(), '.claude', 'rules'),
    behaviors: path.join(homedir(), '.claude', 'hooks'),
  },
  codex: {
    // #1158 — Verified against `codex-rs/core-skills/src/loader.rs` and
    // `docs/providers/skills-paths.md`. Skills primary path is
    // `~/.agents/skills/` (the cross-provider canonical). Commands deploy at
    // `~/.codex/prompts/` for operator visibility per ADR-1; codex-rs ships a
    // static built-in command enum so this directory is not auto-scanned, but
    // it is the documented location and is where Codex would look if it ever
    // scanned. Agents/rules at user scope route through AGENTS.md, not a
    // discrete directory — left empty here.
    agents: '',
    skills: path.join(homedir(), '.agents', 'skills'),
    commands: path.join(homedir(), '.codex', 'prompts'),
    rules: '',
    behaviors: '',
  },
  get omp() {
    const { agentDir } = resolveOmpPaths();
    return { agents: path.join(agentDir, 'agents'), skills: path.join(agentDir, 'skills'),
      commands: path.join(agentDir, 'prompts'), rules: path.join(agentDir, 'rules'),
      behaviors: path.join(agentDir, 'extensions') };
  },
  pi: {
    // Pi's global resource root is configurable. Unlike project deployment,
    // user-scope resources belong under the effective agent directory. Keep
    // skills on this single native path instead of also copying them to
    // ~/.agents/skills, which would create duplicate Pi discovery entries.
    // PI_CODING_AGENT_DIR is configuration only and is not runtime evidence.
    agents: '',
    skills: path.join(piAgentDir(), 'skills'),
    commands: path.join(piAgentDir(), 'prompts'),
    rules: '',
    behaviors: path.join(piAgentDir(), 'extensions'),
  },
  copilot: {
    // #1160 — Non-applicable for filesystem user-scope discovery.
    //
    // VS Code GitHub Copilot's user-scope customization mechanism is the
    // VS Code settings UI (`settings.json` → `github.copilot.chat.*` keys
    // and `chat.modeFiles`/`chat.promptFiles` discovery), NOT a home-dir
    // filesystem scan. `~/.config/github-copilot/` exists on Linux but
    // stores auth state, not customization markdown files. Workspace
    // customization is `.github/{copilot-instructions.md,prompts/,agents/,
    // instructions/}` — see the Copilot `ProviderDefinition.paths.artifacts`
    // entry for the project-scope deploy that IS verified.
    //
    // The paths below remain populated as a "harmless mirror" — deploying
    // there does not break Copilot, but the runtime won't pick them up.
    // Operators wanting cross-project Copilot customization should use
    // VS Code's Settings Sync (settings.json), not AIWG `--scope user`.
    //
    // Skills route through ~/.agents/skills/ which IS a documented
    // cross-provider canonical (Codex/OpenCode scan it; Copilot does
    // not auto-scan but doesn't refuse either).
    agents: path.join(homedir(), '.config', 'github-copilot', 'agents'),
    skills: path.join(homedir(), '.agents', 'skills'),
    commands: path.join(homedir(), '.config', 'github-copilot', 'prompts'),
    rules: path.join(homedir(), '.config', 'github-copilot', 'instructions'),
    behaviors: '',
  },
  cursor: {
    // #1159 — Cursor is closed-source; user-scope behavior is unverified.
    // Cursor's documented "User Rules" feature lives in the app's settings
    // UI (preference data under platform-specific config dirs), not as
    // markdown files in `~/.cursor/`. Project Rules at `.cursor/rules/*.mdc`
    // are confirmed (per #1138 PUW-037), but user-scope filesystem
    // discovery is not documented anywhere AIWG can verify.
    //
    // The paths below are the natural home-dir mirrors of the project-scope
    // layout. Deploying there is harmless (Cursor will ignore the files if
    // it doesn't scan them) but may also be invisible to the runtime. Until
    // Cursor publishes user-scope discovery rules, treat this row as
    // "unverified" — see docs/customization/user-scope-deployment.md.
    agents: path.join(homedir(), '.cursor', 'agents'),
    skills: path.join(homedir(), '.cursor', 'skills'),
    commands: path.join(homedir(), '.cursor', 'commands'),
    rules: path.join(homedir(), '.cursor', 'rules'),
    behaviors: path.join(homedir(), '.cursor', 'rules'),
  },
  opencode: {
    // #1161 — Verified against OpenCode docs (opencode.ai/docs/skills,
    // opencode.ai/docs/rules, deepwiki.com/sst/opencode/5.7-skills-system).
    // User-scope discovery roots at ~/.config/opencode/, NOT ~/.opencode/.
    // Subdirectories use the plural forms per the OpenCode docs convention
    // (agents/, commands/, skills/, etc.) — though the project-scope loader
    // accepts both singular and plural via globs (#773, #1107). At user
    // scope we use the plural form per the documented preference.
    //
    // Skills are also scanned by OpenCode at ~/.agents/skills/ (the
    // cross-provider canonical) and ~/.claude/skills/ — we deploy to
    // .agents/skills/ to keep one user-scope skills dir shared across
    // Codex/Copilot/Warp/Factory/OpenCode rather than duplicating into
    // ~/.config/opencode/skills/ as well.
    //
    // Rules at user scope route through ~/.config/opencode/AGENTS.md per
    // the docs — there is no discrete user-scope rules dir.
    agents: path.join(homedir(), '.config', 'opencode', 'agents'),
    skills: path.join(homedir(), '.agents', 'skills'),
    commands: path.join(homedir(), '.config', 'opencode', 'commands'),
    rules: '',
    behaviors: '',
  },
  warp: {
    // #1162 — Non-applicable for filesystem user-scope discovery.
    //
    // Warp's user-scope mechanism is **Warp Drive** (cloud-synced agents,
    // workflows, notebooks, and rules tied to the operator's Warp account),
    // not a filesystem scan under `~/.warp/`. The project-scope AIWG
    // surface for Warp is `WARP.md` aggregation at the project root via
    // `aiwg-regenerate-warp` — that's the verified discovery path.
    //
    // The paths below remain populated as a "harmless mirror" — deploying
    // there does not break Warp, but the runtime won't pick them up.
    // Operators wanting cross-project Warp customization should publish
    // to Warp Drive via the Warp app, not AIWG `--scope user`.
    //
    // Skills route through ~/.agents/skills/ as a courtesy (Warp does not
    // auto-scan it but doesn't refuse either; aligns with the cross-
    // provider canonical used by Codex/OpenCode).
    agents: path.join(homedir(), '.warp', 'agents'),
    skills: path.join(homedir(), '.agents', 'skills'),
    commands: path.join(homedir(), '.warp', 'commands'),
    rules: path.join(homedir(), '.warp', 'rules'),
    behaviors: '',
  },
  windsurf: {
    // #1163 — Non-applicable for filesystem user-scope discovery.
    //
    // Windsurf's user-scope mechanism is **Cascade Memories** (in-app,
    // managed by the Cascade agent itself, not file-discovered) and
    // global rules in the Windsurf settings UI. Project-scope discovery
    // is `.windsurf/{rules,workflows}/` and AGENTS.md aggregation. There
    // is no documented filesystem scan of `~/.windsurf/` for user-scope
    // content.
    //
    // The paths below remain populated as a "harmless mirror" — deploying
    // there does not break Windsurf, but the runtime won't pick them up.
    // Operators wanting cross-project Windsurf customization should use
    // Cascade Memories (commit a memory via the agent UI) or the
    // Windsurf settings UI, not AIWG `--scope user`.
    agents: path.join(homedir(), '.windsurf', 'agents'),
    skills: path.join(homedir(), '.windsurf', 'skills'),
    commands: path.join(homedir(), '.windsurf', 'workflows'),
    rules: path.join(homedir(), '.windsurf', 'rules'),
    behaviors: '',
  },
  hermes: {
    agents: '',
    // #2119: honor HERMES_HOME so `--scope user` deploys land under the same
    // root the running Hermes session scans, matching the hermes provider's
    // paths.skills resolution.
    skills: resolveHermesHomePath('skills'),
    commands: '',
    rules: '',
    behaviors: '',
  },
  openclaw: {
    agents: path.join(homedir(), '.openclaw', 'agents'),
    skills: path.join(homedir(), '.openclaw', 'skills'),
    commands: path.join(homedir(), '.openclaw', 'commands'),
    rules: path.join(homedir(), '.openclaw', 'rules'),
    behaviors: path.join(homedir(), '.openclaw', 'behaviors'),
  },
  openhuman: {
    // OpenHuman is a home-dir app provider for AIWG installs. The app's native
    // skills registry installs to ~/.openhuman/skills, and custom agents are
    // TOML-only under ~/.openhuman/agents. AIWG does not invent a project-level
    // markdown-agent install for OpenHuman.
    agents: '',
    skills: path.join(homedir(), '.openhuman', 'skills'),
    commands: '',
    rules: path.join(homedir(), '.openhuman', '.aiwg', 'rules'),
    behaviors: '',
  },
  get grokbot() {
    // Fail-closed: skills path is empty until AIWG_GROKBOT_SKILLS_DIR is set.
    // Never invent ~/.grokbot. See adr-grokbot-provider-target / #205/#207.
    const skills = resolveGrokbotSkillsDir() || '';
    return {
      agents: '',
      skills,
      commands: '',
      rules: '',
      behaviors: '',
    };
  },
  get 'grok-build'() {
    // Grok Build discovers user agents and skills under the resolved home.
    const home = resolveGrokHome();
    return {
      agents: home ? path.join(home, 'agents') : '',
      skills: home ? path.join(home, 'skills') : '',
      commands: '',
      rules: '',
      behaviors: '',
    };
  },
  get muse() {
    // #226 — Muse XDG user skills root resolves at deploy time (fail-closed).
    // Bad XDG metadata yields '' so the --scope user mirror skips the skills
    // lane rather than inventing ~/.muse or writing ~/.agents/skills
    // (the cross-provider canonical is a READ surface for Muse, never an
    // AIWG write target — see adr-muse-provider-target.md).
    const skills = resolveMuseXdgSkillsDir() || '';
    return {
      agents: '',
      skills,
      commands: '',
      rules: '',
      behaviors: '',
    };
  },
  factory: {
    // #1164 — Verified against Factory docs (docs.factory.ai/cli/configuration/skills).
    // Skills primary user-scope path is ~/.factory/skills/, NOT the
    // cross-provider .agents/skills/ canonical. Factory's docs explicitly say
    // "for personal use across all projects, you can copy skills to
    // ~/.factory/skills/skill-name" — there's no public statement that
    // Factory scans ~/.agents/skills/, so we deploy to the documented path.
    //
    // Droids and commands at user scope mirror the project-scope layout
    // (.factory/droids/ and .factory/commands/). These paths aren't called
    // out explicitly in the Factory docs as user-scope discovery roots; they
    // follow the same convention as the skills path. If Factory adds dedicated
    // user-scope discovery for these, this entry should be revisited.
    //
    // Rules at user scope route through AGENTS.md per Factory's
    // multi-platform AGENTS.md convention — no discrete user-scope rules dir.
    agents: path.join(homedir(), '.factory', 'droids'),
    skills: path.join(homedir(), '.factory', 'skills'),
    commands: path.join(homedir(), '.factory', 'commands'),
    rules: '',
    behaviors: '',
  },
};

/**
 * Detect the `--scope` flag in a command-line arg list. Returns the resolved
 * scope; defaults to 'project'. Throws when both `--scope user` and `--scope
 * project` appear (mutually exclusive per ADR-4 §1).
 */
export function detectScope(args: ReadonlyArray<string>): Scope {
  const idx = args.findIndex((a) => a === '--scope');
  if (idx === -1) return 'project';
  const value = args[idx + 1];
  if (value !== 'user' && value !== 'project') {
    throw new Error(
      `--scope expected 'user' or 'project', got '${value ?? '(missing)'}'`,
    );
  }
  // Check for duplicate --scope flags.
  const dupIdx = args.findIndex((a, i) => i > idx && a === '--scope');
  if (dupIdx !== -1) {
    throw new Error('--scope appears more than once');
  }
  return value;
}

/**
 * The path to the user-scope aiwg.config per ADR-4 §4. Each operator has
 * one of these per-machine; it tracks user-global deployments.
 */
export function userScopeConfigPath(): string {
  return path.join(homedir(), '.aiwg', 'aiwg.config');
}

/**
 * Resolve the deploy paths for a (provider, scope) pair. For project scope,
 * returns ProviderDefinition-backed project-relative paths (the caller
 * resolves them against the project dir). For user scope, returns the
 * absolute home-rooted paths from USER_SCOPE_PATHS.
 */
export function resolveScopePaths(
  provider: string,
  scope: Scope,
  projectScopePaths: { agents: string; skills: string; commands: string; rules: string; behaviors: string },
): { agents: string; skills: string; commands: string; rules: string; behaviors: string } {
  if (scope === 'project') return projectScopePaths;
  const userPaths = USER_SCOPE_PATHS[provider];
  if (!userPaths) {
    // Unknown provider — fall back to project paths so the caller doesn't crash.
    return projectScopePaths;
  }
  return userPaths;
}

/**
 * Mirror skills deployed under the project-scope skills directory to the
 * user-scope target. Per ADR-4 §2 the cross-agent canonical user-scope
 * skills target is `~/.agents/skills/` for codex/copilot/warp/opencode/
 * factory; for other providers the user-scope skills dir is per-provider.
 *
 * This is an additive copy — the project-scope deploy stays in place; the
 * user-scope copy is created alongside. Operators get the skills available
 * across all their projects without re-running aiwg use per project.
 *
 * Returns the count of skills mirrored, or 0 when nothing was found.
 */
export async function mirrorSkillsToUserScope(
  provider: string,
  projectSkillsDir: string,
): Promise<{ count: number; targetDir: string }> {
  const userPaths = USER_SCOPE_PATHS[provider];
  if (!userPaths || !userPaths.skills) {
    return { count: 0, targetDir: '' };
  }
  return mirrorArtifactDir(projectSkillsDir, userPaths.skills);
}

/**
 * Per-artifact-type mirror result. `entries` are the top-level directory or
 * file names that were successfully copied — these become the entries in the
 * per-user registry's `artifactEntries` map and let `aiwg remove --scope user`
 * delete only what this deploy created (rather than wiping shared dirs).
 */
export interface ArtifactMirrorResult {
  count: number;
  targetDir: string;
  entries: string[];
}

/**
 * #1156 Phase 1 — Mirror the full per-provider artifact set (agents, commands,
 * skills, rules) from project scope to the user-scope target. Additive: the
 * project-scope deploy stays in place; user-scope copies are created alongside
 * so the framework is available across every project on the machine.
 *
 * `projectPaths` are the relative or absolute paths the caller already resolved
 * for project-scope deployment. Each one whose user-scope counterpart is
 * non-empty gets mirrored. Returns per-artifact-type counts, the resolved
 * user-scope target directories, and the list of entry names that were copied
 * (so callers can record them in a per-framework manifest for precise remove).
 */
export async function mirrorToUserScope(
  provider: string,
  projectPaths: {
    agents: string;
    skills: string;
    kernelSkills?: string;
    commands: string;
    rules: string;
    behaviors: string;
  },
): Promise<{
  agents: ArtifactMirrorResult;
  skills: ArtifactMirrorResult;
  commands: ArtifactMirrorResult;
  rules: ArtifactMirrorResult;
  behaviors: ArtifactMirrorResult;
}> {
  const userPaths = USER_SCOPE_PATHS[provider];
  const empty: ArtifactMirrorResult = { count: 0, targetDir: '', entries: [] };
  if (!userPaths) {
    return { agents: empty, skills: empty, commands: empty, rules: empty, behaviors: empty };
  }
  if (provider === 'grok-build') await assertGrokUserMirrorPaths(projectPaths, userPaths);
  const [agents, skills, commands, rules, behaviors] = await Promise.all([
    userPaths.agents ? mirrorArtifactDir(projectPaths.agents, userPaths.agents) : Promise.resolve(empty),
    userPaths.skills
      ? mirrorSkillDirsToUserScope(
        [projectPaths.skills, projectPaths.kernelSkills ?? ''],
        userPaths.skills,
      )
      : Promise.resolve(empty),
    userPaths.commands ? mirrorArtifactDir(projectPaths.commands, userPaths.commands) : Promise.resolve(empty),
    userPaths.rules ? mirrorArtifactDir(projectPaths.rules, userPaths.rules) : Promise.resolve(empty),
    userPaths.behaviors ? mirrorArtifactDir(projectPaths.behaviors, userPaths.behaviors) : Promise.resolve(empty),
  ]);
  return { agents, skills, commands, rules, behaviors };
}

async function assertGrokUserMirrorPaths(
  projectPaths: { agents: string; skills: string; kernelSkills?: string },
  userPaths: { agents: string; skills: string },
): Promise<void> {
  const fs = await import('node:fs/promises');
  const statIfPresent = async (target: string) => {
    try { return await fs.lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const checkTarget = async (target: string): Promise<void> => {
    const stat = await statIfPresent(target);
    if (!stat) return;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Refusing unsafe Grok Build user mirror target: ${target}`);
    }
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) await checkTarget(path.join(target, name));
    }
  };
  for (const [destination, sources] of [
    [userPaths.agents, [projectPaths.agents]],
    [userPaths.skills, [projectPaths.skills, projectPaths.kernelSkills ?? '']],
  ] as const) {
    if (!destination) continue;
    const rootStat = await statIfPresent(destination);
    if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
      throw new Error(`Refusing unsafe Grok Build user mirror root: ${destination}`);
    }
    for (const source of sources) {
      if (!source) continue;
      let names: string[];
      try { names = await fs.readdir(source); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) await checkTarget(path.join(destination, name));
    }
  }
}

/**
 * Merge standard and kernel skill directories into one user-discoverable
 * target. Provider deployments intentionally keep those source surfaces
 * separate, while user scope exposes one native skill root. Duplicate skill
 * names created by the earlier source are overwritten by the later source
 * and counted once; pre-existing operator-owned names are preserved.
 */
export async function mirrorSkillDirsToUserScope(
  sourceDirs: ReadonlyArray<string>,
  targetDir: string,
): Promise<ArtifactMirrorResult> {
  const entries = new Set<string>();
  for (const sourceDir of sourceDirs) {
    const result = await mirrorArtifactDir(sourceDir, targetDir, entries);
    for (const entry of result.entries) entries.add(entry);
  }
  return {
    count: entries.size,
    targetDir,
    entries: [...entries],
  };
}

/**
 * Copy every directory or file under `src` into `dst` (creating `dst` if
 * needed). Returns the count of top-level entries successfully copied and
 * the entry names themselves — the names are needed by callers that record
 * a per-framework manifest at user scope so `aiwg remove --scope user` can
 * delete only what this deploy created.
 *
 * Used by the user-scope mirror to cover both directory-style artifacts
 * (skills, agents) and file-style artifacts (commands, rules in some
 * providers). Failures on individual entries are swallowed so a single bad
 * entry doesn't fail the whole mirror.
 */
async function mirrorArtifactDir(src: string, dst: string, ownedThisCall: ReadonlySet<string> = new Set()): Promise<ArtifactMirrorResult> {
  if (!src || !dst) return { count: 0, targetDir: dst, entries: [] };
  const fs = await import('node:fs/promises');

  let dirents;
  try {
    dirents = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return { count: 0, targetDir: dst, entries: [] };
  }

  // Some providers already deploy kernel skills to an absolute user-level
  // path. Inventory that source for registry accounting instead of trying to
  // recursively copy each entry onto itself.
  if (path.resolve(src) === path.resolve(dst)) {
    const entries: string[] = [];
    for (const entry of dirents) {
      if ((entry.isDirectory() || entry.isFile()) && await isAiwgManagedEntry(path.join(dst, entry.name), entry.isDirectory())) {
        entries.push(entry.name);
      }
    }
    return { count: entries.length, targetDir: dst, entries };
  }

  await fs.mkdir(dst, { recursive: true });
  let count = 0;
  const entries: string[] = [];
  for (const entry of dirents) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    try {
      // User-scope directories are shared with operator-created artifacts.
      // A same-named unmanaged entry belongs to the operator, even when a
      // project has an AIWG-managed source with that name.
      try {
        const existing = await fs.lstat(d);
        if (!ownedThisCall.has(entry.name) && !await isAiwgManagedEntry(d, existing.isDirectory())) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      if (entry.isDirectory()) {
        await fs.cp(s, d, { recursive: true, force: true });
      } else if (entry.isFile()) {
        await fs.copyFile(s, d);
      } else {
        continue;
      }
      count++;
      entries.push(entry.name);
    } catch {
      // ignore individual failures
    }
  }
  return { count, targetDir: dst, entries };
}

async function isAiwgManagedEntry(target: string, directory: boolean): Promise<boolean> {
  const fs = await import('node:fs/promises');
  if (directory) {
    try {
      const marker = await fs.readFile(path.join(target, '.aiwg-managed'), 'utf8');
      if (marker.trim() === 'aiwg') return true;
    } catch { /* legacy deployed skill may use an inline marker */ }
  }
  const markerFile = directory ? path.join(target, 'SKILL.md') : target;
  try {
    const text = await fs.readFile(markerFile, 'utf8');
    return /(?:#|<!--) aiwg:managed v[^\s]+ [^\r\n]+/.test(text.slice(0, 2048));
  } catch {
    return false;
  }
}

/**
 * #1156 Phase 1 — some app providers are exclusively user-scope. `--scope
 * project` against them is meaningless because their paths are home-rooted;
 * silently accepting it would create the false impression that project-scope
 * deploys are tracked. This helper is called by the use/list/remove handlers
 * to fail fast with a clear message on explicit project scope.
 *
 * `--scope user` is a no-op for these providers: that's already what they do
 * without the flag.
 */
export function rejectOpenClawProjectScope(provider: string, scope: Scope): void {
  if ((provider === 'openclaw' || provider === 'openhuman') && scope === 'project') {
    const label = provider === 'openhuman' ? 'OpenHuman' : 'OpenClaw';
    const home = provider === 'openhuman' ? '~/.openhuman/' : '~/.openclaw/';
    throw new Error(
      `${label} is exclusively user-scope (${home}). '--scope project' is not supported for this provider; omit the flag or pass '--scope user'.`,
    );
  }
}
