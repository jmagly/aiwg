// Connect the installed verifier to the existing host-configured signed effects ledger.
import { importImpl } from '../../_resolve-impl.mjs';

async function ledgerFor(projectDir) {
  const { effectSession, openLedger } = await importImpl(import.meta.url, 'effects/host.js');
  return openLedger(await effectSession(projectDir, 'delivery'));
}
export async function prepareDeliveryRecord(projectDir, metadata) {
  const { prepareWorkerDelivery } = await importImpl(import.meta.url, 'effects/worker-delivery.js');
  return prepareWorkerDelivery(await ledgerFor(projectDir), metadata);
}
export async function lookupDeliveryRecord(projectDir, destination) {
  const { lookupWorkerDelivery } = await importImpl(import.meta.url, 'effects/worker-delivery.js');
  return lookupWorkerDelivery(await ledgerFor(projectDir), destination);
}
