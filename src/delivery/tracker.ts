// Resolve the configured internal tracker from repository remotes without consulting unrelated credentials.
import type { AiwgConfig } from '../config/aiwg-config.js';
import { resolveRemotes } from '../config/aiwg-config.js';
import { LiveIssueClient } from '../issues/live.js';
import { trackerToken } from '../issues/tracker-policy.js';
import type { SensitiveInputOptions } from '../auth/sensitive-input.js';
import { git } from './git.js';

export async function deliveryTracker(cwd: string, config: AiwgConfig,
  options: { repo?: string; apiUrl?: string; source?: SensitiveInputOptions } = {}): Promise<LiveIssueClient> {
  const remotes = resolveRemotes(config.remotes);
  if (remotes.issue_provider === 'local' || remotes.issue_tracker === 'local') throw new Error('PR and external issue writes require an external tracker');
  let provider = remotes.issue_provider;
  let repo = options.repo;
  let apiUrl = options.apiUrl;
  if (!repo || !apiUrl || !provider) {
    const remote = remotes.issue_tracker;
    const url = remote.includes('://') || remote.includes('@') ? remote : await git(cwd, 'remote', 'get-url', remote);
    const normalized = url.replace(/^([^@]+@)([^:]+):/, 'ssh://$1$2/');
    let parsed: URL;
    try { parsed = new URL(normalized); } catch { throw new Error('Cannot resolve tracker remote; supply --repo and --api-url with an explicit issue_provider'); }
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && (parsed.username || parsed.password)) throw new Error('Tracker remote URLs must not contain credentials');
    provider ??= parsed.hostname === 'github.com' ? 'github' : 'gitea';
    repo ??= parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    const protocol = parsed.protocol === 'http:' ? 'http:' : 'https:';
    apiUrl ??= provider === 'github' ? parsed.hostname === 'github.com' ? 'https://api.github.com' : `${protocol}//${parsed.host}/api/v3` : `${protocol}//${parsed.host}/api/v1`;
  }
  const token = await trackerToken(provider, remotes.tracker_actor, options.source);
  return new LiveIssueClient({ provider, repo, apiUrl, token, actor: remotes.tracker_actor });
}
