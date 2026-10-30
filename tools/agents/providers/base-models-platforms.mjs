// Shared provider models platforms utilities.
import { resolveAiwgRoot } from './base-inventory.mjs';
import { fs, os, path, yaml } from './base-runtime.mjs';


// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Load model configuration from models.json
 * Priority: Project models.json > User ~/.config/aiwg/models.json > AIWG defaults
 */
export function loadModelConfig(srcRoot) {
  // An addon/framework/bundle `--source` is not the AIWG root, so resolve the
  // shipped defaults through the corpus root; otherwise addon deploys fell
  // through to the hardcoded fallback and deployed bare aliases (#2563).
  const aiwgRoot = (srcRoot && resolveAiwgRoot(srcRoot)) || srcRoot;
  const locations = [
    { path: path.join(process.cwd(), 'models.json'), label: 'project' },
    { path: path.join(process.env.HOME || process.env.USERPROFILE, '.config', 'aiwg', 'models.json'), label: 'user' },
    { path: path.join(aiwgRoot, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'config', 'models.json'), label: 'AIWG defaults' }
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc.path)) {
      try {
        const config = JSON.parse(fs.readFileSync(loc.path, 'utf8'));
        config._source = `${loc.label} (${loc.path})`;
        return config;
      } catch (err) {
        console.warn(`Warning: Could not parse models.json at ${loc.path}: ${err.message}`);
      }
    }
  }

  // Fallback to hardcoded defaults if no config found
  return {
    claude: {
      reasoning: { model: 'claude-opus-5' },
      coding: { model: 'claude-sonnet-5' },
      efficiency: { model: 'claude-haiku-4-5' }
    },
    factory: {
      reasoning: { model: 'heavy' },
      coding: { model: 'medium' },
      efficiency: { model: 'light' }
    },
    shorthand: {
      'opus': 'claude-opus-5',
      'sonnet': 'claude-sonnet-5',
      'haiku': 'claude-haiku-4-5',
      'inherit': 'inherit'
    },
    claude_shorthand: {
      'opus': 'opus',
      'opus-1m': 'opus[1m]',
      'opus[1m]': 'opus[1m]',
      'sonnet': 'sonnet',
      'sonnet-1m': 'sonnet[1m]',
      'sonnet[1m]': 'sonnet[1m]',
      'haiku': 'haiku',
      'inherit': 'inherit'
    }
  };
}


/**
 * Load a fresh dynamically-discovered model catalog when available, otherwise
 * use the committed catalog supplied by the caller. Refresh is performed by
 * `aiwg models refresh`; deployment itself never performs network access.
 */
export function loadRuntimeModelCatalog(staticCatalog, options = {}) {
  if (process.env.VITEST && !options.cacheFile && !options.homeDir) return staticCatalog;
  const homeDir = options.homeDir || os.homedir();
  const cacheFile = options.cacheFile || path.join(homeDir, '.cache', 'aiwg', 'model-catalog.v1.json');
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const fetchedAt = Date.parse(cached?.discovery?.fetchedAt || '');
    const age = Date.now() - fetchedAt;
    if (
      cached?.providers &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= ttlMs
    ) {
      return cached;
    }
  } catch {
    // Missing, stale, or malformed cache: deterministic static fallback.
  }
  return staticCatalog;
}


// ============================================================================
// Frontmatter Utilities
// ============================================================================

/**
 * Maps provider names to the platform identifiers used in skill platforms: fields.
 * Skills use descriptive names (e.g. "claude-code") while providers use short names (e.g. "claude").
 */
export const PROVIDER_TO_PLATFORM = {
  'claude': 'claude-code'
};


/**
 * Parse the platforms: field from a SKILL.md frontmatter block.
 * Accepts a string or a list of strings; all alone means unrestricted.
 * Returns null if platforms is missing, or no frontmatter is present.
 * Returns an empty array for malformed frontmatter or invalid platforms.
 */
export function parseSkillPlatforms(content) {
  // A leading UTF-8 BOM must not hide the frontmatter (and its restrictions).
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!fmMatch || fmMatch.index !== 0) {
    return /^---[ \t]*(?:\r?\n|$)/.test(content) ? [] : null;
  }

  let metadata;
  try {
    const document = yaml.parseDocument(fmMatch[1]);
    if (document.errors.length > 0) return [];
    if (!document.contents) return null; // Empty frontmatter has no restrictions.
    metadata = document.toJS();
  } catch {
    return [];
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  // The yaml package leaves merge keys unresolved, so platforms could arrive only
  // through `<<`; without an explicit key that is ambiguous, so fail closed.
  if (!Object.hasOwn(metadata, 'platforms')) return Object.hasOwn(metadata, '<<') ? [] : null;

  const platforms = metadata.platforms;
  const items = typeof platforms === 'string' ? [platforms] : platforms;
  if (!Array.isArray(items) || !items.every(item => typeof item === 'string')) return [];
  const normalized = items.map(item => item.trim());
  if (normalized.some(item => !item)) return [];
  return normalized.length === 1 && normalized[0] === 'all' ? null : normalized;
}


