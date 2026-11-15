/**
 * Deployment Registration
 *
 * Scans deployed agent and skill directories, extracts metadata from frontmatter,
 * and registers them in the extension registry for discovery.
 *
 * @implements #56, #57
 * @architecture @docs/architecture/cli/extending-cli.md
 * @tests @test/unit/extensions/deployment-registration.test.ts
 */

import fs from 'fs';
import path from 'path';
import type { Extension, AgentMetadata, SkillMetadata, BehaviorMetadata, PlatformSupport } from './types.js';
import type { ExtensionRegistry } from './registry.js';

/**
 * Registration options
 */
export interface RegistrationOptions {
  /** Path to deployed agents directory */
  agentsPath?: string;
  /** Path, or paths, to deployed skills directories */
  skillsPath?: string | string[];
  /** Path to deployed commands directory */
  commandsPath?: string;
  /** Path to deployed rules directory */
  rulesPath?: string;
  /**
   * Path to deployed behaviors directory.
   * For OpenClaw: ~/.openclaw/behaviors/ (native).
   * For Claude Code: .claude/hooks/ (emulated).
   * Empty string means behaviors are aggregated (e.g., Warp's WARP.md) or not supported.
   *
   * @implements #609
   */
  behaviorsPath?: string;
  /** Provider platform name */
  provider: string;
  /** Working directory for relative path resolution */
  cwd?: string;
  /** Suppress scan-by-scan registry diagnostics for compact CLI output. */
  quiet?: boolean;
}

/**
 * Frontmatter parser result
 */
interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  content: string;
}

/**
 * Parse frontmatter from markdown content
 *
 * Extracts YAML frontmatter between --- delimiters.
 *
 * @param content - Markdown content
 * @returns Parsed frontmatter and remaining content
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    return { frontmatter: {}, content };
  }

  const yamlContent = fmMatch[1];
  const remainingContent = content.slice(fmMatch[0].length);

  // Simple YAML parser (basic key: value pairs)
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlContent.split('\n');

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      // Remove quotes if present
      frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return { frontmatter, content: remainingContent };
}

/**
 * Extract description from markdown content
 *
 * Looks for first paragraph after frontmatter.
 *
 * @param content - Markdown content (without frontmatter)
 * @returns Extracted description
 */
