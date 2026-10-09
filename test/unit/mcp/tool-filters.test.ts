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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { McpServerRegistry, injectServers, type InjectProvider, type McpServerDefinition } from "../../../src/mcp/registry.js";
import { McpServerRegistry as RuntimeRegistry, injectServers as runtimeInjectServers } from "../../../src/mcp/registry.mjs";
import { planToolFilters, resolveToolFilters, parseToolPattern, prepareClaudePermissions, mergeClaudePermissions } from "../../../src/mcp/tool-filters.mjs";

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
  vi.stubEnv("CODEX_HOME", join(root, "home", ".codex"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveToolFilters", () => {
  it("merges the * overrides with the provider's own, accepting provider aliases", () => {
    expect(resolveToolFilters(profile, "claude-code")).toEqual({
      deny: ["tracker__delete_issue", "tracker__admin_*", "files__*"],
      allow: [],
    });
    expect(resolveToolFilters(profile, "openai").allow).toEqual(["tracker__list_issues", "tracker__get_issue", "tracker__delete_issue"]);
    expect(resolveToolFilters(profile, "cursor")).toEqual({ deny: ["tracker__delete_issue", "tracker__admin_*", "files__*"], allow: [] });
    expect(resolveToolFilters(undefined, "cursor")).toEqual({ deny: [], allow: [] });
    expect(resolveToolFilters({ providerOverrides: {
      "*": { toolAllow: ["tracker__global"] }, claude: { toolAllow: ["tracker__local"] },
    } }, "claude-code").allow).toEqual(["tracker__global", "tracker__local"]);
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

describe("tool filter precedence and direct API refusal", () => {
  it("warns that Codex allowlists leave other servers unrestricted", () => {
    const plan = planToolFilters("codex", ["git", "files", "blocked"], {
      allow: ["git__status"], deny: ["blocked__*"],
    });
    expect(plan.tomlLines).toEqual({ git: ['enabled_tools = ["status"]'], blocked: ["enabled = false"] });
    expect(plan.warnings).toEqual([expect.stringContaining("files")]);
    expect(plan.warnings[0]).toContain("per-server");
    expect(plan.warnings[0]).not.toContain("blocked,");
  });

  it.each([
    { allow: ["git__status"], deny: ["git__*"], tool: "git_status", enabled: true },
    { allow: ["git__*"], deny: ["git__status"], tool: "git_status", enabled: true },
    { allow: ["git__status"], deny: ["git__status"], tool: "git_status", enabled: false },
  ])("resolves OpenCode overlap $allow / $deny", ({ allow, deny, tool, enabled }) => {
    const plan = planToolFilters("opencode", ["git"], { allow, deny });
    const matching = Object.entries(plan.topLevel.tools!).filter(([key]) =>
      new RegExp(`^${key.replaceAll("*", ".*")}$`).test(tool));
    expect(matching.at(-1)?.[1]).toBe(enabled);
  });

  it.each([prepareClaudePermissions, mergeClaudePermissions])("refuses nonempty permissions.allow via %s", async merge => {
    const file = join(root, "settings.json");
    await expect(merge(file, { deny: [], allow: ["mcp__git__list"] }))
      .rejects.toThrow(/permissions.allow.*mcp__git__list.*restrict-only allowlist/);
    expect(existsSync(file)).toBe(false);
  });
});

describe("Claude settings destination collisions", () => {
  it.each(["same path", "hardlink"])("refuses an MCP collision by %s before writing", async kind => {
    const mcpPath = join(root, "run.json");
    writeFileSync(mcpPath, '{"mcpServers":{}}');
    const settingsPath = kind === "same path" ? mcpPath : join(root, "run.settings.json");
    if (kind === "hardlink") linkSync(mcpPath, settingsPath);
    await expect(prepareClaudePermissions(settingsPath, { deny: ["mcp__git__delete_repo"], allow: [] }, {
      managedDir: join(root, "config"), sidecar: true, mcpPath,
    })).rejects.toThrow(/collides with MCP config/);
    expect(readFileSync(mcpPath, "utf-8")).toBe('{"mcpServers":{}}');
    expect(existsSync(join(root, "config"))).toBe(false);
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

  it.each(["claude", "claude-code"] as InjectProvider[])("refuses %s toolAllow before creating config or receipts", async provider => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const receipt = vi.spyOn(registry, "recordInjection");
    const projectDir = join(root, "project");
    await expect(inject(registry, provider, { projectDir, toolFilters: {
      deny: [], allow: ["tracker__list_issues", "outside__read", "*__x"],
    } })).rejects.toThrow(/tracker__list_issues.*outside__read.*\*__x.*restrict-only allowlist/);
    expect(listFiles(projectDir)).toEqual([]);
    expect(receipt).not.toHaveBeenCalled();
  });

  it("filters preserved Antigravity entries without replacing their launch config", async () => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    const config = join(projectDir, ".agents", "mcp_config.json");
    mkdirSync(join(projectDir, ".agents"), { recursive: true });
    writeFileSync(config, JSON.stringify({ mcpServers: { tracker: { command: "operator", custom: 42, disabledTools: ["operator_denied"] } } }));
    await inject(registry, "antigravity", { projectDir, toolFilters: { deny: ["tracker__delete_issue"], allow: [] } });
    expect(JSON.parse(readFileSync(config, "utf-8")).mcpServers.tracker).toEqual({
      command: "operator", custom: 42, disabledTools: ["operator_denied", "delete_issue"],
    });
    await inject(registry, "antigravity", { projectDir, toolFilters: { deny: ["tracker__*"], allow: [] } });
    expect(JSON.parse(readFileSync(config, "utf-8")).mcpServers.tracker.disabled).toBe(true);
  });

  it.each(["operator_rule", null, {}])("refuses malformed preserved Antigravity disabledTools %s", async disabledTools => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    const config = join(projectDir, ".agents", "mcp_config.json");
    mkdirSync(join(projectDir, ".agents"), { recursive: true });
    const original = JSON.stringify({ mcpServers: { tracker: { command: "operator", disabledTools } } });
    writeFileSync(config, original);
    const receipt = vi.spyOn(registry, "recordInjection");
    await expect(inject(registry, "antigravity", { projectDir, toolFilters: { deny: ["tracker__delete_issue"], allow: [] } }))
      .rejects.toThrow(/tracker.*disabledTools must be an array/);
    expect(readFileSync(config, "utf-8")).toBe(original);
    expect(receipt).not.toHaveBeenCalled();
  });

  it("keeps profile allows after a pre-existing OpenCode wildcard", async () => {
    const registry = new Registry(join(root, "config"));
    await registry.add({ name: "git", type: "stdio", command: "git-server" });
    const projectDir = join(root, "project");
    mkdirSync(projectDir);
    const config = join(projectDir, "opencode.json");
    writeFileSync(config, JSON.stringify({ tools: { git_status: false, "git_*": false, other: true } }));
    for (let i = 0; i < 2; i++) {
      await inject(registry, "opencode", { projectDir, toolFilters: { allow: ["git__status"], deny: ["git__*"] } });
      expect(Object.entries(JSON.parse(readFileSync(config, "utf-8")).tools))
        .toEqual([["other", true], ["git_*", false], ["git_status", true]]);
    }
  });

  it("keeps opencode denies last after an existing conflicting wildcard on reinjection", async () => {
    const registry = new Registry(join(root, "config"));
    await registry.add({ name: "git", type: "stdio", command: "git-server" });
    const projectDir = join(root, "project");
    mkdirSync(projectDir);
    const config = join(projectDir, "opencode.json");
    writeFileSync(config, JSON.stringify({ tools: { git_delete_repo: true, "git_*": true, other: true } }));
    for (let i = 0; i < 2; i++) {
      await inject(registry, "opencode", { projectDir, toolFilters: { deny: ["git__delete_repo"], allow: [] } });
      const tools = JSON.parse(readFileSync(config, "utf-8")).tools;
      expect(Object.entries(tools)).toEqual([["git_*", true], ["other", true], ["git_delete_repo", false]]);
      const matches = Object.entries(tools).filter(([key]) => new RegExp(`^${key.replaceAll("*", ".*")}$`).test("git_delete_repo"));
      expect(matches.at(-1)?.[1]).toBe(false);
    }
  });

  it.each(["{", "[]", "null", '{"permissions":null}', '{"permissions":[]}',
    '{"permissions":{"deny":"x"}}', '{"permissions":{"allow":[1]}}', '{"permissions":{"ask":{}}}'])(
    "validates settings %s before MCP config or receipts", async content => {
      const registry = new Registry(join(root, "config"));
      await registry.add(servers[0]);
      const receipt = vi.spyOn(registry, "recordInjection");
      const projectDir = join(root, "project");
      const settings = join(projectDir, ".claude", "settings.local.json");
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(settings, content);
      const config = join(projectDir, ".mcp.json");
      writeFileSync(config, '{"mcpServers":{},"keep":true}');
      await expect(inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__delete_issue"], allow: [] } }))
        .rejects.toThrow(/settings/);
      expect(readFileSync(settings, "utf-8")).toBe(content);
      expect(readFileSync(config, "utf-8")).toBe('{"mcpServers":{},"keep":true}');
      expect(receipt).not.toHaveBeenCalled();
    });

  it.each(["file", "parent", "user"])("refuses a %s settings symlink before writing MCP", async kind => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const receipt = vi.spyOn(registry, "recordInjection");
    const projectDir = join(root, "project");
    const parent = kind === "user" ? join(root, "home", ".claude") : join(projectDir, ".claude");
    const target = join(root, "operator");
    mkdirSync(target, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    if (kind === "parent") symlinkSync(target, parent);
    else {
      mkdirSync(parent, { recursive: true });
      writeFileSync(join(target, "settings.json"), '{}');
      symlinkSync(join(target, "settings.json"), join(parent, kind === "user" ? "settings.json" : "settings.local.json"));
    }
    await expect(inject(registry, "claude", { projectDir, scope: kind === "user" ? "user" : "project",
      toolFilters: { deny: ["tracker__delete_issue"], allow: [] } })).rejects.toThrow(/symlink/);
    expect(existsSync(join(projectDir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, "home", ".claude.json"))).toBe(false);
    expect(receipt).not.toHaveBeenCalled();
  });

  it("creates and rewrites user settings privately", async () => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const options = { scope: "user" as const, toolFilters: { deny: ["tracker__delete_issue"], allow: [] } };
    const settings = join(root, "home", ".claude", "settings.json");
    await inject(registry, "claude", options);
    if (process.platform !== "win32") {
      expect(statSync(settings).mode & 0o777).toBe(0o600);
      chmodSync(settings, 0o644);
      await inject(registry, "claude", options);
      expect(statSync(settings).mode & 0o777).toBe(0o600);
    }
  });

  it("creates new project settings privately and preserves an existing mode", async () => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    const settings = join(projectDir, ".claude", "settings.local.json");
    const options = { projectDir, toolFilters: { deny: ["tracker__a"], allow: [] } };
    await inject(registry, "claude", options);
    if (process.platform !== "win32") {
      expect(statSync(settings).mode & 0o777).toBe(0o600);
      chmodSync(settings, 0o640);
      await inject(registry, "claude", options);
      expect(statSync(settings).mode & 0o777).toBe(0o640);
    }
  });

  it.each(["changed deny", "legacy digest"])("retains uncertain rules on switch and later injections (%s)", async kind => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    const settings = join(projectDir, ".claude", "settings.local.json");
    await inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__a"], allow: [] } });
    const recordDir = join(root, "config", "claude-tool-permissions");
    const recordFile = join(recordDir, readdirSync(recordDir)[0]);
    if (kind === "changed deny") {
      // A restored/edited deny array still contains a rule named in the stale record.
      writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Bash(rm:*)", "mcp__tracker__a"] } }));
    } else {
      const record = JSON.parse(readFileSync(recordFile, "utf-8"));
      delete record.denyDigest;
      writeFileSync(recordFile, JSON.stringify(record));
    }
    for (let i = 0; i < 2; i++) {
      const result = await inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__b"], allow: [] } });
      expect(JSON.parse(readFileSync(settings, "utf-8")).permissions.deny).toContain("mcp__tracker__a");
      expect(result.warnings).toEqual([expect.stringMatching(/mcp__tracker__a.*Remove these rules manually/)]);
      expect(JSON.parse(readFileSync(recordFile, "utf-8")).denyAdded).toContain("mcp__tracker__a");
    }
    const edited = JSON.parse(readFileSync(settings, "utf-8"));
    edited.permissions.deny = edited.permissions.deny.filter((rule: string) => rule !== "mcp__tracker__a");
    writeFileSync(settings, JSON.stringify(edited));
    await inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__b"], allow: [] } });
    expect(JSON.parse(readFileSync(recordFile, "utf-8")).denyAdded).not.toContain("mcp__tracker__a");
  });

  it("still removes obsolete rules when only unrelated settings changed", async () => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    const settings = join(projectDir, ".claude", "settings.local.json");
    await inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__a"], allow: [] } });
    const edited = JSON.parse(readFileSync(settings, "utf-8"));
    edited.model = "operator";
    writeFileSync(settings, JSON.stringify(edited));
    await inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__b"], allow: [] } });
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({ model: "operator", permissions: { deny: ["mcp__tracker__b"] } });
  });

  it.each(["project root", "user .claude"])("shares ownership through a symlinked %s", async kind => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    mkdirSync(projectDir);
    const alias = join(root, "alias");
    const realParent = kind === "project root" ? projectDir : join(root, "dotfiles");
    mkdirSync(realParent, { recursive: true });
    if (kind === "project root") symlinkSync(projectDir, alias, "dir");
    else {
      mkdirSync(join(root, "home"));
      symlinkSync(realParent, join(root, "home", ".claude"), "dir");
    }
    const scope = kind === "project root" ? "project" as const : "user" as const;
    await inject(registry, "claude", { projectDir: kind === "project root" ? alias : projectDir, scope,
      toolFilters: { deny: ["tracker__a"], allow: [] } });
    if (kind === "user .claude") {
      await mergeClaudePermissions(join(realParent, "settings.json"), { deny: ["mcp__tracker__b"], allow: [] }, {
        userScope: true, managedDir: join(root, "config"),
      });
    } else {
      await inject(registry, "claude", { projectDir, scope, toolFilters: { deny: ["tracker__b"], allow: [] } });
    }
    const settings = kind === "project root" ? join(projectDir, ".claude", "settings.local.json") : join(realParent, "settings.json");
    expect(JSON.parse(readFileSync(settings, "utf-8")).permissions.deny).toEqual(["mcp__tracker__b"]);
    expect(readdirSync(join(root, "config", "claude-tool-permissions"))).toHaveLength(1);
  });

  it.each(["{", "{}", '{"denyAdded":[123]}'])("gives a reset hint for corrupt ownership %s", async corrupt => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    await inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__a"], allow: [] } });
    const recordDir = join(root, "config", "claude-tool-permissions");
    const recordFile = join(recordDir, readdirSync(recordDir)[0]);
    writeFileSync(recordFile, corrupt);
    const mcp = readFileSync(join(projectDir, ".mcp.json"), "utf-8");
    await expect(inject(registry, "claude", { projectDir })).rejects.toThrow(`Delete ${recordFile} to reset ownership`);
    expect(readFileSync(join(projectDir, ".mcp.json"), "utf-8")).toBe(mcp);
  });

  it("refuses an uncreatable ownership directory before changing MCP or settings", async () => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    writeFileSync(join(root, "config", "claude-tool-permissions"), "operator file");
    const projectDir = join(root, "project");
    await expect(inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__a"], allow: [] } }))
      .rejects.toThrow();
    expect(listFiles(projectDir)).toEqual([]);
  });

  it("switches profiles and clears owned rules while preserving user rules and identical pre-existing rules", async () => {
    let registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    const settings = join(projectDir, ".claude", "settings.local.json");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    const userRule = "mcp__tracker__user";
    writeFileSync(settings, JSON.stringify({ model: "keep", permissions: { deny: [userRule, "Bash(rm:*)"], allow: ["Read(**)"], ask: ["Write"] } }));
    await inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__user", "tracker__a"], allow: [] } });
    // A changed deny array makes ownership uncertain; retain all occurrences until manually removed.
    registry = new Registry(join(root, "config"));
    const edited = JSON.parse(readFileSync(settings, "utf-8"));
    edited.permissions.deny.push("mcp__tracker__a");
    writeFileSync(settings, JSON.stringify(edited));
    await inject(registry, "claude", { projectDir, toolFilters: { deny: ["tracker__b"], allow: [] } });
    expect(JSON.parse(readFileSync(settings, "utf-8")).permissions.deny).toEqual([userRule, "Bash(rm:*)", "mcp__tracker__a", "mcp__tracker__a", "mcp__tracker__b"]);
    await inject(registry, "claude", { projectDir });
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({ model: "keep", permissions: {
      deny: [userRule, "Bash(rm:*)", "mcp__tracker__a", "mcp__tracker__a"], allow: ["Read(**)"], ask: ["Write"],
    } });
  });

  it("removes profile A rules when switching to B and keeps ownership isolated by settings path", async () => {
    const registry = new Registry(join(root, "config"));
    await registry.add(servers[0]);
    const projectDir = join(root, "project");
    const otherProject = join(root, "other-project");
    const options = { toolFilters: { deny: ["tracker__a"], allow: [] } };
    await inject(registry, "claude", { ...options, projectDir });
    await inject(registry, "claude", { ...options, projectDir: otherProject });
    const settings = join(projectDir, ".claude", "settings.local.json");
    const prior = readFileSync(settings, "utf-8");
    await inject(registry, "claude", { projectDir, dryRun: true, toolFilters: { deny: ["tracker__b"], allow: [] } });
    expect(readFileSync(settings, "utf-8")).toBe(prior);
    await inject(new Registry(join(root, "config")), "claude", { projectDir, toolFilters: { deny: ["tracker__b"], allow: [] } });
    expect(JSON.parse(readFileSync(settings, "utf-8")).permissions.deny).toEqual(["mcp__tracker__b"]);
    expect(JSON.parse(readFileSync(join(otherProject, ".claude", "settings.local.json"), "utf-8")).permissions.deny)
      .toEqual(["mcp__tracker__a"]);
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
        allow: ["Read(**)"],
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

    const stored = JSON.parse(readFileSync(join(root, "config", "mcp-profiles.json"), "utf-8")).profiles.triage;
    expect(stored.providerOverrides).toEqual({
      "*": { toolDeny: ["tracker__delete_issue"] },
    });

    const out = join(root, "triage.json");
    const stdout = run(["inject", "--provider", "claude", "--profile", "triage", "--ephemeral", "--out", out]);
    const settings = join(root, "triage.settings.json");
    expect(stdout).toContain(`claude --mcp-config ${out} --settings ${settings}`);
    expect(JSON.parse(readFileSync(settings, "utf-8"))).toEqual({
      permissions: { deny: ["mcp__tracker__delete_issue"] },
    });
    if (process.platform !== "win32") {
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(settings).mode & 0o777).toBe(0o600);
      chmodSync(settings, 0o644);
      run(["inject", "--provider", "claude", "--profile", "triage", "--ephemeral", "--out", out]);
      expect(statSync(settings).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the default ephemeral settings sidecar in the same private directory", () => {
    run(["profile", "add", "triage", "--servers", "tracker", "--tool-deny", "tracker__delete_issue"]);
    run(["inject", "--provider", "claude", "--profile", "triage", "--ephemeral", "--no-credentials"]);
    const tempDir = join(root, readdirSync(root).find(name => name.startsWith("aiwg-mcp-"))!);
    expect(readdirSync(tempDir).sort()).toEqual(["triage-claude-code.json", "triage-claude-code.settings.json"]);
    if (process.platform !== "win32") {
      expect(statSync(tempDir).mode & 0o777).toBe(0o700);
      for (const file of readdirSync(tempDir)) expect(statSync(join(tempDir, file)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a settings sidecar symlink before writing either output", () => {
    run(["profile", "add", "triage", "--servers", "tracker", "--tool-deny", "tracker__delete_issue"]);
    const out = join(root, "triage.json");
    const target = join(root, "operator.json");
    writeFileSync(target, "operator content");
    symlinkSync(target, join(root, "triage.settings.json"));
    expect(() => run(["inject", "--provider", "claude", "--profile", "triage", "--ephemeral", "--out", out]))
      .toThrow(/symlink/);
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("operator content");
  });

  it("enforces credential policy before writing an ephemeral config or its settings", () => {
    run(["profile", "add", "triage", "--servers", "tracker", "--tool-deny", "tracker__delete_issue"]);
    const registryPath = join(root, "config", "mcp-servers.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    registry.servers.tracker.headerEnv = { Authorization: "TOKEN" };
    writeFileSync(registryPath, JSON.stringify(registry));
    const out = join(root, "triage.json");
    expect(() => run(["inject", "--provider", "claude", "--profile", "triage", "--ephemeral", "--out", out, "--no-credentials"]))
      .toThrow(/Refusing to render/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(root, "triage.settings.json"))).toBe(false);
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
    run(["inject", "--provider", "claude", "--profile", "triage"]);
    run(["profile", "edit", "triage", "--clear-tool-filters"]);
    run(["inject", "--provider", "claude", "--profile", "triage"]);
    expect(JSON.parse(readFileSync(join(root, "project", ".claude", "settings.local.json"), "utf-8")).permissions.deny).toEqual([]);
    const stored = JSON.parse(readFileSync(join(root, "config", "mcp-profiles.json"), "utf-8")).profiles.triage;
    expect(stored.providerOverrides).toEqual({});
  });
});
