/**
 * Provider Platform Watcher
 *
 * Monitors provider platforms (Claude Code, Cursor, Copilot, etc.) for
 * upstream changes and emits events when new versions, doc updates, or
 * breaking changes are detected.
 *
 * Integrates with the daemon's CronScheduler via event emission and can
 * also be invoked manually via IPC.
 *
 * @see https://git.integrolabs.net/roctinam/aiwg/issues/615
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { importImpl } from '../_resolve-impl.mjs';

const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const { cliCommand } = await importImpl(import.meta.url, 'process/cli-command.mjs');

/**
 * Source definition for a single provider watch target.
 * @typedef {Object} WatchSource
 * @property {string} type - Source type: 'npm' | 'github-release' | 'changelog-url' | 'docs-url'
 * @property {string} url - URL or package name to monitor
 * @property {string} [path] - Subpath for docs or changelog scraping
 */

/**
 * Provider definition with all watch sources.
 * @typedef {Object} ProviderDef
 * @property {string} id - Provider identifier (matches capability-matrix.yaml)
 * @property {string} displayName - Human-readable name
 * @property {WatchSource[]} sources - Ordered list of watch sources
 * @property {string[]} referenceFiles - Local files to update when changes detected
 * @property {string[]} integrationDocs - Integration docs that may need updating
 */

/** Built-in provider source definitions */
const PROVIDER_SOURCES = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    sources: [
      { type: 'npm', url: '@anthropic-ai/claude-code' },
      { type: 'github-release', url: 'anthropics/claude-code' },
      { type: 'docs-url', url: 'https://docs.anthropic.com/en/docs/claude-code' },
    ],
    referenceFiles: ['.aiwg/references/platforms/claude-code.md'],
    integrationDocs: [],
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    sources: [
      { type: 'changelog-url', url: 'https://www.cursor.com/changelog' },
      { type: 'docs-url', url: 'https://docs.cursor.com' },
    ],
    referenceFiles: ['.aiwg/references/platforms/cursor.md'],
    integrationDocs: ['docs/integrations/cursor-quickstart.md'],
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    sources: [
      { type: 'github-release', url: 'github/copilot-docs' },
      { type: 'docs-url', url: 'https://docs.github.com/en/copilot' },
    ],
    referenceFiles: ['.aiwg/references/platforms/github-copilot.md'],
    integrationDocs: [],
  },
  {
    id: 'factory',
    displayName: 'Factory AI',
    sources: [
      { type: 'docs-url', url: 'https://docs.factory.ai' },
    ],
    referenceFiles: ['.aiwg/references/platforms/factory-ai.md'],
    integrationDocs: [],
  },
  {
    id: 'devin',
    displayName: 'Devin Desktop',
    sources: [
      { type: 'changelog-url', url: 'https://windsurf.com/changelog' },
      { type: 'docs-url', url: 'https://docs.windsurf.com' },
    ],
    referenceFiles: ['.aiwg/references/platforms/windsurf.md'],
    integrationDocs: [],
  },
  {
    id: 'warp',
    displayName: 'Warp',
    sources: [
      { type: 'docs-url', url: 'https://docs.warp.dev' },
    ],
    referenceFiles: ['.aiwg/references/platforms/warp.md'],
    integrationDocs: [],
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    sources: [
      { type: 'npm', url: '@openai/codex' },
      { type: 'github-release', url: 'openai/codex' },
    ],
    referenceFiles: [],
    integrationDocs: [],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    sources: [
      { type: 'npm', url: 'opencode' },
      { type: 'github-release', url: 'opencode-ai/opencode' },
    ],
    referenceFiles: ['.aiwg/references/platforms/opencode.md'],
    integrationDocs: [],
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    sources: [
      { type: 'docs-url', url: 'https://docs.openclaw.ai' },
    ],
    referenceFiles: ['.aiwg/references/platforms/openclaw.md'],
    integrationDocs: [],
  },
];

