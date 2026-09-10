/**
 * MCP Helpers Tests
 *
 * Tests for src/mcp/helpers.mjs — runAiwgCli, allow-list, scope split,
 * destructive detection.
 *
 * @source @src/mcp/helpers.mjs
 * @implements #1311 #1312
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: spawnMock,
}));
// @ts-expect-error — .mjs untyped
import * as helpers from "../../../src/mcp/helpers.mjs";
import { getCommandIds } from "../../../src/extensions/commands/definitions";
import { helpHandler } from "../../../src/cli/handlers/help.js";

const {
  resolveProjectRoot,
  isGlobalAllowed,
  isDestructive,
  loadCommandAllowList,
  mcpError,
  mcpJson,
  GLOBAL_ALLOWED_TOOLS,
  DESTRUCTIVE_COMMANDS,
} = helpers as any;

describe("MCP helpers — scope split", () => {
  it("isGlobalAllowed returns true for discovery tools", () => {
    expect(isGlobalAllowed("discover")).toBe(true);
    expect(isGlobalAllowed("skill-list")).toBe(true);
    expect(isGlobalAllowed("skill-show")).toBe(true);
    expect(isGlobalAllowed("command-list")).toBe(true);
    expect(isGlobalAllowed("rule-show")).toBe(true);
  });

  it("isGlobalAllowed returns false for project-required tools", () => {
    expect(isGlobalAllowed("artifact-read")).toBe(false);
    expect(isGlobalAllowed("artifact-write")).toBe(false);
    expect(isGlobalAllowed("memory-put")).toBe(false);
  });

  it("GLOBAL_ALLOWED_TOOLS includes all 5 list/show pairs plus discover", () => {
    expect(GLOBAL_ALLOWED_TOOLS.has("discover")).toBe(true);
    // skill/command/rule/agent/template
    for (const t of ["skill", "command", "rule", "agent", "template"]) {
      for (const operation of ["list", "show"]) {
        const tool = `${t}-${operation}`;
        expect(GLOBAL_ALLOWED_TOOLS.has(tool), `${tool} must be globally allowed`).toBe(true);
        expect(isGlobalAllowed(tool), `${tool} classification must agree`).toBe(true);
      }
    }
  });
});

// Independent declared policy examples, not derived from the set under test.
const gatedCommands = [
  "remove", "rollback-workspace", "promote", "uninstall-plugin", "cleanup-audit",
  "doc-sync", "sandbox", "ralph", "agent-loop-ext", "ralph-abort",
];

describe("MCP helpers — destructive detection", () => {
  it.each(gatedCommands)("requires confirmation for declared command %s", command => {
    expect(DESTRUCTIVE_COMMANDS.has(command)).toBe(true);
    expect(isDestructive(command)).toBe(true);
  });

  it("does not flag read-only commands", () => {
    expect(isDestructive("discover")).toBe(false);
    expect(isDestructive("list")).toBe(false);
    expect(isDestructive("doctor")).toBe(false);
    expect(isDestructive("version")).toBe(false);
  });
});

describe("MCP helpers — allow-list loader", () => {
  it("loads command IDs from definitions.ts", async () => {
    const set = await loadCommandAllowList();
    expect(set.size).toBeGreaterThan(50);
    expect(set.has("discover")).toBe(true);
    expect(set.has("use")).toBe(true);
    expect(set.has("doctor")).toBe(true);
    expect(set.has("definitely-not-a-real-command")).toBe(false);
  });

  it("stays in sync with the TypeScript command registry", async () => {
    const set = await loadCommandAllowList();
    const registryIds = getCommandIds();

    expect([...set].sort()).toEqual([...registryIds].sort());
    for (const recent of [
      "issue-audit",
      "address-issues",
      "fanout",
      "chunk",
      "corpus",
      "wizard",
      "session",
      "repo-access",
      "features",
      "feedback",
      "diagnose",
      "doc-consolidate",
      "best-practices-audit",
      "skill-lint",
      "agentcard",
      "packages",
      "local-executor",
    ]) {
      expect(set.has(recent), `${recent} should be command-run allow-listed`).toBe(true);
    }
  });
});

describe("MCP helpers — isolated allow-list sources and cache", () => {
  const install = path.resolve("/synthetic/aiwg-install");
  const checkout = path.resolve("/synthetic/checkout");
  const registryPath = "src/extensions/commands/definitions.ts";
  let isolated: typeof helpers;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("AIWG_ROOT", install);
    vi.spyOn(process, "cwd").mockReturnValue(checkout);
    spawnMock.mockReset();
    // A fresh module instance gives every scenario an empty private cache.
    isolated = await import("../../../src/mcp/helpers.mjs");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    spawnMock.mockReset();
    vi.resetModules();
  });

  function helpChild(stdout: string, code = 0) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }), kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      void Promise.resolve().then(() => {
        child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", code);
      });
      return child;
    });
    return child;
  }

  it("prefers the install registry, deduplicates exact IDs and caches the same set", async () => {
    const read = vi.spyOn(fs, "readFile").mockResolvedValue("  id: 'alpha',\n  id: 'beta-tool',\n  id: 'alpha',\n  title: 'not-an-id',\n");
    const result = await isolated.loadCommandAllowList();
    expect([...result]).toEqual(["alpha", "beta-tool"]);
    expect(read).toHaveBeenCalledExactlyOnceWith(path.join(install, registryPath), "utf-8");
    expect(spawnMock).not.toHaveBeenCalled();
    read.mockRejectedValue(new Error("Cache must avoid another read"));
    expect(await isolated.loadCommandAllowList()).toBe(result);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("tries the checkout registry only after the install read fails", async () => {
    const read = vi.spyOn(fs, "readFile")
      .mockRejectedValueOnce(new Error("Synthetic unavailable install"))
      .mockResolvedValueOnce("  id: 'checkout-only',\n");
    expect([...await isolated.loadCommandAllowList()]).toEqual(["checkout-only"]);
    expect(read.mock.calls).toEqual([[path.join(install, registryPath), "utf-8"], [path.join(checkout, registryPath), "utf-8"]]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("parses and caches structured help output when both source reads fail", async () => {
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    helpChild(JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: ["alpha", "beta-tool"] }));
    const result = await isolated.loadCommandAllowList();
    expect([...result]).toEqual(["alpha", "beta-tool"]);
    expect(read.mock.calls).toEqual([[path.join(install, registryPath), "utf-8"], [path.join(checkout, registryPath), "utf-8"]]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe("aiwg");
    expect(args).toEqual(["help", "--json"]);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(checkout);
    expect(await isolated.loadCommandAllowList()).toBe(result);
    expect(read).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("uses help for an empty readable source without reading the checkout", async () => {
    const read = vi.spyOn(fs, "readFile").mockResolvedValue("");
    helpChild(JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: ["from-help"] }));
    expect([...await isolated.loadCommandAllowList()]).toEqual(["from-help"]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("preserves every canonical ID from the actual structured help producer through fallback", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await helpHandler.execute({ args: ["--json"], rawArgs: ["help", "--json"], cwd: checkout, frameworkRoot: install }))
      .toEqual({ exitCode: 0 });
    expect(output).toHaveBeenCalledTimes(1);
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    helpChild(output.mock.calls[0][0]);
    const result = await isolated.loadCommandAllowList();
    expect([...result]).toEqual(getCommandIds());
    expect(result.has("mc")).toBe(true);
    expect(result.has("aiwg")).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls.map(call => call.slice(0, 2))).toEqual([["aiwg", ["help", "--json"]]]);
  });

  it("keeps an unparseable nonempty source fail-closed and caches its empty result", async () => {
    const read = vi.spyOn(fs, "readFile").mockResolvedValue("// synthetic registry without any definitions\n");
    const result = await isolated.loadCommandAllowList();
    expect([...result]).toEqual([]);
    expect(await isolated.loadCommandAllowList()).toBe(result);
    expect(read).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("caches an empty allow-list when the help process cannot spawn", async () => {
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    spawnMock.mockImplementationOnce(() => { throw new Error("Synthetic unavailable executable"); });
    const result = await isolated.loadCommandAllowList();
    expect([...result]).toEqual([]);
    expect(await isolated.loadCommandAllowList()).toBe(result);
    expect(read).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps help text without command records fail-closed", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    helpChild("No command records are available.\n");
    expect([...await isolated.loadCommandAllowList()]).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["human help", "    aiwg use sdlc\n    mc dispatch\n"],
    ["invalid JSON", "{broken"],
    ["null", "null"],
    ["wrong schema", JSON.stringify({ schema: "unknown", commandIds: ["mc"] })],
    ["absent schema", JSON.stringify({ commandIds: ["mc"] })],
    ["non-array IDs", JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: "mc" })],
    ["mixed ID types", JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: ["mc", 1] })],
    ["whitespace ID", JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: ["mc", "not a command"] })],
    ["duplicate IDs", JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: ["mc", "mc"] })],
    ["empty registry", JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: [] })],
  ])("rejects the complete fallback response for %s", async (_name, stdout) => {
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    helpChild(stdout);
    expect([...await isolated.loadCommandAllowList()]).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an otherwise valid structured registry from a nonzero subprocess", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    helpChild(JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: ["mc"] }), 7);
    expect([...await isolated.loadCommandAllowList()]).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  async function commandRun() {
    const { registerCommandRunTool } = await import("../../../src/mcp/tools/command-run.mjs");
    const server = { registerTool: vi.fn() };
    registerCommandRunTool(server);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(server.registerTool.mock.calls[0][0]).toBe("command-run");
    return server.registerTool.mock.calls[0][2];
  }

  it("dispatches an allowed command through the actual consumer after structured fallback", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    helpChild(JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: ["version", "mc"] }));
    helpChild("synthetic version output\n");
    const callback = await commandRun();
    const result = await callback({ command: "version", args: [], project_dir: checkout, confirmed: false, timeout_ms: 1000 });
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({
      command: "version", exit_code: 0, stdout: "synthetic version output\n", stderr: "", confirmed: false,
    }, null, 2) }] });
    expect(spawnMock.mock.calls.map(call => call.slice(0, 2))).toEqual([["aiwg", ["help", "--json"]], ["aiwg", ["version"]]]);
  });

  it.each(gatedCommands)("refuses %s without confirmation before spawning", async command => {
    vi.spyOn(fs, "readFile").mockResolvedValue(`  id: '${command}'`);
    // If a gate regresses, return a bounded successful child so the failure is
    // unauthorized dispatch, not an incomplete-mock exception or timeout.
    helpChild("unexpected dispatch");
    helpChild("unexpected dispatch");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registerTool = vi.fn();
    const { registerCommandRunTool } = await import("../../../src/mcp/tools/command-run.mjs");
    registerCommandRunTool({ registerTool });
    const callback = registerTool.mock.calls[0][2];
    for (const confirmed of [undefined, false]) {
      const result = await callback({ command, args: [], confirmed });
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify({
        error: `command-run: "${command}" is a destructive command. Re-invoke with confirmed=true to proceed.`,
        remediation: "Set confirmed=true after surfacing the impact to the user.", requires_confirmation: true,
      }, null, 2) }] });
      expect(spawnMock).not.toHaveBeenCalled();
    }
  });

  it.each(gatedCommands)("dispatches confirmed %s with exact literal arguments", async command => {
    vi.spyOn(fs, "readFile").mockResolvedValue(`  id: '${command}'`);
    helpChild("synthetic command output", 7);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registerTool = vi.fn();
    const { registerCommandRunTool } = await import("../../../src/mcp/tools/command-run.mjs");
    registerCommandRunTool({ registerTool });
    const callback = registerTool.mock.calls[0][2];
    const args = ["literal argument with spaces", "semi;colon", "$(literal)"];
    const result = await callback({ command, args, project_dir: checkout, confirmed: true, timeout_ms: 1000 });
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({
      command, exit_code: 7, stdout: "synthetic command output", stderr: "", confirmed: true,
    }, null, 2) }] });
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith("aiwg", [command, ...args], {
      shell: false, cwd: checkout, env: expect.any(Object), stdio: ["pipe", "pipe", "pipe"],
    });
  });

  it("refuses an example executable name at the consumer without dispatching it", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    helpChild(JSON.stringify({ schema: "aiwg.command-registry.v1", commandIds: ["version", "mc"] }));
    const callback = await commandRun();
    const result = await callback({ command: "aiwg", args: [], confirmed: false, timeout_ms: 1000 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'command-run: command "aiwg" not in allow-list.',
      remediation: 'Call `command-list` (or `discover --type command`) to see available commands.',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable registry at the consumer without dispatching a command", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Synthetic unavailable source"));
    helpChild("    version  human text is not an authoritative registry\n");
    const callback = await commandRun();
    const result = await callback({ command: "version", args: [], confirmed: false, timeout_ms: 1000 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'command-run: cannot load command allow-list from AIWG_ROOT. AIWG installation may be incomplete.',
      remediation: 'Run `aiwg doctor` to verify AIWG_ROOT is set correctly.',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("MCP helpers — response envelopes", () => {
  it("mcpError produces isError=true with remediation", () => {
    const r = mcpError("boom", { remediation: "do X" });
    expect(r.isError).toBe(true);
    expect(r.content[0].type).toBe("text");
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toBe("boom");
    expect(body.remediation).toBe("do X");
  });

  it("mcpError adds requires_confirmation flag", () => {
    const r = mcpError("destructive", { requiresConfirmation: true });
    const body = JSON.parse(r.content[0].text);
    expect(body.requires_confirmation).toBe(true);
  });

  it("mcpJson wraps a JSON object", () => {
    const r = mcpJson({ ok: true });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true });
  });
});

describe("MCP helpers — resolveProjectRoot fallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to AIWG_ROOT when allowGlobal=true and no project", async () => {
    const stat = vi.spyOn(fs, "stat").mockRejectedValue(new Error("Synthetic missing project marker"));
    const result = await resolveProjectRoot(undefined, {
      allowGlobal: true,
      toolName: "discover",
    });
    expect(result).toEqual({ root: helpers.AIWG_ROOT, isGlobal: true });
    expect(stat).toHaveBeenCalled();
  });

  it("rejects with remediation when allowGlobal=false and no project", async () => {
    const stat = vi.spyOn(fs, "stat").mockRejectedValue(new Error("Synthetic missing project marker"));
    await expect(resolveProjectRoot(undefined, {
      allowGlobal: false,
      toolName: "artifact-read",
    })).rejects.toThrow('Tool "artifact-read" requires a project root. No .aiwg directory or .aiwg-location pointer found. Run from an AIWG project or `aiwg new` first. Remediation: Run from an AIWG project directory or pass project_dir explicitly.');
    expect(stat).toHaveBeenCalled();
  });

  it("accepts an explicit directory without project discovery", async () => {
    const stat = vi.spyOn(fs, "stat").mockRejectedValue(new Error("Unexpected discovery"));
    const result = await resolveProjectRoot("/tmp/some-explicit-dir", {
      allowGlobal: false,
      toolName: "artifact-read",
    });
    expect(result.root).toBe("/tmp/some-explicit-dir");
    expect(result.isGlobal).toBe(false);
    expect(stat).not.toHaveBeenCalled();
  });
});

describe("MCP helpers — artifact location resolution", () => {
  const aliases = ["AIWG_ARTIFACTS_PATH", "AIWG_PROJECT_ARTIFACTS_PATH", "AIWG_PROJECT_AIWG_DIR"];
  const project = path.resolve("/synthetic/project");
  beforeEach(() => {
    for (const key of aliases) vi.stubEnv(key, "");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(aliases)("uses %s without reading the pointer", async key => {
    vi.stubEnv(key, " ../artifacts ");
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pointer read"));
    expect(await helpers.resolveProjectAiwgDir(project)).toBe(path.resolve(project, "../artifacts"));
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])("honors alias precedence when the first usable index is %s", async first => {
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pointer read"));
    aliases.forEach((key, index) => vi.stubEnv(key, index < first ? "  " : `candidate-${index}`));
    expect(await helpers.resolveProjectAiwgDir(project)).toBe(path.resolve(project, `candidate-${first}`));
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["relative", "nested/artifacts", path.resolve(project, "nested/artifacts")],
    ["absolute", "/synthetic/external", path.resolve("/synthetic/external")],
    ["quoted assignment", 'AIWG_ARTIFACTS_PATH = "../shared artifacts"', path.resolve(project, "../shared artifacts")],
    ["export assignment", "export AIWG_ARTIFACTS_PATH='../shared'", path.resolve(project, "../shared")],
    ["comments and CRLF", "# location\r\n\r\n './stored'\r\nignored-second-line", path.resolve(project, "stored")],
    ["empty", "", path.resolve(project, ".aiwg")],
    ["comments only", "# one\n  # two\n", path.resolve(project, ".aiwg")],
    ["empty quoted value", '""', path.resolve(project, ".aiwg")],
  ])("resolves %s pointer contents", async (_name, contents, expected) => {
    const read = vi.spyOn(fs, "readFile").mockResolvedValue(contents);
    expect(await helpers.resolveProjectAiwgDir(project)).toBe(expected);
    expect(read).toHaveBeenCalledExactlyOnceWith(path.join(project, ".aiwg-location"), "utf-8");
  });

  it("defaults to the project artifact directory when the pointer is missing", async () => {
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error("Synthetic missing pointer"), { code: "ENOENT" }));
    expect(await helpers.resolveProjectAiwgDir(project)).toBe(path.join(project, ".aiwg"));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("MCP helpers — nearest project marker", () => {
  const project = path.resolve("/synthetic/project");
  const child = path.join(project, "child");
  const filesystemRoot = path.parse(project).root;
  afterEach(() => vi.restoreAllMocks());
  function markers(entries: Record<string, "file" | "directory">) {
    return vi.spyOn(fs, "stat").mockImplementation(async file => {
      const kind = entries[String(file)];
      if (!kind) throw Object.assign(new Error("Synthetic absent marker"), { code: "ENOENT" });
      return { isDirectory: () => kind === "directory", isFile: () => kind === "file" } as any;
    });
  }

  it.each([
    [filesystemRoot, ".aiwg", "directory"],
    [filesystemRoot, ".aiwg-location", "file"],
    [child, ".aiwg", "directory"],
    [child, ".aiwg-location", "file"],
  ] as const)("includes the filesystem root when starting at %s with marker %s", async (start, name, kind) => {
    const marker = path.join(filesystemRoot, name);
    const stat = markers({ [marker]: kind });
    await expect(helpers.findProjectRoot(start)).resolves.toBe(filesystemRoot);
    expect(stat.mock.calls.filter(([file]) => file === marker)).toHaveLength(1);
  });

  it.each(["missing", "wrong types"])("terminates at the root with %s markers", async scenario => {
    const stat = markers(scenario === "missing" ? {} : {
      [path.join(filesystemRoot, ".aiwg")]: "file",
      [path.join(filesystemRoot, ".aiwg-location")]: "directory",
    });
    await expect(helpers.findProjectRoot(filesystemRoot)).rejects.toThrow('No .aiwg directory or .aiwg-location pointer found.');
    expect(stat.mock.calls.map(([file]) => file)).toEqual([
      path.join(filesystemRoot, ".aiwg"), path.join(filesystemRoot, ".aiwg-location"),
    ]);
  });

  it("returns the nearest artifact directory without inspecting a pointer or ancestor", async () => {
    const stat = markers({ [path.join(child, ".aiwg")]: "directory", [path.join(project, ".aiwg")]: "directory" });
    expect(await helpers.findProjectRoot(child)).toBe(child);
    expect(stat.mock.calls.map(([file]) => file)).toEqual([path.join(child, ".aiwg")]);
  });

  it("accepts a nearest pointer file ahead of an ancestor artifact directory", async () => {
    const stat = markers({ [path.join(child, ".aiwg-location")]: "file", [path.join(project, ".aiwg")]: "directory" });
    expect(await helpers.findProjectRoot(child)).toBe(child);
    expect(stat.mock.calls.map(([file]) => file)).toEqual([path.join(child, ".aiwg"), path.join(child, ".aiwg-location")]);
  });

  it("rejects wrong marker types and continues to the nearest valid ancestor", async () => {
    const stat = markers({ [path.join(child, ".aiwg")]: "file", [path.join(child, ".aiwg-location")]: "directory", [path.join(project, ".aiwg")]: "directory" });
    expect(await helpers.findProjectRoot(child)).toBe(project);
    expect(stat.mock.calls.map(([file]) => file)).toEqual([path.join(child, ".aiwg"), path.join(child, ".aiwg-location"), path.join(project, ".aiwg")]);
  });

  it.each([undefined, "."])("discovers the project from cwd for explicitDir=%s", async explicit => {
    vi.spyOn(process, "cwd").mockReturnValue(child);
    markers({ [path.join(project, ".aiwg-location")]: "file" });
    expect(await helpers.resolveProjectRoot(explicit, { allowGlobal: true })).toEqual({ root: project, isGlobal: false });
  });

  it("normalizes an explicit relative root without marker discovery", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(child);
    const stat = markers({});
    expect(await helpers.resolveProjectRoot("../selected/../target")).toEqual({ root: path.join(project, "target"), isGlobal: false });
    expect(stat).not.toHaveBeenCalled();
  });
});

describe("MCP helpers — complete response contracts", () => {
  it.each([
    ["absent", undefined, { error: "problem" }],
    ["empty", {}, { error: "problem" }],
    ["false options", { remediation: "", requiresConfirmation: false }, { error: "problem" }],
    ["both options", { remediation: "retry locally", requiresConfirmation: true }, { error: "problem", remediation: "retry locally", requires_confirmation: true }],
  ])("serializes the exact error envelope with %s options", (_name, options, expected) => {
    expect(helpers.mcpError("problem", options)).toEqual({
      content: [{ type: "text", text: JSON.stringify(expected, null, 2) }], isError: true,
    });
  });

  it.each([
    ["raw text", "text\nwith a line", "text\nwith a line"],
    ["empty text", "", ""],
    ["null", null, "null"],
    ["false", false, "false"],
    ["zero", 0, "0"],
    ["array", ["one", 2], '[\n  "one",\n  2\n]'],
  ])("preserves the exact success envelope for %s", (_name, data, expected) => {
    expect(helpers.mcpJson(data)).toEqual({ content: [{ type: "text", text: expected }] });
  });
});

describe("MCP helpers — CLI process boundary", () => {
  let child: EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }), kill: vi.fn(),
    });
    spawnMock.mockReset().mockReturnValue(child);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it("passes literal argv without a shell and preserves requested cwd and input", async () => {
    const args = ["synthetic", "two words", "; literal-metacharacter"];
    const result = helpers.runAiwgCli(args, {
      cwd: "/synthetic-project", env: { AIWG_TEST_PROCESS_SENTINEL: "synthetic" }, input: "payload\n",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, argv, options] = spawnMock.mock.calls[0];
    // Assert only selected options: failure output must not dump the inherited environment.
    expect(command).toBe("aiwg");
    expect(argv).toEqual(args);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe("/synthetic-project");
    expect(options.env.AIWG_TEST_PROCESS_SENTINEL).toBe("synthetic");
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(child.stdin.write).toHaveBeenCalledExactlyOnceWith("payload\n");
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ stdout: "", stderr: "", code: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accumulates both streams until close and retains a nonzero exit code", async () => {
    const result = helpers.runAiwgCli(["synthetic"]);
    expect(spawnMock.mock.calls[0][2].cwd).toBe(process.cwd());
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.stdout.emit("data", Buffer.from("first "));
    child.stderr.emit("data", Buffer.from("warning "));
    child.stdout.emit("data", Buffer.from("second"));
    child.stderr.emit("data", Buffer.from("detail"));
    child.emit("close", 7);
    await expect(result).resolves.toEqual({ stdout: "first second", stderr: "warning detail", code: 7 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [[0xc2], [0xa3], "£"],
    [[0xe2], [0x82, 0xac], "€"],
    [[0xf0, 0x9f], [0x98, 0x80], "😀"],
  ])("reassembles split UTF-8 bytes %j + %j independently on each stream", async (first, second, expected) => {
    const result = helpers.runAiwgCli(["synthetic"]);
    child.stdout.emit("data", Buffer.from(first));
    child.stderr.emit("data", Buffer.from(first));
    child.stdout.emit("data", Buffer.from(second));
    child.stderr.emit("data", Buffer.from(second));
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ stdout: expected, stderr: expected, code: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes incomplete trailing sequences once at close", async () => {
    const result = helpers.runAiwgCli(["synthetic"]);
    child.stdout.emit("data", Buffer.from([0xe2]));
    child.stdout.emit("data", Buffer.from([0x82]));
    child.stderr.emit("data", Buffer.from([0xf0, 0x9f]));
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ stdout: "�", stderr: "�", code: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a missing process exit code as minus one", async () => {
    const result = helpers.runAiwgCli(["synthetic"]);
    child.emit("close", null);
    await expect(result).resolves.toEqual({ stdout: "", stderr: "", code: -1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects process error with the original error and clears its timer", async () => {
    const error = new Error("Synthetic spawn failure");
    const result = helpers.runAiwgCli(["synthetic"]);
    const assertion = expect(result).rejects.toBe(error);
    child.emit("error", error);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects a synchronous spawn exception without creating a timer", async () => {
    const error = new Error("Synthetic synchronous spawn failure");
    spawnMock.mockImplementationOnce(() => { throw error; });
    await expect(helpers.runAiwgCli(["synthetic"])).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("signals termination at the requested deadline and preserves the timeout error after close", async () => {
    const result = helpers.runAiwgCli(["synthetic"], { timeoutMs: 50 });
    const assertion = expect(result).rejects.toThrow("aiwg synthetic timed out after 50ms");
    await vi.advanceTimersByTimeAsync(49);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", 0);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at the deadline without close and escalates after one second of cleanup grace", async () => {
    let outcome: unknown;
    const result = helpers.runAiwgCli(["synthetic"], { timeoutMs: 50 }).catch((error: Error) => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("aiwg synthetic timed out after 50ms");
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(999);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.emit("close", null);
      await result;
    }
  });

  it("cancels escalation when a timed-out child closes during its cleanup grace", async () => {
    const result = helpers.runAiwgCli(["synthetic"], { timeoutMs: 50 });
    const assertion = expect(result).rejects.toThrow("timed out after 50ms");
    await vi.advanceTimersByTimeAsync(50);
    child.emit("close", null);
    await assertion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans escalation when SIGTERM synchronously causes close", async () => {
    child.kill.mockImplementationOnce(() => { child.emit("close", 0); return true; });
    const result = helpers.runAiwgCli(["synthetic"], { timeoutMs: 50 });
    const assertion = expect(result).rejects.toThrow("timed out after 50ms");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout result and cleanup deadline after a late process error", async () => {
    let outcome: unknown;
    const result = helpers.runAiwgCli(["synthetic"], { timeoutMs: 50 }).catch((error: Error) => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(50);
      child.emit("error", new Error("Synthetic late process error"));
      await vi.advanceTimersByTimeAsync(0);
      expect((outcome as Error).message).toBe("aiwg synthetic timed out after 50ms");
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    } finally {
      child.emit("close", null);
      await result;
    }
  });

  it("contains signal exceptions while preserving timeout rejection and timer cleanup", async () => {
    child.kill.mockImplementation(() => { throw new Error("Synthetic signal failure"); });
    let outcome: unknown;
    const result = helpers.runAiwgCli(["synthetic"], { timeoutMs: 50 }).catch((error: Error) => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(1050);
      expect((outcome as Error).message).toBe("aiwg synthetic timed out after 50ms");
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.emit("close", null);
      await result;
    }
  });

  it("cancels timeout termination when the child completes early", async () => {
    const result = helpers.runAiwgCli(["synthetic"], { timeoutMs: 50 });
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ stdout: "", stderr: "", code: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains an asynchronous stdin error, rejects promptly and bounds child cleanup", async () => {
    const error = Object.assign(new Error("Synthetic closed input"), { code: "EPIPE" });
    let outcome: unknown;
    const result = helpers.runAiwgCli(["synthetic"], { input: "payload", timeoutMs: 5000 }).catch((caught: unknown) => { outcome = caught; });
    try {
      expect(() => child.stdin.emit("error", error)).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe(error);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(999);
      expect(child.kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { child.emit("close", null); await result; }
  });

  it.each(["write", "end"] as const)("cleans up after a synchronous stdin %s exception", async operation => {
    const error = new Error(`Synthetic ${operation} exception`);
    child.stdin[operation].mockImplementationOnce(() => { throw error; });
    const result = helpers.runAiwgCli(["synthetic"], { input: "payload" });
    try {
      await expect(result).rejects.toBe(error);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { child.emit("close", null); }
  });

  it("handles an error emitted during write without attempting a later end", async () => {
    const error = new Error("Synthetic synchronous input event");
    child.stdin.write.mockImplementationOnce(() => child.stdin.emit("error", error));
    const result = helpers.runAiwgCli(["synthetic"], { input: "payload" });
    try {
      await expect(result).rejects.toBe(error);
      expect(child.stdin.end).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally { child.emit("close", null); }
  });

  it("cancels input-error escalation when signaling synchronously closes the child", async () => {
    const error = new Error("Synthetic input failure");
    child.kill.mockImplementationOnce(() => { child.emit("close", null); return true; });
    const result = helpers.runAiwgCli(["synthetic"]).catch((caught: Error) => caught);
    try {
      expect(() => child.stdin.emit("error", error)).not.toThrow();
      expect(await result).toBe(error);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally { child.emit("close", null); await result; }
  });

  it("preserves a timeout and its cleanup when a late stdin error arrives", async () => {
    const result = helpers.runAiwgCli(["synthetic"], { timeoutMs: 50 }).catch((caught: Error) => caught);
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(() => child.stdin.emit("error", new Error("Synthetic late input error"))).not.toThrow();
      expect((await result).message).toBe("aiwg synthetic timed out after 50ms");
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    } finally { child.emit("close", null); await result; }
  });

  it("handles late stdin errors after normal close without changing success or signaling", async () => {
    const result = helpers.runAiwgCli(["synthetic"]);
    child.emit("close", 0);
    expect(() => child.stdin.emit("error", new Error("Synthetic late input error"))).not.toThrow();
    await expect(result).resolves.toEqual({ stdout: "", stderr: "", code: 0 });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the original input error and cleanup after a late process error", async () => {
    const error = new Error("Synthetic first input error");
    const result = helpers.runAiwgCli(["synthetic"]).catch((caught: Error) => caught);
    try {
      expect(() => child.stdin.emit("error", error)).not.toThrow();
      child.emit("error", new Error("Synthetic later process error"));
      expect(await result).toBe(error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    } finally { child.emit("close", null); await result; }
  });

  it("preserves a process error if a stdin error follows it", async () => {
    const error = new Error("Synthetic first process error");
    const result = helpers.runAiwgCli(["synthetic"]);
    const assertion = expect(result).rejects.toBe(error);
    child.emit("error", error);
    expect(() => child.stdin.emit("error", new Error("Synthetic later input error"))).not.toThrow();
    await assertion;
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("preserves split UTF-8 over real child pipes with observed byte-boundary synchronization", async () => {
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let child: ChildProcess | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const firstChunks = new Map<string, number[]>();
  let sentRemainder = false;
  spawnMock.mockImplementationOnce(() => {
    child = spawn(process.execPath, ['-e', `
      process.on('message', () => {
        process.stdout.write(Buffer.from([0x82, 0xac]));
        process.stderr.write(Buffer.from([0x82, 0xac]));
        process.disconnect();
      });
      process.stdout.write(Buffer.from([0xe2]));
      process.stderr.write(Buffer.from([0xe2]));
    `], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      stream!.on('data', (chunk: Buffer) => {
        if (!firstChunks.has(name)) firstChunks.set(name, [...chunk]);
        if (firstChunks.size === 2 && !sentRemainder) {
          sentRemainder = true;
          child!.send('continue');
        }
      });
    }
    watchdog = setTimeout(() => child?.kill('SIGKILL'), 2000);
    return child;
  });
  try {
    const result = await helpers.runAiwgCli(['synthetic-pipe-fixture'], { timeoutMs: 1000 });
    expect(firstChunks.get('stdout')).toEqual([0xe2]);
    expect(firstChunks.get('stderr')).toEqual([0xe2]);
    expect(sentRemainder).toBe(true);
    expect(result).toEqual({ stdout: '€', stderr: '€', code: 0 });
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    spawnMock.mockReset();
  }
}, 5000);

it("rejects promptly and reaps a ready real child that ignores SIGTERM without the test guard intervening", async () => {
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => process.send('ignored'));
    process.send('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let ignored = false;
  let guardFired = false;
  child.on('message', message => { if (message === 'ignored') ignored = true; });
  const guard = setTimeout(() => { guardFired = true; child.kill('SIGKILL'); }, 4000);
  try {
    const first = await Promise.race([once(child, 'message'), closed.then(() => [])]);
    expect(first[0]).toBe('ready');
    // Readiness is established before starting the helper deadline, avoiding
    // a test that accidentally kills the child before its handler is installed.
    spawnMock.mockReturnValueOnce(child);
    await expect(helpers.runAiwgCli(['synthetic-uncooperative'], { timeoutMs: 50 }))
      .rejects.toThrow('aiwg synthetic-uncooperative timed out after 50ms');
    await closed;
    expect(ignored).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
    expect(guardFired).toBe(false);
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    spawnMock.mockReset();
  }
}, 6000);
