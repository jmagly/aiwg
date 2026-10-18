import { mkdtemp } from '../../helpers/temp-dir.js';
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonlAdapter, HttpAdapter } from "../../../src/dataset/adapters.js";
import { FileDatasetOrchestrationRepository } from "../../../src/dataset/file-orchestration-repository.js";
import {
  FortemiExecutionBridge,
  sealFortemiFixtureReceipt,
} from "../../../src/dataset/fortemi-execution-bridge.js";
import { LocalDatasetExecutionBackend } from "../../../src/dataset/local-execution-backend.js";
import { MemoryDatasetOrchestrationRepository } from "../../../src/dataset/orchestration-repository.js";
import { DatasetOrchestrationService } from "../../../src/dataset/orchestration-service.js";
import { presentDatasetResult } from "../../../src/dataset/presentation.js";
import {
  DATASET_CONTRACT_VERSION,
  computeProcessingPlanDigest,
  type CapabilityProfile,
  type ProcessingPlan,
  type RunReceipt,
} from "../../../src/dataset/index.js";

const root = resolve(import.meta.dirname, "../../..");
const fixture = resolve(
  root,
  "test/fixtures/dataset/adapters/sources/records.jsonl",
);
const profile: CapabilityProfile = {
  contractVersion: DATASET_CONTRACT_VERSION,
  kind: "CapabilityProfile",
  id: "profile:test",
  capabilities: [
    {
      name: "incremental-read",
      requirement: "required",
      acceptedVersions: ["1"],
      degradation: { action: "fail" },
    },
  ],
};
function setup(adapter = new JsonlAdapter()) {
  const repo = new MemoryDatasetOrchestrationRepository();
  const service = new DatasetOrchestrationService(repo, {
    adapter: () => adapter,
    localBackend: new LocalDatasetExecutionBackend(),
    now: () => "2026-09-03T00:00:00Z",
  });
  return { repo, service };
}
async function planned() {
  const x = setup();
  await x.service.source({
    id: "source:test",
    revisionId: "revision:test",
    adapter: { id: "aiwg.adapter.jsonl", version: "1.0.0" },
    config: { path: fixture },
    policy: { offline: true, allowedRoot: root },
  });
  const result = await x.service.plan({
    id: "plan:test",
    sourceId: "source:test",
    profile,
    schemas: [{ id: "schema:test", version: "1" }],
    policy: {
      privacy: "internal",
      intendedUse: ["test"],
      locality: "local-only",
      network: "offline",
      authorizationRefs: [],
    },
    steps: [
      {
        id: "step:test",
        operation: "materialize",
        implementation: { id: "local", version: "1" },
        configDigest: { algorithm: "sha256", value: "a".repeat(64) },
      },
    ],
    artifactClasses: ["regenerable-index"],
    createdBy: "test",
    estimates: { reads: 3, writes: 3 },
  });
  return { ...x, plan: result.data as ProcessingPlan };
}

