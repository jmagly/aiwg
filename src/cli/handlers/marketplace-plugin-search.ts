// Handle offline plugin discovery and explicitly requested public cache refresh.
import { formatPluginSearch, searchMarketplacePlugins } from '../../marketplace/plugin-search.js';
import type { HandlerContext, HandlerResult } from './types.js';

export async function handlePluginSearch(ctx: HandlerContext): Promise<HandlerResult> {
  try {
    const values: Record<string, string> = {};
    const query: string[] = [];
    for (let index = 1; index < ctx.args.length; index++) {
      const arg = ctx.args[index];
      if (arg === '--plugins' || arg === '--json' || arg === '--refresh') continue;
      if (arg === '--provider' || arg === '--max-age-days') {
        const value = ctx.args[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
        values[arg] = value;
      } else if (arg.startsWith('--')) throw new Error(`Unsupported plugin search flag: ${arg}`);
      else query.push(arg);
    }
    if (!query.join(' ').trim()) throw new Error('Query required for plugin search');
    const report = await searchMarketplacePlugins(query.join(' '), {
      provider: values['--provider'],
      refresh: ctx.args.includes('--refresh'),
      maxAgeDays: values['--max-age-days'] === undefined ? undefined : Number(values['--max-age-days']),
    });
    for (const warning of report.warnings) console.warn(`Warning: ${warning}`);
    console.log(ctx.args.includes('--json') ? JSON.stringify(report, null, 2) : formatPluginSearch(report));
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: 1, message: `Error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
