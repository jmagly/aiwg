// Resolves exact backend identities without implicit local fallback.
import type { DatasetOrchestrationDependencies } from './orchestration-types.js'
import { DatasetContractError } from './contracts.js'

export function selectDatasetBackend(deps: DatasetOrchestrationDependencies, id?: string) {
  if (deps.selectBackend) return deps.selectBackend(id)
  if (id === undefined || id === 'local') return deps.localBackend
  if (id === 'fortemi-core' && deps.fortemiBackend) return deps.fortemiBackend
  throw new DatasetContractError(id === 'fortemi-core' ? 'DATASET_FORTEMI_UNAVAILABLE' : 'DATASET_BACKEND_NOT_REGISTERED',
    'An explicitly selected compatible dataset backend is required')
}
