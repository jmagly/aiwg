/**
 * Skill→Command Translation Layer
 *
 * Generates command files from canonical SKILL.md sources for providers that
 * require command format natively (Factory, OpenCode, Warp, Windsurf, Copilot,
 * Codex, OpenClaw).
 *
 * Skills are the canonical source format; commands are deployment artifacts.
 * See ADR: Skills as the Canonical Extension Type.
 *
 * @implements .aiwg/architecture/adr-skills-canonical-extension-type.md
 * @issue #550
 */

import fs from 'fs/promises';
import path from 'path';
export { parseFrontmatter, providerNeedsCommands, providerUsesSkillsNatively } from './skill-command-frontmatter.js';
import { recordManagedCommands } from './command-ownership.js';
import { parseFrontmatter, providerNeedsCommands, type SkillFrontmatter } from './skill-command-frontmatter.js';

/**
 * Ownership signal for generated command files (#2507).
 *
 * Command wrappers were written as bare files: no `aiwg:managed` marker and no
 * `.aiwg-manifest.json` entry. AIWG could neither count them as deployed nor
 * recognise them as its own, so a later run reported the wrappers it had just
 * written as unmanaged artifacts the operator should delete. They now carry the
 * same signals as any other deployed artifact, tagged `skill-command` so the
 * flat-command prune leaves them to the skills prune that governs their source.
 */
