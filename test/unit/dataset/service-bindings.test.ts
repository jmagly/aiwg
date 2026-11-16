// Exercises qualified composition through real CLI construction and shared persistence.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatasetCliService, datasetHandler, executeDatasetCommand } from '../../../src/cli/handlers/dataset.js'
import type { HandlerContext } from '../../../src/cli/handlers/types.js'
import { datasetDigest, verifyProcessingPlanDigest, verifyRunReceiptDigest, validateDatasetContract } from '../../../src/dataset/contracts.js'
import { request } from '../../../src/dataset/adapter-sdk.js'
import { DatasetBindingRegistry, datasetBindingRegistry } from '../../../src/dataset/service-binding-registry.js'
import { requireDatasetBindingSelection, requireDatasetServiceBinding } from '../../../src/dataset/service-binding-contract.js'
import { FileDatasetOrchestrationRepository } from '../../../src/dataset/file-orchestration-repository.js'
import { LocalDatasetExecutionBackend } from '../../../src/dataset/local-execution-backend.js'
import { sealFortemiFixtureReceipt } from '../../../src/dataset/fortemi-execution-bridge.js'
import { bindingCheckpointId } from '../../../src/dataset/service-binding-checkpoints.js'
import { loadSchemaCatalog, SchemaResolver } from '../../../src/schema/index.js'
import { SyntheticPackageAdapter, fixtureBridge, fixtureDescriptor, fixtureJson } from '../../fixtures/dataset/bindings/runtime.js'
import type { AdapterCheckpoint } from '../../../src/dataset/adapter-types.js'
import type { ProcessingPlan } from '../../../src/dataset/types.js'

const temporary: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
let sequence = 0
async function setup(options: Parameters<typeof fixtureBridge>[1] = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'aiwg-binding-')); temporary.push(cwd)
  await writeFile(join(cwd, 'package.jsonl'), await readFile(new URL('../../fixtures/dataset/bindings/package.jsonl', import.meta.url)))
  const adapter = new SyntheticPackageAdapter()
  const identity = (await adapter.check(request('identity', { path: 'package.jsonl' }, { offline: true, allowedRoot: cwd }))).value!.sourceIdentity
  const manifest = adapter.describe()
  const checkpoint: AdapterCheckpoint = {
    contractVersion: 'aiwg.dataset.adapter/v1', kind: 'AdapterCheckpoint', adapter: { id: manifest.id, version: manifest.version },
    sourceIdentity: identity, cursor: '-1', schema: { id: manifest.schemas.checkpoint.id, version: manifest.schemas.checkpoint.version, digest: manifest.schemas.checkpoint.digest }, createdAt: '2026-11-16T00:00:00Z',
  }
  const bridge = fixtureBridge(() => ({ ...checkpoint, cursor: '0' }), options)
  await bridge.backend.negotiate()
  const descriptor = { ...fixtureDescriptor(adapter, options.capabilities), id: `fixture.binding-${++sequence}` }
  const selection = datasetBindingRegistry.register(descriptor, adapter, bridge.backend, bridge.backendIdentity)
  await writeFile(join(cwd, 'binding.json'), JSON.stringify(selection))
  const ctx = (args: string[], signal?: AbortSignal): HandlerContext => ({ cwd, frameworkRoot: cwd, args, rawArgs: ['dataset', ...args], signal })
  const cli = async (args: string[], signal?: AbortSignal) => {
    const response = await executeDatasetCommand(ctx([...args, '--binding', 'binding.json', '--json'], signal))
    return JSON.parse(response.message!)
  }
  const source = {
    id: 'source:package', revisionId: 'revision:package-v1', identity,
    adapter: { id: manifest.id, version: manifest.version }, config: { path: 'package.jsonl' },
    policy: { offline: true, allowedRoot: cwd }, checkpoint,
  }
  await writeFile(join(cwd, 'source.json'), JSON.stringify(source))
  expect((await cli(['source', '--file', 'source.json'])).ok).toBe(true)
  const planInput = {
    id: 'plan:package', sourceId: source.id, profile: fixtureJson('profile.json'), backend: 'fortemi-core',
    schemas: [{ id: 'schema:package', version: '1.0.0', digest: datasetDigest('package-schema') }],
    policy: { privacy: 'internal', intendedUse: ['synthetic-preservation'], locality: 'local-only', network: 'offline', authorizationRefs: ['approval:fixture'] },
    steps: ['preserve-package', 'project-native-graph-membership'].map(operation => ({
      id: `step:${operation}`, operation, implementation: { id: descriptor.backend.id, version: descriptor.backend.version, digest: descriptor.backend.packageDigest }, configDigest: datasetDigest(source.config),
    })),
    artifactClasses: ['derived', 'regenerable-index'], estimates: { reads: 1, writes: 3, bytes: 4096 },
    approvals: [{ id: 'approval:fixture', required: true, reason: 'bounded synthetic effects' }], createdBy: 'fixture',
  }
  await writeFile(join(cwd, 'plan.json'), JSON.stringify(planInput))
  const planned = await cli(['plan', '--file', 'plan.json'])
  const plan = planned.data as ProcessingPlan | undefined
  const ingest = (key = 'once', signal?: AbortSignal) => cli(['ingest', plan!.id, '--digest', plan!.planDigest.value, '--idempotency-key', key, '--approve', 'approval:fixture'], signal)
  return { cwd, ctx, cli, ingest, plan, planned, planInput, adapter, descriptor, selection, source, bridge, checkpoint }
}

