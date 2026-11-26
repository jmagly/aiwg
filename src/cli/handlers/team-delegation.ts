// Resolves native team instruction models and preserves tier intent on MC handoffs.
import { parseWorkerTier, resolveDelegation } from '../../models/delegation.js';
import type { HandlerContext } from './types.js';

export async function teamDelegation(ctx: HandlerContext, provider: string,
  members: Array<{ agent: string }>, assignment: string, tierValue?: string) {
  const requestedTier = parseWorkerTier(tierValue);
  if (provider !== 'claude') return { requestedTier, routes: [] };
  const routes = [];
  for (const member of members) routes.push((await resolveDelegation({ orchestrator: 'team',
    workerId: member.agent, assignment, provider, cwd: ctx.cwd, requestedTier })).record);
  return { requestedTier, routes };
}