/**
 * Returns true if a skill (given its source content) should be deployed to the given provider.
 * If no provider is specified, always returns true.
 */
export function skillMatchesProvider(content, provider) {
  if (!provider) return true;

  const platforms = parseSkillPlatforms(content);
  if (!platforms) return true; // No restriction

  const platformName = PROVIDER_TO_PLATFORM[provider] || provider;
  return platforms.includes(platformName) || platforms.includes(provider);
}


/**
 * Inject the target platform name into a SKILL.md frontmatter block.
 *
 * Source skills use platforms: [all] as a deployment token.
 * At deploy time this function replaces [all] with [<targetPlatform>] so
 * each deployed copy accurately reflects where it was installed.
 *
 * Explicit restriction lists (not [all]) are preserved as-is.
 * If no platforms: field is present, one is added.
 */
export function injectPlatformInContent(content, targetPlatform) {
  if (!targetPlatform) return content;

  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, open, fm, close, body] = fmMatch;

  const injected = `platforms: [${targetPlatform}]`;

  // Case 1: inline [all] token → replace with target platform
  let updated = fm.replace(/^platforms:\s*\[all\]\n?/m, injected + '\n');
  if (updated !== fm) return open + updated + close + body;

  // Case 2: inline explicit restriction (not [all]) → leave as-is, do not inject
  if (/^platforms:\s*\[(?!all\])[^\]]+\]/m.test(fm)) {
    return content;
  }

  // Case 3: multi-line list → replace entire block with injected value
  updated = fm.replace(/^platforms:\s*\n(?:[ \t]+-[ \t]+\S[^\n]*\n?)*/m, injected + '\n');
  if (updated !== fm) return open + updated + close + body;

  // Case 4: bare `platforms:` with no value → replace
  updated = fm.replace(/^platforms:\s*$/m, injected);
  if (updated !== fm) return open + updated + close + body;

  // Case 5: no platforms: field at all → insert after the first frontmatter line
  const fmLines = fm.split('\n');
  fmLines.splice(1, 0, injected);
  return open + fmLines.join('\n') + close + body;
}


/**
 * Remove the `platforms:` field from a SKILL.md frontmatter block.
 *
 * Hermes (and other providers that treat `platforms:` as an OS gate —
 * linux / macos / windows) hide any skill whose value isn't a recognized
 * OS. AIWG source skills use the field as a *provider* restriction token
 * (`[all]`, provider names), which is the opposite meaning, so deployed
 * copies destined for such providers must drop the field entirely. An
 * absent field is the documented "compatible with all platforms" default.
 */
/**
 * Remove the `triggers:` field from a deployed rule's frontmatter.
 *
 * Rules declare trigger phrases so `aiwg discover` can reach them by the
 * question an agent asks rather than by their policy name (#2544). That is
 * index-time metadata: no provider matches a *rule* by trigger, and the agent
 * reading the deployed rule gains nothing from the list. Shipping it spends
 * startup context on noise, which is exactly the budget #2540 is defending —
 * ~2KB across the 16 rules covered today, and ~16KB if every rule adopts.
 *
 * Skills are untouched: several providers do match skills by trigger.
 */
export function stripTriggersFromContent(content) {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, open, fm, close, body] = fmMatch;
  // Block list form:
  //   triggers:
  //     - "am I allowed to do this"
  let updated = fm.replace(
    /^triggers:[ \t]*\r?\n(?:[ \t]+-[ \t]+\S[^\r\n]*(?:\r?\n|$))*/m,
    '',
  );
  // Inline form: triggers: ["a", "b"]
  if (updated === fm) updated = fm.replace(/^triggers:[^\r\n]*(?:\r?\n|$)/m, '');

  if (updated === fm) return content;
  // An otherwise-empty frontmatter block is dropped rather than left as `---\n---`.
  if (updated.trim().length === 0) return body.replace(/^\r?\n/, '');
  // Removing a block mid-frontmatter can leave a trailing blank line before the
  // closing fence; the deployed file should not carry it.
  return open + updated.replace(/\s+$/, '') + close + body;
}


export function stripPlatformsFromContent(content) {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))([\s\S]*)$/);
  if (!fmMatch) return content;

  const [, open, fm, close, body] = fmMatch;
  let updated = fm.replace(/^platforms:[^\r\n]*(?:\r?\n|$)/m, '');

  // Multi-line list form:
  //   platforms:
  //     - claude-code
  //     - hermes
  if (updated === fm) {
    updated = fm.replace(
      /^platforms:[ \t]*\r?\n(?:[ \t]+-[ \t]+\S[^\r\n]*(?:\r?\n|$))*/m,
      '',
    );
  }

  if (updated === fm) return content;
  return open + updated + close + body;
}
