// Supplies bounded synthetic package preservation and native projection bindings.
import { readFileSync } from 'node:fs'
import { JsonlAdapter } from '../../../../src/dataset/adapters.js'
import { datasetDigest } from '../../../../src/dataset/contracts.js'
import { FortemiExecutionBridge, sealFortemiFixtureReceipt, type FortemiTransport } from '../../../../src/dataset/fortemi-execution-bridge.js'
import type { AdapterCheckpoint } from '../../../../src/dataset/adapter-types.js'
import type { ExecutionResult } from '../../../../src/dataset/orchestration-types.js'
import type { ProcessingPlan, RunReceipt } from '../../../../src/dataset/types.js'
import type { DatasetBindingComponent, DatasetServiceBinding } from '../../../../src/dataset/service-binding-contract.js'
import { bindingCheckpointId } from '../../../../src/dataset/service-binding-checkpoints.js'

export const fixtureJson = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'))
const backendIdentity: DatasetBindingComponent = {
  id: 'fortemi-core', version: '1.0.0', packageDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
}
export class SyntheticPackageAdapter extends JsonlAdapter {
  override describe() {
    return { ...super.describe(), id: 'fixture.package', packageDigest: datasetDigest('synthetic-package-adapter-v1'), trust: { state: 'verified' as const } }
  }
}
export function fixtureDescriptor(adapter: SyntheticPackageAdapter, capabilities = fixtureJson('descriptor.valid.json').capabilities): DatasetServiceBinding {
  const manifest = adapter.describe()
  return {
    ...fixtureJson('descriptor.valid.json'),
    adapter: { id: manifest.id, version: manifest.version, packageDigest: manifest.packageDigest },
    adapterManifestDigest: datasetDigest(manifest), capabilities,
  }
}
export function fixtureBridge(checkpoint: () => AdapterCheckpoint, options: {
  capabilities?: Array<{ name: string; version: string }>
  mutateReceipt?: (receipt: RunReceipt) => RunReceipt
  outcome?: ExecutionResult['outcome']
} = {}) {
  const requests: Parameters<FortemiTransport['execute']>[0][] = []
  const preserved: unknown[] = []
  const graph: unknown[] = []
  const memberships: unknown[] = []
  const receipts: RunReceipt[] = []
  const backend = new FortemiExecutionBridge({
    capabilities: async () => options.capabilities ?? fixtureJson('descriptor.valid.json').capabilities,
    async execute(request) {
      requests.push(request)
      const plan = request.plan as ProcessingPlan
      const outcome = options.outcome ?? 'committed'
      const committed = outcome === 'committed'
      const result: ExecutionResult = {
        outcome, attemptedRecords: request.records.length, committedRecords: committed ? request.records.length : 0,
        rejectedRecords: 0, diagnostics: [], checkpoint: checkpoint(),
      }
      const receipt: RunReceipt = sealFortemiFixtureReceipt({
        contractVersion: 'aiwg.dataset/v1', kind: 'RunReceipt', id: 'receipt:fixture', runId: 'run:fixture',
        planId: plan.id, planDigest: plan.planDigest, outcome: outcome === 'ambiguous' ? 'attempted' : outcome,
        committed, attemptedRecords: result.attemptedRecords, committedRecords: result.committedRecords, rejectedRecords: 0,
        createdAt: '2026-11-16T00:00:00Z', receiptDigest: datasetDigest('pending'),
        ...(request.priorCheckpoint ? { checkpointBeforeId: bindingCheckpointId(request.priorCheckpoint) } : {}),
        ...(committed && result.checkpoint ? { checkpointAfterId: bindingCheckpointId(result.checkpoint) } : {}),
      })
      if (committed) {
        preserved.push(...request.records)
        graph.push({ sourceRevision: plan.source.revisionId, planDigest: plan.planDigest })
        memberships.push({ package: plan.source.identity, count: request.records.length })
      }
      const returned = options.mutateReceipt?.(receipt) ?? receipt
      receipts.push(returned)
      return { result, receipt: returned }
    },
  })
  return { backend, backendIdentity: structuredClone(backendIdentity), requests, preserved, graph, memberships, receipts }
}
