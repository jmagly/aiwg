// Interpret the optional per-bundle copy selector through the existing use handler.
import type { HandlerContext, HandlerResult } from './types.js';
import { frameworkRegistryId } from '../../config/framework-aliases.js';

export async function executeCopySelection(ctx: HandlerContext, execute: (ctx: HandlerContext) => Promise<HandlerResult>): Promise<HandlerResult | undefined> {
  const index = ctx.args.indexOf('--copy');
  if (index < 0) return undefined;
  const selector = ctx.args[index + 1]?.startsWith('-') === false ? ctx.args[index + 1] : undefined;
  const args = [...ctx.args];
  args.splice(index, selector ? 2 : 1);
  const target = args[0];
  if (!target || target.startsWith('-')) return { exitCode: 2, message: '--copy requires a use target.' };
  if (!selector || frameworkRegistryId(selector) === frameworkRegistryId(target)) {
    return execute({ ...ctx, args: [...args, '--copy-all'] });
  }
  if (target !== 'all') return { exitCode: 2, message: `--copy ${selector} requires 'use all' or 'use ${selector}'.` };
  // Validate and copy the selected bundle first so a typo cannot partially index all.
  const copied = await execute({ ...ctx, args: [selector, ...args.slice(1), '--copy-all'] });
  if (copied.exitCode) return copied;
  return execute({ ...ctx, args });
}

export function discoveryDeploymentArgs(args: string[], indexOnly: boolean): string[] {
  const sourceIndex = args.indexOf('--deploy-source');
  if (sourceIndex >= 0 && args[sourceIndex + 1] === 'project-local') {
    indexOnly = !args.some(arg => ['--copy-all', '--copy-standard-skills'].includes(arg));
  }
  if (!indexOnly) return args;
  return [...args.filter(arg => !['--copy-all', '--copy-standard-skills', '--index-mode'].includes(arg)), '--discovery-only'];
}

export function discoveryMessage(target: string, dryRun = false): string {
  return `${dryRun ? 'Would index' : 'Indexed'} ${target}; find artifacts with aiwg discover "<capability>" and load them with aiwg show. Use aiwg use ${target} --copy (or --copy-all) for provider copies. Existing copies are retained; review aiwg remove ${target} --dry-run before choosing removal and re-indexing.`;
}

export function reportDiscovery(ctx: HandlerContext, result: HandlerResult, indexOnly: boolean): HandlerResult {
  if (result.exitCode || !indexOnly || ctx.args[0] === 'cockpit'
    || ctx.args.some(arg => ['--json', '--help', '-h', '--workspace-signals'].includes(arg))) return result;
  return { ...result, message: [result.message, discoveryMessage(ctx.args[0] || 'all', ctx.args.includes('--dry-run'))].filter(Boolean).join('\n') };
}
