import {
  computeRunReceiptDigest,
  verifyRunReceiptDigest,
  validateDatasetContract,
} from "./contracts.js";
import type {
  DatasetExecutionBackend,
  ExecutionRequest,
  ExecutionResult,
} from "./orchestration-types.js";
import type { AdapterCheckpoint } from "./adapter-types.js";
import { bindingCheckpointId } from "./service-binding-checkpoints.js";
import type { RunReceipt } from "./types.js";
export interface FortemiTransport {
  capabilities(): Promise<readonly { name: string; version: string }[]>;
  execute(request: {
    plan: unknown;
    records: readonly unknown[];
    signal?: AbortSignal;
    priorCheckpoint?: AdapterCheckpoint;
  }): Promise<{ result: ExecutionResult; receipt: RunReceipt }>;
}
export class FortemiExecutionBridge implements DatasetExecutionBackend {
  readonly id = "fortemi-core";
  private offered: readonly { name: string; version: string }[] = [];
  constructor(private readonly transport?: FortemiTransport) {}
  capabilities() {
    return this.offered;
  }
  async negotiate() {
    if (!this.transport)
      throw new Error(
        "DATASET_FORTEMI_UNAVAILABLE: injected Fortemi transport required",
      );
    this.offered = await this.transport.capabilities();
    return this.offered;
  }
  async execute(r: ExecutionRequest) {
    if (!this.transport)
      throw new Error(
        "DATASET_FORTEMI_UNAVAILABLE: injected Fortemi transport required",
      );
    const response = await this.transport.execute({
      plan: r.plan,
      records: r.records,
      signal: r.signal,
      priorCheckpoint: r.priorCheckpoint,
    });
    if (
      response.receipt.planDigest.value !== r.plan.planDigest.value ||
      response.receipt.planId !== r.plan.id ||
      !validateDatasetContract(response.receipt).valid ||
      (r.priorCheckpoint !== undefined && response.receipt.checkpointBeforeId !== bindingCheckpointId(r.priorCheckpoint)) ||
      (response.result.outcome === "committed" && response.result.checkpoint !== undefined && response.receipt.checkpointAfterId !== bindingCheckpointId(response.result.checkpoint)) ||
      response.receipt.attemptedRecords !== response.result.attemptedRecords ||
      response.receipt.committedRecords !== response.result.committedRecords ||
      response.receipt.rejectedRecords !== response.result.rejectedRecords ||
      response.receipt.committed !== (response.result.outcome === "committed") ||
      response.receipt.outcome !== (response.result.outcome === "ambiguous" ? "attempted" : response.result.outcome) ||
      !verifyRunReceiptDigest(response.receipt)
    )
      throw new Error("DATASET_FORTEMI_RECEIPT_INVALID");
    return response.result;
  }
}
export function sealFortemiFixtureReceipt(receipt: RunReceipt): RunReceipt {
  return { ...receipt, receiptDigest: computeRunReceiptDigest(receipt) };
}
