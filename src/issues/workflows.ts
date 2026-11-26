import { parseArgs, stringFlag, csvFlag, type ParsedArgs } from './args.js';
import { LocalIssueProviderCore, localIssueRoot } from './index.js';
import type { LocalIssueFilter } from './types.js';

export const QUESTION_LABEL = 'question';

export interface QuestionLabelPlanInput {
  issueLabels: string[];
  repositoryLabels: string[];
  unresolvedQuestionCount: number;
}

export interface QuestionLabelPlan {
  label: typeof QUESTION_LABEL;
  createLabel: boolean;
  addLabel: boolean;
  removeLabel: boolean;
  keepLabel: boolean;
  reason: 'open-questions' | 'answered' | 'already-clear';
}

function hasLabel(labels: string[], name: string): boolean {
  return labels.some((label) => label.toLowerCase() === name.toLowerCase());
}

/**
 * Plan the tracker label mutation for address-issues open questions (#1726).
 *
 * The caller owns provider-specific API calls; this function keeps the state
 * transition deterministic and idempotent across Gitea/GitHub/local stores.
 */
export function planQuestionLabelUpdate(input: QuestionLabelPlanInput): QuestionLabelPlan {
  const issueHasQuestion = hasLabel(input.issueLabels, QUESTION_LABEL);
  const repoHasQuestion = hasLabel(input.repositoryLabels, QUESTION_LABEL);
  const hasOpenQuestions = input.unresolvedQuestionCount > 0;

  if (hasOpenQuestions) {
    return {
      label: QUESTION_LABEL,
      createLabel: !repoHasQuestion,
      addLabel: !issueHasQuestion,
      removeLabel: false,
      keepLabel: issueHasQuestion,
      reason: 'open-questions',
    };
  }

  if (issueHasQuestion) {
    return {
      label: QUESTION_LABEL,
      createLabel: false,
      addLabel: false,
      removeLabel: true,
      keepLabel: false,
      reason: 'answered',
    };
  }

  return {
    label: QUESTION_LABEL,
    createLabel: false,
    addLabel: false,
    removeLabel: false,
    keepLabel: false,
    reason: 'already-clear',
  };
}

export async function auditLocalIssuesCli(args: string[], cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs(args);
  requireLocalProvider(parsed, 'issue-audit');
  const issues = new LocalIssueProviderCore(localIssueRoot(cwd));
  const limit = numberFlag(parsed, 'limit') ?? 50;
  const result = await issues.listIssues({
    limit,
    cursor: stringFlag(parsed, 'cursor'),
    filter: buildFilter(parsed),
  });

  const counts = {
    open: result.issues.filter((issue) => issue.status === 'open').length,
    closed: result.issues.filter((issue) => issue.status === 'closed').length,
    archived: result.issues.filter((issue) => issue.status === 'archived').length,
  };

  if (parsed.flags.has('json')) {
    console.log(JSON.stringify({ provider: 'local', limit, nextCursor: result.nextCursor, counts, issues: result.issues }, null, 2));
    return;
  }

  console.log('# Issue Audit');
  console.log('');
  console.log('Scope: local .aiwg/issues/');
  console.log(`Mode: ${parsed.flags.has('apply') ? 'apply requested, local audit is read-only' : 'read-only'}`);
  console.log('');
  console.log('## Counts');
  console.log(`- Issues audited: ${result.issues.length}`);
  console.log(`- Open: ${counts.open}`);
  console.log(`- Closed: ${counts.closed}`);
  console.log(`- Archived: ${counts.archived}`);
  console.log('');
  console.log('## Findings');
  for (const issue of result.issues) {
    console.log(`- ${issue.id} [${issue.status}/${issue.priority}] ${issue.title}`);
  }
  if (result.nextCursor) console.log(`\nNext cursor: ${result.nextCursor}`);
}

function buildFilter(args: ParsedArgs): LocalIssueFilter {
  const expression = stringFlag(args, 'filter');
  const filter: LocalIssueFilter = {};
  if (expression) {
    for (const token of expression.split(/\s+/).filter(Boolean)) {
      const [key, value] = token.split(/:(.*)/s);
      if (!value) continue;
      if (key === 'status') filter.status = value as never;
      else if (key === 'label') filter.labels = [...(filter.labels ?? []), value];
      else if (key === 'type') filter.type = value as never;
      else if (key === 'priority') filter.priority = value as never;
      else if (key === 'assignee') filter.assignee = value;
      else if (key === 'search') filter.search = value;
    }
  }
  filter.status = (stringFlag(args, 'status') as never) ?? filter.status;
  const labels = csvFlag(args, 'label');
  if (labels.length > 0) filter.labels = [...(filter.labels ?? []), ...labels];
  filter.type = (stringFlag(args, 'type') as never) ?? filter.type;
  filter.priority = (stringFlag(args, 'priority') as never) ?? filter.priority;
  filter.assignee = stringFlag(args, 'assignee') ?? filter.assignee;
  filter.search = stringFlag(args, 'search') ?? filter.search;
  return filter;
}

function requireLocalProvider(args: ParsedArgs, command: string): void {
  const provider = stringFlag(args, 'provider');
  if (provider !== 'local') {
    throw new Error(`${command} CLI workflow support is currently local-only; pass --provider local or use the configured external tracker workflow`);
  }
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}
