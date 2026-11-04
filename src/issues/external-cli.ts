// Route explicit/configured external issue writes through actor verification and existing issue composition.
import { readFile } from 'node:fs/promises';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { sensitiveInputOptions } from '../auth/sensitive-input.js';
import { deliveryTracker } from '../delivery/tracker.js';
import type { IssueCompositionModule } from './cli.js';

export interface ExternalArgs { raw: string[]; positional: string[]; flags: Map<string, string | boolean> }
export async function externalIssues(args: ExternalArgs, cwd: string,
  composition: () => Promise<{ plan: Record<string, any>; composer: IssueCompositionModule }>): Promise<boolean> {
  const [operation, number] = args.positional;
  if (!['create', 'new', 'comment', 'close'].includes(operation) || args.flags.get('provider') === 'local') return false;
  const config = await readAiwgConfig(cwd);
  if (!config || config.remotes?.issue_provider === 'local' || config.remotes?.issue_tracker === 'local') return false;
  if (!config.remotes?.issue_tracker && !['gitea', 'github'].includes(String(config.remotes?.issue_provider))) return false;
  const value = (key: string) => typeof args.flags.get(key) === 'string' ? args.flags.get(key) as string : undefined;
  if (value('provider') && value('provider') !== config.remotes?.issue_provider) throw new Error('--provider must match the configured tracker');
  const client = await deliveryTracker(cwd, config, { repo: value('repo'), apiUrl: value('api-url'), source: sensitiveInputOptions(args.raw, 'token') });
  let result: unknown;
  if (operation === 'create' || operation === 'new') {
    const { plan, composer } = await composition();
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
        let labels = draft.labels as Array<string | number> | undefined;
        if (client.provider === 'gitea' && labels?.length) {
          const available: Array<{ id: number; name: string }> = [];
          for (let page = 1; ; page++) {
            const entries = await client.repositoryRequest<Array<{ id: number; name: string }>>('GET', `/labels?limit=100&page=${page}`);
            available.push(...entries);
            if (entries.length < 100) break;
          }
          labels = labels.map(name => {
            const id = available.find(label => label.name === name)?.id;
            if (id === undefined) throw new Error('Issue label is not defined on the configured tracker');
            return id;
          });
        }
        const issue = await client.repositoryRequest<{ number: number; body: string }>('POST', '/issues', {
          title: draft.title, body: draft.body, labels, assignees: draft.assignees,
        });
        return { id: String(issue.number), reference: `#${issue.number}`, body: issue.body };
      },
      async update(issue: { id: string }, patch: { body: string }) {
        await client.repositoryRequest('PATCH', `/issues/${issue.id}`, patch);
      },
    }, { authorizationDigest: value('authorize-policy') });
    if ((result as { status: string }).status !== 'created') throw new Error(`Issue creation refused: ${JSON.stringify(result)}`);
  } else {
    if (!/^[1-9][0-9]*$/.test(number ?? '')) throw new Error(`${operation} requires a positive issue number`);
    const body = value('body-file') ? await readFile(value('body-file')!, 'utf8') : value('body') ?? value('reason');
    if (operation === 'comment' && !body) throw new Error('comment requires --body or --body-file');
    if (body) result = await client.repositoryRequest('POST', `/issues/${number}/comments`, { body });
    if (operation === 'close') result = await client.repositoryRequest('PATCH', `/issues/${number}`, { state: 'closed' });
  }
  console.log(JSON.stringify(result, null, 2));
  return true;
}
