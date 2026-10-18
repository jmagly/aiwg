import { mkdtemp } from '../../../helpers/temp-dir.js';
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DATASET_ACTIONS, datasetHandler, executeDatasetCommand } from "../../../../src/cli/handlers/dataset.js";
import type { HandlerContext } from "../../../../src/cli/handlers/types.js";
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