function extractDescription(content: string): string {
  // Find first paragraph
  const paragraphMatch = content.match(/^[^\n#*-]+/m);
  if (paragraphMatch) {
    return paragraphMatch[0].trim().slice(0, 200); // Limit to 200 chars
  }
  return 'No description available';
}

/**
 * Extract capabilities from agent content
 *
 * Parses ## Capabilities or ## Skills sections.
 *
 * @param content - Markdown content
 * @returns Array of capabilities
 */
function extractCapabilities(content: string): string[] {
  const capabilitiesMatch = content.match(/##\s+(?:Capabilities|Skills)\s*\n([\s\S]*?)(?=\n##|\n$)/i);
  if (!capabilitiesMatch) return [];

  const capSection = capabilitiesMatch[1];
  const items = capSection.match(/^[-*]\s+(.+)$/gm);
  if (!items) return [];

  return items.map(item => {
    const text = item.replace(/^[-*]\s+/, '').trim();
    // Extract just the capability name (before colon if present)
    const colonIdx = text.indexOf(':');
    return colonIdx > 0 ? text.slice(0, colonIdx).trim().toLowerCase() : text.toLowerCase();
  }).slice(0, 10); // Limit to 10 capabilities
}

/**
 * Extract keywords from content
 *
 * Simple keyword extraction from headings and first paragraph.
 *
 * @param content - Markdown content
 * @param name - Extension name
 * @returns Array of keywords
 */
function extractKeywords(content: string, name: string): string[] {
  const keywords = new Set<string>();

  // Add name words
  name.toLowerCase().split(/[-\s]+/).forEach(word => {
    if (word.length > 2) keywords.add(word);
  });

  // Extract from headings
  const headings = content.match(/^#+\s+(.+)$/gm);
  if (headings) {
    headings.slice(0, 5).forEach(heading => {
      const text = heading.replace(/^#+\s+/, '');
      text.toLowerCase().split(/[\s,]+/).forEach(word => {
        if (word.length > 3 && !/^(and|the|for|with|from)$/.test(word)) {
          keywords.add(word);
        }
      });
    });
  }

  return Array.from(keywords).slice(0, 10);
}

/**
 * Parse model specification from frontmatter
 *
 * Handles both simple (opus/sonnet/haiku) and full model names.
 *
 * @param modelValue - Model value from frontmatter
 * @returns Model metadata
 */
function parseModel(modelValue: unknown): AgentMetadata['model'] {
  const modelStr = String(modelValue || 'sonnet').toLowerCase();

  let tier: 'haiku' | 'sonnet' | 'opus' = 'sonnet';
  if (/haiku/i.test(modelStr)) tier = 'haiku';
  else if (/opus/i.test(modelStr)) tier = 'opus';

  return { tier };
}

/**
 * Scan deployed agents directory
 *
 * Reads agent markdown files from the deployed directory and creates Extension
 * objects with metadata extracted from frontmatter.
 *
 * @param agentsPath - Path to .claude/agents or equivalent
 * @param provider - Provider platform name
 * @param cwd - Working directory for relative path resolution
 * @returns Array of agent extensions
 */
export async function scanDeployedAgents(
  agentsPath: string,
  provider: string,
  cwd: string = process.cwd()
): Promise<Extension[]> {
  const absolutePath = path.isAbsolute(agentsPath) ? agentsPath : path.join(cwd, agentsPath);

  // Check if directory exists
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
    return [];
  }

  const agents: Extension[] = [];
  const files = fs.readdirSync(absolutePath);

  for (const file of files) {
    if (!file.endsWith('.md')) continue;

    const filePath = path.join(absolutePath, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const { frontmatter, content: bodyContent } = parseFrontmatter(content);

    // Extract ID from filename (remove .md extension)
    const id = path.basename(file, '.md');

    // Extract name (prefer frontmatter, fallback to title-cased ID)
    const name = String(frontmatter.name ||
      id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));

    // Extract description
    const description = String(frontmatter.description || extractDescription(bodyContent));

    // Extract capabilities
    const capabilities = extractCapabilities(bodyContent);

    // Extract keywords
    const keywords = extractKeywords(bodyContent, name);

    // Parse model
    const model = parseModel(frontmatter.model);

    // Extract tools (default to common tools)
    const toolsValue = frontmatter.tools || 'Read, Write, Bash';
    const tools = String(toolsValue).split(',').map(t => t.trim());

    // Extract role
    const role = String(frontmatter.role || frontmatter.description || description);

    // Build agent extension
    const agent: Extension = {
      id,
      type: 'agent',
      name,
      description,
      version: String(frontmatter.version || '1.0.0'),
      capabilities,
      keywords,
      category: String(frontmatter.category || 'agent'),
      platforms: {
        [provider]: 'full' as PlatformSupport,
      },
      deployment: {
        pathTemplate: `${agentsPath}/{id}.md`,
        core: false,
      },
      metadata: {
        type: 'agent',
        role,
        model,
        tools,
      } satisfies AgentMetadata,
      installation: {
        installedAt: new Date().toISOString(),
        installedFrom: 'local',
        installedPath: filePath,
        enabled: true,
      },
    };

    agents.push(agent);
  }

  return agents;
}

/**
 * Scan deployed skills directory
 *
 * Reads skill directories from the deployed directory and creates Extension
 * objects with metadata extracted from skill.md files.
 *
 * @param skillsPath - Path to .claude/skills or equivalent
 * @param provider - Provider platform name
 * @param cwd - Working directory for relative path resolution
 * @returns Array of skill extensions
 */
export async function scanDeployedSkills(
  skillsPath: string,
  provider: string,
  cwd: string = process.cwd()
): Promise<Extension[]> {
  const absolutePath = path.isAbsolute(skillsPath) ? skillsPath : path.join(cwd, skillsPath);

  // Check if directory exists
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
    return [];
  }

  const skills: Extension[] = [];
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });

  // Collect skill directories, descending one namespace level when a top-level
  // entry has no direct SKILL.md but holds child skill dirs — e.g. OpenClaw
  // kernel skills at ~/.openclaw/skills/aiwg/<name>/SKILL.md (PUW-025).
  // OpenClaw's own loader recurses under skill roots, so the registrar must too;
  // otherwise it reports "Registered 0 skills" for skills that actually load (#1563).
  const hasSkillFile = (dir: string): boolean =>
    fs.existsSync(path.join(dir, 'SKILL.md')) || fs.existsSync(path.join(dir, 'skill.md'));
  const skillDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(absolutePath, entry.name);
    if (hasSkillFile(dir)) {
      skillDirs.push(dir);
      continue;
    }
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const childDir = path.join(dir, child.name);
      if (hasSkillFile(childDir)) skillDirs.push(childDir);
    }
  }

  for (const skillDir of skillDirs) {
    const skillFile = path.join(skillDir, 'SKILL.md');
    const skillFileLower = path.join(skillDir, 'skill.md');
    const actualSkillFile = fs.existsSync(skillFile) ? skillFile : skillFileLower;

    const content = fs.readFileSync(actualSkillFile, 'utf8');
    const { frontmatter, content: bodyContent } = parseFrontmatter(content);

    // Extract ID from directory name
    const id = path.basename(skillDir);

    // Extract name
    const name = String(frontmatter.name ||
      id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));

    // Extract description
    const description = String(frontmatter.description || extractDescription(bodyContent));

    // Extract trigger phrases
    const triggersValue = frontmatter.triggers || frontmatter.triggerPhrases || '';
    const triggerPhrases = String(triggersValue)
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    // Extract tools
    const toolsValue = frontmatter.tools || '';
    const tools = toolsValue ? String(toolsValue).split(',').map(t => t.trim()) : undefined;

    // Build skill extension
    const skill: Extension = {
      id,
      type: 'skill',
      name,
      description,
      version: String(frontmatter.version || '1.0.0'),
      capabilities: extractCapabilities(bodyContent),
      keywords: extractKeywords(bodyContent, name),
      category: String(frontmatter.category || 'skill'),
      platforms: {
        [provider]: 'full' as PlatformSupport,
      },
      deployment: {
        pathTemplate: `${skillsPath}/{id}/skill.md`,
        additionalFiles: ['references.md'].filter(f => fs.existsSync(path.join(skillDir, f))),
        core: false,
      },
      metadata: {
        type: 'skill',
        triggerPhrases: triggerPhrases.length > 0 ? triggerPhrases : [`use ${id}`, name.toLowerCase()],
        tools,
      } satisfies SkillMetadata,
      installation: {
        installedAt: new Date().toISOString(),
        installedFrom: 'local',
        installedPath: skillDir,
        enabled: true,
      },
    };

    skills.push(skill);
  }

  return skills;
}

