// Admits trusted, preloaded adapter/backend pairs and pins their CLI execution identity.
import { satisfies } from 'semver'
import type { AdapterReadEvent, DatasetSourceAdapter } from './adapter-types.js'
import { DATASET_ADAPTER_CONTRACT_VERSION } from './adapter-types.js'
import { validateCheckpoint } from './adapter-sdk.js'
import { datasetDigest, DatasetContractError } from './contracts.js'
import type { DatasetExecutionBackend, DatasetOrchestrationDependencies } from './orchestration-types.js'
import { DATASET_CONTRACT_VERSION } from './types.js'
import {
  requireDatasetBindingSelection, requireDatasetServiceBinding,
  type DatasetBindingComponent, type DatasetBindingSelection, type DatasetServiceBinding,
} from './service-binding-contract.js'

interface Registration {
  descriptor: DatasetServiceBinding
  adapter: DatasetSourceAdapter
  backend: DatasetExecutionBackend
  backendIdentity: DatasetBindingComponent
}
const same = (a: unknown, b: unknown) => datasetDigest(a).value === datasetDigest(b).value
const offers = (backend: DatasetExecutionBackend) => [...backend.capabilities()].sort((a, b) => a.name.localeCompare(b.name))
const expectedOffers = (descriptor: DatasetServiceBinding) => [...descriptor.capabilities].sort((a, b) => a.name.localeCompare(b.name))

function assertRegistration({ descriptor: d, adapter, backend, backendIdentity }: Registration) {
  const manifest = adapter.describe()
  if (manifest.contractVersion !== DATASET_ADAPTER_CONTRACT_VERSION || !satisfies('1.0.0', manifest.datasetContractRange)
    || d.datasetContractVersion !== DATASET_CONTRACT_VERSION || d.adapterContractVersion !== manifest.contractVersion
    || manifest.id !== d.adapter.id || manifest.version !== d.adapter.version
    || !same(manifest.packageDigest, d.adapter.packageDigest) || !same(datasetDigest(manifest), d.adapterManifestDigest)
    || !backendIdentity || backendIdentity.id !== d.backend.id || backendIdentity.version !== d.backend.version
    || !same(backendIdentity.packageDigest, d.backend.packageDigest)
    || backend.id !== d.backend.id || !same(offers(backend), expectedOffers(d)))
    throw new DatasetContractError('DATASET_BINDING_INCOMPATIBLE', 'Registered implementation differs from the qualified binding')
  if (manifest.maturity === 'experimental' || manifest.trust.state === 'untrusted')
    throw new DatasetContractError('DATASET_BINDING_UNQUALIFIED', 'Adapter maturity and trust must permit qualification')
}

function boundedAdapter(entry: Registration): DatasetSourceAdapter {
  const adapter = entry.adapter
  return {
    describe: () => { assertRegistration(entry); return adapter.describe() },
    configure: config => { assertRegistration(entry); return adapter.configure(config) },
    check: request => { assertRegistration(entry); return adapter.check(request) },
    discover: request => { assertRegistration(entry); return adapter.discover(request) },
    preview: request => { assertRegistration(entry); return adapter.preview({ ...request, limits: { ...request.limits, ...entry.descriptor.limits } }) },
    async *read(request): AsyncIterable<AdapterReadEvent> {
      assertRegistration(entry)
      const limits = entry.descriptor.limits
      const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(limits.timeoutMs)])
      let count = 0; let bytes = 0
      for await (const event of adapter.read({ ...request, signal, limits: { ...request.limits, ...limits } })) {
        if (request.signal?.aborted) return
        if (signal.aborted) throw new DatasetContractError('DATASET_BINDING_RESOURCE_LIMIT', 'Binding read deadline exceeded')
        if (event.kind === 'diagnostic' && event.diagnostic.severity === 'error')
          throw new DatasetContractError(event.diagnostic.code, 'Qualified adapter read failed before execution')
        if (event.kind === 'record') {
          const size = Buffer.byteLength(JSON.stringify(event.record.value))
          bytes += size; count++
          if (count > limits.maxRecords || bytes > limits.maxBytes || size > limits.maxRecordBytes)
            throw new DatasetContractError('DATASET_BINDING_RESOURCE_LIMIT', 'Binding record or byte limit exceeded')
        }
        yield event
      }
    },
  }
}

export class DatasetBindingRegistry {
  readonly #entries = new Map<string, Registration>()

  /** Trusted bootstrap only: registration never imports code or reads evidence paths. */
  register(value: unknown, adapter: DatasetSourceAdapter, backend: DatasetExecutionBackend, backendIdentity: DatasetBindingComponent): DatasetBindingSelection {
    const descriptor = requireDatasetServiceBinding(value)
    const key = `${descriptor.id}@${descriptor.version}`
    if (this.#entries.has(key)) throw new Error('DATASET_BINDING_DUPLICATE')
    const entry = { descriptor, adapter, backend, backendIdentity: structuredClone(backendIdentity) }
    assertRegistration(entry)
    this.#entries.set(key, entry)
    return {
      contractVersion: descriptor.contractVersion, kind: 'DatasetBindingSelection',
      id: descriptor.id, version: descriptor.version, descriptorDigest: datasetDigest(descriptor),
    }
  }

  select(value: unknown): Pick<DatasetOrchestrationDependencies, 'adapter' | 'selectBackend'> {
    const selection = requireDatasetBindingSelection(value)
    const entry = this.#entries.get(`${selection.id}@${selection.version}`)
    if (!entry) throw new Error('DATASET_BINDING_NOT_REGISTERED')
    if (!same(selection.descriptorDigest, datasetDigest(entry.descriptor))) throw new Error('DATASET_BINDING_DIGEST_MISMATCH')
    assertRegistration(entry)
    const adapter = boundedAdapter(entry)
    const boundId = `dataset-binding:${selection.id}@${selection.version}:sha256:${selection.descriptorDigest.value}`
    const backend: DatasetExecutionBackend = {
      id: boundId,
      locality: entry.descriptor.backend.id === 'local' ? 'local' : 'remote',
      capabilities: () => { assertRegistration(entry); return entry.backend.capabilities() },
      async execute(request) {
        assertRegistration(entry)
        if (request.plan.execution.backend !== boundId) throw new Error('DATASET_BINDING_PLAN_MISMATCH')
        if (request.signal?.aborted) return { outcome: 'cancelled', attemptedRecords: 0, committedRecords: 0, rejectedRecords: 0, diagnostics: [] }
        const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(entry.descriptor.limits.timeoutMs)])
        const result = await entry.backend.execute({ ...request, signal })
        if (result.checkpoint && validateCheckpoint(result.checkpoint, adapter.describe(), request.plan.source.identity).length)
          throw new Error('DATASET_BINDING_CHECKPOINT_MISMATCH')
        return result
      },
    }
    return {
      adapter(id, version) {
        if (id !== entry.descriptor.adapter.id || version !== entry.descriptor.adapter.version)
          throw new Error('DATASET_BINDING_ADAPTER_MISMATCH')
        assertRegistration(entry)
        return adapter
      },
      selectBackend(id) {
        if (id !== undefined && id !== boundId && id !== entry.descriptor.backend.id)
          throw new DatasetContractError('DATASET_BINDING_BACKEND_MISMATCH', 'The plan requires its explicitly selected binding')
        assertRegistration(entry)
        return backend
      },
    }
  }
}

/** Empty by default. Trusted installed entrypoints register statically imported implementations. */
export const datasetBindingRegistry = new DatasetBindingRegistry()
