import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBuiltinAdapterRegistry } from "../../dataset/adapters.js";
import { FileDatasetOrchestrationRepository } from "../../dataset/file-orchestration-repository.js";
import { LocalDatasetExecutionBackend } from "../../dataset/local-execution-backend.js";
import { DatasetOrchestrationService } from "../../dataset/orchestration-service.js";
import { presentDatasetResult } from "../../dataset/presentation.js";
import type { CommandHandler, HandlerContext, HandlerResult } from "./types.js";

export const DATASET_ACTIONS = [
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
] as const;
function option(args: readonly string[], name: string) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
function positions(args: readonly string[]) {
  const values = new Set([
    "--file",
    "--count",
    "--digest",
    "--idempotency-key",
    "--approve",
    "--reconciliation-digest",
    "--reconciliation-threshold",
  ]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (values.has(args[i]!)) {
      i++;
      continue;
    }
    if (!args[i]!.startsWith("-")) out.push(args[i]!);
  }
  return out;
}
function input(ctx: HandlerContext) {
  const file = option(ctx.args, "--file");
  if (!file)
    throw new Error("DATASET_INPUT_REQUIRED: --file <json> is required");
  return JSON.parse(readFileSync(resolve(ctx.cwd, file), "utf8")) as any;
}
function service(ctx: HandlerContext) {
  const registry = createBuiltinAdapterRegistry();
  return new DatasetOrchestrationService(
    new FileDatasetOrchestrationRepository(ctx.cwd),
    {
      adapter: (id, version) => {
        const adapter = registry.adapters.find((candidate) => {
          const manifest = candidate.describe();
          return manifest.id === id && manifest.version === version;
        });
        if (!adapter)
          throw new Error(`ADAPTER_NOT_REGISTERED: ${id}@${version}`);
        return adapter;
      },
      localBackend: new LocalDatasetExecutionBackend(),
    },
  );
}
export async function executeDatasetCommand(ctx: HandlerContext, providedService?: DatasetOrchestrationService): Promise<HandlerResult> {
  const [action, ...ids] = positions(ctx.args);
  if (!DATASET_ACTIONS.includes(action as any))
    return {
      exitCode: 1,
      message: `Unknown dataset action '${action ?? ""}'.`,
    };
  if (action === "status" && !ids[0])
    return {
      exitCode: 1,
      rawOutput: true,
      message: presentDatasetResult({
        schema: "aiwg.dataset-orchestration/v1",
        action,
        ok: false,
        diagnostics: [{
          code: "DATASET_ARGUMENT_REQUIRED",
          message: "Missing required run ID. Usage: aiwg dataset status <run-id>",
          boundary: "input",
          retryable: false,
        }],
      }, ctx.args.includes("--json")),
    };
  const s = providedService ?? service(ctx);
  let result: any;
  switch (action) {
    case "source":
      result = await s.source(input(ctx));
      break;
    case "check":
      result = await s.check(ids[0]!, ctx.args.includes("--offline"));
      break;
    case "preview":
      result = await s.preview(
        ids[0]!,
        Number(option(ctx.args, "--count") ?? 10),
        ctx.args.includes("--offline"),
        ctx.signal,
      );
      break;
    case "plan":
      result = await s.plan(input(ctx));
      break;
    case "ingest":
      result = await s.ingest({
        planId: ids[0]!,
        planDigest: option(ctx.args, "--digest") ?? "",
        idempotencyKey: option(ctx.args, "--idempotency-key") ?? "",
        approvalIds: (option(ctx.args, "--approve") ?? "")
          .split(",")
          .filter(Boolean),
        ...(option(ctx.args, "--reconciliation-digest")
          ? {
              reconciliationApproval: {
                previewDigest: option(ctx.args, "--reconciliation-digest")!,
                threshold: Number(
                  option(ctx.args, "--reconciliation-threshold"),
                ),
              },
            }
          : {}),
        signal: ctx.signal,
      });
      break;
    case "status":
      result = await s.status(ids[0]!);
      break;
    case "show":
      result = await s.show(ids[0]!);
      break;
    case "verify":
      result = await s.verify(ids[0]!);
      break;
    case "query":
      result = await s.query(ids[0]!);
      break;
    case "lineage":
      result = await s.lineage(ids[0]!);
      break;
    case "export":
      result = await s.export(ids[0]!);
      break;
    case "cancel":
      result = await s.cancel(ids[0]!);
      break;
    case "retry":
      result = await s.retry(ids[0]!, ctx.signal);
      break;
  }
  return {
    exitCode: result.ok ? 0 : 1,
    rawOutput: true,
    message: presentDatasetResult(result, ctx.args.includes("--json")),
  };
}
export const datasetHandler: CommandHandler = {
  id: "dataset",
  name: "Dataset intelligence",
  description:
    "Register, preview, plan, ingest, verify, query, and trace datasets",
  category: "index",
  aliases: ["datasets"],
  async help() {
    return {
      exitCode: 0,
      rawOutput: true,
      message: [
        "Usage: aiwg dataset <action> [id] [options]",
        "",
        "Actions: source, check, preview, plan, ingest, status, show, verify, query, lineage, export, cancel, retry",
        "source/plan: --file <json>",
        "preview: <source-id> [--count N] [--offline]",
        "ingest: <plan-id> --digest <sha256> --idempotency-key <key> [--approve id,id]",
        "status <run-id>: Inspect one run by its required ID.",
        "All actions: --json for the canonical aiwg.dataset-orchestration/v1 envelope.",
      ].join("\n"),
    };
  },
  async execute(ctx) {
    try {
      return await executeDatasetCommand(ctx);
    } catch (e) {
      return {
        exitCode: 1,
        rawOutput: true,
        message:
          JSON.stringify(
            {
              schema: "aiwg.dataset-orchestration/v1",
              ok: false,
              diagnostics: [
                {
                  code: "DATASET_CLI_INVALID",
                  message: e instanceof Error ? e.message : String(e),
                  boundary: "input",
                  retryable: false,
                },
              ],
            },
            null,
            2,
          ) + "\n",
      };
    }
  },
};
