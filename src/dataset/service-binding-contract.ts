// Defines and validates the versioned dataset CLI composition boundary.
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { fortemiPinnedSchemaPath } from './fortemi-schema-path.js'
import type { Digest } from './types.js'

export const DATASET_BINDING_VERSION = 'aiwg.dataset.service-binding/v1' as const
export interface DatasetBindingComponent { id: string; version: string; packageDigest: Digest }
export interface DatasetBindingSelection {
  contractVersion: typeof DATASET_BINDING_VERSION
  kind: 'DatasetBindingSelection'
  id: string
  version: string
  descriptorDigest: Digest
}
export interface DatasetServiceBinding {
  contractVersion: typeof DATASET_BINDING_VERSION
  kind: 'DatasetServiceBinding'
  id: string
  version: string
  datasetContractVersion: 'aiwg.dataset/v1'
  adapterContractVersion: 'aiwg.dataset.adapter/v1'
  adapter: DatasetBindingComponent
  adapterManifestDigest: Digest
  backend: DatasetBindingComponent
  capabilities: Array<{ name: string; version: string }>
  limits: { maxRecords: number; maxBytes: number; maxRecordBytes: number; timeoutMs: number }
  qualification: {
    fixtureRevision: string
    cells: Array<{ name: 'admission' | 'capability-version' | 'cancellation-resume' | 'replay' | 'receipt-mismatch'; passed: boolean; evidence: string[] }>
  }
}
const schema = JSON.parse(readFileSync(fortemiPinnedSchemaPath('schemas/dataset/service-binding.v1.schema.json'), 'utf8'))
const ajv = new Ajv2020({ strict: true, allErrors: true })
ajv.addSchema(schema)
const selection = ajv.compile<DatasetBindingSelection>({ $ref: `${schema.$id}#/$defs/selection` })
const descriptor = ajv.compile<DatasetServiceBinding>({ $ref: `${schema.$id}#/$defs/descriptor` })

export function requireDatasetBindingSelection(value: unknown): DatasetBindingSelection {
  if (!selection(value)) throw new Error('DATASET_BINDING_SELECTION_INVALID')
  return structuredClone(value)
}
export function requireDatasetServiceBinding(value: unknown): DatasetServiceBinding {
  if (!descriptor(value)) throw new Error('DATASET_BINDING_CONTRACT_INVALID')
  if (new Set(value.capabilities.map(item => item.name)).size !== value.capabilities.length)
    throw new Error('DATASET_BINDING_CAPABILITY_DUPLICATE')
  if (new Set(value.qualification.cells.map(cell => cell.name)).size !== 5 || value.qualification.cells.some(cell => !cell.passed))
    throw new Error('DATASET_BINDING_UNQUALIFIED')
  return structuredClone(value)
}
