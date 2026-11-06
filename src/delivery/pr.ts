// Open tracker PRs and execute optional local merges using configured signing and transport policy.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AiwgConfig } from '../config/aiwg-config.js';
import { readAiwgConfig, resolveDelivery, resolveRemotes, resolveProject, resolveProjectHandling } from '../config/aiwg-config.js';
import { sensitiveInputOptions } from '../auth/sensitive-input.js';
import { deliveryTracker } from './tracker.js';
import { commitOptions, git, push, signingEnabled, verifyCommit } from './git.js';
import type { LiveIssueClient } from '../issues/live.js';
import { warnTemplateSections } from './template-sections.js';

interface PullRequest {
  number: number;
  state: string;
  title: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}
interface PrOptions { title?: string; body?: string; head?: string; commitMessageFile?: string; mirror?: string }

async function branchCommits(cwd: string, base: string, head: string, config: AiwgConfig): Promise<void> {
  if (!signingEnabled(config.delivery)) return;
  for (const sha of (await git(cwd, 'rev-list', `${base}..${head}`)).split('\n').filter(Boolean)) await verifyCommit(cwd, sha, config.delivery);
}

export async function openPr(cwd: string, config: AiwgConfig, client: LiveIssueClient, options: PrOptions): Promise<unknown> {
  const policy = resolveDelivery(config.delivery);
  if (policy.mode !== 'pr-required') throw new Error('Opening a PR requires delivery.mode=pr-required');
  if (!options.title) throw new Error('open requires --title');
  warnTemplateSections(options.body ?? '', 'agentic/code/addons/aiwg-utils/templates/pull-requests/description.md');
  const remote = resolveRemotes(config.remotes).primary;
  const head = options.head ?? await git(cwd, 'symbolic-ref', '--short', 'HEAD');
  await git(cwd, 'check-ref-format', '--branch', head);
  if (head === policy.default_branch) throw new Error('PR head must differ from the default branch');
  if (await git(cwd, 'symbolic-ref', '--short', 'HEAD') !== head) throw new Error('PR head must be the checked out branch');
  await client.verifyActor();
  const identity = commitOptions(config.delivery, cwd);
  if (options.commitMessageFile) {
    if (!(await git(cwd, 'diff', '--cached', '--name-only'))) throw new Error('Nothing staged to commit');
    await git(cwd, ...identity, 'commit', '-F', path.resolve(cwd, options.commitMessageFile));
  }
  const sha = await git(cwd, 'rev-parse', '--verify', `refs/heads/${head}^{commit}`);
  const current = await git(cwd, 'rev-parse', 'HEAD');
  if (current !== sha) throw new Error('PR head must be the current checked out commit');
  await git(cwd, 'fetch', remote);
  await branchCommits(cwd, `refs/remotes/${remote}/${policy.default_branch}`, sha, config);
  await push(cwd, cwd, config, remote, head, true);
  return client.repositoryRequest('POST', '/pulls', { title: options.title, body: options.body ?? '', head, base: policy.default_branch });
}

