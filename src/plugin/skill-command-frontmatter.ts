// Parse the portable skill command frontmatter contract.
export interface SkillFrontmatter {
  description?: string;
  commandHint?: {
    argumentHint?: string;
    allowedTools?: string | string[];
    template?: string;
    model?: string;
    modelRole?: 'reasoning' | 'coding' | 'efficiency';
    modelTier?: 'economy' | 'standard' | 'premium';
    modelEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    modelRationale?: string;
    category?: string;
    orchestration?: boolean;
    executionSteps?: string[];
    cliDisabled?: boolean;
  };
  userInvocable?: boolean;
  effort?: number;
  context?: string;
  disableModelInvocation?: boolean;
  allowedTools?: string | string[];
}

// ============================================
// Provider Configuration
// ============================================

/**
 * Providers that need command files generated from skills.
 *
 * Providers not listed here get skills deployed natively (no translation needed).
 */
const PROVIDERS_NEEDING_COMMANDS = new Set([
  'factory',
  'opencode',  // OpenCode scans .opencode/command/**/*.md via ConfigCommand.load() (PUW-006 #1107)
  'warp',
  'windsurf',
  'copilot',
  'codex',
  'openclaw',
]);

/**
 * Providers where skills are deployed natively (no command generation needed).
 */
const SKILLS_ONLY_PROVIDERS = new Set([
  'antigravity',
  'claude',
  'cursor',
  'grokbot',
  'hermes',
  'muse', // #236: skills deploy natively; no command translation (indexed-only agents/commands/rules)
  'openhuman',
  'pi',
  'omp',
]);

/**
 * Check if a provider needs command files generated from skills.
 */
export function providerNeedsCommands(provider: string): boolean {
  return PROVIDERS_NEEDING_COMMANDS.has(provider);
}

/**
 * Check if a provider uses skills natively (no command translation).
 */
export function providerUsesSkillsNatively(provider: string): boolean {
  return SKILLS_ONLY_PROVIDERS.has(provider);
}

// ============================================
// Frontmatter Parsing
// ============================================

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 *
 * This is a lightweight parser that handles the subset of YAML used in
 * SKILL.md frontmatter. For full YAML support, a library like js-yaml
 * would be needed, but the frontmatter format is simple enough for this.
 */
export function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: content };
  }

  const fmRaw = fmMatch[1];
  const body = fmMatch[2];
  const frontmatter: SkillFrontmatter = {};

  // Parse top-level keys
  const lines = fmRaw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // description: ...
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) {
      frontmatter.description = descMatch[1].trim();
      i++;
      continue;
    }

    // userInvocable: false
    const uiMatch = line.match(/^userInvocable:\s*(true|false)/i);
    if (uiMatch) {
      frontmatter.userInvocable = uiMatch[1].toLowerCase() === 'true';
      i++;
      continue;
    }

    // user-invocable: false (kebab-case variant)
    const uiKebabMatch = line.match(/^user-invocable:\s*(true|false)/i);
    if (uiKebabMatch) {
      frontmatter.userInvocable = uiKebabMatch[1].toLowerCase() === 'true';
      i++;
      continue;
    }

    // effort: N
    const effortMatch = line.match(/^effort:\s*(\d+)/);
    if (effortMatch) {
      frontmatter.effort = parseInt(effortMatch[1], 10);
      i++;
      continue;
    }

    // context: fork|inherit
    const ctxMatch = line.match(/^context:\s*(\w+)/);
    if (ctxMatch) {
      frontmatter.context = ctxMatch[1];
      i++;
      continue;
    }

    // disableModelInvocation: true
    const dmiMatch = line.match(/^(?:disableModelInvocation|disable-model-invocation):\s*(true|false)/i);
    if (dmiMatch) {
      frontmatter.disableModelInvocation = dmiMatch[1].toLowerCase() === 'true';
      i++;
      continue;
    }

    // allowed-tools: (top-level, for the skill itself)
    const atMatch = line.match(/^allowed-tools:\s*(.+)/);
    if (atMatch) {
      frontmatter.allowedTools = atMatch[1].trim();
      i++;
      continue;
    }

    // commandHint: block
    if (line.match(/^commandHint:\s*$/)) {
      const hint: SkillFrontmatter['commandHint'] = {};
      i++;
      while (i < lines.length && lines[i].match(/^\s+/)) {
        const hintLine = lines[i].trim();

        const ahMatch = hintLine.match(/^argumentHint:\s*(.+)/);
        if (ahMatch) { hint.argumentHint = ahMatch[1].trim(); i++; continue; }

        const hatMatch = hintLine.match(/^allowedTools:\s*(.+)/);
        if (hatMatch) { hint.allowedTools = hatMatch[1].trim(); i++; continue; }

        const tmplMatch = hintLine.match(/^template:\s*(.+)/);
        if (tmplMatch) { hint.template = tmplMatch[1].trim(); i++; continue; }

        const modMatch = hintLine.match(/^model:\s*(.+)/);
        if (modMatch) { hint.model = modMatch[1].trim(); i++; continue; }

        const roleMatch = hintLine.match(/^modelRole:\s*(reasoning|coding|efficiency)\s*$/);
        if (roleMatch) { hint.modelRole = roleMatch[1] as NonNullable<typeof hint.modelRole>; i++; continue; }

        const tierMatch = hintLine.match(/^modelTier:\s*(economy|standard|premium)\s*$/);
        if (tierMatch) { hint.modelTier = tierMatch[1] as NonNullable<typeof hint.modelTier>; i++; continue; }

        const effortMatch = hintLine.match(/^modelEffort:\s*(minimal|low|medium|high|xhigh)\s*$/);
        if (effortMatch) { hint.modelEffort = effortMatch[1] as NonNullable<typeof hint.modelEffort>; i++; continue; }

        const rationaleMatch = hintLine.match(/^modelRationale:\s*(.+)$/);
        if (rationaleMatch) { hint.modelRationale = rationaleMatch[1].trim(); i++; continue; }

        const catMatch = hintLine.match(/^category:\s*(.+)/);
        if (catMatch) { hint.category = catMatch[1].trim(); i++; continue; }

        const orchMatch = hintLine.match(/^orchestration:\s*(true|false)/i);
        if (orchMatch) { hint.orchestration = orchMatch[1].toLowerCase() === 'true'; i++; continue; }

        const cliMatch = hintLine.match(/^cliDisabled:\s*(true|false)/i);
        if (cliMatch) { hint.cliDisabled = cliMatch[1].toLowerCase() === 'true'; i++; continue; }

        i++;
      }
      frontmatter.commandHint = hint;
      continue;
    }

    i++;
  }

  return { frontmatter, body };
}