describe("dataset orchestration (#2236)", () => {
  it("checks, bounds previews, and binds every decision into the immutable digest", async () => {
    const { service, plan } = await planned();
    expect((await service.check("source:test", true)).ok).toBe(true);
    const preview = await service.preview("source:test", 2, true);
    expect((preview.data as any).records).toHaveLength(2);
    expect(plan.capabilities).toEqual(profile.capabilities);
    expect(
      computeProcessingPlanDigest({
        ...plan,
        estimates: { reads: 4, writes: 3 },
      }).value,
    ).not.toBe(plan.planDigest.value);
  });
  it("executes exactly once, verifies receipts, supports query/lineage, and rejects conflicting replay", async () => {
    const { service, plan } = await planned();
    const first = await service.ingest({
      planId: plan.id,
      planDigest: plan.planDigest.value,
      idempotencyKey: "once",
    });
    expect(first.ok).toBe(true);
    const state = first.data as any;
    expect(state.status).toBe("committed");
    expect(
      (
        await service.ingest({
          planId: plan.id,
          planDigest: plan.planDigest.value,
          idempotencyKey: "once",
        })
      ).data,
    ).toEqual(state);
    expect((await service.verify(state.runId)).ok).toBe(true);
    expect((await service.query(`artifact:${plan.id}`)).data).toMatchObject({
      records: expect.any(Array),
    });
    expect((await service.lineage(state.runId)).data).toMatchObject({
      sourceRevisionId: "revision:test",
    });
    const other = { ...plan, id: "plan:other" };
    other.planDigest = computeProcessingPlanDigest(other);
    await (service as any).repo.putPlan(other);
    expect(
      (
        await service.ingest({
          planId: other.id,
          planDigest: other.planDigest.value,
          idempotencyKey: "once",
        })
      ).diagnostics[0].code,
    ).toBe("DATASET_IDEMPOTENCY_CONFLICT");
  });
  it("requires exact approval bindings and does not advance state on cancellation", async () => {
    const { repo, service, plan } = await planned();
    const guarded = {
      ...plan,
      approvals: [
        { id: "approval:owner", required: true, reason: "restricted" },
      ],
      reconciliation: {
        tombstones: 5,
        previewDigest: { algorithm: "sha256" as const, value: "b".repeat(64) },
        approvalThreshold: 5,
      },
    };
    guarded.planDigest = computeProcessingPlanDigest(guarded);
    await repo.putPlan(guarded);
    expect(
      (
        await service.ingest({
          planId: guarded.id,
          planDigest: guarded.planDigest.value,
          idempotencyKey: "guarded",
        })
      ).diagnostics[0].code,
    ).toBe("DATASET_APPROVAL_REQUIRED");
    const controller = new AbortController();
    controller.abort();
    const result = await service.ingest({
      planId: guarded.id,
      planDigest: guarded.planDigest.value,
      idempotencyKey: "cancel",
      approvalIds: ["approval:owner"],
      reconciliationApproval: { previewDigest: "b".repeat(64), threshold: 5 },
      signal: controller.signal,
    });
    expect((result.data as any).status).toBe("cancelled");
    expect((result.data as any).checkpoint).toBeUndefined();
  });
  it("gates network adapters before initialization in offline mode", async () => {
    const configure = vi.spyOn(HttpAdapter.prototype, "configure");
    const { service } = setup(new HttpAdapter());
    await service.source({
      id: "source:http",
      revisionId: "r:http",
      adapter: { id: "aiwg.adapter.http", version: "1.0.0" },
      config: { url: "https://example.com/data" },
      policy: { offline: true },
    });
    const result = await service.check("source:http", true);
    expect(result.diagnostics[0].code).toBe("DATASET_OFFLINE_COLD");
    expect(configure).not.toHaveBeenCalled();
    configure.mockRestore();
  });
  it("reports every offline cache state distinctly", async () => {
    for (const [state, code] of [["stale", "DATASET_OFFLINE_STALE"], ["corrupt", "DATASET_OFFLINE_CORRUPT"], ["wrong-revision", "DATASET_OFFLINE_WRONG_REVISION"], ["unverifiable", "DATASET_OFFLINE_UNVERIFIABLE"]] as const) {
      const { service } = setup(new HttpAdapter());
      await service.source({ id: `source:${state}`, revisionId: "r", adapter: { id: "aiwg.adapter.http", version: "1.0.0" }, config: { url: "https://example.com/data" }, policy: { offline: true }, cache: { state } });
      expect((await service.check(`source:${state}`, true)).diagnostics[0].code).toBe(code);
    }
    const { service } = setup(new HttpAdapter());
    await service.source({ id: "source:warm", revisionId: "r", identity: "cached", adapter: { id: "aiwg.adapter.http", version: "1.0.0" }, config: { url: "https://example.com/data" }, policy: { offline: true }, cache: { state: "warm-verified", records: [] } });
    expect(await service.check("source:warm", true)).toMatchObject({ ok: true, data: { cache: "warm-verified" } });
  });
  it("persists state atomically and renders human and JSON from one envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aiwg-dataset-"));
    const repo = new FileDatasetOrchestrationRepository(dir);
    await repo.putSource({
      id: "s",
      revisionId: "r",
      adapter: { id: "a", version: "1" },
      config: {},
      policy: { offline: true },
    });
    expect((await repo.getSource("s"))?.revisionId).toBe("r");
    expect(
      JSON.parse(
        await readFile(join(dir, ".aiwg/dataset/state.v1.json"), "utf8"),
      ).sources.s.id,
    ).toBe("s");
    const result = {
      schema: "aiwg.dataset-orchestration/v1" as const,
      action: "check" as const,
      ok: true,
      data: { ready: true },
      diagnostics: [],
    };
    expect(JSON.parse(presentDatasetResult(result, true))).toEqual(result);
    expect(presentDatasetResult(result, false)).toContain("check succeeded");
  });
  it("fails closed without an injected Fortemi transport and verifies mapped receipts", async () => {
    await expect(
      new FortemiExecutionBridge().execute({
        plan: {} as ProcessingPlan,
        records: [],
      }),
    ).rejects.toThrow("DATASET_FORTEMI_UNAVAILABLE");
    const plan = (await planned()).plan;
    const draft: RunReceipt = {
      contractVersion: DATASET_CONTRACT_VERSION,
      kind: "RunReceipt",
      id: "receipt:f",
      runId: "run:f",
      planId: plan.id,
      planDigest: plan.planDigest,
      outcome: "committed",
      committed: true,
      attemptedRecords: 0,
      committedRecords: 0,
      rejectedRecords: 0,
      createdAt: "2026-09-03T00:00:00Z",
      receiptDigest: { algorithm: "sha256", value: "0".repeat(64) },
    };
    const bridge = new FortemiExecutionBridge({
      capabilities: async () => [],
      execute: async () => ({
        result: {
          outcome: "committed",
          attemptedRecords: 0,
          committedRecords: 0,
          rejectedRecords: 0,
          diagnostics: [],
        },
        receipt: sealFortemiFixtureReceipt(draft),
      }),
    });
    await bridge.negotiate();
    expect((await bridge.execute({ plan, records: [] })).outcome).toBe(
      "committed",
    );
  });
});
