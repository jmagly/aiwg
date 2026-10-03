/**
 * MCP profile tool filters.
 *
 * Golden files under test/fixtures/mcp-tool-filters hold every file each
 * harness receives, plus the warnings, when profile.json is injected with the
 * servers in servers.json. Set AIWG_UPDATE_GOLDEN=1 to rewrite them, then
 * review the diff against each harness's documentation.
 *
 * @source @src/mcp/tool-filters.mjs
 * @source @src/mcp/registry.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { McpServerRegistry, injectServers, type InjectProvider, type McpServerDefinition } from "../../../src/mcp/registry.js";
import { McpServerRegistry as RuntimeRegistry, injectServers as runtimeInjectServers } from "../../../src/mcp/registry.mjs";
import { planToolFilters, resolveToolFilters, parseToolPattern } from "../../../src/mcp/tool-filters.mjs";

const fixtures = resolve(__dirname, "../../fixtures/mcp-tool-filters");
const profile = JSON.parse(readFileSync(join(fixtures, "profile.json"), "utf-8"));
const servers = JSON.parse(readFileSync(join(fixtures, "servers.json"), "utf-8")) as McpServerDefinition[];
const cliPath = resolve(__dirname, "../../../src/mcp/cli.mjs");

const providers = ["claude-code", "codex", "opencode", "factory", "windsurf", "antigravity", "cursor", "warp"] as InjectProvider[];

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap(name => {
    const full = join(root, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiwg-mcp-tools-"));
  vi.stubEnv("HOME", join(root, "home"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveToolFilters", () => {
  it("merges the * overrides with the provider's own, accepting provider aliases", () => {
    expect(resolveToolFilters(profile, "claude-code")).toEqual({
      deny: ["tracker__delete_issue", "tracker__admin_*", "files__*"],
      allow: ["tracker__list_issues"],
    });
    expect(resolveToolFilters(profile, "openai").allow).toEqual(["tracker__list_issues", "tracker__get_issue", "tracker__delete_issue"]);
    expect(resolveToolFilters(profile, "cursor")).toEqual({ deny: ["tracker__delete_issue", "tracker__admin_*", "files__*"], allow: [] });
    expect(resolveToolFilters(undefined, "cursor")).toEqual({ deny: [], allow: [] });
  });

  it("parses <server>__<tool> and rejects patterns without a server", () => {
    expect(parseToolPattern("git-gitea__delete_*")).toEqual({ server: "git-gitea", tool: "delete_*" });
    expect(parseToolPattern("delete_repo")).toBeNull();
    expect(parseToolPattern("__x")).toBeNull();
  });

  it("warns about malformed patterns and ignores servers outside the injected set", () => {
    const plan = planToolFilters("claude-code", ["tracker"], { deny: ["delete_repo", "*__x", "other__y", "tracker__z"], allow: [] });
    expect(plan.claudePermissions).toEqual({ deny: ["mcp__tracker__z"], allow: [] });
    expect(plan.warnings).toEqual([
      'toolDeny pattern "delete_repo" is not <server>__<tool> with a literal server name; not rendered.',
      'toolDeny pattern "*__x" is not <server>__<tool> with a literal server name; not rendered.',
    ]);
  });
});

describe.each([
  { implementation: "TypeScript", Registry: McpServerRegistry, inject: injectServers },
  { implementation: "runtime", Registry: RuntimeRegistry as unknown as typeof McpServerRegistry, inject: runtimeInjectServers as typeof injectServers },
])("$implementation injection with tool filters", ({ Registry, inject }) => {
  it.each(providers)("matches the %s golden file", async provider => {
    const registry = new Registry(join(root, "config"));
    for (const server of servers) await registry.add(server);
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    const result = await inject(registry, provider, { projectDir, toolFilters: resolveToolFilters(profile, provider) });

    const files = Object.fromEntries(
      [...listFiles(projectDir), ...listFiles(join(root, "home"))]
        .sort()
        .map(file => [relative(root, file), readFileSync(file, "utf-8")]),
    );
    const actual = { files, warnings: result.warnings };
    const golden = join(fixtures, `${provider}.golden.json`);
    if (process.env.AIWG_UPDATE_GOLDEN === "1") writeFileSync(golden, JSON.stringify(actual, null, 2) + "\n");
    expect(actual).toEqual(JSON.parse(readFileSync(golden, "utf-8")));
  });

  it("keeps existing Claude Code permission rules and adds each rule once", async () => {
    const registry = new Registry(join(root, "config"));
    for (const server of servers) await registry.add(server);
    const projectDir = join(root, "project");
    const settings = join(projectDir, ".claude", "settings.local.json");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ model: "keep", permissions: { deny: ["Bash(rm:*)"], allow: ["Read(**)"] } }));
    const toolFilters = resolveToolFilters(profile, "claude-code");
    await inject(registry, "claude-code", { projectDir, toolFilters });
    await inject(registry, "claude-code", { projectDir, toolFilters });
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({
      model: "keep",
      permissions: {
        deny: ["Bash(rm:*)", "mcp__tracker__delete_issue", "mcp__tracker__admin_*", "mcp__files"],
        allow: ["Read(**)", "mcp__tracker__list_issues"],
      },
    });
  });
});

describe("aiwg mcp CLI with profile tool filters", () => {
  function run(args: string[]) {
    return execFileSync(process.execPath, [cliPath, ...args], {
      cwd: join(root, "project"),
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: join(root, "home"), AIWG_CONFIG: join(root, "config"), TMPDIR: root },
    });
  }

  beforeEach(() => {
    for (const dir of ["config", "project", "home"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "config", "mcp-servers.json"), JSON.stringify({
      apiVersion: "aiwg.io/v1",
      kind: "McpServerRegistry",
      servers: Object.fromEntries(servers.map(server => [server.name, server])),
    }));
  });

  it("sets filters with profile flags and writes a --settings file beside the ephemeral config", () => {
    run(["profile", "add", "triage", "--servers", "tracker,files", "--tool-deny", "tracker__delete_issue"]);
    run(["profile", "edit", "triage", "--provider", "claude", "--tool-allow", "tracker__list_issues"]);
    const stored = JSON.parse(readFileSync(join(root, "config", "mcp-profiles.json"), "utf-8")).profiles.triage;
    expect(stored.providerOverrides).toEqual({
      "*": { toolDeny: ["tracker__delete_issue"] },
      claude: { toolAllow: ["tracker__list_issues"] },
    });

    const out = join(root, "triage.json");
    const stdout = run(["inject", "--provider", "claude", "--profile", "triage", "--ephemeral", "--out", out]);
    const settings = join(root, "triage.settings.json");
    expect(stdout).toContain(`claude --mcp-config ${out} --settings ${settings}`);
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({
      permissions: { deny: ["mcp__tracker__delete_issue"], allow: ["mcp__tracker__list_issues"] },
    });
  });

  it("prints a warning for each filter the provider cannot express", () => {
    run(["profile", "add", "triage", "--servers", "tracker", "--tool-deny", "tracker__delete_issue"]);
    const stderr = execFileSync("sh", ["-c", `"${process.execPath}" "${cliPath}" inject --provider cursor --profile triage 2>&1 >/dev/null`], {
      cwd: join(root, "project"),
      encoding: "utf-8",
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: join(root, "home"), AIWG_CONFIG: join(root, "config") },
    });
    expect(stderr).toContain("WARNING cursor: tool filters are not rendered; cursor documents no per-tool filter in its MCP config.");
  });

  it("clears a provider's filters", () => {
    run(["profile", "add", "triage", "--servers", "tracker", "--tool-deny", "tracker__delete_issue"]);
    run(["profile", "edit", "triage", "--clear-tool-filters"]);
    const stored = JSON.parse(readFileSync(join(root, "config", "mcp-profiles.json"), "utf-8")).profiles.triage;
    expect(stored.providerOverrides).toEqual({});
  });
});