export async function mergePr(cwd: string, config: AiwgConfig, client: LiveIssueClient, number: string, options: PrOptions = {}): Promise<unknown> {
  if (!/^[1-9][0-9]*$/.test(number)) throw new Error('merge requires a positive PR number');
  const policy = resolveDelivery(config.delivery);
  const remotes = resolveRemotes(config.remotes);
  // Resolve invalid signing policy before any tracker or git mutations.
  const identity = commitOptions(config.delivery, cwd);
  const signed = signingEnabled(config.delivery);
  if (signed && policy.merge === 'tracker') throw new Error('Configured signing requires a local merge route; ask Steward to set delivery.merge');
  if (options.mirror && (!remotes.secondary.some(remote => remote.name === options.mirror) || !resolveProjectHandling(resolveProject(config.project)).mirror)) throw new Error('Mirror must be a configured secondary remote permitted by project handling');
  await client.verifyActor();
  const pr = await client.repositoryRequest<PullRequest>('GET', `/pulls/${number}`);
  if (pr.state !== 'open') throw new Error('PR is not open');
  if (pr.base.ref !== policy.default_branch) throw new Error('PR must target the configured default branch');
  if (!/^[a-f0-9]{40,64}$/.test(pr.head.sha)) throw new Error('Tracker returned an invalid head SHA');
  if (policy.merge === 'tracker') {
    const style = policy.merge_style;
    const method = style === 'squash' ? 'squash' : style === 'rebase-merge' ? 'rebase' : 'merge';
    if (client.provider === 'github' && style === 'fast-forward-only') throw new Error('GitHub does not support tracker fast-forward-only merges; use delivery.merge=local');
    const result = await client.repositoryRequest<{ merged?: boolean }>(client.provider === 'github' ? 'PUT' : 'POST', `/pulls/${number}/merge`, client.provider === 'github'
      ? { merge_method: method, sha: pr.head.sha } : { Do: style === 'fast-forward-only' ? 'fast-forward-only' : style === 'rebase-merge' ? 'rebase-merge' : method, head_commit_id: pr.head.sha });
    if (result.merged === false) throw new Error('Tracker refused the PR merge');
    return result;
  }
  await git(cwd, 'fetch', remotes.primary);
  await git(cwd, 'fetch', remotes.primary, pr.head.sha);
  const mainRef = `refs/remotes/${remotes.primary}/${policy.default_branch}`;
  const main = await git(cwd, 'rev-parse', mainRef);
  const base = await git(cwd, 'merge-base', pr.head.sha, main);
  const tree = (ref: string) => git(cwd, 'rev-parse', `${ref}^{tree}`);
  if (await tree(base) !== await tree(main)) throw new Error('Current main tree differs from branch base; synchronize and verify first');
  if (!(await git(cwd, 'rev-list', `${main}..${pr.head.sha}`))) throw new Error('PR has no branch commits to merge');
  await branchCommits(cwd, main, pr.head.sha, config);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'aiwg-merge-'));
  const worktree = path.join(scratch, 'worktree');
  let added = false;
  try {
    await git(cwd, 'worktree', 'add', '--detach', worktree, main); added = true;
    await git(worktree, ...identity, 'merge', '--no-ff', ...(signed ? ['-S'] : []), '-m', `merge: ${pr.title} (#${number})`, pr.head.sha);
    const merged = await git(worktree, 'rev-parse', 'HEAD');
    if (await tree(merged) !== await tree(pr.head.sha)) throw new Error('Merge tree differs from verified PR head');
    await verifyCommit(worktree, merged, config.delivery, cwd);
    // Refuse a changed PR or main before push; the ordinary push also rejects a concurrent non-fast-forward update.
    const latest = await client.repositoryRequest<PullRequest>('GET', `/pulls/${number}`);
    if (latest.state !== 'open' || latest.head.sha !== pr.head.sha || latest.base.ref !== pr.base.ref) throw new Error('PR changed during merge; retry after verification');
    await git(cwd, 'fetch', remotes.primary);
    if (await git(cwd, 'rev-parse', mainRef) !== main) throw new Error('Main changed during merge; synchronize and verify first');
    await push(worktree, cwd, config, remotes.primary, `${merged}:refs/heads/${policy.default_branch}`);
    await client.repositoryRequest('PATCH', `/pulls/${number}`, { state: 'closed' });
    await git(cwd, 'fetch', remotes.primary);
    if (await git(cwd, 'rev-parse', mainRef) !== merged) throw new Error('Remote default branch differs from the local merge');
    if (options.mirror) await git(cwd, 'push', options.mirror, `${merged}:refs/heads/${policy.default_branch}`);
    return { number: Number(number), merged, signed, mode: policy.merge };
  } finally {
    try { if (added) await git(cwd, 'worktree', 'remove', '--force', worktree); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  }
}

export async function main(args: string[], cwd = process.cwd()): Promise<number> {
  const config = await readAiwgConfig(cwd);
  if (!config) throw new Error('PR delivery requires .aiwg/aiwg.config');
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const allowed = ['title', 'body-file', 'head', 'commit-message-file', 'mirror', 'repo', 'api-url', 'token-store', 'token-env'];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (!allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(key)) throw new Error(`Invalid PR option: --${key}`);
    flags.set(key, args[++i]);
  }
  if (!['open', 'merge'].includes(positional[0]) || positional.length !== (positional[0] === 'merge' ? 2 : 1)) throw new Error('Usage: aiwg run skill aiwg-pr -- open --title <title> --body-file <path> [--commit-message-file <path>] | merge <number> [--mirror <remote>]');
  const client = await deliveryTracker(cwd, config, { repo: flags.get('repo'), apiUrl: flags.get('api-url'), source: sensitiveInputOptions(args, 'token') });
  const options: PrOptions = { title: flags.get('title'), head: flags.get('head'), commitMessageFile: flags.get('commit-message-file'), mirror: flags.get('mirror'),
    body: flags.has('body-file') ? await readFile(path.resolve(cwd, flags.get('body-file')!), 'utf8') : undefined };
  const result = positional[0] === 'open' ? await openPr(cwd, config, client, options) : await mergePr(cwd, config, client, positional[1], options);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
