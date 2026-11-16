import { randomUUID } from "node:crypto";
import { selectDatasetBackend } from "./backend-selection.js";
import { bindingReceiptCheckpoints, verifyBindingCheckpointReceipt } from "./service-binding-checkpoints.js";
import {
  computeProcessingPlanDigest,
  computeRunReceiptDigest,
  datasetDigest,
  DatasetContractError,
  negotiateDatasetCapabilities,
  verifyProcessingPlanDigest,
} from "./contracts.js";
import {
  DEFAULT_ADAPTER_LIMITS,
  request,
  sha256Digest,
} from "./adapter-sdk.js";
import type { DatasetOrchestrationRepository } from "./orchestration-repository.js";
import {
  DATASET_CONTRACT_VERSION,
  type CapabilityProfile,
  type ProcessingPlan,
  type RunReceipt,
} from "./types.js";
import {
  DATASET_ORCHESTRATION_VERSION,
  type DatasetAction,
  type DatasetOrchestrationDependencies,
  type DatasetResult,
  type DatasetRunState,
  type RegisteredSource,
} from "./orchestration-types.js";

export class DatasetOrchestrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly boundary: DatasetResult["diagnostics"][number]["boundary"] = "input",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DatasetOrchestrationError";
  }
}
const ok = <T>(
  action: DatasetAction,
  data: T,
  extra: Partial<DatasetResult<T>> = {},
): DatasetResult<T> => ({
  schema: DATASET_ORCHESTRATION_VERSION,
  action,
  ok: true,
  data,
  diagnostics: [],
  ...extra,
});
const fail = (action: DatasetAction, e: unknown): DatasetResult => {
  const x =
    e instanceof DatasetOrchestrationError
      ? e
      : e instanceof DatasetContractError
        ? new DatasetOrchestrationError(e.code, e.message, "plan")
      : new DatasetOrchestrationError(
          "DATASET_INTERNAL_ERROR",
          e instanceof Error ? e.message : String(e),
          "repository",
        );
  return {
    schema: DATASET_ORCHESTRATION_VERSION,
    action,
    ok: false,
    diagnostics: [
      {
        code: x.code,
        message: x.message,
        boundary: x.boundary,
        retryable: x.retryable,
      },
    ],
  };
};