describe('qualified dataset CLI bindings (#3816)', () => {
  it('projects strict schema fixtures and the catalog authority into runtime validators', async () => {
    const schema = JSON.parse(await readFile('schemas/dataset/service-binding.v1.schema.json', 'utf8'))
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema)
    for (const name of ['descriptor.valid.json', 'selection.valid.json']) expect(validate(fixtureJson(name)), JSON.stringify(validate.errors)).toBe(true)
    expect(validate(fixtureJson('selection.invalid.json'))).toBe(false)
    expect(validate(fixtureJson('capability-version.invalid.json'))).toBe(false)
    expect(() => requireDatasetServiceBinding(fixtureJson('capability-version.invalid.json'))).toThrow('CONTRACT_INVALID')
    expect(() => requireDatasetBindingSelection(fixtureJson('selection.invalid.json'))).toThrow('SELECTION_INVALID')
    expect(() => requireDatasetServiceBinding({ ...fixtureJson('descriptor.valid.json'), datasetContractVersion: 'aiwg.dataset/v2' })).toThrow('CONTRACT_INVALID')
    const catalog = loadSchemaCatalog({ rootDir: process.cwd() })
    expect(catalog.valid, JSON.stringify(catalog.diagnostics)).toBe(true)
    expect(new SchemaResolver(catalog.catalog!, { rootDir: process.cwd() }).require('dataset.service-binding@1.0.0').artifact.authority.path)
      .toBe('schemas/dataset/service-binding.v1.schema.json')
  })

  it('selects a qualified pair through the handler, negotiates exact capabilities and preserves bindings', async () => {
    const x = await setup()
    expect(x.planned).toMatchObject({ ok: true, degraded: [] })
    expect(x.plan!.execution.backend).toContain(x.selection.descriptorDigest.value)
    expect(x.plan!.source.revisionId).toBe(x.source.revisionId)
    expect(x.plan!.capabilities).toEqual(x.planInput.profile.capabilities)
    expect(x.plan!.capabilityDecision.satisfied).toEqual(['native-graph', 'native-membership', 'package-preservation'])
    expect(verifyProcessingPlanDigest(x.plan!)).toBe(true)
    expect(validateDatasetContract(x.plan!).valid).toBe(true)
    const reply = await datasetHandler.execute(x.ctx(['preview', x.source.id, '--binding', 'binding.json', '--count', '1', '--offline', '--json']))
    expect(reply.exitCode).toBe(0)
    const run = (await x.ingest()).data
    expect(run.status).toBe('committed')
    expect(run.planDigest).toEqual(x.plan!.planDigest)
    expect(run.checkpoint).toMatchObject({ ...x.checkpoint, cursor: '0' })
    expect(verifyRunReceiptDigest(run.receipt)).toBe(true)
    expect(run.receipt.planDigest).toEqual(x.plan!.planDigest)
    expect(run.receipt.checkpointBeforeId).toBe(bindingCheckpointId(x.checkpoint))
    expect(run.receipt.checkpointAfterId).toBe(bindingCheckpointId(run.checkpoint))
    expect(x.bridge.requests[0].priorCheckpoint).toEqual(x.checkpoint)
    expect(x.bridge.preserved).toHaveLength(1)
    expect((x.bridge.preserved[0] as any).value).toMatchObject({ packageHash: 'b'.repeat(64), files: expect.any(Array) })
    expect(x.bridge.graph).toEqual([{ sourceRevision: x.source.revisionId, planDigest: x.plan!.planDigest }])
    expect(x.bridge.memberships).toHaveLength(1)
    expect((await x.cli(['lineage', run.runId])).data).toMatchObject({ sourceRevisionId: x.source.revisionId, checkpoint: run.checkpoint })
    expect((await x.cli(['verify', run.runId])).ok).toBe(true)
    expect((await x.ingest()).data).toEqual(run)
    expect(x.bridge.requests).toHaveLength(1)
    const noSelection = await datasetHandler.execute(x.ctx(['ingest', x.plan!.id, '--digest', x.plan!.planDigest.value, '--idempotency-key', 'no-binding', '--approve', 'approval:fixture', '--json']))
    expect(noSelection.exitCode).toBe(1)
    expect(x.bridge.requests).toHaveLength(1)
  })

  it.each(['package-preservation', 'native-graph', 'native-membership', 'version'])('fails before reading or execution without exact %s capability', async missing => {
    const capabilities = fixtureJson('descriptor.valid.json').capabilities
      .filter((item: { name: string }) => item.name !== missing)
      .map((item: { name: string; version: string }) => ({ ...item, version: missing === 'version' ? '2.0.0' : item.version }))
    const read = vi.spyOn(SyntheticPackageAdapter.prototype, 'read')
    const x = await setup({ capabilities })
    expect(x.planned).toMatchObject({ ok: false, diagnostics: [{ code: 'DATASET_REQUIRED_CAPABILITY_UNSUPPORTED' }] })
    expect(read).not.toHaveBeenCalled()
    expect(x.bridge.requests).toHaveLength(0)
    expect(x.bridge.preserved).toEqual([])
    expect(x.bridge.graph).toEqual([])
    expect((await x.cli(['query', 'artifact:plan:package'])).data.records).toEqual([])
  })

  it('preserves local execution locality for an explicitly qualified local pair', async () => {
    const x = await setup(); const registry = new DatasetBindingRegistry()
    const local = new LocalDatasetExecutionBackend()
    vi.spyOn(local, 'capabilities').mockReturnValue([{ name: 'incremental-read', version: '1.0.0' }])
    const backendIdentity = { id: 'local', version: '1.0.0', packageDigest: datasetDigest('synthetic-local-backend-v1') }
    const descriptor = { ...fixtureDescriptor(x.adapter, local.capabilities()), backend: backendIdentity }
    const selection = registry.register(descriptor, x.adapter, local, backendIdentity)
    await writeFile(join(x.cwd, 'local-binding.json'), JSON.stringify(selection))
    const service = createDatasetCliService(x.ctx(['--binding', 'local-binding.json']), registry)
    const result = await service.plan({ ...x.planInput, backend: 'local', profile: {
      ...x.planInput.profile,
      capabilities: [{ name: 'incremental-read', requirement: 'required', acceptedVersions: ['1.0.0'], degradation: { action: 'fail' } }],
    } } as any)
    expect(result.ok).toBe(true)
    expect((result.data as ProcessingPlan).execution).toMatchObject({ locality: 'local', backend: expect.stringContaining('dataset-binding:') })
  })

  it('rejects unregistered, unqualified, incompatible, duplicate and changed registrations', async () => {
    const x = await setup(); const registry = new DatasetBindingRegistry()
    expect(() => registry.select(x.selection)).toThrow('NOT_REGISTERED')
    const failed = structuredClone(x.descriptor); failed.qualification.cells[0].passed = false
    expect(() => registry.register(failed, x.adapter, x.bridge.backend, x.bridge.backendIdentity)).toThrow('UNQUALIFIED')
    const duplicate = structuredClone(x.descriptor); duplicate.qualification.cells[1] = duplicate.qualification.cells[0]
    expect(() => registry.register(duplicate, x.adapter, x.bridge.backend, x.bridge.backendIdentity)).toThrow('UNQUALIFIED')
    for (const changed of [
      { ...x.descriptor, adapter: { ...x.descriptor.adapter, version: '2.0.0' } },
      { ...x.descriptor, adapterManifestDigest: datasetDigest('wrong') },
      { ...x.descriptor, capabilities: [{ name: 'note-upsert', version: '1.0.0' }] },
    ]) expect(() => registry.register(changed, x.adapter, x.bridge.backend, x.bridge.backendIdentity)).toThrowError(expect.objectContaining({ code: 'DATASET_BINDING_INCOMPATIBLE' }))
    registry.register(x.descriptor, x.adapter, x.bridge.backend, x.bridge.backendIdentity)
    expect(() => registry.register(x.descriptor, x.adapter, x.bridge.backend, x.bridge.backendIdentity)).toThrow('DUPLICATE')
    expect(() => registry.select({ ...x.selection, descriptorDigest: datasetDigest('wrong') })).toThrow('DIGEST_MISMATCH')
    const describe = x.adapter.describe.bind(x.adapter)
    vi.spyOn(x.adapter, 'describe').mockImplementation(() => ({ ...describe(), maturity: 'experimental' }))
    expect(() => registry.select(x.selection)).toThrowError(expect.objectContaining({ code: 'DATASET_BINDING_INCOMPATIBLE' }))
  })

  it.each(['version', 'packageDigest'] as const)('rejects a backend %s that differs from trusted installed identity', async field => {
    const x = await setup(); const registry = new DatasetBindingRegistry()
    const descriptor = structuredClone(x.descriptor)
    if (field === 'version') descriptor.backend.version = '2.0.0'
    else descriptor.backend.packageDigest = datasetDigest('wrong-backend-package')
    expect(() => registry.register(descriptor, x.adapter, x.bridge.backend, x.bridge.backendIdentity))
      .toThrowError(expect.objectContaining({ code: 'DATASET_BINDING_INCOMPATIBLE' }))
    expect(() => registry.select(x.selection)).toThrow('NOT_REGISTERED')
  })

  it.each(['check', 'discover', 'preview'] as const)('rechecks adapter maturity at the selected %s boundary', async operation => {
    const x = await setup()
    const selected = datasetBindingRegistry.select(x.selection).adapter(x.source.adapter.id, x.source.adapter.version)
    const invoked = vi.spyOn(x.adapter, operation)
    const manifest = x.adapter.describe()
    vi.spyOn(x.adapter, 'describe').mockReturnValue({ ...manifest, maturity: 'experimental' })
    expect(() => selected[operation]({ ...request('drift', x.source.config, x.source.policy), count: 1 }))
      .toThrowError(expect.objectContaining({ code: 'DATASET_BINDING_INCOMPATIBLE' }))
    expect(invoked).not.toHaveBeenCalled()
  })

  it.each(['rewrite-before', 'strip-before', 'strip-after', 'rewrite-after'] as const)('rejects %s in a freshly checksummed persisted receipt', async mismatch => {
    const x = await setup(); const run = (await x.ingest()).data
    expect((await x.cli(['verify', run.runId])).ok).toBe(true)
    const receipt = { ...run.receipt }
    if (mismatch === 'rewrite-before') receipt.checkpointBeforeId = bindingCheckpointId({ ...x.checkpoint, cursor: '-2' })
    if (mismatch === 'strip-before') delete receipt.checkpointBeforeId
    if (mismatch === 'strip-after') delete receipt.checkpointAfterId
    if (mismatch === 'rewrite-after') receipt.checkpointAfterId = bindingCheckpointId({ ...run.checkpoint, cursor: '99' })
    const sealed = sealFortemiFixtureReceipt(receipt)
    expect(verifyRunReceiptDigest(sealed)).toBe(true)
    await new FileDatasetOrchestrationRepository(x.cwd).putRun({ ...run, receipt: sealed })
    expect((await x.cli(['verify', run.runId])).diagnostics[0].code).toBe('DATASET_RECEIPT_INVALID')
  })

  it('verifies a binding run without a prior checkpoint and rejects an invented before-checkpoint', async () => {
    const x = await setup(); const repo = new FileDatasetOrchestrationRepository(x.cwd)
    await repo.putSource({ ...x.source, checkpoint: undefined })
    const run = (await x.ingest()).data
    expect(run.receipt.checkpointBeforeId).toBeUndefined()
    expect((await x.cli(['verify', run.runId])).ok).toBe(true)
    await repo.putRun({ ...run, receipt: sealFortemiFixtureReceipt({ ...run.receipt, checkpointBeforeId: bindingCheckpointId(x.checkpoint) }) })
    expect((await x.cli(['verify', run.runId])).ok).toBe(false)
  })

  it.each(['revision', 'identity', 'checkpoint'])('fails verification when the bound source %s changes', async field => {
    const x = await setup(); const run = (await x.ingest()).data
    const source = { ...x.source }
    if (field === 'revision') source.revisionId = 'revision:other'
    if (field === 'identity') source.identity = 'identity:other'
    if (field === 'checkpoint') source.checkpoint = { ...source.checkpoint, cursor: '99' }
    await new FileDatasetOrchestrationRepository(x.cwd).putSource(source)
    expect((await x.cli(['verify', run.runId])).diagnostics[0].code).toBe('DATASET_RECEIPT_INVALID')
  })

  it('rejects dataset-supplied module paths and malformed CLI selectors without loading them', async () => {
    const x = await setup()
    await writeFile(join(x.cwd, 'malicious.mjs'), 'throw new Error("MODULE_EXECUTED")')
    for (const value of [fixtureJson('selection.invalid.json'), { ...x.selection, id: './malicious.mjs' }, { ...x.selection, version: '2.0.0' }]) {
      await writeFile(join(x.cwd, 'binding.json'), JSON.stringify(value))
      const response = await datasetHandler.execute(x.ctx(['check', x.source.id, '--binding', 'binding.json', '--json']))
      expect(response.exitCode).toBe(1)
      expect(response.message).not.toContain('MODULE_EXECUTED')
    }
    for (const args of [['check', x.source.id, '--binding'], ['check', x.source.id, '--binding', '--json'], ['check', x.source.id, '--binding', 'binding.json', '--binding', 'binding.json']])
      expect(() => createDatasetCliService(x.ctx(args))).toThrow('SELECTION_REQUIRED')
  })

  it('rejects explicit local substitution, capability drift and conflicting replay before effects', async () => {
    const x = await setup()
    await writeFile(join(x.cwd, 'plan.json'), JSON.stringify({ ...x.planInput, backend: 'local' }))
    expect((await x.cli(['plan', '--file', 'plan.json'])).diagnostics[0].code).toBe('DATASET_BINDING_BACKEND_MISMATCH')
    const first = (await x.ingest()).data
    const repo = new FileDatasetOrchestrationRepository(x.cwd)
    const other = { ...x.plan!, id: 'plan:other' }
    const { computeProcessingPlanDigest } = await import('../../../src/dataset/contracts.js')
    other.planDigest = computeProcessingPlanDigest(other)
    await repo.putPlan(other)
    expect((await x.cli(['ingest', other.id, '--digest', other.planDigest.value, '--idempotency-key', 'once', '--approve', 'approval:fixture'])).diagnostics[0].code)
      .toBe('DATASET_IDEMPOTENCY_CONFLICT')
    await repo.putRun({ ...first, checkpoint: { ...first.checkpoint, cursor: '100' } })
    expect((await x.cli(['verify', first.runId])).diagnostics[0].code).toBe('DATASET_RECEIPT_INVALID')
    vi.spyOn(x.bridge.backend, 'capabilities').mockReturnValue([])
    const changed = await datasetHandler.execute(x.ctx(['ingest', x.plan!.id, '--digest', x.plan!.planDigest.value, '--idempotency-key', 'changed', '--binding', 'binding.json', '--json']))
    expect(changed.exitCode).toBe(1)
    expect(x.bridge.requests).toHaveLength(1)
  })

  it('preserves the committed source checkpoint on bounded cancellation and resumes with a new approved attempt', async () => {
    const x = await setup(); const controller = new AbortController(); controller.abort()
    const cancelled = (await x.ingest('cancelled', controller.signal)).data
    expect(cancelled).toMatchObject({ status: 'cancelled', receipt: { committed: false, committedRecords: 0 } })
    expect(cancelled.checkpoint).toBeUndefined()
    const repo = new FileDatasetOrchestrationRepository(x.cwd)
    expect((await repo.getSource(x.source.id))!.checkpoint).toEqual(x.checkpoint)
    expect(x.bridge.requests).toHaveLength(0)
    const resumed = (await x.ingest('resumed')).data
    expect(resumed.status).toBe('committed')
    expect(x.bridge.requests[0].priorCheckpoint).toEqual(x.checkpoint)
    expect((await x.ingest('cancelled')).data).toEqual(cancelled)
    expect(x.bridge.requests).toHaveLength(1)
  })

  it('retains attempted counts on backend cancellation and resumes without advancing its uncommitted checkpoint', async () => {
    const options = { outcome: 'cancelled' as 'cancelled' | 'committed' }
    const x = await setup(options)
    const cancelled = (await x.ingest('partial')).data
    expect(cancelled).toMatchObject({ status: 'cancelled', receipt: { attemptedRecords: 1, committedRecords: 0, checkpointBeforeId: bindingCheckpointId(x.checkpoint) } })
    expect(cancelled.checkpoint).toBeUndefined()
    expect(cancelled.receipt.checkpointAfterId).toBeUndefined()
    expect((await x.cli(['verify', cancelled.runId])).ok).toBe(true)
    expect(x.bridge.preserved).toHaveLength(0)
    options.outcome = 'committed'
    expect((await x.ingest('resume-partial')).data.status).toBe('committed')
    expect(x.bridge.requests.map(value => value.priorCheckpoint)).toEqual([x.checkpoint, x.checkpoint])
    expect(x.bridge.preserved).toHaveLength(1)
  })

  it.each(['plan', 'plan-id', 'counts', 'outcome', 'digest', 'checkpoint'])('rejects independently returned receipt %s mismatch', async mismatch => {
    const x = await setup({ mutateReceipt(receipt) {
      if (mismatch === 'plan') receipt.planDigest = datasetDigest('wrong-plan')
      if (mismatch === 'plan-id') receipt.planId = 'plan:other'
      if (mismatch === 'counts') receipt.committedRecords++
      if (mismatch === 'outcome') { receipt.committed = false; receipt.outcome = 'cancelled' }
      if (mismatch === 'checkpoint') receipt.checkpointAfterId = 'checkpoint:wrong'
      if (mismatch === 'digest') return { ...receipt, receiptDigest: datasetDigest('wrong-receipt') }
      return sealFortemiFixtureReceipt(receipt)
    } })
    const result = await x.ingest()
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0].message).toContain('DATASET_FORTEMI_RECEIPT_INVALID')
    expect((await new FileDatasetOrchestrationRepository(x.cwd).getSource(x.source.id))!.checkpoint).toEqual(x.checkpoint)
    expect((await new FileDatasetOrchestrationRepository(x.cwd).getRunByIdempotency('once'))!.lastCommittedReceipt).toBeUndefined()
  })

  it('blocks excess records and bytes before executing the backend', async () => {
    for (const content of ['{}\n{}\n{}\n', JSON.stringify({ oversized: 'x'.repeat(3000) }) + '\n']) {
      const x = await setup()
      await writeFile(join(x.cwd, 'package.jsonl'), content)
      // Clear the old checkpoint so the adapter can expose the changed bounded fixture.
      const repo = new FileDatasetOrchestrationRepository(x.cwd)
      await repo.putSource({ ...x.source, checkpoint: undefined })
      const result = await x.ingest()
      expect(result.ok).toBe(false)
      expect(result.diagnostics[0].code).toMatch(/RESOURCE_LIMIT/)
      expect(x.bridge.requests).toHaveLength(0)
    }
  })
})
