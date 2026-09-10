/**
 * MCP Subsystem Toolset Dispatch Tests
 *
 * @source @src/mcp/tools/subsystems.mjs
 * @implements #1322-#1332
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

beforeEach(() => runAiwgCliMock.mockClear());

// @ts-expect-error — .mjs untyped
import * as subsystems from "../../../src/mcp/tools/subsystems.mjs";

const { parseToolsets, KNOWN_TOOLSETS, registerOptInToolsets } = subsystems as any;

describe("mc-dispatch numeric schema contracts", () => {
  function captureSchema() {
    const tools = new Map<string, any>();
    const server = { registerTool(name: string, config: any) { tools.set(name, config); } };
    registerOptInToolsets(server, new Set(["mc"]));
    return tools.get("mc-dispatch").inputSchema;
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

describe("MCP subsystems — toolset parsing", () => {
  it("empty string returns empty set", () => {
    expect(parseToolsets("").size).toBe(0);
    expect(parseToolsets(undefined).size).toBe(0);
    expect(parseToolsets(null).size).toBe(0);
  });

  it("'core' alone is implicit — empty opt-in set", () => {
    expect(parseToolsets("core").size).toBe(0);
    expect(parseToolsets("core,").size).toBe(0);
  });

  it("'all' enables every known toolset", () => {
    const all = parseToolsets("all");
    for (const t of KNOWN_TOOLSETS) {
      expect(all.has(t)).toBe(true);
    }
  });

  it("normalises case and whitespace", () => {
    const set = parseToolsets(" Memory , KB , RALPH ");
    expect(set.has("memory")).toBe(true);
    expect(set.has("kb")).toBe(true);
    expect(set.has("ralph")).toBe(true);
  });

  it("silently drops unknown toolsets (warns to stderr)", () => {
    const set = parseToolsets("memory,nonexistent,kb");
    expect(set.has("memory")).toBe(true);
    expect(set.has("kb")).toBe(true);
    expect(set.has("nonexistent")).toBe(false);
  });

  it("known toolsets match expected list", () => {
    const expected = ['flows', 'missions', 'memory', 'kb', 'research', 'activity-log', 'index', 'ralph', 'mc', 'ops', 'sandbox'];
    for (const t of expected) {
      expect(KNOWN_TOOLSETS).toContain(t);
    }
  });

  it("'all' includes post-1533 orchestration toolsets", () => {
    const all = parseToolsets("all");
    expect(all.has("flows")).toBe(true);
    expect(all.has("missions")).toBe(true);
    expect(all.has("sandbox")).toBe(true);
  });

  it("mc-dispatch forwards LFD budget controls to the CLI", async () => {
    const tools = new Map<string, any>();
    const server = {
      registerTool: vi.fn((name: string, config: any, handler: any) => {
        tools.set(name, { config, handler });
      }),
    };

    registerOptInToolsets(server, new Set(["mc"]));

    await tools.get("mc-dispatch").handler(z.object(tools.get("mc-dispatch").config.inputSchema).parse({
      session_id: "mc-123",
      objective: "tighten loop controls",
      completion: "budget-stop report emitted",
      max_iterations: 7,
      max_total_tokens: 50_000,
      max_output_tokens: 12_000,
      max_tool_calls: 80,
      max_total_cost: 4.5,
      max_wall_clock_minutes: 30,
      exploration_quota: 3,
    }));

    expect(runAiwgCliMock).toHaveBeenCalledWith([
      "mc",
      "dispatch",
      "mc-123",
      "tighten loop controls",
      "--completion",
      "budget-stop report emitted",
      "--max-iterations",
      "7",
      "--max-total-tokens",
      "50000",
      "--max-output-tokens",
      "12000",
      "--max-tool-calls",
      "80",
      "--max-total-cost",
      "4.5",
      "--max-wall-clock-minutes",
      "30",
      "--exploration-quota",
      "3",
    ], { input: undefined });
  });
});