function inferKernelSkillsPath(skillsPath: string): string | null {
  const parsed = path.parse(skillsPath);
  const rel = parsed.root ? path.relative(parsed.root, skillsPath) : skillsPath;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  const aiwgIdx = segments.lastIndexOf('.aiwg');

  if (aiwgIdx < 0) return null;
  const next = segments[aiwgIdx + 1];
  if (next !== 'skills' && next !== 'skill') return null;

  const kernelSegments = [...segments.slice(0, aiwgIdx), ...segments.slice(aiwgIdx + 1)];
  const kernelPath = parsed.root
    ? path.join(parsed.root, ...kernelSegments)
    : path.join(...kernelSegments);

  return kernelPath && kernelPath !== skillsPath ? kernelPath : null;
}

function uniqueSkillPaths(skillsPath: string | string[]): string[] {
  const inputs = Array.isArray(skillsPath) ? skillsPath : [skillsPath];
  const paths: string[] = [];

  for (const p of inputs) {
    if (!p) continue;
    paths.push(p);
    const kernelPath = inferKernelSkillsPath(p);
    if (kernelPath) paths.push(kernelPath);
  }

  return [...new Set(paths)];
}

/**
 * Scan deployed behaviors directory
 *
 * Reads behavior directories from the deployed path and creates Extension objects
 * with metadata extracted from BEHAVIOR.md frontmatter.
 *
 * Behaviors are directories containing a BEHAVIOR.md file and optionally a scripts/
 * subdirectory. On OpenClaw this is the native format; on other providers behaviors
 * are emulated via hook wrappers or session injection.
 *
 * @param behaviorsPath - Path to deployed behaviors directory (e.g., ~/.openclaw/behaviors/)
 * @param provider - Provider platform name
 * @param cwd - Working directory for relative path resolution
 * @returns Array of behavior extensions
 *
 * @implements #609
 */
