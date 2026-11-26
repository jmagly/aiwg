/**
 * Local issue CLI — `aiwg issue <subcommand>`
 *
 * This command operates on local issue storage under `.aiwg/issues/`. It can
 * also import/export snapshots and opt into live Gitea/GitHub API sync for
 * local issue migration workflows.
 *
 * @issue #1462
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFrameworkRoot } from '../channel/manager.mjs';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { parseArgs, stringFlag, csvFlag, type ParsedArgs } from './args.js';
import { externalIssues } from './external-cli.js';
import { trackerToken } from './tracker-policy.js';
import { sensitiveInputOptions } from '../auth/sensitive-input.js';
import {
  LocalIssueProviderCore,
  buildExternalIssueSnapshotFromLocal,
  buildLocalIssueConflictReport,
  createLiveIssueClient,
  localIssueRoot,
  parseCommentIdMappings,
  parseExternalIssueSnapshot,
} from './index.js';

export async function main(args: string[], cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs(args);
  parsed.cwd = cwd;
  const subcommand = parsed.positional[0];
  const rest = parsed.positional.slice(1);
  if (parsed.flags.has('backend')) {
    throw new Error('aiwg issue commands use the local issue provider; --backend is not supported');
  }
  if (await externalIssues(parsed, cwd, async (draft) => ({ plan: await buildIssuePlan(parsed, cwd, draft), composer: await loadIssueComposer() }))) return;
  if (subcommand === 'edit') throw new Error('aiwg issues edit requires a configured external tracker; local issue edits are not supported');
  const provider = stringFlag(parsed, 'provider');
  if (provider && provider !== 'local') {
    throw new Error(`aiwg issue is for local issue storage only; configured external trackers use their tracker tools (${provider})`);
  }

  const issues = new LocalIssueProviderCore(localIssueRoot(cwd));

  switch (subcommand) {
    case 'init':
      await handleInit(issues, parsed);
      return;
    case 'new':
    case 'create':
      await handleNew(issues, parsed, cwd);
      return;
    case 'plan':
    case 'draft-plan':
      await handlePlan(parsed, cwd);
      return;
    case 'list':
    case 'ls':
      await handleList(issues, parsed);
      return;
    case 'show':
      await handleShow(issues, rest, parsed);
      return;
    case 'import':
      await handleImport(issues, parsed);
      return;
    case 'export':
      await handleExport(issues, rest, parsed);
      return;
    case 'sync':
      await handleSync(issues, rest, parsed);
      return;
    case 'comment':
      await handleComment(issues, rest, parsed);
      return;
    case 'close':
      await handleClose(issues, rest, parsed);
      return;
    case 'index':
      await handleIndex(issues, rest, parsed);
      return;
    default:
      printUsage();
      if (subcommand) throw new Error(`Unknown issue subcommand: ${subcommand}`);
  }
}

async function handleInit(issues: LocalIssueProviderCore, args: ParsedArgs): Promise<void> {
  const padding = stringFlag(args, 'padding');
  const config = await issues.init({
    prefix: stringFlag(args, 'prefix'),
    padding: padding ? Number.parseInt(padding, 10) : undefined,
  });
  printJsonOrText(args, config, `Initialized local issues with prefix ${config.issue_key.prefix}`);
}

export interface IssueCompositionModule {
  planIssueDraft(draft: Record<string, unknown>, options?: Record<string, unknown>): Record<string, any>;
  executeIssuePlan(
    plan: Record<string, any>,
    adapter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, any>>;
}

async function loadIssueComposer(): Promise<IssueCompositionModule> {
  const frameworkRoot = await getFrameworkRoot();
  const modulePath = path.join(frameworkRoot, 'tools', 'issues', 'policy-boundary-composer.mjs');
  return import(pathToFileURL(modulePath).href) as Promise<IssueCompositionModule>;
}

async function buildIssuePlan(args: ParsedArgs, cwd: string, draft: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const title = draft.title ?? stringFlag(args, 'title') ?? args.positional[1];
  if (!title) throw new Error('Usage: aiwg issue plan --title <title> [--body <text>|--body-file <path>]');
  const body = typeof draft.body === 'string' ? draft.body : await readBody(args);
  const config = await readAiwgConfig(cwd);
  const composer = await loadIssueComposer();
  return composer.planIssueDraft({
    title,
    body,
    type: stringFlag(args, 'type') as never,
    priority: stringFlag(args, 'priority') as never,
    labels: csvFlag(args, 'label'),
    assignees: csvFlag(args, 'assignee'),
    author: stringFlag(args, 'author'),
    milestone: stringFlag(args, 'milestone'),
    ...draft,
  }, { threatAssessment: config?.security?.threatAssessment });
}

async function handlePlan(args: ParsedArgs, cwd: string): Promise<void> {
  const plan = await buildIssuePlan(args, cwd);
  console.log(JSON.stringify(plan, null, 2));
}

async function handleNew(issues: LocalIssueProviderCore, args: ParsedArgs, cwd: string): Promise<void> {
  const plan = await buildIssuePlan(args, cwd);
  if (plan.disposition === 'blocked') {
    throw new Error(`Issue draft rejected by ${plan.blockingRule}; no issue was written. Run aiwg issue plan to inspect suggested segments.`);
  }
  const authorizationDigest = stringFlag(args, 'authorize-policy');
  if (plan.authorizationRequired && authorizationDigest !== plan.digest) {
    throw new Error(`Issue draft requires explicit policy authorization. Review 'aiwg issue plan', then pass --authorize-policy ${plan.digest}. No issue was written.`);
  }

  await issues.requireInitialized();
  const composer = await loadIssueComposer();
  const records = new Map<string, Awaited<ReturnType<LocalIssueProviderCore['createIssue']>>>();
  const adapter = {
    async findByMarker(marker: string) {
      const listed = await issues.listIssues({ limit: 10_000 });
      for (const entry of listed.issues) {
        const record = await issues.getIssue(entry.id, { body: true, comments: 0 });
        if (record.body.includes(marker)) {
          records.set(record.fields.id, record);
          return { id: record.fields.id, reference: record.fields.id, body: record.body };
        }
      }
      return null;
    },
    async create(draft: Record<string, any>) {
      const record = await issues.createIssue({
        title: draft.title,
        body: draft.body,
        type: stringFlag(args, 'type') as never,
        priority: stringFlag(args, 'priority') as never,
        labels: draft.labels,
        assignees: draft.assignees,
        author: stringFlag(args, 'author'),
      });
      records.set(record.fields.id, record);
      return { id: record.fields.id, reference: record.fields.id, body: record.body };
    },
    async update(issue: { id: string }, patch: { body: string }) {
      const record = records.get(issue.id) ?? await issues.getIssue(issue.id, { body: true, comments: 0 });
      const references = [...patch.body.matchAll(/(?:Depends on|Related):\s+([A-Z][A-Z0-9_-]*-\d+)/g)]
        .map((match) => match[1])
        .filter((reference) => reference !== issue.id);
      await issues.updateIssueFields(issue.id, {
        links: {
          ...record.fields.links,
          related: [...new Set([...record.fields.links.related, ...references])],
          parent: patch.body.match(/Depends on:\s+([A-Z][A-Z0-9_-]*-\d+)/)?.[1] ?? record.fields.links.parent,
        },
      });
      await issues.commentIssue(issue.id, patch.body.slice(patch.body.indexOf('## Related')), {
        author: stringFlag(args, 'author') ?? 'aiwg',
      });
    },
  };
  const result = await composer.executeIssuePlan(plan, adapter, { authorizationDigest });
  if (result.status !== 'created') {
    throw new Error(`Issue creation ${result.status}: ${result.error ?? 'review the recovery envelope'}\n${JSON.stringify(result.recovery ?? result, null, 2)}`);
  }
  if (args.flags.has('json') || result.created.length > 1) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const issue = result.created[0];
    console.log(`Created ${issue.reference}: ${plan.segments[0].title}`);
  }
}

async function handleList(issues: LocalIssueProviderCore, args: ParsedArgs): Promise<void> {
  const limit = stringFlag(args, 'limit');
  const result = await issues.listIssues({
    limit: limit ? Number.parseInt(limit, 10) : undefined,
    cursor: stringFlag(args, 'cursor'),
    filter: {
      status: stringFlag(args, 'status') as never,
      labels: csvFlag(args, 'label'),
      type: stringFlag(args, 'type') as never,
      priority: stringFlag(args, 'priority') as never,
      assignee: stringFlag(args, 'assignee'),
      search: stringFlag(args, 'search'),
    },
  });
  if (args.flags.has('json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.issues.length === 0) console.log('No matching issues found.');
  for (const issue of result.issues) {
    console.log(`${issue.id}\t${issue.status}\t${issue.priority}\t${issue.title}`);
  }
  if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
}

async function handleShow(issues: LocalIssueProviderCore, rest: string[], args: ParsedArgs): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error('Usage: aiwg issue show <id> [--comments last:10|all]');
  const issue = await issues.getIssue(id, { comments: (stringFlag(args, 'comments') ?? 'all') as never });
  if (args.flags.has('json')) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }
  console.log(`# ${issue.fields.id}: ${issue.fields.title}`);
  console.log(`status: ${issue.fields.status}`);
  console.log(`priority: ${issue.fields.priority}`);
  console.log(`labels: ${issue.fields.labels.join(', ') || '(none)'}`);
  console.log('');
  console.log(issue.body);
  if (issue.events.length > 0) {
    console.log('\n## Events');
    for (const event of issue.events) {
      console.log(`- ${event.created_at} ${event.type} by ${event.author}${event.body ? `: ${event.body}` : ''}`);
    }
  }
}

async function handleImport(issues: LocalIssueProviderCore, args: ParsedArgs): Promise<void> {
  const from = stringFlag(args, "from");
  if (from !== "gitea" && from !== "github") throw new Error("Usage: aiwg issue import --from gitea|github (--snapshot-file path | --live --repo owner/name --external-id N)");
  const snapshot = args.flags.has("live")
    ? await (await liveClient(args, from)).importIssue(requiredStringFlag(args, "external-id"))
    : parseExternalIssueSnapshot(JSON.parse(await readRequiredFile(args, "snapshot-file")));
  if (from !== snapshot.provider) throw new Error(`snapshot provider ${snapshot.provider} does not match --from ${from}`);
  const issue = await issues.importIssue({
    provider: snapshot.provider,
    external_id: snapshot.external_id,
    external_url: snapshot.external_url,
    title: snapshot.title,
    body: snapshot.body,
    status: snapshot.status,
    labels: snapshot.labels,
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
    comments: snapshot.comments,
  });
  printJsonOrText(args, issue, `Imported ${snapshot.provider}#${snapshot.external_id} as ${issue.fields.id}`);
}
async function handleExport(issues: LocalIssueProviderCore, rest: string[], args: ParsedArgs): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("Usage: aiwg issue export <id> --to gitea|github [--out path] [--live --repo owner/name]");
  const provider = stringFlag(args, "to");
  if (provider !== "gitea" && provider !== "github") throw new Error("Usage: aiwg issue export <id> --to gitea|github [--out path] [--live --repo owner/name]");
  const issue = await issues.getIssue(id, { body: true, comments: "all" });
  const snapshot = buildExternalIssueSnapshotFromLocal(issue, provider);
  if (!args.flags.has("live")) {
    await writeOptionalOutput(args, snapshot);
    return;
  }

  const client = await liveClient(args, provider);
  if (snapshot.external_id && !args.flags.has("force")) {
    const remote = await client.fetchIssue(snapshot.external_id);
    const report = buildLocalIssueConflictReport(issue, remote);
    if (report.conflicts.length > 0) {
      throw new Error(`Refusing live export with ${report.conflicts.length} unresolved conflict(s); run sync conflicts or pass --force after review`);
    }
  }

  const result = await client.exportIssue(snapshot);
  await issues.updateIssueFields(id, {
    source: { provider, external_id: result.snapshot.external_id, external_url: result.snapshot.external_url ?? null },
    links: {
      ...issue.fields.links,
      external: result.snapshot.external_url ? [...new Set([...issue.fields.links.external, result.snapshot.external_url])] : issue.fields.links.external,
    },
  });
  if (result.commentMappings.length > 0) await issues.applyCommentIdMappings(id, result.commentMappings);
  await writeOptionalOutput(args, result);
}
async function handleSync(issues: LocalIssueProviderCore, rest: string[], args: ParsedArgs): Promise<void> {
  const action = rest[0];
  if (action === 'conflicts' || action === 'conflict-report') {
    const id = rest[1];
    if (!id) throw new Error('Usage: aiwg issue sync conflicts <id> --snapshot-file path');
    const issue = await issues.getIssue(id, { body: true, comments: 'all' });
    const snapshot = parseExternalIssueSnapshot(JSON.parse(await readRequiredFile(args, 'snapshot-file')));
    const report = buildLocalIssueConflictReport(issue, snapshot);
    await writeOptionalOutput(args, report);
    return;
  }
  if (action === 'map-comments') {
    const id = rest[1];
    if (!id) throw new Error('Usage: aiwg issue sync map-comments <id> --map-file path');
    const mappings = parseCommentIdMappings(JSON.parse(await readRequiredFile(args, 'map-file')));
    const events = await issues.applyCommentIdMappings(id, mappings);
    printJsonOrText(args, events, `Mapped ${mappings.length} external comment id(s) for ${id}`);
    return;
  }
  throw new Error('Usage: aiwg issue sync conflicts <id> --snapshot-file path | map-comments <id> --map-file path');
}

async function handleComment(issues: LocalIssueProviderCore, rest: string[], args: ParsedArgs): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error('Usage: aiwg issue comment <id> --body <text>|--body-file <path>');
  const body = await readBody(args);
  const event = await issues.commentIssue(id, body, { author: stringFlag(args, 'author') });
  printJsonOrText(args, event, `Commented on ${id}`);
}

async function handleClose(issues: LocalIssueProviderCore, rest: string[], args: ParsedArgs): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error('Usage: aiwg issue close <id> [--reason <text>|--body-file <path>]');
  const reason = stringFlag(args, 'reason') ?? stringFlag(args, 'body') ?? await optionalBodyFile(args);
  const issue = await issues.closeIssue(id, { author: stringFlag(args, 'author'), reason });
  printJsonOrText(args, issue, `Closed ${issue.fields.id}`);
}

async function handleIndex(issues: LocalIssueProviderCore, rest: string[], args: ParsedArgs): Promise<void> {
  if (rest[0] !== 'rebuild') throw new Error('Usage: aiwg issue index rebuild [--force]');
  const index = await issues.rebuildIssueIndex({ force: args.flags.has('force') });
  printJsonOrText(args, index, `Local issue index ready (${index.issues.length} issues)`);
}

async function liveClient(args: ParsedArgs, provider: 'gitea' | 'github') {
  const repo = requiredStringFlag(args, 'repo');
  const actor = (await readAiwgConfig(args.cwd ?? process.cwd()))?.remotes?.tracker_actor;
  const token = await trackerToken(provider, actor, sensitiveInputOptions(args.raw, 'token'));
  return createLiveIssueClient({ provider, repo, apiUrl: stringFlag(args, 'api-url'), token, actor });
}

function requiredStringFlag(args: ParsedArgs, flag: string): string {
  const value = stringFlag(args, flag);
  if (!value) throw new Error(`Missing required --${flag}`);
  return value;
}
async function readRequiredFile(args: ParsedArgs, flag: string): Promise<string> {
  const file = stringFlag(args, flag);
  if (!file) throw new Error(`Missing required --${flag} path`);
  return readFile(file, 'utf-8');
}

async function writeOptionalOutput(args: ParsedArgs, value: unknown): Promise<void> {
  const out = stringFlag(args, 'out');
  const rendered = JSON.stringify(value, null, 2) + '\n';
  if (out) {
    await writeFile(out, rendered, 'utf-8');
    if (!args.flags.has('json')) console.log(`Wrote ${out}`);
    return;
  }
  console.log(rendered.trimEnd());
}

async function readBody(args: ParsedArgs): Promise<string> {
  const body = stringFlag(args, 'body');
  if (body !== undefined) return body;
  const bodyFile = stringFlag(args, 'body-file');
  if (bodyFile) return readFile(bodyFile, 'utf-8');
  return '';
}

async function optionalBodyFile(args: ParsedArgs): Promise<string | undefined> {
  const bodyFile = stringFlag(args, 'body-file');
  return bodyFile ? readFile(bodyFile, 'utf-8') : undefined;
}

function printJsonOrText(args: ParsedArgs, value: unknown, text: string): void {
  if (args.flags.has('json')) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(text);
  }
}

export function printUsage(): void {
  console.log(`Usage:
  aiwg issues create|new --title "..." --body-file path [--label a,b --label c] [--assignee a,b --assignee c] [--milestone <title|id>]
  aiwg issues edit <number> [--milestone <title|id|none>] [--add-label a,b] [--remove-label c]
    [--title "..."] [--body-file path] [--authorize-policy DIGEST]  (external tracker only)
  aiwg issues comment|close <number> [--body-file path]  (configured external tracker)
  Use --provider local for local writes when an external tracker is configured.
  aiwg issue init [--prefix KEY] [--padding N]
  aiwg issue plan --title "..." [--body "..."] [--body-file path] [--label a,b --label c] [--assignee a,b --assignee c] [--milestone <title|id>] [--json]
  aiwg issue new --title "..." [--body "..."] [--body-file path] [--authorize-policy DIGEST]
  aiwg issues list --provider local [--status open] [--label bug] [--search text] [--limit 20] [--json]
  aiwg issue show <KEY> [--comments last:10|all]
  aiwg issue import --from gitea|github --snapshot-file path [--json]
  aiwg issue export <KEY> --to gitea|github [--out path]
  aiwg issue import --from gitea|github --live --repo owner/name --external-id N [token source]
  aiwg issue export <KEY> --to gitea|github --live --repo owner/name [token source]
  aiwg issue sync conflicts <KEY> --snapshot-file path [--out path]
  aiwg issue sync map-comments <KEY> --map-file path [--json]
  aiwg issue comment <KEY> --body "..." [--author name]
  aiwg issue close <KEY> [--reason "..."]
  aiwg issue index rebuild [--force]

Notes:
  issue and issues are aliases; --help and -h show this reference for any subcommand.
  list queries local storage only; initialize it with aiwg issues init.
  External tracker queries require that tracker's tools, including duplicate searches.
  create/new, edit, comment and close use the configured external tracker and verified actor.
  --provider local selects local storage; an external --provider must match project config.
  --label, --assignee, --add-label and --remove-label accept comma lists and repeats;
    values combine in order without duplicates. Other flags may only be specified once.
  Milestones resolve open and closed titles, or accept Gitea ids / GitHub numbers.
  Edit accepts issue or PR numbers; --milestone none clears the milestone.
  --authorize-policy DIGEST authorizes a reviewed issue plan when policy requires it.

Live token sources: --token-interactive, --token-stdin, --token-file <path>,
  --token-store <name>, --token-env <NAME> (see docs/cli/sensitive-values.md).`);
}
