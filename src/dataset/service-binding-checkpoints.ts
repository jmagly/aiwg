// Binds selected-service checkpoints into the existing digest-protected receipt fields.
import type { AdapterCheckpoint } from './adapter-types.js'
import { datasetDigest } from './contracts.js'
import type { DatasetOrchestrationRepository } from './orchestration-repository.js'
import type { DatasetRunState, ExecutionResult } from './orchestration-types.js'

export function bindingCheckpointId(checkpoint: AdapterCheckpoint): string {
  return `checkpoint:sha256:${datasetDigest(checkpoint).value}`
}
export function bindingReceiptCheckpoints(backend: string, before: AdapterCheckpoint | undefined, result: ExecutionResult) {
  if (!backend.startsWith('dataset-binding:')) return {}
  return {
    ...(before ? { checkpointBeforeId: bindingCheckpointId(before) } : {}),
    ...(result.outcome === 'committed' && result.checkpoint ? { checkpointAfterId: bindingCheckpointId(result.checkpoint) } : {}),
  }
}
export async function verifyBindingCheckpointReceipt(run: DatasetRunState, repo: DatasetOrchestrationRepository): Promise<boolean> {
  const plan = await repo.getPlan(run.planId)
  if (plan?.execution.backend.startsWith('dataset-binding:')) {
    const source = await repo.getSource(plan.source.id)
    if (!source || source.revisionId !== plan.source.revisionId || (source.identity ?? source.id) !== plan.source.identity) return false
    const before = source.checkpoint ? bindingCheckpointId(source.checkpoint) : undefined
    const after = run.status === 'committed' && run.checkpoint ? bindingCheckpointId(run.checkpoint) : undefined
    return run.receipt?.checkpointBeforeId === before && run.receipt?.checkpointAfterId === after
  }
  const after = run.receipt?.checkpointAfterId
  return !after || !after.startsWith('checkpoint:sha256:') || (!!run.checkpoint && bindingCheckpointId(run.checkpoint) === after)
}
