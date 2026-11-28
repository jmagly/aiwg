// Route explicit/configured external issue writes through actor verification and existing issue composition.
import { readFile } from 'node:fs/promises';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { sensitiveInputOptions } from '../auth/sensitive-input.js';
import { deliveryTracker, trackerLabels, trackerMilestone } from '../delivery/tracker.js';
import { editIssue, type IssueComposition } from './edit.js';
import type { ParsedArgs } from './args.js';
import { requireIssuePlanAuthorization } from './policy.js';

export type ExternalArgs = ParsedArgs;
export async function externalIssues(args: ExternalArgs, cwd: string,
  composition: IssueComposition): Promise<boolean> {
  const [operation, number] = args.positional;
  if (!['create', 'new', 'edit', 'comment', 'close', 'list', 'ls'].includes(operation) || args.flags.get('provider') === 'local') return false;
  const config = await readAiwgConfig(cwd);
  if (!config || config.remotes?.issue_provider === 'local' || config.remotes?.issue_tracker === 'local') return false;
  if (!config.remotes?.issue_tracker && !['gitea', 'github'].includes(String(config.remotes?.issue_provider))) return false;
  if (operation === 'list' || operation === 'ls') {
    throw new Error('Cannot query the configured external tracker with aiwg issues list. Use its tracker tools for duplicate searches. For local storage, run aiwg issues init, then aiwg issues list --provider local.');
  }
  const value = (key: string) => typeof args.flags.get(key) === 'string' ? args.flags.get(key) as string : undefined;
  if (value('provider') && value('provider') !== config.remotes?.issue_provider) throw new Error('--provider must match the configured tracker');
  const client = await deliveryTracker(cwd, config, { repo: value('repo'), apiUrl: value('api-url'), source: sensitiveInputOptions(args.raw, 'token') });
  let result: unknown;
  if (operation === 'create' || operation === 'new') {
    if (args.flags.has('milestone') && !value('milestone')?.trim()) throw new Error('--milestone requires a non-empty value');
    const { plan, composer } = await composition();
    requireIssuePlanAuthorization(plan, value('authorize-policy'));
    const milestone = value('milestone') === undefined ? undefined : await trackerMilestone(client, value('milestone')!);
    const resolvedLabels = await trackerLabels(client, [...new Set<string>(plan.segments.flatMap((segment: { labels: string[] }) => segment.labels))]);
    result = await composer.executeIssuePlan(plan, {
      async findByMarker(marker: string) {
        for (let page = 1; ; page++) {
          const entries = await client.repositoryRequest<Array<{ number: number; body?: string }>>('GET', `/issues?state=all&per_page=100&limit=100&page=${page}`);
          const entry = entries.find(issue => issue.body?.includes(marker));
          if (entry) return { id: String(entry.number), reference: `#${entry.number}`, body: entry.body };
          if (entries.length < 100) return null;
        }
      },
      async create(draft: Record<string, unknown>) {
        const labels = (draft.labels as string[]).map(name => client.provider === 'gitea' ? resolvedLabels.find(label => label.name === name)!.id : name);
        const issue = await client.repositoryRequest<{ number: number; body: string }>('POST', '/issues', {
          title: draft.title, body: draft.body, labels, assignees: draft.assignees, milestone,
        });
        return { id: String(issue.number), reference: `#${issue.number}`, body: issue.body };
      },
      async update(issue: { id: string }, patch: { body: string }) {
        await client.repositoryRequest('PATCH', `/issues/${issue.id}`, patch);
      },
    }, { authorizationDigest: value('authorize-policy') });
    if ((result as { status: string }).status !== 'created') throw new Error(`Issue creation refused: ${JSON.stringify(result)}`);
  } else if (operation === 'edit') {
    result = await editIssue(args, client, composition);
  } else {
    if (!/^[1-9][0-9]*$/.test(number ?? '')) throw new Error(`${operation} requires a positive issue number`);
    const body = value('body-file') ? await readFile(value('body-file')!, 'utf8') : value('body') ?? value('reason');
    if (operation === 'comment' && !body) throw new Error('comment requires --body or --body-file');
    if (body) {
      const { plan } = await composition({ title: 'comment', body }, { checkTemplate: false });
      requireIssuePlanAuthorization(plan, value('authorize-policy'), true);
    }
    if (body) result = await client.repositoryRequest('POST', `/issues/${number}/comments`, { body });
    if (operation === 'close') result = await client.repositoryRequest('PATCH', `/issues/${number}`, { state: 'closed' });
  }
  console.log(JSON.stringify(result, null, 2));
  return true;
}