export class DatasetOrchestrationService {
  constructor(
    private readonly repo: DatasetOrchestrationRepository,
    private readonly deps: DatasetOrchestrationDependencies,
  ) {}
  private now() {
    return this.deps.now?.() ?? new Date().toISOString();
  }
  private async offlineRemote(id: string, action: "check" | "preview", count = 10): Promise<DatasetResult | undefined> {
    const source = await this.repo.getSource(id);
    if (!source) return undefined;
    const manifest = this.deps.adapter(source.adapter.id, source.adapter.version).describe();
    if (manifest.permissions.network === "none") return undefined;
    const state = source.cache?.state ?? "cold";
    if (state === "warm-verified") return ok(action, action === "check" ? { sourceIdentity: source.identity ?? source.id, cache: state } : { records: (source.cache?.records ?? []).slice(0, Math.max(1, Math.min(100, count))), cache: state });
    const codes = { cold: "DATASET_OFFLINE_COLD", stale: "DATASET_OFFLINE_STALE", corrupt: "DATASET_OFFLINE_CORRUPT", "wrong-revision": "DATASET_OFFLINE_WRONG_REVISION", unverifiable: "DATASET_OFFLINE_UNVERIFIABLE" } as const;
    return fail(action, new DatasetOrchestrationError(codes[state], `Offline cache state is ${state}`, "adapter"));
  }
  async source(source: RegisteredSource) {
    try {
      this.deps.adapter(source.adapter.id, source.adapter.version);
      await this.repo.putSource(source);
      return ok("source", {
        sourceId: source.id,
        revisionId: source.revisionId,
      });
    } catch (e) {
      return fail("source", e);
    }
  }
  private async context(id: string, offline = false) {
    const source = await this.repo.getSource(id);
    if (!source)
      throw new DatasetOrchestrationError(
        "DATASET_SOURCE_NOT_FOUND",
        `Unknown source ${id}`,
      );
    const adapter = this.deps.adapter(
      source.adapter.id,
      source.adapter.version,
    );
    const manifest = adapter.describe();
    if (offline && manifest.permissions.network !== "none")
      throw new DatasetOrchestrationError(
        "DATASET_OFFLINE_COLD",
        "Offline policy prohibits initializing a network adapter",
        "adapter",
      );
    const configured = await adapter.configure(source.config);
    if (!configured.ok || !configured.config)
      throw new DatasetOrchestrationError(
        configured.diagnostics[0]?.code ?? "DATASET_ADAPTER_CONFIG_INVALID",
        configured.diagnostics[0]?.message ?? "Adapter configuration failed",
        "adapter",
      );
    return { source, adapter, manifest, configured };
  }
  async check(id: string, offline = false) {
    try {
      if (offline) { const cached = await this.offlineRemote(id, "check"); if (cached) return cached; }
      const c = await this.context(id, offline);
      const result = await c.adapter.check(
        request(`check:${id}`, c.configured.config!, {
          ...c.source.policy,
          offline,
        }),
      );
      if (!result.ok)
        throw new DatasetOrchestrationError(
          result.diagnostics[0]?.code ?? "DATASET_CHECK_FAILED",
          result.diagnostics[0]?.message ?? "Check failed",
          "adapter",
        );
      return ok("check", result.value);
    } catch (e) {
      return fail("check", e);
    }
  }
  async preview(id: string, count = 10, offline = false, signal?: AbortSignal) {
    try {
      if (offline) { const cached = await this.offlineRemote(id, "preview", count); if (cached) return cached; }
      const c = await this.context(id, offline);
      const bounded = Math.max(1, Math.min(100, count));
      const result = await c.adapter.preview({
        ...request(
          `preview:${id}`,
          c.configured.config!,
          { ...c.source.policy, offline },
          DEFAULT_ADAPTER_LIMITS,
        ),
        count: bounded,
        signal,
      });
      if (!result.ok)
        throw new DatasetOrchestrationError(
          result.diagnostics[0]?.code ?? "DATASET_PREVIEW_FAILED",
          result.diagnostics[0]?.message ?? "Preview failed",
          "adapter",
        );
      return ok("preview", {
        records: result.value ?? [],
        bounds: {
          records: bounded,
          bytes: DEFAULT_ADAPTER_LIMITS.maxBytes,
          timeoutMs: DEFAULT_ADAPTER_LIMITS.timeoutMs,
          maxDepth: DEFAULT_ADAPTER_LIMITS.maxDepth,
        },
      });
    } catch (e) {
      return fail("preview", e);
    }
  }
  async plan(input: {
    id: string;
    sourceId: string;
    profile: CapabilityProfile;
    schemas: ProcessingPlan["schemas"];
    policy: ProcessingPlan["policy"];
    backend?: string;
    fallback?: "local";
    estimates?: ProcessingPlan["estimates"];
    approvals?: ProcessingPlan["approvals"];
    reconciliation?: ProcessingPlan["reconciliation"];
    steps: ProcessingPlan["steps"];
    artifactClasses: ProcessingPlan["artifactClasses"];
    createdBy: string;
    offline?: boolean;
  }) {
    try {
      const c = await this.context(input.sourceId, input.offline);
      const backend = selectDatasetBackend(this.deps, input.backend);
      if (!backend)
        throw new DatasetOrchestrationError(
          "DATASET_FORTEMI_UNAVAILABLE",
          "Fortemi support requires an injected compatible bridge",
          "backend",
        );
      const decision = negotiateDatasetCapabilities(
        input.profile,
        backend.capabilities(),
      );
      const draft: ProcessingPlan = {
        contractVersion: DATASET_CONTRACT_VERSION,
        kind: "ProcessingPlan",
        id: input.id,
        datasetRevisionId: c.source.revisionId,
        capabilityProfileId: input.profile.id,
        steps: input.steps,
        artifactClasses: input.artifactClasses,
        createdBy: input.createdBy,
        source: {
          id: c.source.id,
          revisionId: c.source.revisionId,
          identity: c.source.identity ?? c.source.id,
        },
        adapter: {
          id: c.manifest.id,
          version: c.manifest.version,
          configDigest: c.configured.configDigest!,
        },
        schemas: input.schemas,
        capabilities: input.profile.capabilities,
        capabilityDecision: decision,
        policy: input.policy,
        execution: {
          locality: backend.locality ?? (backend.id === "local" ? "local" : "remote"),
          backend: backend.id,
          ...(input.fallback ? { fallback: input.fallback } : {}),
        },
        estimates: input.estimates ?? { reads: 0, writes: 0 },
        approvals: input.approvals ?? [],
        ...(input.reconciliation
          ? { reconciliation: input.reconciliation }
          : {}),
        planDigest: sha256Digest("pending"),
      };
      const plan = { ...draft, planDigest: computeProcessingPlanDigest(draft) };
      await this.repo.putPlan(plan);
      return ok("plan", plan, {
        backend: backend.id,
        degraded: decision.degraded.map((v) => v.capability),
      });
    } catch (e) {
      return fail("plan", e);
    }
  }
  async ingest(input: {
    planId: string;
    planDigest: string;
    idempotencyKey: string;
    approvalIds?: string[];
    reconciliationApproval?: { previewDigest: string; threshold: number };
    signal?: AbortSignal;
  }) {
    try {
      const plan = await this.repo.getPlan(input.planId);
      if (!plan)
        throw new DatasetOrchestrationError(
          "DATASET_PLAN_NOT_FOUND",
          `Unknown plan ${input.planId}`,
          "plan",
        );
      if (
        !verifyProcessingPlanDigest(plan) ||
        plan.planDigest.value !== input.planDigest
      )
        throw new DatasetOrchestrationError(
          "DATASET_PLAN_DIGEST_MISMATCH",
          "Reviewed plan content or supplied digest changed",
          "plan",
        );
      const prior = await this.repo.getRunByIdempotency(input.idempotencyKey);
      if (prior) {
        if (prior.planDigest.value !== plan.planDigest.value)
          throw new DatasetOrchestrationError(
            "DATASET_IDEMPOTENCY_CONFLICT",
            "Idempotency identity is already bound to another plan",
            "plan",
          );
        return ok("ingest", prior, {
          backend: plan.execution.backend,
          degraded: prior.degraded,
        });
      }
      const missing = plan.approvals.filter(
        (a) => a.required && !input.approvalIds?.includes(a.id),
      );
      if (missing.length)
        throw new DatasetOrchestrationError(
          "DATASET_APPROVAL_REQUIRED",
          `Missing approvals: ${missing.map((v) => v.id).join(", ")}`,
          "plan",
        );
      if (
        plan.reconciliation &&
        (input.reconciliationApproval?.previewDigest !==
          plan.reconciliation.previewDigest.value ||
          input.reconciliationApproval.threshold !==
            plan.reconciliation.approvalThreshold)
      )
        throw new DatasetOrchestrationError(
          "DATASET_RECONCILIATION_APPROVAL_REQUIRED",
          "Reconciliation requires the exact preview digest and threshold reviewed in the plan",
          "plan",
        );
      const c = await this.context(
        plan.source.id,
        plan.policy.network === "offline",
      );
      if (
        c.source.revisionId !== plan.source.revisionId ||
        c.manifest.id !== plan.adapter.id ||
        c.manifest.version !== plan.adapter.version ||
        c.configured.configDigest?.value !== plan.adapter.configDigest.value
      )
        throw new DatasetOrchestrationError(
          "DATASET_SOURCE_COMPATIBILITY_CHANGED",
          "Source revision, adapter, or configuration changed after planning",
          "plan",
        );
      const backend = selectDatasetBackend(this.deps, plan.execution.backend);
      if (!backend)
        throw new DatasetOrchestrationError(
          "DATASET_FORTEMI_UNAVAILABLE",
          "Fortemi support requires an injected compatible bridge",
          "backend",
        );
      negotiateDatasetCapabilities(
        {
          contractVersion: DATASET_CONTRACT_VERSION,
          kind: "CapabilityProfile",
          id: plan.capabilityProfileId,
          capabilities: [...plan.capabilities],
        },
        backend.capabilities(),
      );
      const runId = `run:${randomUUID()}`;
      let state: DatasetRunState = {
        runId,
        idempotencyKey: input.idempotencyKey,
        planId: plan.id,
        planDigest: plan.planDigest,
        status: "running",
        attempt: 1,
        startedAt: this.now(),
        degraded: plan.capabilityDecision.degraded.map((v) => v.capability),
        freshness: "unknown",
      };
      await this.repo.putRun(state);
      const records = [];
      for await (const event of c.adapter.read({
        ...request(`read:${runId}`, c.configured.config!, {
          ...c.source.policy,
          offline: plan.policy.network === "offline",
        }),
        checkpoint: c.source.checkpoint,
        signal: input.signal,
      })) {
        if (event.kind === "record") records.push(event.record);
      }
      const result = await backend.execute({
        plan,
        records,
        signal: input.signal,
        priorCheckpoint: c.source.checkpoint,
      });
      const receiptDraft: RunReceipt = {
        contractVersion: DATASET_CONTRACT_VERSION,
        kind: "RunReceipt",
        id: `receipt:${runId}`,
        runId,
        planId: plan.id,
        planDigest: plan.planDigest,
        outcome: result.outcome === "ambiguous" ? "attempted" : result.outcome,
        committed: result.outcome === "committed",
        attemptedRecords: result.attemptedRecords,
        committedRecords: result.committedRecords,
        rejectedRecords: result.rejectedRecords,
        createdAt: this.now(),
        receiptDigest: sha256Digest("pending"),
        diagnosticCodes: result.diagnostics.map((v) => v.code),
        ...bindingReceiptCheckpoints(backend.id, c.source.checkpoint, result),
      };
      const receipt = {
        ...receiptDraft,
        receiptDigest: computeRunReceiptDigest(receiptDraft),
      };
      state = {
        ...state,
        status: result.outcome,
        endedAt: this.now(),
        receipt,
        ...(result.outcome === "committed"
          ? { lastCommittedReceipt: receipt, checkpoint: result.checkpoint }
          : {}),
        freshness: result.outcome === "committed" ? "current" : "stale",
      };
      await this.repo.putRun(state);
      if (result.outcome === "committed" && result.artifact)
        await this.repo.putArtifactRecords(
          result.artifact.id,
          result.artifact.records.map((v) => v.value),
        );
      return ok("ingest", state, {
        backend: backend.id,
        degraded: state.degraded,
      });
    } catch (e) {
      return fail("ingest", e);
    }
  }
  async status(runId: string) {
    try {
      const run = await this.repo.getRun(runId);
      if (!run)
        throw new DatasetOrchestrationError(
          "DATASET_RUN_NOT_FOUND",
          `Unknown run ${runId}`,
        );
      return ok("status", run);
    } catch (e) {
      return fail("status", e);
    }
  }
  async show(id: string) {
    try {
      return ok(
        "show",
        (await this.repo.getPlan(id)) ??
          (await this.repo.getRun(id)) ??
          (await this.repo.getSource(id)) ??
          (() => {
            throw new DatasetOrchestrationError(
              "DATASET_OBJECT_NOT_FOUND",
              `Unknown object ${id}`,
            );
          })(),
      );
    } catch (e) {
      return fail("show", e);
    }
  }
  async verify(runId: string) {
    try {
      const run = await this.repo.getRun(runId);
      if (!run?.receipt)
        throw new DatasetOrchestrationError(
          "DATASET_RECEIPT_NOT_FOUND",
          `No receipt for ${runId}`,
        );
      const valid =
        computeRunReceiptDigest(run.receipt).value ===
          run.receipt.receiptDigest.value &&
        run.receipt.planDigest.value === run.planDigest.value && await verifyBindingCheckpointReceipt(run, this.repo);
      return valid
        ? ok("verify", { runId, valid })
        : fail(
            "verify",
            new DatasetOrchestrationError(
              "DATASET_RECEIPT_INVALID",
              "Receipt digest or plan binding is invalid",
              "repository",
            ),
          );
    } catch (e) {
      return fail("verify", e);
    }
  }
  async query(artifactId: string) {
    try {
      return ok("query", {
        artifactId,
        records: await this.repo.listArtifactRecords(artifactId),
      });
    } catch (e) {
      return fail("query", e);
    }
  }
  async lineage(runId: string) {
    try {
      const run = await this.repo.getRun(runId);
      if (!run)
        throw new DatasetOrchestrationError(
          "DATASET_RUN_NOT_FOUND",
          `Unknown run ${runId}`,
        );
      const plan = await this.repo.getPlan(run.planId);
      const source = plan ? await this.repo.getSource(plan.source.id) : undefined;
      const records = await this.repo.listArtifactRecords(`artifact:${run.planId}`);
      return ok("lineage", {
        artifactId: `artifact:${run.planId}`,
        artifactRevision: run.planDigest.value,
        runId,
        sourceRevisionId: plan?.source.revisionId,
        planDigest: run.planDigest,
        principal: plan?.createdBy,
        adapter: plan?.adapter,
        schemas: plan?.schemas,
        checkpoint: run.checkpoint ?? source?.checkpoint,
        validation: run.receipt
          ? {
              receiptId: run.receipt.id,
              receiptDigest: run.receipt.receiptDigest,
              valid:
                computeRunReceiptDigest(run.receipt).value ===
                run.receipt.receiptDigest.value,
            }
          : undefined,
        records: records.map((record, ordinal) => ({
          ordinal,
          digest: datasetDigest(record),
        })),
      });
    } catch (e) {
      return fail("lineage", e);
    }
  }
  async export(artifactId: string) {
    try {
      return ok("export", {
        artifactId,
        format: "application/json",
        records: await this.repo.listArtifactRecords(artifactId),
      });
    } catch (e) {
      return fail("export", e);
    }
  }
  async cancel(runId: string) {
    try {
      const run = await this.repo.getRun(runId);
      if (!run)
        throw new DatasetOrchestrationError(
          "DATASET_RUN_NOT_FOUND",
          `Unknown run ${runId}`,
        );
      if (run.status !== "running")
        throw new DatasetOrchestrationError(
          "DATASET_RUN_NOT_CANCELLABLE",
          `Run is ${run.status}`,
        );
      const next = {
        ...run,
        status: "cancelled" as const,
        endedAt: this.now(),
        freshness: "stale" as const,
      };
      await this.repo.putRun(next);
      return ok("cancel", next);
    } catch (e) {
      return fail("cancel", e);
    }
  }
  async retry(runId: string, signal?: AbortSignal) {
    try {
      const run = await this.repo.getRun(runId);
      if (!run)
        throw new DatasetOrchestrationError(
          "DATASET_RUN_NOT_FOUND",
          `Unknown run ${runId}`,
        );
      if (run.status === "committed" || run.status === "running")
        throw new DatasetOrchestrationError(
          "DATASET_RUN_NOT_RETRYABLE",
          `Run is ${run.status}`,
        );
      const result = await this.ingest({
        planId: run.planId,
        planDigest: run.planDigest.value,
        idempotencyKey: `${run.idempotencyKey}:retry:${run.attempt + 1}`,
        signal,
      });
      if (result.ok && result.data) {
        const retried = {
          ...(result.data as DatasetRunState),
          attempt: run.attempt + 1,
        };
        await this.repo.putRun(retried);
        return ok("retry", retried, {
          backend: result.backend,
          degraded: result.degraded,
        });
      }
      return { ...result, action: "retry" as const };
    } catch (error) {
      return fail("retry", error);
    }
  }
}
