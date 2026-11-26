import { readFile } from 'node:fs/promises';
import { trackerLabels, trackerMilestone } from '../delivery/tracker.js';
import type { LiveIssueClient } from './live.js';
import { csvFlag, stringFlag, type ParsedArgs } from './args.js';
import type { IssueCompositionModule } from './cli.js';

export type IssueComposition = (draft?: Record<string, unknown>) => Promise<{
  plan: Record<string, any>; composer: IssueCompositionModule;
}>;

export async function editIssue(args: ParsedArgs, client: LiveIssueClient, composition: IssueComposition): Promise<unknown> {
  const number = args.positional[1];
  if (!/^[1-9][0-9]*$/.test(number ?? '')) throw new Error('edit requires a positive issue or PR number');
  const patch: Record<string, unknown> = {};
  for (const flag of ['title', 'body-file', 'milestone']) {
    if (args.flags.has(flag) && !stringFlag(args, flag)?.trim()) throw new Error(`--${flag} requires a non-empty value`);
  }
  const add = csvFlag(args, 'add-label');
  const remove = csvFlag(args, 'remove-label');
  const labels = await trackerLabels(client, [...new Set([...add, ...remove])]);
  if (args.flags.has('milestone')) {
    const milestone = stringFlag(args, 'milestone')!;
    patch.milestone = milestone === 'none' ? client.provider === 'gitea' ? 0 : null : await trackerMilestone(client, milestone);
  }
  if (args.flags.has('title') || args.flags.has('body-file')) {
    const current = await client.repositoryRequest<{ title: string; body?: string }>('GET', `/issues/${number}`);
    const title = stringFlag(args, 'title') ?? current.title;
    const body = args.flags.has('body-file') ? await readFile(stringFlag(args, 'body-file')!, 'utf8') : current.body ?? '';
    const { plan } = await composition({ title, body, providerScope: `issue-edit:${client.provider}:${number}` });
    if (plan.disposition === 'blocked' || plan.segments.length !== 1) {
      throw new Error(`Issue edit rejected by composition policy (${plan.blockingRule ?? plan.disposition}); edits require one accepted segment. No write was made.`);
    }
    if (plan.authorizationRequired && stringFlag(args, 'authorize-policy') !== plan.digest) {
      throw new Error(`Issue edit requires explicit policy authorization. Review this plan, then pass --authorize-policy ${plan.digest}. No write was made.\n${JSON.stringify(plan)}`);
    }
    if (args.flags.has('title')) patch.title = title;
    if (args.flags.has('body-file')) patch.body = body;
  }
  if (!Object.keys(patch).length && !add.length && !remove.length) throw new Error('edit requires --milestone, --add-label, --remove-label, --title or --body-file');
  // Keep the explicit preflight and the client's verification before each write.
  await client.verifyActor();
  let result: unknown = { number: Number(number) };
  if (Object.keys(patch).length) result = await client.repositoryRequest('PATCH', `/issues/${number}`, patch);
  if (add.length) {
    result = await client.repositoryRequest('POST', `/issues/${number}/labels`, {
      labels: add.map(name => client.provider === 'gitea' ? labels.find(label => label.name === name)!.id : name),
    });
  }
  for (const name of remove) {
    const id = client.provider === 'gitea' ? labels.find(label => label.name === name)!.id : name;
    result = await client.repositoryRequest('DELETE', `/issues/${number}/labels/${encodeURIComponent(id)}`);
  }
  return result;
}
