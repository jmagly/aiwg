/**
 * MCP orchestration tool tests.
 *
 * @source @src/mcp/tools/orchestration.mjs
 * @implements #1584
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const { runAiwgCliMock } = vi.hoisted(() => ({
  runAiwgCliMock: vi.fn(async () => ({ stdout: '{"ok":true}', stderr: "", code: 0 })),
}));

vi.mock("../../../src/mcp/helpers.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/mcp/helpers.mjs")>();
  return {
    ...actual,
    runAiwgCli: runAiwgCliMock,
  };
});

beforeEach(() => {
  runAiwgCliMock.mockReset();
  runAiwgCliMock.mockResolvedValue({ stdout: '{"ok":true}', stderr: "", code: 0 });
});

// @ts-expect-error — .mjs untyped
import * as orchestration from "../../../src/mcp/tools/orchestration.mjs";

const { listFlows, registerMissionToolset } = orchestration as any;

describe("mission-dispatch numeric schema contracts", () => {
  function captureSchema() {
    const tools = new Map<string, any>();
    const server = { registerTool(name: string, config: any) { tools.set(name, config); } };
    registerMissionToolset(server);
    return tools.get("mission-dispatch").inputSchema;
  }
  const counters = ["max_iterations", "max_total_tokens", "max_output_tokens", "max_tool_calls", "exploration_quota"];
  const decimals = ["max_total_cost", "max_wall_clock_minutes"];
  for (const field of [...counters, ...decimals]) {
    const invalid: unknown[] = [0, -1, NaN, Infinity, "1"];
    if (counters.includes(field)) invalid.push(1.5, Number.MAX_SAFE_INTEGER + 1);
    it.each(invalid)(`rejects ${field}=%s in the registered schema`, value => {
      expect(captureSchema()[field].safeParse(value).success).toBe(false);
      expect(runAiwgCliMock).not.toHaveBeenCalled();
    });
  }
  it("accepts exact boundary values and fractional decimal limits", () => {
    const schema = captureSchema();
    for (const field of counters) {
      expect(schema[field].parse(1)).toBe(1);
      expect(schema[field].parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    }
    for (const field of decimals) expect(schema[field].parse(0.25)).toBe(0.25);
  });
  it("leaves omitted quota and ceilings absent without injecting defaults", () => {
    const schema = captureSchema();
    for (const field of [...counters, ...decimals]) expect(schema[field].parse(undefined)).toBeUndefined();
  });
});

describe("MCP orchestration — flows", () => {
  it("lists declarative YAML Flows from the framework corpus", async () => {
    const flows = await listFlows({ filter: "flow-release" });
    const release = flows.find((flow: any) => flow.name === "flow-release");

    expect(release).toBeDefined();
    expect(release.framework).toBe("sdlc-complete");
    expect(release.kind).toBe("WorkflowPlaybook");
    expect(release.apiVersion).toBe("workflow.aiwg.io/v1");
    expect(release.step_count).toBeGreaterThan(0);
    expect(release.wrapper_skill.exists).toBe(true);
  });
});

describe("MCP orchestration — missions", () => {
  function captureDispatch() {
    const tools = new Map<string, any>();
    registerMissionToolset({ registerTool(name: string, config: any, handler: any) {
      tools.set(name, { config, handler });
    } });
    const tool = tools.get("mission-dispatch");
    return (input: Record<string, unknown>) => tool.handler(z.object(tool.config.inputSchema).parse(input));
  }

  const required = { session_id: "synthetic-session", objective: "synthetic objective", completion: "synthetic criterion" };
  const baseArgs = ["mc", "dispatch", "synthetic-session", "synthetic objective", "--completion", "synthetic criterion"];

  it.each([undefined, false])("refuses dispatch with confirmed=%s before invoking the CLI", async confirmed => {
    const result = await captureDispatch()({ ...required, ...(confirmed === undefined ? {} : { confirmed }) });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: "mission-dispatch requires confirmed=true because Missions can launch long-running worker cycles.",
      requires_confirmation: true,
      remediation: "Surface objective, completion, and target session to the operator before confirming.",
    });
    expect(runAiwgCliMock).not.toHaveBeenCalled();
  });

  it("does not inject omitted numeric controls or quota into the actual CLI request", async () => {
    const result = await captureDispatch()({ ...required, confirmed: true });
    expect(runAiwgCliMock).toHaveBeenCalledTimes(1);
    expect(runAiwgCliMock).toHaveBeenCalledWith(baseArgs, { cwd: undefined, timeoutMs: 30_000 });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      command: "aiwg mc dispatch", exit_code: 0, stdout: '{"ok":true}', stderr: "",
      relationship_to_mc: "AIWG Mission is the orchestration contract; mc is the durable dispatch/session substrate.",
    });
  });

  it.each([
    ["max_iterations", "--max-iterations", Number.MAX_SAFE_INTEGER, "9007199254740991"],
    ["max_total_tokens", "--max-total-tokens", Number.MAX_SAFE_INTEGER, "9007199254740991"],
    ["max_output_tokens", "--max-output-tokens", Number.MAX_SAFE_INTEGER, "9007199254740991"],
    ["max_tool_calls", "--max-tool-calls", Number.MAX_SAFE_INTEGER, "9007199254740991"],
    ["exploration_quota", "--exploration-quota", 1, "1"],
    ["max_total_cost", "--max-total-cost", 0.25, "0.25"],
    ["max_wall_clock_minutes", "--max-wall-clock-minutes", 0.125, "0.125"],
  ])("forwards only the declared %s control with its exact value", async (field, flag, value, expected) => {
    await captureDispatch()({ ...required, confirmed: true, [field]: value });
    expect(runAiwgCliMock).toHaveBeenCalledTimes(1);
    expect(runAiwgCliMock).toHaveBeenCalledWith([...baseArgs, flag, expected], { cwd: undefined, timeoutMs: 30_000 });
  });

  it.each(["completion-wins", "budget-wins"])("preserves explicit %s stop semantics", async policy => {
    await captureDispatch()({ ...required, confirmed: true, budget_stop_policy: policy });
    expect(runAiwgCliMock).toHaveBeenCalledTimes(1);
    expect(runAiwgCliMock).toHaveBeenCalledWith([...baseArgs, "--budget-stop-policy", policy], { cwd: undefined, timeoutMs: 30_000 });
  });

  it("returns a transport rejection as an MCP error without retrying dispatch", async () => {
    runAiwgCliMock.mockRejectedValueOnce(new Error("synthetic transport failure"));
    const result = await captureDispatch()({ ...required, confirmed: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "mission-dispatch: synthetic transport failure" });
    expect(runAiwgCliMock).toHaveBeenCalledTimes(1);
  });

  it("mission-dispatch forwards LFD budget controls to Mission Control", async () => {
    const tools = new Map<string, any>();
    const server = {
      registerTool: vi.fn((name: string, config: any, handler: any) => {
        tools.set(name, { config, handler });
      }),
    };

    registerMissionToolset(server);

    await tools.get("mission-dispatch").handler(z.object(tools.get("mission-dispatch").config.inputSchema).parse({
      session_id: "mc-456",
      objective: "run a bounded LFD mission",
      completion: "best-output report emitted",
      max_iterations: 9,
      max_total_tokens: 60_000,
      max_output_tokens: 15_000,
      max_tool_calls: 90,
      max_total_cost: 5.25,
      max_wall_clock_minutes: 40,
      exploration_quota: 3,
      project_dir: "/tmp/project",
      confirmed: true,
    }));

    expect(runAiwgCliMock).toHaveBeenCalledWith([
      "mc",
      "dispatch",
      "mc-456",
      "run a bounded LFD mission",
      "--completion",
      "best-output report emitted",
      "--max-iterations",
      "9",
      "--max-total-tokens",
      "60000",
      "--max-output-tokens",
      "15000",
      "--max-tool-calls",
      "90",
      "--max-total-cost",
      "5.25",
      "--max-wall-clock-minutes",
      "40",
      "--exploration-quota",
      "3",
    ], { cwd: "/tmp/project", timeoutMs: 30_000 });
  });
});