const MANAGED_MARKER_PATTERN = /^(?:<!--\s*aiwg:managed\s|#\s*aiwg:managed\s)/m;

function addManagedMarker(content: string, version: string, source: string): string {
  if (MANAGED_MARKER_PATTERN.test(content)) return content;
  if (content.startsWith('---\n')) {
    return content.replace(/^---\n/, `---\n# aiwg:managed v${version} ${source}\n`);
  }
  return `<!-- aiwg:managed v${version} ${source} -->\n${content}`;
}

// ============================================
// Types
// ============================================

export interface TranslationOptions {
  /** Target provider name */
  provider: string;
  /** Target directory for generated command files */
  targetDir: string;
  /** If true, return results without writing files */
  dryRun?: boolean;
  /** If true, log verbose output */
  verbose?: boolean;
  /**
   * Version stamped into the managed marker and sidecar entry for generated
   * commands. Defaults to `unknown` when the caller has no version context.
   */
  deployVersion?: string;
  /**
   * Project root path. Used by per-provider dual-write paths (e.g., Copilot
   * `.github/prompts/<id>.prompt.md`). When omitted, dual-write derives the
   * root from `path.dirname(path.dirname(targetDir))` which works for
   * standard `<root>/.github/commands/` layouts but not arbitrary test
   * fixtures. Pass `projectPath` explicitly when targetDir is non-standard.
   */
  projectPath?: string;
  /**
   * Optional filter — only skills whose name returns true from this predicate
   * are translated. When omitted, all skills are translated. Used by Claude
   * (PUW-015 #1116) to limit translation to flow-* skills + a small allowlist
   * of operator-invocable command surfaces.
   */
  nameFilter?: (skillName: string) => boolean;
}

export interface TranslatedCommand {
  /** Skill source path */
  sourcePath: string;
  /** Skill name (from directory name) */
  skillName: string;
  /** Generated command filename */
  commandFilename: string;
  /** Generated command content */
  content: string;
  /** Whether the skill was skipped (e.g., userInvocable: false) */
  skipped: boolean;
  /** Reason for skipping */
  skipReason?: string;
}

export interface TranslationResult {
  /** Provider that was targeted */
  provider: string;
  /** Target directory for generated commands */
  targetDir: string;
  /** Successfully translated commands */
  translated: TranslatedCommand[];
  /** Skipped skills (background-only, etc.) */
  skipped: TranslatedCommand[];
  /** Errors encountered during translation */
  errors: { skillName: string; error: string }[];
  /** Total skills processed */
  totalProcessed: number;
}

/**
 * Parsed SKILL.md frontmatter fields relevant to command translation
 */
// ============================================
// Command Generation
// ============================================

/**
 * Generate a command .md file content from parsed skill data.
 *
 * Maps SKILL.md frontmatter to legacy command frontmatter format:
 * - `description:` from skill description
 * - `argument-hint:` from commandHint.argumentHint
 * - `allowed-tools:` from commandHint.allowedTools (comma-separated)
 */
export function generateCommandContent(
  _skillName: string,
  frontmatter: SkillFrontmatter,
  body: string,
  provider?: string,
): string {
  const lines: string[] = ['---'];

  // description is always included
  if (frontmatter.description) {
    lines.push(`description: ${frontmatter.description}`);
  }

  const hint = frontmatter.commandHint;

  // argument-hint from commandHint
  if (hint?.argumentHint) {
    lines.push(`argument-hint: ${hint.argumentHint}`);
  }

  // allowed-tools: prefer commandHint.allowedTools, fall back to top-level allowedTools
  const tools = hint?.allowedTools ?? frontmatter.allowedTools;
  if (tools) {
    const toolStr = Array.isArray(tools) ? tools.join(', ') : tools;
    lines.push(`allowed-tools: ${toolStr}`);
  }

  const modelPolicy = resolveSkillModelPolicy(hint);
  if (modelPolicy) {
    lines.push(`aiwg-model-role: ${modelPolicy.modelRole}`);
    lines.push(`aiwg-model-tier: ${modelPolicy.modelTier}`);
    if (modelPolicy.modelEffort) lines.push(`aiwg-model-effort: ${modelPolicy.modelEffort}`);
    if (hint?.modelRationale) lines.push(`aiwg-model-rationale: ${hint.modelRationale}`);
    if (provider === 'claude') {
      lines.push(`model: ${modelPolicy.legacyModel}`);
      if (modelPolicy.modelEffort) {
        const effort = modelPolicy.modelEffort === 'medium' ? 2
          : modelPolicy.modelEffort === 'high' || modelPolicy.modelEffort === 'xhigh' ? 3 : 1;
        lines.push(`effort: ${effort}`);
      }
    }
  }

  lines.push('---');
  lines.push('');

  // Body content is passed through unchanged
  lines.push(body.trimStart());

  return lines.join('\n');
}

// ============================================
// Translation Pipeline
// ============================================

/**
 * Translate all skills in a directory to command files.
 *
 * Reads each subdirectory in `skillsDir` as a skill, parses SKILL.md,
 * and generates a corresponding command .md file.
 *
 * @param skillsDir - Source skills directory (e.g., `agentic/code/frameworks/sdlc-complete/skills/`)
 * @param options - Translation options (provider, target dir, dry-run)
 * @returns Translation result with counts and any errors
 */
export async function translateSkillsToCommands(
  skillsDir: string,
  options: TranslationOptions,
): Promise<TranslationResult> {
  const result: TranslationResult = {
    provider: options.provider,
    targetDir: options.targetDir,
    translated: [],
    skipped: [],
    errors: [],
    totalProcessed: 0,
  };
  // Ownership records for the commands this call writes (#2507).
  const managedEntries: { filename: string; content: string; sourcePath: string }[] = [];
  const promptEntries: { filename: string; content: string; sourcePath: string }[] = [];

  // Check if this provider needs commands. nameFilter overrides the
  // provider gating: when an operator passes an explicit filter (e.g. Claude
  // flow→command emission per PUW-015 #1116), they're opting in to selective
  // translation regardless of the provider's default skills-native posture.
  if (!options.nameFilter && !providerNeedsCommands(options.provider)) {
    if (options.verbose) {
      console.log(`  Provider '${options.provider}' uses skills natively — skipping command generation`);
    }
    return result;
  }

  // Read skill directories
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(skillsDir, { withFileTypes: true });
    entries = dirEntries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    // No skills directory — nothing to translate
    return result;
  }

  // Process each skill
  for (const skillName of entries) {
    // Apply name filter when provided (PUW-015 / #1116 — Claude flow filter).
    if (options.nameFilter && !options.nameFilter(skillName)) {
      continue;
    }
    result.totalProcessed++;
    const skillMdPath = path.join(skillsDir, skillName, 'SKILL.md');

    try {
      const content = await fs.readFile(skillMdPath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      // Skip background-only skills (userInvocable: false)
      if (frontmatter.userInvocable === false) {
        const skipped: TranslatedCommand = {
          sourcePath: skillMdPath,
          skillName,
          commandFilename: `${skillName}.md`,
          content: '',
          skipped: true,
          skipReason: 'userInvocable: false (background-only skill)',
        };
        result.skipped.push(skipped);
        if (options.verbose) {
          console.log(`  Skipped: ${skillName} (background-only)`);
        }
        continue;
      }

      // Generate command content
      const commandContent = addManagedMarker(
        generateCommandContent(skillName, frontmatter, body, options.provider),
        options.deployVersion ?? 'unknown',
        'bundled',
      );
      const commandFilename = `${skillName}.md`;

      const translated: TranslatedCommand = {
        sourcePath: skillMdPath,
        skillName,
        commandFilename,
        content: commandContent,
        skipped: false,
      };

      // Write file (unless dry-run)
      if (!options.dryRun) {
        const targetPath = path.join(options.targetDir, commandFilename);
        await fs.mkdir(options.targetDir, { recursive: true });
        await fs.writeFile(targetPath, commandContent, 'utf-8');

        // Copilot dual-write per PUW-004 (#1105): also emit to
        // `.github/prompts/<skill>.prompt.md` so Copilot Chat picks up the
        // skills as `/`-invocable prompt files. Always-deploy invariant
        // (ADR-1 §0.6) keeps the legacy `.github/commands/` write above.
        if (options.provider === 'copilot') {
          const projectRoot = options.projectPath
            ?? path.dirname(path.dirname(options.targetDir));
          const promptsDir = path.join(projectRoot, '.github', 'prompts');
          const promptPath = path.join(promptsDir, `${skillName}.prompt.md`);
          await fs.mkdir(promptsDir, { recursive: true });
          await fs.writeFile(promptPath, commandContent, 'utf-8');
          promptEntries.push({ filename: `${skillName}.prompt.md`, content: commandContent, sourcePath: skillMdPath });
        }
        managedEntries.push({ filename: commandFilename, content: commandContent, sourcePath: skillMdPath });
      }

      result.translated.push(translated);
      if (options.verbose) {
        console.log(`  Translated: ${skillName} → ${commandFilename}`);
      }
    } catch (error) {
      // SKILL.md might not exist (skill has no markdown file) — skip gracefully
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('ENOENT')) {
        // No SKILL.md — skip silently
        continue;
      }
      result.errors.push({ skillName, error: errMsg });
      if (options.verbose) {
        console.error(`  Error: ${skillName} — ${errMsg}`);
      }
    }
  }

  if (!options.dryRun) {
    const version = options.deployVersion ?? 'unknown';
    await recordManagedCommands(options.targetDir, managedEntries, version, 'bundled');
    if (promptEntries.length > 0) {
      const projectRoot = options.projectPath
        ?? path.dirname(path.dirname(options.targetDir));
      await recordManagedCommands(
        path.join(projectRoot, '.github', 'prompts'),
        promptEntries,
        version,
        'bundled',
      );
    }
  }

  return result;
}