export async function scanDeployedBehaviors(
  behaviorsPath: string,
  provider: string,
  cwd: string = process.cwd()
): Promise<Extension[]> {
  if (!behaviorsPath) return [];

  const absolutePath = path.isAbsolute(behaviorsPath) ? behaviorsPath : path.join(cwd, behaviorsPath);

  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
    return [];
  }

  const behaviors: Extension[] = [];
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const behaviorDir = path.join(absolutePath, entry.name);
    const behaviorFile = path.join(behaviorDir, 'BEHAVIOR.md');

    if (!fs.existsSync(behaviorFile)) continue;

    const content = fs.readFileSync(behaviorFile, 'utf8');
    const { frontmatter, content: bodyContent } = parseFrontmatter(content);

    const id = entry.name;
    const name = String(frontmatter.name ||
      id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
    const description = String(frontmatter.description || extractDescription(bodyContent));
    const keywords = extractKeywords(bodyContent, name);

    const behavior: Extension = {
      id,
      type: 'behavior',
      name,
      description,
      version: String(frontmatter.version || '1.0.0'),
      capabilities: [],
      keywords,
      category: String(frontmatter.category || 'behavior'),
      platforms: {
        [provider]: 'full' as PlatformSupport,
      },
      deployment: {
        pathTemplate: `${behaviorsPath}/{id}/BEHAVIOR.md`,
        core: false,
      },
      metadata: {
        type: 'behavior',
      } satisfies BehaviorMetadata,
      installation: {
        installedAt: new Date().toISOString(),
        installedFrom: 'local',
        installedPath: behaviorDir,
        enabled: true,
      },
    };

    behaviors.push(behavior);
  }

  return behaviors;
}

/**
 * Register deployed extensions in the registry
 *
 * Scans deployed agent, skill, and behavior directories, creates Extension objects,
 * and registers them in the provided registry.
 *
 * @param registry - Extension registry to populate
 * @param options - Registration options
 *
 * @example
 * ```typescript
 * import { getRegistry } from './registry.js';
 * import { registerDeployedExtensions } from './deployment-registration.js';
 *
 * const registry = getRegistry();
 * await registerDeployedExtensions(registry, {
 *   agentsPath: '.claude/agents',
 *   skillsPath: '.claude/skills',
 *   provider: 'claude',
 * });
 *
 * // Now list all deployed agents
 * const agents = registry.getByType('agent');
 * console.log(`Deployed ${agents.length} agents`);
 * ```
 */
export async function registerDeployedExtensions(
  registry: ExtensionRegistry,
  options: RegistrationOptions
): Promise<void> {
  const { agentsPath, skillsPath, behaviorsPath, provider, cwd, quiet = false } = options;

  // Scan and register agents
  if (agentsPath) {
    const agents = await scanDeployedAgents(agentsPath, provider, cwd);
    for (const agent of agents) {
      registry.register(agent);
    }
    if (!quiet) console.log(`Registered ${agents.length} agents from ${agentsPath}`);
  }

  // Scan and register skills
  if (skillsPath) {
    let total = 0;
    const perPath: string[] = [];
    for (const pathToScan of uniqueSkillPaths(skillsPath)) {
      const skills = await scanDeployedSkills(pathToScan, provider, cwd);
      for (const skill of skills) {
        registry.register(skill);
      }
      total += skills.length;
      perPath.push(`${skills.length} from ${pathToScan}`);
    }
    if (!quiet) console.log(`Registered ${total} skills (${perPath.join(', ')})`);
  }

  // Scan and register behaviors (#609)
  if (behaviorsPath) {
    const behaviors = await scanDeployedBehaviors(behaviorsPath, provider, cwd);
    for (const behavior of behaviors) {
      registry.register(behavior);
    }
    if (!quiet && behaviors.length > 0) {
      console.log(`Registered ${behaviors.length} behaviors from ${behaviorsPath}`);
    }
  }

  // Commands are already registered via command definitions, so we skip scanning
}
