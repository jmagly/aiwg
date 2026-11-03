// Retain individual provider outcomes while continuing a multi-provider deployment.
import type { HandlerResult } from './types.js';

type ProviderResults = HandlerResult & { providerResults?: Map<string, HandlerResult> };

export async function deployEachProvider(
  providers: string[],
  deploy: (provider: string, order: number) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const providerResults = new Map<string, HandlerResult>();
  for (const [order, provider] of providers.entries()) {
    try {
      providerResults.set(provider, await deploy(provider, order));
    } catch (error) {
      providerResults.set(provider, { exitCode: 1, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = [...providerResults.values()].find(result => result.exitCode !== 0);
  return { exitCode: failed?.exitCode ?? 0, message: failed?.message, providerResults } as ProviderResults;
}

export function resultForProvider(result: HandlerResult, provider: string): HandlerResult {
  return (result as ProviderResults).providerResults?.get(provider) ?? result;
}