export class ProviderWatcher extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.stateDir - Directory for persisting watcher state
   * @param {string[]} [options.providers] - Provider IDs to watch (default: all)
   * @param {number} [options.intervalHours] - Check interval in hours (default: 6)
   */
  constructor(options = {}) {
    super();
    this.stateDir = options.stateDir || '.aiwg/daemon/provider-watch';
    this.providers = (options.providers || PROVIDER_SOURCES.map((p) => p.id)).map(id => id === 'windsurf' ? 'devin' : id);
    this.intervalHours = options.intervalHours || 6;
    // npm keeps its own config/registry variables; only daemon secrets are removed.
    this.environment = options.environment;
    this.statePath = path.join(this.stateDir, 'state.json');
    this.state = this.loadState();
    this._intervalHandle = null;
  }

  /**
   * Start periodic checking on the configured interval.
   * Runs an initial check immediately, then every `intervalHours`.
   */
  start() {
    if (this._intervalHandle) return; // already running

    // Run first check after a short delay (30s) to let daemon finish init
    const initialDelay = setTimeout(() => {
      this.checkAll().catch((err) =>
        this.emit('error', { provider: '*', error: err.message })
      );
    }, 30_000);
    initialDelay.unref?.();

    // Schedule recurring checks
    const intervalMs = this.intervalHours * 60 * 60 * 1000;
    this._intervalHandle = setInterval(() => {
      this.checkAll().catch((err) =>
        this.emit('error', { provider: '*', error: err.message })
      );
    }, intervalMs);
    this._intervalHandle.unref?.();
  }

  /**
   * Stop periodic checking. Safe to call multiple times.
   */
  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }

  /** Load persisted state (last-seen versions, timestamps). */
  loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      }
    } catch {
      // Corrupted state — reset
    }
    return { providers: {}, lastFullCheck: null };
  }

  /** Persist state to disk. */
  saveState() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  /**
   * Run a full check across all watched providers.
   * Emits 'change' events for each detected update.
   * @returns {Promise<ChangeReport[]>} Array of detected changes
   */
  async checkAll() {
    const changes = [];
    const activeProviders = PROVIDER_SOURCES.filter((p) =>
      this.providers.includes(p.id)
    );

    for (const provider of activeProviders) {
      try {
        const providerChanges = await this.checkProvider(provider);
        changes.push(...providerChanges);
      } catch (error) {
        this.emit('error', {
          provider: provider.id,
          error: error.message,
        });
      }
    }

    this.state.lastFullCheck = new Date().toISOString();
    this.saveState();

    if (changes.length > 0) {
      this.emit('changes-detected', { changes, timestamp: new Date().toISOString() });
    }

    return changes;
  }

  /**
   * Check a single provider for upstream changes.
   * @param {ProviderDef} provider
   * @returns {Promise<ChangeReport[]>}
   */
  async checkProvider(provider) {
    const changes = [];
    const providerState = this.state.providers[provider.id] || {
      lastCheck: null,
      lastSeenVersions: {},
      lastSeenHashes: {},
    };

    for (const source of provider.sources) {
      try {
        const result = await this.checkSource(provider.id, source, providerState);
        if (result) {
          changes.push({
            provider: provider.id,
            displayName: provider.displayName,
            source: source.type,
            sourceUrl: source.url,
            ...result,
            referenceFiles: provider.referenceFiles,
            integrationDocs: provider.integrationDocs,
            detectedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        this.emit('source-error', {
          provider: provider.id,
          source: source.type,
          url: source.url,
          error: error.message,
        });
      }
    }

    providerState.lastCheck = new Date().toISOString();
    this.state.providers[provider.id] = providerState;

    return changes;
  }

  /**
   * Check a single source for changes.
   * @param {string} providerId
   * @param {WatchSource} source
   * @param {Object} providerState
   * @returns {Promise<Object|null>} Change details or null if no change
   */
  async checkSource(providerId, source, providerState) {
    switch (source.type) {
      case 'npm':
        return this.checkNpm(providerId, source, providerState);
      case 'github-release':
        return this.checkGithubRelease(providerId, source, providerState);
      case 'changelog-url':
        return this.checkChangelog(providerId, source, providerState);
      case 'docs-url':
        return this.checkDocs(providerId, source, providerState);
      default:
        return null;
    }
  }

  /**
   * Check npm registry for new versions.
   * Uses `npm view` to avoid needing an npm token.
   */
  async checkNpm(providerId, source, providerState) {
    const pkg = source.url;

    try {
      const [file, args] = cliCommand('npm', ['view', pkg, 'version', 'dist-tags', '--json']);
      const output = boundedExecFileSync(file, args, 'quick', {
        env: this.environment ?? process.env,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(output);
      const latestVersion = typeof data === 'string' ? data : data.version || data['dist-tags']?.latest;

      if (!latestVersion) return null;

      const lastSeen = providerState.lastSeenVersions[`npm:${pkg}`];
      if (lastSeen === latestVersion) return null;

      providerState.lastSeenVersions[`npm:${pkg}`] = latestVersion;

      return {
        type: 'new-version',
        previousVersion: lastSeen || '(first check)',
        newVersion: latestVersion,
        impact: lastSeen ? 'medium' : 'low',
        summary: `${pkg} updated to ${latestVersion}${lastSeen ? ` (was ${lastSeen})` : ''}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check GitHub releases API for new releases.
   * Uses unauthenticated API (60 req/hr limit — fine for 6-hour intervals).
   */
  async checkGithubRelease(providerId, source, providerState) {
    const repo = source.url;
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

    try {
      const response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'AIWG-Provider-Watcher/1.0' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) return null;

      const data = await response.json();
      const tagName = data.tag_name;
      const lastSeen = providerState.lastSeenVersions[`github:${repo}`];

      if (lastSeen === tagName) return null;

      providerState.lastSeenVersions[`github:${repo}`] = tagName;

      const isBreaking = (data.body || '').toLowerCase().includes('breaking');

      return {
        type: 'new-release',
        previousVersion: lastSeen || '(first check)',
        newVersion: tagName,
        impact: isBreaking ? 'high' : 'medium',
        summary: `${repo} released ${tagName}${lastSeen ? ` (was ${lastSeen})` : ''}`,
        releaseNotes: (data.body || '').slice(0, 2000),
        releaseUrl: data.html_url,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check a changelog URL for new content.
   * Computes a content hash and compares to last seen.
   */
  async checkChangelog(providerId, source, providerState) {
    try {
      const response = await fetch(source.url, {
        headers: { 'User-Agent': 'AIWG-Provider-Watcher/1.0' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) return null;

      const text = await response.text();
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const lastHash = providerState.lastSeenHashes[`changelog:${source.url}`];

      if (lastHash === hash) return null;

      providerState.lastSeenHashes[`changelog:${source.url}`] = hash;

      if (!lastHash) return null; // First check — no diff to report

      return {
        type: 'changelog-update',
        impact: 'low',
        summary: `Changelog updated at ${source.url}`,
        contentHash: hash,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check a documentation URL for content changes.
   * Same hash-based approach as changelog.
   */
  async checkDocs(providerId, source, providerState) {
    try {
      const response = await fetch(source.url, {
        headers: { 'User-Agent': 'AIWG-Provider-Watcher/1.0' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) return null;

      const text = await response.text();
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const lastHash = providerState.lastSeenHashes[`docs:${source.url}`];

      if (lastHash === hash) return null;

      providerState.lastSeenHashes[`docs:${source.url}`] = hash;

      if (!lastHash) return null; // First check

      return {
        type: 'docs-update',
        impact: 'low',
        summary: `Documentation updated at ${source.url}`,
        contentHash: hash,
      };
    } catch {
      return null;
    }
  }

  /**
   * Generate a structured PR body from detected changes.
   * @param {ChangeReport[]} changes
   * @returns {string} Markdown-formatted PR body
   */
  static generatePRBody(changes) {
    if (!changes.length) return '';

    const byProvider = {};
    for (const change of changes) {
      if (!byProvider[change.provider]) {
        byProvider[change.provider] = { displayName: change.displayName, changes: [] };
      }
      byProvider[change.provider].changes.push(change);
    }

    const impactOrder = { high: 0, medium: 1, low: 2 };
    const maxImpact = changes.reduce(
      (max, c) => (impactOrder[c.impact] < impactOrder[max] ? c.impact : max),
      'low'
    );

    const lines = [];
    lines.push(`## Provider Updates Detected`);
    lines.push('');
    lines.push(`**Impact**: ${maxImpact.charAt(0).toUpperCase() + maxImpact.slice(1)}`);
    lines.push(`**Detected**: ${new Date().toISOString().split('T')[0]}`);
    lines.push(`**Providers affected**: ${Object.keys(byProvider).length}`);
    lines.push('');

    for (const [id, { displayName, changes: provChanges }] of Object.entries(byProvider)) {
      lines.push(`### ${displayName}`);
      lines.push('');
      for (const c of provChanges) {
        lines.push(`- **${c.type}**: ${c.summary}`);
        if (c.releaseUrl) lines.push(`  - Release: ${c.releaseUrl}`);
      }
      lines.push('');

      const refFiles = provChanges.flatMap((c) => c.referenceFiles || []);
      const docFiles = provChanges.flatMap((c) => c.integrationDocs || []);
      const allFiles = [...new Set([...refFiles, ...docFiles])];
      if (allFiles.length) {
        lines.push('**Files to review**:');
        for (const f of allFiles) {
          lines.push(`- \`${f}\``);
        }
        lines.push('');
      }
    }

    lines.push('### Requires Human Review');
    lines.push('');
    for (const change of changes.filter((c) => c.impact === 'high')) {
      lines.push(`- [ ] ${change.displayName}: ${change.summary}`);
    }
    if (!changes.some((c) => c.impact === 'high')) {
      lines.push('No high-impact changes detected.');
    }

    return lines.join('\n');
  }

  /**
   * Get the cron expression for the daemon scheduler.
   * @returns {string} Cron expression for the configured interval
   */
  getCronExpression() {
    // Run at minute 0, every N hours
    return `0 */${this.intervalHours} * * *`;
  }

  /** Get provider source definitions (for inspection/config). */
  static getProviderSources() {
    return PROVIDER_SOURCES;
  }

  /**
   * Return the default automation rule for PR creation on provider changes.
   * Register this with the AutomationEngine so `provider.changes` events
   * automatically dispatch an agent task to create a PR.
   * @returns {Object} Automation rule definition
   */
  static getAutomationRule() {
    return {
      id: 'provider-watch-pr',
      description: 'Create PR when provider changes are detected',
      trigger: {
        source: 'provider-watch',
        type: 'provider.changes',
      },
      action: {
        type: 'agent',
        agent: 'aiwg-steward',
        priority: 1,
        prompt: [
          'Provider platform changes have been detected by the ProviderWatcher daemon.',
          '',
          'Changes payload is available in the event context. Your task:',
          '1. Read the changes from `.aiwg/daemon/provider-watch/state.json`',
          '2. Run `ProviderWatcher.generatePRBody(changes)` or format equivalently',
          '3. Create a new branch: `provider-updates/{date}`',
          '4. Update any affected reference files listed in the changes',
          '5. Commit changes and open a PR to main with the structured body',
          '6. PR must require human review before merge (never auto-merge)',
          '',
          'If no reference files need updating, create an informational issue instead.',
        ].join('\n'),
      },
      requiresApproval: false,
      cooldownMs: 6 * 60 * 60 * 1000, // 6 hours — match watcher interval
    };
  }

  /** Get status summary for IPC/CLI. */
  getStatus() {
    return {
      watching: this.providers,
      intervalHours: this.intervalHours,
      lastFullCheck: this.state.lastFullCheck,
      providers: Object.fromEntries(
        Object.entries(this.state.providers).map(([id, s]) => [
          id,
          {
            lastCheck: s.lastCheck,
            versionsTracked: Object.keys(s.lastSeenVersions || {}).length,
            hashesTracked: Object.keys(s.lastSeenHashes || {}).length,
          },
        ])
      ),
    };
  }
}

export default ProviderWatcher;
