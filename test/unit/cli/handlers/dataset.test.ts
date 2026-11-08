import { mkdtemp } from '../../../helpers/temp-dir.js';
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DATASET_ACTIONS, datasetHandler, executeDatasetCommand } from "../../../../src/cli/handlers/dataset.js";
import type { HandlerContext } from "../../../../src/cli/handlers/types.js";
import * as repositories from "../../../../src/dataset/file-orchestration-repository.js";
import type { DatasetRunState } from "../../../../src/dataset/orchestration-types.js";
const context = (args: string[]): HandlerContext => ({
  args,
  rawArgs: ["dataset", ...args],
  cwd: process.cwd(),
  frameworkRoot: process.cwd(),
});
describe("dataset CLI handler (#2236)", () => {
  it("documents every lifecycle action without executing it", async () => {
    const result = await datasetHandler.help!(context([]));
    expect(result.exitCode).toBe(0);
    for (const action of [
      "source",
      "check",
      "preview",
      "plan",
      "ingest",
      "status",
      "show",
      "verify",
      "query",
      "lineage",
      "export",
      "cancel",
      "retry",
    ])
      expect(result.message).toContain(action);
    expect(result.message).toContain("status <run-id>");
    expect(result.message).toContain("Inspect one run");
  });
  it("rejects status without a run ID before constructing or reading the repository (#3815)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aiwg-dataset-status-"));
    const getRun = vi.spyOn(repositories.FileDatasetOrchestrationRepository.prototype, "getRun")
      .mockResolvedValue(undefined);
    const construct = vi.spyOn(repositories, "FileDatasetOrchestrationRepository");
    const result = await datasetHandler.execute({ ...context(["status", "--json"]), cwd });
    expect(construct).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.rawOutput).toBe(true);
    expect(JSON.parse(result.message!)).toEqual({
      schema: "aiwg.dataset-orchestration/v1",
      action: "status",
      ok: false,
      diagnostics: [{
        code: "DATASET_ARGUMENT_REQUIRED",
        message: "Missing required run ID. Usage: aiwg dataset status <run-id>",
        boundary: "input",
        retryable: false,
      }],
    });
  });
  it("explains the required status run ID in human output (#3815)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aiwg-dataset-status-"));
    const result = await datasetHandler.execute({ ...context(["status"]), cwd });
    expect(result.exitCode).toBe(1);
    expect(result.message).toBe(
      "status failed: DATASET_ARGUMENT_REQUIRED: Missing required run ID. Usage: aiwg dataset status <run-id>\n",
    );
  });
  it("keeps unknown-run errors and targets a supplied known run ID (#3815)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aiwg-dataset-status-"));
    const repo = new repositories.FileDatasetOrchestrationRepository(cwd);
    const run: DatasetRunState = {
      runId: "run:known", idempotencyKey: "once", planId: "plan:test",
      planDigest: { algorithm: "sha256", value: "a".repeat(64) },
      status: "running", attempt: 1, startedAt: "2026-11-02T00:00:00Z",
      degraded: [], freshness: "unknown",
    };
    await repo.putRun(run);
    const getRun = vi.spyOn(repositories.FileDatasetOrchestrationRepository.prototype, "getRun");
    const getPlan = vi.spyOn(repositories.FileDatasetOrchestrationRepository.prototype, "getPlan");
    const getSource = vi.spyOn(repositories.FileDatasetOrchestrationRepository.prototype, "getSource");
    const missing = await datasetHandler.execute({ ...context(["status", "run:missing", "--json"]), cwd });
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.message!)).toMatchObject({
      action: "status", ok: false,
      diagnostics: [{ code: "DATASET_RUN_NOT_FOUND", message: "Unknown run run:missing" }],
    });
    const known = await datasetHandler.execute({ ...context(["status", "run:known", "--json"]), cwd });
    expect(known.exitCode).toBe(0);
    expect(JSON.parse(known.message!)).toMatchObject({ action: "status", ok: true, data: run });
    expect(getRun.mock.calls).toEqual([["run:missing"], ["run:known"]]);
    expect(getPlan).not.toHaveBeenCalled();
    expect(getSource).not.toHaveBeenCalled();
  });
  it("returns a stable machine-readable error envelope", async () => {
    const result = await datasetHandler.execute(
      context(["show", "missing", "--json"]),
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.message!)).toMatchObject({
      schema: "aiwg.dataset-orchestration/v1",
      action: "show",
      ok: false,
      diagnostics: [{ code: "DATASET_OBJECT_NOT_FOUND" }],
    });
  });
  it("dispatches every supported CLI action through one provided orchestration service", async () => {
    const calls: string[] = [];
    const result = (action: string) => ({ schema: "aiwg.dataset-orchestration/v1", action, ok: true, data: {}, diagnostics: [] });
    const service = new Proxy({}, { get: (_target, property) => vi.fn(async () => { calls.push(String(property)); return result(String(property)); }) }) as any;
    const cwd = await mkdtemp(join(tmpdir(), "aiwg-dataset-binding-"));
    await writeFile(join(cwd, "input.json"), "{}\n");
    for (const action of DATASET_ACTIONS) {
      const args = action === "source" || action === "plan" ? [action, "--file", "input.json", "--json"]
        : action === "ingest" ? [action, "plan:test", "--digest", "a".repeat(64), "--idempotency-key", "once", "--json"]
        : [action, "object:test", "--json"];
      const response = await executeDatasetCommand({ ...context(args), cwd }, service);
      expect(response.exitCode, action).toBe(0);
      expect(JSON.parse(response.message!).action).toBe(action);
    }
    expect(calls).toEqual([...DATASET_ACTIONS]);
  });
});
