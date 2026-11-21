/**
 * Provider Hook Capabilities
 *
 * Defines @-link support, hook file names, and directives for each provider.
 * Used by postDeploy to write hook files and wire directives.
 *
 * @issue #444
 */

export const PROVIDER_CAPABILITIES = {
  claude: {
    atLinkSupport: true,
    hookFileName: 'AIWG.md',
    hookDirective: '@AIWG.md',
    contextFile: 'CLAUDE.md',
  },
  warp: {
    atLinkSupport: true,
    hookFileName: 'AIWG-warp.md',
    hookDirective: '@AIWG-warp.md',
    contextFile: 'WARP.md',
  },
  cursor: {
    atLinkSupport: true,
    hookFileName: 'AIWG-cursor.md',
    hookDirective: '@AIWG-cursor.md',
    // PUW-037 (#1138): .cursorrules is deprecated by Cursor in favor of
    // AGENTS.md + .cursor/rules/*.mdc with MDC frontmatter. AGENTS.md is
    // the canonical context file going forward.
    contextFile: 'AGENTS.md',
  },
  copilot: {
    atLinkSupport: false,
    hookFileName: 'AIWG-copilot.md',
    hookDirective: null,
    contextFile: '.github/copilot-instructions.md',
    fallback: 'full-inject',
  },
  devin: {
    atLinkSupport: false,
    hookFileName: 'AIWG-windsurf.md',
    hookDirective: null,
    contextFile: 'AGENTS.md',
    fallback: 'full-inject',
  },
  factory: {
    atLinkSupport: false,
    hookFileName: 'AIWG-factory.md',
    hookDirective: null,
    contextFile: 'AGENTS.md',
    fallback: 'full-inject',
  },
  opencode: {
    atLinkSupport: true,
    hookFileName: 'AIWG-opencode.md',
    hookDirective: '@AIWG-opencode.md',
    contextFile: '.opencode/context.md',
  },
  codex: {
    atLinkSupport: false,
    hookFileName: 'AIWG-codex.md',
    hookDirective: null,
    contextFile: 'CODEX.md',
    fallback: 'full-inject',
  },
};

/**
 * Get hook capability for a provider.
 * @param {string} provider
 * @returns {object|null}
 */
export function getHookCapability(provider) {
  return PROVIDER_CAPABILITIES[provider] || null;
}

/**
 * Check if a provider supports @-link hook files.
 * @param {string} provider
 * @returns {boolean}
 */
export function supportsAtLink(provider) {
  const cap = PROVIDER_CAPABILITIES[provider];
  return cap ? cap.atLinkSupport : false;
}
