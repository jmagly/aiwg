// Resolve configured tracker credentials and enforce actor policy before HTTP writes.
import type { TrackerActorConfig } from '../config/aiwg-config.js';
import type { SensitiveInputDependencies, SensitiveInputOptions } from '../auth/sensitive-input.js';
import { resolveLiveIssueToken } from './live.js';
import type { ExternalIssueProvider } from './types.js';

export async function trackerToken(provider: ExternalIssueProvider, actor?: TrackerActorConfig,
  source: SensitiveInputOptions = {}, dependencies: SensitiveInputDependencies = {}): Promise<string | undefined> {
  if (actor?.credential && Object.keys(source).some(key => key !== 'prefix')) {
    throw new Error('Configured tracker_actor.credential cannot be overridden by token flags');
  }
  try {
    return await resolveLiveIssueToken(provider, actor?.credential ?? source, dependencies);
  } catch (error) {
    if (!actor?.login) throw error;
    throw new Error(`Cannot load tracker token. ${trackerAuthenticationHint(provider, actor)}`);
  }
}

export function trackerAuthenticationHint(provider: ExternalIssueProvider, actor: TrackerActorConfig): string {
  return `Authentication required for configured tracker_actor.login ${JSON.stringify(actor.login)}. Set up a ${provider} token belonging to this actor with aiwg auth secret set <name> --value-stdin, then set remotes.tracker_actor.credential to {"store":"<name>"} (or {"env":"TOKEN_ENV"} with that variable supplied). If a credential reference is already configured, refresh that source.`;
}

export function checkTrackerActor(actor: TrackerActorConfig, login: unknown): void {
  if (typeof login !== 'string' || !login) throw new Error('Tracker API did not identify an authenticated actor');
  const normalized = login.toLowerCase();
  if (actor.forbid_actors?.some(value => value.toLowerCase() === normalized)) throw new Error('Tracker actor is forbidden by remotes.tracker_actor.forbid_actors');
  if (actor.login && actor.login.toLowerCase() !== normalized) throw new Error('Tracker API user does not match remotes.tracker_actor.login');
}
