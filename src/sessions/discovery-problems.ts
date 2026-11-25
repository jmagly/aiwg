// Keep unreadable and unsupported discovery candidates visible through import coverage.
import { resolve } from 'node:path';
import { SessionContractError, sha256, type SourceDescriptor } from './contracts.js';
import { redactSourceLocator } from './discovery.js';
import { containsSource } from './source-boundary.js';
import type { DiscoveryManifestSource } from './workspace-discovery.js';

export function discoveryProblem(descriptor: SourceDescriptor, roots: string[], status: 'unsupported' | 'unreadable'): DiscoveryManifestSource {
  const locator = resolve(descriptor.locator);
  return {
    sourceId: sha256([descriptor.provider, locator, status].join('\0')),
    provider: descriptor.provider, locator, locatorClass: descriptor.locatorClass,
    redactedLocator: redactSourceLocator(locator),
    authorizedRoot: roots.find(root => containsSource(root, locator))!,
    modifiedAt: '', sizeBytes: 0, digest: '', status,
  };
}

export function unsupportedSource(descriptor: SourceDescriptor): boolean {
  return /\.jsonl\.[a-z0-9]+$/i.test(descriptor.locator)
    && !(descriptor.provider === 'codex' && /\.jsonl\.zst$/i.test(descriptor.locator));
}

export function recordDiscoveryProblem(descriptor: SourceDescriptor, roots: string[], status: 'unsupported' | 'unreadable',
  providerSources: DiscoveryManifestSource[], candidates: DiscoveryManifestSource[], error?: unknown): void {
  if (error instanceof SessionContractError && error.code === 'RESOURCE_LIMIT_EXCEEDED') throw error;
  const problem = discoveryProblem(descriptor, roots, status);
  if (candidates.some(source => source.sourceId === problem.sourceId)) return;
  providerSources.push(problem);
  candidates.push(problem);
}