/**
 * Translate a single SKILL.md content string to command format.
 *
 * Convenience function for testing and one-off translations.
 *
 * @param skillName - Skill name (used for display only)
 * @param skillContent - Raw SKILL.md file content
 * @returns Generated command .md content, or null if skill should be skipped
 */
export function translateSingleSkill(
  skillName: string,
  skillContent: string,
  provider?: string,
): string | null {
  const { frontmatter, body } = parseFrontmatter(skillContent);

  // Skip background-only skills
  if (frontmatter.userInvocable === false) {
    return null;
  }

  return generateCommandContent(skillName, frontmatter, body, provider);
}

export interface ResolvedSkillModelPolicy {
  modelRole: 'reasoning' | 'coding' | 'efficiency';
  modelTier: 'economy' | 'standard' | 'premium';
  modelEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  legacyModel: 'opus' | 'sonnet' | 'haiku';
  source: 'canonical' | 'legacy';
}

/** Deterministically migrate legacy commandHint.model into portable intent. */
export function resolveSkillModelPolicy(
  hint: SkillFrontmatter['commandHint'],
): ResolvedSkillModelPolicy | null {
  if (!hint) return null;
  const legacy = hint.model?.trim().toLowerCase();
  const legacyRole = legacy === 'opus' ? 'reasoning'
    : legacy === 'haiku' ? 'efficiency'
      : legacy ? 'coding' : undefined;
  const modelRole = hint.modelRole ?? legacyRole;
  if (!modelRole) return null;
  const modelTier = hint.modelTier
    ?? (modelRole === 'reasoning' ? 'premium'
      : modelRole === 'efficiency' ? 'economy' : 'standard');
  return {
    modelRole,
    modelTier,
    modelEffort: hint.modelEffort,
    legacyModel: modelRole === 'reasoning' ? 'opus'
      : modelRole === 'efficiency' ? 'haiku' : 'sonnet',
    source: hint.modelRole || hint.modelTier ? 'canonical' : 'legacy',
  };
}
