// Validate optional tracker credentials and merge execution policy in existing config owners.
import type { AiwgConfig } from './aiwg-config.js';

export function validateDeliverySettings(config: Pick<AiwgConfig, 'delivery' | 'remotes'>): string[] {
  const errors: string[] = [];
  const delivery = config.delivery;
  if (delivery?.merge !== undefined && !['local-signed', 'local', 'tracker'].includes(delivery.merge)) errors.push('delivery.merge must be local-signed, local, or tracker');
  for (const name of ['tracker_actor', 'customer_tracker_actor'] as const) {
    const credential = config.remotes?.[name]?.credential;
    if (credential !== undefined) {
      const entries = credential && typeof credential === 'object' ? Object.entries(credential) : [];
      if (entries.length !== 1 || !entries.every(([key, value]) => typeof value === 'string' &&
        (key === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) : key === 'store' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)))) {
        errors.push(`remotes.${name}.credential requires exactly one store or env reference`);
      }
    }
  }
  if (delivery?.merge === 'local-signed' && (!delivery.signing?.key || !delivery.committer?.name || !delivery.committer.email)) {
    errors.push('delivery.merge=local-signed requires signing.key and committer.name/email');
  }
  return errors;
}
