// Shared provider models platforms utilities.
import { fileURLToPath } from 'node:url';
import { resolveAiwgRoot } from './base-inventory.mjs';
import { createRequire, fs, os, path, yaml } from './base-runtime.mjs';


// ============================================================================
// Model Configuration
// ============================================================================

const isPlainObject = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

/** Merge plain objects; malformed overrides cannot erase inherited object fields. */
function mergeModelConfig(base, layer, source, prefix = '') {
  const merged = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (['_source', '__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const field = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(base[key]) && !isPlainObject(value)) {
      console.warn(`Warning: Ignoring non-object models.json key "${field}" at ${source}; keeping inherited object`);
      continue;
    }
    merged[key] = isPlainObject(value)
      ? mergeModelConfig(isPlainObject(base[key]) ? base[key] : {}, value, source, field)
      : value;
  }
  return merged;
}

/**
 * Merge model configuration: AIWG defaults ← user ← project.
 * Omitted fields inherit; object fields require object overrides. _source lists applied layers.
 */
export function loadModelConfig(srcRoot) {
  // Bundle sources are not corpus roots. If no corpus can be found, read the
  // defaults shipped beside this loader before falling back to the catalog.
  const aiwgRoot = (srcRoot && resolveAiwgRoot(srcRoot)) || srcRoot;
  const shippedPath = 'agentic/code/frameworks/sdlc-complete/config/models.json';
  const bundledPath = new URL(`../../../${shippedPath}`, import.meta.url);
  const defaultPaths = [...new Set([
    ...(aiwgRoot ? [path.join(aiwgRoot, shippedPath)] : []),
    fileURLToPath(bundledPath),
  ])];
  function readConfig(file) {
    if (!fs.existsSync(file)) return null;
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('expected a JSON object');
      }
      return config;
    } catch (err) {
      console.warn(`Warning: Could not parse models.json at ${file}: ${err.message}`);
      return null;
    }
  }

  let config;
  const sources = [];
  for (const file of defaultPaths) {
    config = readConfig(file);
    if (config) {
      sources.push(`AIWG defaults (${file})`);
      break;
    }
  }
  if (!config) {
    const catalog = createRequire(import.meta.url)('../../../agentic/code/providers/model-catalog.v1.json');
    config = {};
    for (const provider of ['claude', 'factory']) {
      config[provider] = Object.fromEntries(Object.entries(catalog.providers[provider].roles)
        .map(([role, entry]) => [role, { model: entry.id }]));
    }
    // Windsurf's catalog currently has only "inherited" placeholders. Until it
    // supplies concrete IDs, use Factory's API pins, matching shipped Windsurf.
    config.windsurf = Object.fromEntries(Object.entries(config.factory).map(([role, entry]) => {
      const id = catalog.providers.windsurf?.roles?.[role]?.id;
      return [role, { model: typeof id === 'string' && id.trim() && id !== 'inherited' ? id : entry.model }];
    }));
    config.shorthand = { inherit: 'inherit' };
    config.claude_shorthand = { inherit: 'inherit' };
    for (const [alias, role] of Object.entries({ opus: 'reasoning', sonnet: 'coding', haiku: 'efficiency' })) {
      config.shorthand[alias] = config.claude[role].model;
      config.claude_shorthand[alias] = alias;
      if (alias !== 'haiku') {
        config.claude_shorthand[`${alias}-1m`] = `${alias}[1m]`;
        config.claude_shorthand[`${alias}[1m]`] = `${alias}[1m]`;
      }
    }
    sources.push('model catalog (fallback)');
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  for (const loc of [
    { path: path.join(homeDir, '.config', 'aiwg', 'models.json'), label: 'user' },
    { path: path.join(process.cwd(), 'models.json'), label: 'project' },
  ]) {
    const layer = readConfig(loc.path);
    if (layer) {
      config = mergeModelConfig(config, layer, loc.path);
      sources.push(`${loc.label} (${loc.path})`);
    }
  }
  return { ...config, _source: sources.join(' ← ') };
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
