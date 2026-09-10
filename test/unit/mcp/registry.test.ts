/**
 * MCP Server Registry Tests
 *
 * Tests for the MCP server definition storage and provider injection.
 *
 * @source @src/mcp/registry.ts
 * @implements #554
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, open, unlink, rename } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { createHash } from "node:crypto";

const filesystemBoundary = vi.hoisted(() => ({ root: "", failReadPath: "", mutations: [] as string[] }));
vi.mock("path", async importOriginal => {
  const actual = await importOriginal<typeof import("path")>();
  return {
    ...actual,
    resolve: (...parts: string[]) => {
      // Redirect only the home-scoped adapters exercised by this owner.
      // Do not change HOME or production provider metadata.
      if (filesystemBoundary.root && parts.length === 2 &&
          [".factory/mcp.json", ".codex/config.toml", ".codeium/windsurf/mcp_config.json", ".warp/mcp.json"].includes(parts[1])) {
        return actual.resolve(filesystemBoundary.root, "provider-home", parts[1]);
      }
      return actual.resolve(...parts);
    },
  };
});
// Vitest resolves fs/promises and node:fs/promises to this same mock.
// The native OMP writer also uses atomic writes/locks.
// Keep those mutations inside the same fixture; lstat may inspect ancestors.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { resolve, relative, isAbsolute, sep } = await import("node:path");
  function check(file: unknown) {
    const root = filesystemBoundary.root;
    const rel = root ? relative(root, resolve(String(file))) : "..";
    if (!root || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Registry test attempted filesystem access outside its temporary directory");
    }
  }
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      check(args[0]);
      if (String(args[0]) === filesystemBoundary.failReadPath) throw Object.assign(new Error("synthetic read refusal"), { code: "EACCES" });
      return actual.readFile(...args);
    },
    writeFile: (...args: Parameters<typeof actual.writeFile>) => { check(args[0]); filesystemBoundary.mutations.push("writeFile"); return actual.writeFile(...args); },
    mkdir: (...args: Parameters<typeof actual.mkdir>) => { check(args[0]); filesystemBoundary.mutations.push("mkdir"); return actual.mkdir(...args); },
    open: (...args: Parameters<typeof actual.open>) => { check(args[0]); filesystemBoundary.mutations.push("open"); return actual.open(...args); },
    unlink: (...args: Parameters<typeof actual.unlink>) => { check(args[0]); filesystemBoundary.mutations.push("unlink"); return actual.unlink(...args); },
    rename: (...args: Parameters<typeof actual.rename>) => { check(args[0]); check(args[1]); filesystemBoundary.mutations.push("rename"); return actual.rename(...args); },
  };
});

import {
  McpServerRegistry,
  injectServers,
  getProviderConfigPath,
  SUPPORTED_PROVIDERS,
} from "../../../src/mcp/registry.js";
import { injectServers as injectRuntimeServers, McpServerRegistry as RuntimeMcpServerRegistry } from "../../../src/mcp/registry.mjs";

type RegistryContract = Pick<McpServerRegistry, keyof McpServerRegistry>;
const registryImplementations: { implementation: string; create: (directory: string) => RegistryContract }[] = [
  { implementation: "TypeScript", create: directory => new McpServerRegistry(directory) },
  // Exercise the common public API, not either implementation's private fields.
  { implementation: "runtime", create: directory => new RuntimeMcpServerRegistry(directory) as RegistryContract },
];
describe.each(registryImplementations)("$implementation McpServerRegistry", ({ create }) => {
  let tempDir: string;
  let registry: RegistryContract;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aiwg-mcp-test-"));
    filesystemBoundary.root = tempDir;
    registry = create(tempDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
    filesystemBoundary.root = "";
  });

  describe("constructor and getPath", () => {
    it("should resolve the registry file path", () => {
      expect(registry.getPath()).toBe(join(tempDir, "mcp-servers.json"));
    });
  });

  it.each(["read", "write", "mkdir", "open", "unlink", "rename-source", "rename-destination"])("blocks out-of-fixture %s before filesystem access", operation => {
    // A sibling sharing the prefix is outside the fixture, not an allowed child.
    const outside = join(`${tempDir}-outside`, "synthetic-config");
    const action = operation === "read" ? () => readFile(outside, "utf-8")
      : operation === "write" ? () => writeFile(outside, "synthetic")
      : operation === "open" ? () => open(outside, "wx")
      : operation === "unlink" ? () => unlink(outside)
      : operation === "rename-source" ? () => rename(outside, join(tempDir, "inside"))
      : operation === "rename-destination" ? () => rename(join(tempDir, "inside"), outside)
      : () => mkdir(outside, { recursive: true });
    expect(action).toThrow("Registry test attempted filesystem access outside its temporary directory");
  });

  describe("load", () => {
    it("keeps cached data until clearCache then reads the changed disk state", async () => {
      const first = { apiVersion: "aiwg.io/v1", kind: "McpServerRegistry", servers: {
        first: { name: "first", type: "http", url: "https://first.example/mcp" },
      } };
      const second = { ...first, servers: {
        second: { name: "second", type: "stdio", command: "synthetic-command", args: ["literal"] },
      } };
      await writeFile(registry.getPath(), JSON.stringify(first));
      const cached = await registry.load();
      expect(cached).toEqual(first);
      await writeFile(registry.getPath(), JSON.stringify(second));
      expect(await registry.load()).toBe(cached);
      expect(await registry.load()).toEqual(first);
      registry.clearCache();
      expect(await registry.load()).toEqual(second);
      expect(await registry.load()).not.toBe(cached);
    });

    it("does not create a registry when save is called before load", async () => {
      await registry.save();
      expect(existsSync(registry.getPath())).toBe(false);
    });

    it("creates nested storage and persists a loaded empty registry", async () => {
      const nested = create(join(tempDir, "nested", "config"));
      await nested.load();
      await nested.save();
      expect(await readFile(nested.getPath(), "utf-8")).toBe(JSON.stringify({
        apiVersion: "aiwg.io/v1", kind: "McpServerRegistry", servers: {},
      }, null, 2) + "\n");
    });
    it("should return empty registry when file does not exist", async () => {
      const data = await registry.load();
      expect(data.apiVersion).toBe("aiwg.io/v1");
      expect(data.kind).toBe("McpServerRegistry");
      expect(data.servers).toEqual({});
    });

    it("should parse existing registry file", async () => {
      await writeFile(
        join(tempDir, "mcp-servers.json"),
        JSON.stringify({
          apiVersion: "aiwg.io/v1",
          kind: "McpServerRegistry",
          servers: {
            test: { name: "test", type: "http", url: "https://example.com/mcp" },
          },
        }),
      );

      // Need fresh registry to avoid cache
      const fresh = create(tempDir);
      const data = await fresh.load();
      expect(data.servers.test).toBeDefined();
      expect(data.servers.test.url).toBe("https://example.com/mcp");
    });
  });

  describe("add", () => {
    it("should add a new http server", async () => {
      await registry.add({
        name: "fortemi",
        type: "http",
        url: "https://memory.s9.internal/mcp",
      });

      const content = JSON.parse(await readFile(registry.getPath(), "utf-8"));
      expect(content.servers.fortemi).toBeDefined();
      expect(content.servers.fortemi.url).toBe("https://memory.s9.internal/mcp");
      expect(content.servers.fortemi.type).toBe("http");
      expect(content.servers.fortemi.addedAt).toBeDefined();
    });

    it("persists authenticated header references without credential values", async () => {
      await registry.add({
        name: "fortemi-enterprise",
        type: "http",
        url: "https://memory.example.internal/mcp",
        headerEnv: { Authorization: "AIWG_FORTEMI_TOKEN" },
      });

      const raw = await readFile(registry.getPath(), "utf-8");
      const content = JSON.parse(raw);
      expect(content.servers["fortemi-enterprise"].headerEnv).toEqual({
        Authorization: "AIWG_FORTEMI_TOKEN",
      });
      expect(raw).not.toContain("Bearer ");
      expect(raw).not.toContain("synthetic-test-token");
    });

    it("rejects unsafe credential reference names before persisting", async () => {
      await expect(
        registry.add({
          name: "invalid-auth",
          type: "http",
          url: "https://memory.example.internal/mcp",
          headerEnv: { Authorization: "../credentials.json" },
        }),
      ).rejects.toThrow(/Invalid MCP header environment variable reference/);
      expect(existsSync(registry.getPath())).toBe(false);
    });

    it("should add a new stdio server", async () => {
      await registry.add({
        name: "mytools",
        type: "stdio",
        command: "npx",
        args: ["mcp-server-mytools"],
      });

      const content = JSON.parse(await readFile(registry.getPath(), "utf-8"));
      expect(content.servers.mytools.command).toBe("npx");
      expect(content.servers.mytools.args).toEqual(["mcp-server-mytools"]);
    });

    it("should reject duplicate server names", async () => {
      await registry.add({ name: "test", type: "http", url: "https://a.com" });

      await expect(
        registry.add({ name: "test", type: "http", url: "https://b.com" }),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe("remove", () => {
    it("persists removal without changing another server", async () => {
      await registry.add({ name: "removed", type: "http", url: "https://removed.example" });
      await registry.add({ name: "retained", type: "stdio", command: "synthetic", args: ["keep"] });
      const before = JSON.parse(await readFile(registry.getPath(), "utf-8"));
      await registry.remove("removed");
      const fresh = await create(tempDir).load();
      expect(fresh).toEqual({ ...before, servers: { retained: before.servers.retained } });
    });
    it("should remove an existing server", async () => {
      await registry.add({ name: "test", type: "http", url: "https://a.com" });
      await registry.remove("test");

      const content = JSON.parse(await readFile(registry.getPath(), "utf-8"));
      expect(content.servers.test).toBeUndefined();
    });

    it("should throw for non-existent server", async () => {
      await expect(registry.remove("nonexistent")).rejects.toThrow(/not found/);
    });
  });

  describe("update", () => {
    it("persists only requested fields and updatedAt while preserving creation metadata", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      await registry.add({ name: "original", type: "http", url: "https://old.example", description: "keep" });
      const before = await create(tempDir).get("original");
      vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
      await registry.update("original", { url: "https://new.example" });
      expect(await create(tempDir).get("original")).toEqual({
        ...before, url: "https://new.example", updatedAt: "2026-01-02T00:00:00.000Z",
      });
      expect(before?.addedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("rejects invalid update references without changing memory or disk", async () => {
      await registry.add({ name: "original", type: "http", url: "https://old.example", headerEnv: { Authorization: "SYNTHETIC_REFERENCE" } });
      const before = await readFile(registry.getPath(), "utf-8");
      await expect(registry.update("original", {
        url: "https://wrong.example", headerEnv: { Authorization: "invalid-reference" },
      })).rejects.toThrow('Invalid MCP header environment variable reference "invalid-reference"');
      expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
      expect(await registry.load()).toEqual(JSON.parse(before));
    });
    it("should update an existing server", async () => {
      await registry.add({ name: "test", type: "http", url: "https://old.com" });
      await registry.update("test", { url: "https://new.com" });

      const content = JSON.parse(await readFile(registry.getPath(), "utf-8"));
      expect(content.servers.test.url).toBe("https://new.com");
      expect(content.servers.test.name).toBe("test");
    });

    it("should throw for non-existent server", async () => {
      await expect(
        registry.update("nonexistent", { url: "https://new.com" }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("get", () => {
    it("should return a server definition", async () => {
      await registry.add({ name: "test", type: "http", url: "https://a.com" });
      const server = await registry.get("test");
      expect(server).toBeDefined();
      expect(server!.url).toBe("https://a.com");
    });

    it("should return undefined for non-existent server", async () => {
      const server = await registry.get("nonexistent");
      expect(server).toBeUndefined();
    });
  });

  describe("list", () => {
    it("should return all servers", async () => {
      await registry.add({ name: "a", type: "http", url: "https://a.com" });
      await registry.add({ name: "b", type: "stdio", command: "npx", args: ["b"] });

      const servers = await registry.list();
      expect(servers).toHaveLength(2);
      expect(servers.map((s) => s.name).sort()).toEqual(["a", "b"]);
    });

    it("should return empty array when no servers", async () => {
      const servers = await registry.list();
      expect(servers).toEqual([]);
    });
  });

  describe("recordInjection", () => {
    it("persists unique injection records for a fresh registry instance", async () => {
      await registry.add({ name: "test", type: "http", url: "https://test.example" });
      for (const provider of ["cursor", "factory", "cursor"]) await registry.recordInjection("test", provider);
      const fresh = create(tempDir);
      expect((await fresh.get("test"))?.injectedProviders).toEqual(["cursor", "factory"]);
      expect(await fresh.getInjectedProviders()).toEqual(["cursor", "factory"]);
    });

    it("does not create storage when recording injection for an unknown server", async () => {
      await registry.recordInjection("missing", "cursor");
      expect(existsSync(registry.getPath())).toBe(false);
      expect(await registry.list()).toEqual([]);
    });
    it("should track injected providers", async () => {
      await registry.add({ name: "test", type: "http", url: "https://a.com" });
      await registry.recordInjection("test", "claude-code");
      await registry.recordInjection("test", "cursor");

      const server = await registry.get("test");
      expect(server!.injectedProviders).toContain("claude-code");
      expect(server!.injectedProviders).toContain("cursor");
    });

    it("should not duplicate provider entries", async () => {
      await registry.add({ name: "test", type: "http", url: "https://a.com" });
      await registry.recordInjection("test", "claude-code");
      await registry.recordInjection("test", "claude-code");

      const server = await registry.get("test");
      expect(
        server!.injectedProviders!.filter((p) => p === "claude-code"),
      ).toHaveLength(1);
    });
  });

  describe("getInjectedProviders", () => {
    it("should return unique set of all injected providers", async () => {
      await registry.add({ name: "a", type: "http", url: "https://a.com" });
      await registry.add({ name: "b", type: "http", url: "https://b.com" });
      await registry.recordInjection("a", "claude-code");
      await registry.recordInjection("a", "cursor");
      await registry.recordInjection("b", "cursor");
      await registry.recordInjection("b", "factory");

      const providers = await registry.getInjectedProviders();
      expect(providers.sort()).toEqual(["claude-code", "cursor", "factory"]);
    });
  });
});

describe("injectServers", () => {
  let tempDir: string;
  let projectDir: string;
  let registry: McpServerRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aiwg-mcp-inject-"));
    filesystemBoundary.root = tempDir;
    projectDir = join(tempDir, "project");
    await mkdir(projectDir, { recursive: true });

    registry = new McpServerRegistry(tempDir);
    await registry.add({
      name: "fortemi",
      type: "http",
      url: "https://memory.internal/mcp",
    });
    await registry.add({
      name: "gitea",
      type: "http",
      url: "https://mcp-gitea.internal/mcp",
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    filesystemBoundary.root = "";
  });

  const jsonAdapters = [
    { provider: "claude-code", location: "project", file: ".claude/settings.local.json", shape: "plain" },
    { provider: "claude", location: "project", file: ".claude/settings.local.json", shape: "plain" },
    { provider: "cursor", location: "project", file: ".cursor/mcp.json", shape: "plain" },
    { provider: "factory", location: "home", file: ".factory/mcp.json", shape: "factory" },
    { provider: "opencode", location: "project", file: "opencode.json", shape: "opencode" },
    { provider: "antigravity", location: "project", file: ".agents/mcp_config.json", shape: "antigravity" },
    { provider: "agy", location: "project", file: ".agents/mcp_config.json", shape: "antigravity" },
    { provider: "windsurf", location: "home", file: ".codeium/windsurf/mcp_config.json", shape: "plain" },
    { provider: "warp", location: "home", file: ".warp/mcp.json", shape: "plain" },
  ] as const;

  describe.each([
    { implementation: "TypeScript", inject: injectServers, create: (directory: string) => new McpServerRegistry(directory), claudeRecord: "claude" },
    { implementation: "runtime", inject: injectRuntimeServers as typeof injectServers, create: (directory: string) => new RuntimeMcpServerRegistry(directory) as McpServerRegistry, claudeRecord: "claude-code" },
  ])("$implementation JSON adapters", ({ inject, create, claudeRecord }) => {
  beforeEach(() => { registry = create(tempDir); });

  // Characterization only: alias bookkeeping differs between implementations.
  // Do not interpret these expectations as resolving the canonical-ID contract.
  const recordedProvider = (provider: string) => provider === "agy" ? "antigravity"
    : provider === "claude" ? claudeRecord : provider;

  it.each(jsonAdapters)("accepts an existing empty object server map for $provider", async ({ provider, location, file, shape }) => {
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    const key = shape === "opencode" ? "mcp" : "mcpServers";
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ preferences: { keep: true }, [key]: {} }));
    expect(await inject(registry, provider, { projectDir, servers: ["fortemi"] })).toEqual({
      provider, configPath, serversInjected: ["fortemi"], alreadyPresent: [],
    });
    const entry = {
      ...(shape === "factory" ? { type: "http", disabled: false } : shape === "opencode" ? { type: "remote" } : {}),
      [shape === "antigravity" ? "serverUrl" : "url"]: "https://memory.internal/mcp",
    };
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({ preferences: { keep: true }, [key]: { fortemi: entry } });
  });

  it.each([
    { provider: "claude-code", file: ".claude/settings.local.json", key: "mcpServers" },
    { provider: "opencode", file: "opencode.json", key: "mcp" },
    { provider: "antigravity", file: ".agents/mcp_config.json", key: "mcpServers" },
  ].flatMap(adapter => [
    { label: "array root", value: [] },
    { label: "string root", value: "retain" },
    { label: "null root", value: null },
    { label: "numeric root", value: 42 },
    { label: "boolean root", value: false },
    { label: "array map", value: { preferences: { keep: true }, [adapter.key]: [] } },
    { label: "string map", value: { preferences: { keep: true }, [adapter.key]: "retain" } },
    { label: "null map", value: { preferences: { keep: true }, [adapter.key]: null } },
    { label: "numeric map", value: { preferences: { keep: true }, [adapter.key]: 42 } },
    { label: "boolean map", value: { preferences: { keep: true }, [adapter.key]: false } },
  ].map(sample => ({ ...adapter, ...sample }))))("refuses structurally invalid $label for $provider without writes", async ({ provider, file, value }) => {
    const configPath = join(projectDir, file);
    const original = JSON.stringify(value) + "\n";
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, original);
    const before = await readFile(registry.getPath(), "utf-8");
    filesystemBoundary.mutations = [];
    try {
      await expect.soft(inject(registry, provider, { projectDir })).rejects.toThrow("MCP configuration must contain an object root and an object server map");
      expect.soft(filesystemBoundary.mutations).toEqual([]);
      expect(await readFile(configPath, "utf-8")).toBe(original);
      expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
      expect(await registry.load()).toEqual(JSON.parse(before));
      expect(await create(tempDir).load()).toEqual(JSON.parse(before));
    } finally {
      filesystemBoundary.mutations = [];
    }
  });

  it.each(jsonAdapters)("attempts no writes after a non-missing read failure for $provider", async ({ provider, location, file, shape }) => {
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    await mkdir(dirname(configPath), { recursive: true });
    const original = '{ "preferences": { "keep": true } }\n';
    await writeFile(configPath, original);
    const before = await readFile(registry.getPath(), "utf-8");
    filesystemBoundary.failReadPath = configPath;
    filesystemBoundary.mutations = [];
    try {
      const pending = inject(registry, provider, { projectDir });
      if (shape === "antigravity") await expect.soft(pending).rejects.toThrow("synthetic read refusal");
      else await expect.soft(pending).rejects.toMatchObject({ code: "EACCES" });
      expect(filesystemBoundary.mutations).toEqual([]);
    } finally {
      filesystemBoundary.failReadPath = "";
      filesystemBoundary.mutations = [];
    }
    expect(await readFile(configPath, "utf-8")).toBe(original);
    expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
    expect(await registry.load()).toEqual(JSON.parse(before));
    expect(await create(tempDir).load()).toEqual(JSON.parse(before));
  });

  it.each(jsonAdapters)("refuses malformed JSON without changing bytes or metadata for $provider", async ({ provider, location, file }) => {
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    const original = '{ "preferences": "retain", "mcpServers": ';
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, original);
    const before = await readFile(registry.getPath(), "utf-8");
    await expect.soft(inject(registry, provider, { projectDir })).rejects.toThrow("Refusing to overwrite malformed MCP config");
    expect(await readFile(configPath, "utf-8")).toBe(original);
    expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
    expect(await registry.load()).toEqual(JSON.parse(before));
    expect(await create(tempDir).load()).toEqual(JSON.parse(before));
  });

  it.each(jsonAdapters)("characterizes existing-name conflict handling for $provider", async ({ provider, location, file, shape }) => {
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    const key = shape === "opencode" ? "mcp" : "mcpServers";
    const oldEntry = { command: "existing-command", args: ["--retain"], custom: { enabled: false } };
    const prior = { preferences: { retain: true }, [key]: { fortemi: oldEntry } };
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(prior));
    const result = await inject(registry, provider, { projectDir, servers: ["fortemi"] });
    const keepsExisting = shape === "antigravity";
    const replacement = {
      ...(shape === "factory" ? { type: "http", disabled: false } : shape === "opencode" ? { type: "remote" } : {}),
      url: "https://memory.internal/mcp",
    };
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({
      ...prior, [key]: { fortemi: keepsExisting ? oldEntry : replacement },
    });
    expect(result).toEqual({ provider, configPath, serversInjected: keepsExisting ? [] : ["fortemi"], alreadyPresent: ["fortemi"] });
    const fresh = create(tempDir);
    expect((await fresh.get("fortemi"))?.injectedProviders).toEqual(keepsExisting ? [] : [recordedProvider(provider)]);
    expect((await fresh.get("gitea"))?.injectedProviders).toEqual([]);
  });

  it.each(jsonAdapters)("does not record injection when config path is a directory for $provider", async ({ provider, location, file, shape }) => {
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    await mkdir(configPath, { recursive: true });
    const before = await readFile(registry.getPath(), "utf-8");
    const pending = inject(registry, provider, { projectDir });
    if (shape === "antigravity") await expect(pending).rejects.toThrow(/Refusing to overwrite malformed MCP config.*EISDIR/);
    else await expect(pending).rejects.toMatchObject({ code: "EISDIR" });
    expect(await readdir(configPath)).toEqual([]);
    expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
    expect(await registry.load()).toEqual(JSON.parse(before));
    expect(await create(tempDir).load()).toEqual(JSON.parse(before));
  });

  it.each(jsonAdapters)("preserves unrelated configuration and entries for $provider", async ({ provider, location, file, shape }) => {
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    const key = shape === "opencode" ? "mcp" : "mcpServers";
    const prior = {
      preferences: { nested: { retain: ["one", "two"] }, enabled: false },
      [key]: { unrelated: { command: "existing-command", args: ["--keep", "literal space"], env: { SYNTHETIC: "retain" } } },
    };
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(prior));
    const result = await inject(registry, provider, { projectDir, servers: ["fortemi"] });
    const entry = {
      ...(shape === "factory" ? { type: "http", disabled: false } : shape === "opencode" ? { type: "remote" } : {}),
      [shape === "antigravity" ? "serverUrl" : "url"]: "https://memory.internal/mcp",
    };
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({
      ...prior, [key]: { ...prior[key], fortemi: entry },
    });
    expect(result).toEqual({ provider, configPath, serversInjected: ["fortemi"], alreadyPresent: [] });
    const fresh = create(tempDir);
    expect((await fresh.get("fortemi"))?.injectedProviders).toEqual([recordedProvider(provider)]);
    expect((await fresh.get("gitea"))?.injectedProviders).toEqual([]);
  });

  it.each(jsonAdapters)("writes exact stdio mapping for $provider", async ({ provider, location, file, shape }) => {
    await registry.add({ name: "matrix", type: "stdio", command: "synthetic-command", args: ["--literal", "space value"], env: { SYNTHETIC_SETTING: "keep" } });
    const result = await inject(registry, provider, { projectDir, servers: ["matrix"] });
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    const entry = shape === "opencode"
      ? { type: "local", command: ["synthetic-command", "--literal", "space value"], env: { SYNTHETIC_SETTING: "keep" } }
      : { ...(shape === "factory" ? { type: "stdio", disabled: false } : {}), command: "synthetic-command", args: ["--literal", "space value"], env: { SYNTHETIC_SETTING: "keep" } };
    expect(result).toEqual({ provider, configPath, serversInjected: ["matrix"], alreadyPresent: [] });
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({ [shape === "opencode" ? "mcp" : "mcpServers"]: { matrix: entry } });
    const fresh = create(tempDir);
    expect((await fresh.get("matrix"))?.injectedProviders).toEqual([recordedProvider(provider)]);
    expect((await fresh.get("fortemi"))?.injectedProviders).toEqual([]);
  });

  it.each(jsonAdapters.flatMap(adapter => (["http", "sse"] as const).map(type => ({ ...adapter, type }))))("writes exact $type mapping for $provider", async ({ provider, location, file, shape, type }) => {
    await registry.add({ name: "matrix", type, url: "https://synthetic.example/mcp", headers: { "X-Synthetic": "keep" } });
    const result = await inject(registry, provider, { projectDir, servers: ["matrix"] });
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    const entry = {
      ...(shape === "factory" ? { type, disabled: false } : shape === "opencode" ? { type: "remote" } : {}),
      [shape === "antigravity" ? "serverUrl" : "url"]: "https://synthetic.example/mcp",
      headers: { "X-Synthetic": "keep" },
    };
    expect(result).toEqual({ provider, configPath, serversInjected: ["matrix"], alreadyPresent: [] });
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({ [shape === "opencode" ? "mcp" : "mcpServers"]: { matrix: entry } });
    expect((await create(tempDir).get("matrix"))?.injectedProviders).toEqual([recordedProvider(provider)]);
  });

  it.each(jsonAdapters)("does not invent optional fields for $provider", async ({ provider, location, file, shape }) => {
    await registry.add({ name: "local", type: "stdio", command: "synthetic-command" });
    await registry.add({ name: "remote", type: "http", url: "https://synthetic.example/mcp" });
    const result = await inject(registry, provider, { projectDir, servers: ["local", "remote"] });
    const configPath = join(location === "home" ? join(tempDir, "provider-home") : projectDir, file);
    const local = shape === "opencode" ? { type: "local", command: ["synthetic-command"] }
      : { ...(shape === "factory" ? { type: "stdio", disabled: false } : {}), command: "synthetic-command", args: [] };
    const remote = {
      ...(shape === "factory" ? { type: "http", disabled: false } : shape === "opencode" ? { type: "remote" } : {}),
      [shape === "antigravity" ? "serverUrl" : "url"]: "https://synthetic.example/mcp",
    };
    expect(result).toEqual({ provider, configPath, serversInjected: ["local", "remote"], alreadyPresent: [] });
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({ [shape === "opencode" ? "mcp" : "mcpServers"]: { local, remote } });
  });
  });

  it("should inject into claude-code config", async () => {
    const result = await injectServers(registry, "claude-code", {
      projectDir,
    });

    expect(result.serversInjected).toContain("fortemi");
    expect(result.serversInjected).toContain("gitea");
    expect(result.error).toBeUndefined();

    const written = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(written.mcpServers.fortemi).toBeDefined();
    expect(written.mcpServers.fortemi.url).toBe("https://memory.internal/mcp");
    expect(written.mcpServers.gitea).toBeDefined();
  });

  it("should inject claude alias using ProviderDefinition mcp adapter metadata", async () => {
    const result = await injectServers(registry, "claude", {
      projectDir,
    });

    expect(result.serversInjected).toContain("fortemi");
    const configPath = join(projectDir, ".claude/settings.local.json");
    const written = JSON.parse(await readFile(configPath, "utf-8"));
    expect(written.mcpServers.fortemi.url).toBe("https://memory.internal/mcp");
  });

  it("should inject into cursor config", async () => {
    const result = await injectServers(registry, "cursor", { projectDir });

    expect(result.serversInjected).toHaveLength(2);
    const written = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(written.mcpServers.fortemi).toBeDefined();
  });

  it("should inject only specified servers", async () => {
    const result = await injectServers(registry, "claude-code", {
      servers: ["fortemi"],
      projectDir,
    });

    expect(result.serversInjected).toEqual(["fortemi"]);
    const written = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(written.mcpServers.fortemi).toBeDefined();
    expect(written.mcpServers.gitea).toBeUndefined();
  });

  it("should preserve existing provider config", async () => {
    // Write existing config first
    const configDir = join(projectDir, ".claude");
    const prior = {
      preferences: { theme: "dark", nested: { retain: ["one", "two"] } },
      enabled: false,
      mcpServers: {
        existing: { command: "existing-cmd", args: ["--keep", "literal space"], env: { SYNTHETIC_SETTING: "retain" } },
      },
    };
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "settings.local.json"),
      JSON.stringify(prior),
    );

    const result = await injectServers(registry, "claude-code", { projectDir });

    const written = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(written).toEqual({
      ...prior,
      mcpServers: {
        ...prior.mcpServers,
        fortemi: { url: "https://memory.internal/mcp" },
        gitea: { url: "https://mcp-gitea.internal/mcp" },
      },
    });
    expect(result.serversInjected).toEqual(["fortemi", "gitea"]);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("should support dry run mode", async () => {
    const result = await injectServers(registry, "claude-code", {
      projectDir,
      dryRun: true,
    });

    expect(result.serversInjected).toHaveLength(2);
    // Config file should NOT exist after dry run
    await expect(readFile(result.configPath, "utf-8")).rejects.toThrow();
  });

  describe.each([
    { implementation: "TypeScript", inject: injectServers },
    { implementation: "runtime", inject: injectRuntimeServers as typeof injectServers },
  ])("$implementation dry-run isolation", ({ inject }) => {
  it.each([
    ["claude-code", false], ["claude-code", true],
    ["codex", false], ["codex", true],
  ] as const)("dry run for %s with existing=%s leaves provider and registry unchanged", async (provider, existing) => {
    const configPath = getProviderConfigPath(provider, projectDir);
    const original = provider === "codex"
      ? '# preserve formatting\nmodel = "synthetic-model"\n\n[mcp_servers.fortemi]\nurl = "https://old.example/mcp"\n\n[mcp_servers.unrelated]\ncommand = "keep"\n'
      : '{ "preferences": { "keep": true }, "mcpServers": { "fortemi": { "url": "https://old.example/mcp" } } }\n';
    if (existing) {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, original);
    }
    const registryBefore = await readFile(registry.getPath(), "utf-8");
    const result = await inject(registry, provider, { projectDir, dryRun: true });
    expect(result).toEqual({
      provider, configPath, serversInjected: ["fortemi", "gitea"],
      alreadyPresent: existing ? ["fortemi"] : [],
    });
    if (existing) expect(await readFile(configPath, "utf-8")).toBe(original);
    else {
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(dirname(configPath))).toBe(false);
    }
    expect(await readFile(registry.getPath(), "utf-8")).toBe(registryBefore);
    expect(await registry.load()).toEqual(JSON.parse(registryBefore));
    expect(await new McpServerRegistry(tempDir).load()).toEqual(JSON.parse(registryBefore));
  });
  });

  it("should return error when no servers to inject", async () => {
    const emptyRegistry = new McpServerRegistry(join(tempDir, "empty"));
    const result = await injectServers(emptyRegistry, "claude-code", { projectDir });
    expect(result.error).toMatch(/No servers to inject/);
  });

  it("should handle opencode mcp key format", async () => {
    const result = await injectServers(registry, "opencode", { projectDir });

    const written = JSON.parse(await readFile(result.configPath, "utf-8"));
    // OpenCode uses 'mcp' key, not 'mcpServers'
    expect(written.mcp).toBeDefined();
    expect(written.mcp.fortemi).toBeDefined();
    expect(written.mcp.fortemi.type).toBe("remote");
  });

  it("should handle factory config format", async () => {
    const result = await injectServers(registry, "factory");
    expect(result.configPath).toBe(join(tempDir, "provider-home", ".factory", "mcp.json"));

    const written = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(written.mcpServers.fortemi).toBeDefined();
    expect(written.mcpServers.fortemi.type).toBe("http");
    expect(written.mcpServers.fortemi.disabled).toBe(false);
  });

  it("should handle codex TOML format", async () => {
    const result = await injectServers(registry, "codex");
    expect(result.configPath).toBe(join(tempDir, "provider-home", ".codex", "config.toml"));

    const content = await readFile(result.configPath, "utf-8");
    expect(content).toContain("[mcp_servers.fortemi]");
    expect(content).toContain("[mcp_servers.gitea]");
    expect(content).toContain('url = "https://memory.internal/mcp"');
  });

  describe.each([
    { implementation: "TypeScript", inject: injectServers },
    { implementation: "runtime", inject: injectRuntimeServers as typeof injectServers },
  ])("$implementation native OMP dispatch", ({ inject }) => {
    it.each(["omp", "oh-my-pi"])("writes native config and ownership then reinjects idempotently for %s", async provider => {
      const configPath = join(projectDir, ".omp", "mcp.json");
      const options = { projectDir, scope: "project" as const, servers: ["fortemi"] };
      const first = await inject(registry, provider, options);
      expect(first).toEqual({ provider, configPath, serversInjected: ["fortemi"], alreadyPresent: [], removed: [] });
      const expectedEntry = { type: "http", url: "https://memory.internal/mcp" };
      const written = JSON.parse(await readFile(configPath, "utf-8"));
      expect(written).toEqual({ mcpServers: { fortemi: expectedEntry } });
      const receipt = JSON.parse(await readFile(`${configPath}.aiwg-ownership.json`, "utf-8"));
      expect(receipt).toEqual({ schema: "aiwg.omp-mcp-ownership.v1", servers: {
        fortemi: createHash("sha256").update(JSON.stringify(written.mcpServers.fortemi)).digest("hex"),
      } });
      expect((await readdir(dirname(configPath))).sort()).toEqual(["mcp.json", "mcp.json.aiwg-ownership.json"]);
      expect((await new McpServerRegistry(tempDir).get("fortemi"))?.injectedProviders).toEqual(["omp"]);
      expect((await new McpServerRegistry(tempDir).get("gitea"))?.injectedProviders).toEqual([]);
      expect(await inject(registry, provider, options)).toEqual({ ...first, alreadyPresent: ["fortemi"] });
      expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({ mcpServers: { fortemi: expectedEntry } });
    });

    it.each(["omp", "oh-my-pi"])("does not create native config, receipt, lock or metadata on dry run for %s", async provider => {
      const configPath = join(projectDir, ".omp", "mcp.json");
      const before = await readFile(registry.getPath(), "utf-8");
      expect(await inject(registry, provider, { projectDir, scope: "project", dryRun: true })).toEqual({
        provider, configPath, serversInjected: ["fortemi", "gitea"], alreadyPresent: [], removed: [],
      });
      expect(existsSync(dirname(configPath))).toBe(false);
      expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
      expect(await registry.load()).toEqual(JSON.parse(before));
    });

    it.each(["omp", "oh-my-pi"])("returns an error and preserves an operator-owned conflict for %s", async provider => {
      const configPath = join(projectDir, ".omp", "mcp.json");
      await mkdir(dirname(configPath), { recursive: true });
      const original = '{ "mcpServers": { "fortemi": { "command": "operator-owned" } } }\n';
      await writeFile(configPath, original);
      const before = await readFile(registry.getPath(), "utf-8");
      expect(await inject(registry, provider, { projectDir, scope: "project" })).toEqual({
        provider, configPath, serversInjected: [], alreadyPresent: [],
        error: "OMP MCP server fortemi is operator-owned or modified; preserve it and choose a different name",
      });
      expect(await readFile(configPath, "utf-8")).toBe(original);
      expect(await readdir(dirname(configPath))).toEqual(["mcp.json"]);
      expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
      expect(await registry.load()).toEqual(JSON.parse(before));
    });
  });

  const tomlStrings = [
    { label: "backslashes", value: "C:\\tools\\new", encoded: String.raw`"C:\\tools\\new"` },
    { label: "quotes", value: 'quoted "value"', encoded: String.raw`"quoted \"value\""` },
    { label: "newline", value: "line\nnext", encoded: String.raw`"line\nnext"` },
    { label: "controls", value: "\u0000\b\t\f\r", encoded: String.raw`"\u0000\b\t\f\r"` },
    { label: "DEL", value: "delete\u007fvalue", encoded: String.raw`"delete\u007fvalue"` },
    { label: "Unicode", value: "café 😀", encoded: '"café 😀"' },
  ];
  const tomlImplementations = [
    { implementation: "TypeScript", inject: injectServers },
    { implementation: "runtime", inject: injectRuntimeServers },
  ];
  const tomlSectionCases = [
    { label: "comment", prefix: '# example [mcp_servers.target]\nmodel = "keep"\n', existing: false },
    { label: "multiline string", prefix: 'note = """\n[mcp_servers.target]\nexample text\n"""\n', existing: false },
    { label: "quoted header", prefix: "", header: '[mcp_servers."target"]', existing: true },
    { label: "spaced header", prefix: "", header: '[ mcp_servers . target ]', existing: true },
  ];
  const invalidToml = [
    'secret = "unterminated', 'mcp_servers = 3', 'mcp_servers = []',
    '[[mcp_servers]]\nx = 1', '[[mcp_servers.target]]\nx = 1',
    'mcp_servers.target = 3', 'mcp_servers.other = []',
  ];
  it.each(tomlImplementations.flatMap(implementation => (["codex", "openai"] as const).flatMap(provider => invalidToml.map(input => ({ ...implementation, provider, input })))))("refuses invalid TOML $input without mutation in $implementation $provider", async ({ inject, provider, input }) => {
    const configPath = getProviderConfigPath(provider, projectDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, input);
    await registry.add({ name: "target", type: "stdio", command: "new" });
    const before = await readFile(registry.getPath(), "utf-8");
    filesystemBoundary.mutations.length = 0;
    await expect(inject(registry, provider, { projectDir, servers: ["target"] })).rejects.toThrow(/TOML/);
    expect(filesystemBoundary.mutations).toEqual([]);
    expect(await readFile(configPath, "utf-8")).toBe(input);
    expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
    expect(await new McpServerRegistry(tempDir).load()).toEqual(JSON.parse(before));
  });
  it.each(tomlImplementations.flatMap(implementation => (["codex", "openai"] as const).map(provider => ({ ...implementation, provider }))))("refuses unreadable TOML without mutation in $implementation $provider", async ({ inject, provider }) => {
    const configPath = getProviderConfigPath(provider, projectDir);
    const input = '# preserve\nmodel = "keep"\n';
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, input);
    const before = await readFile(registry.getPath(), "utf-8");
    filesystemBoundary.mutations.length = 0;
    filesystemBoundary.failReadPath = configPath;
    try {
      await expect(inject(registry, provider, { projectDir })).rejects.toMatchObject({ code: "EACCES" });
      expect(filesystemBoundary.mutations).toEqual([]);
    } finally { filesystemBoundary.failReadPath = ""; }
    expect(await readFile(configPath, "utf-8")).toBe(input);
    expect(await readFile(registry.getPath(), "utf-8")).toBe(before);
    expect(await new McpServerRegistry(tempDir).load()).toEqual(JSON.parse(before));
  });
  it.each(tomlImplementations.flatMap(implementation => (["codex", "openai"] as const).flatMap(provider => tomlSectionCases.map(sample => ({ ...implementation, provider, ...sample })))))("recognizes real sections with $label in $implementation $provider TOML", async ({ inject, provider, prefix, header, existing }) => {
    const configPath = getProviderConfigPath(provider, projectDir);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, prefix + (existing ? `${header}\ncommand = "old"\n` : ""));
    await registry.add({ name: "target", type: "stdio", command: "new" });
    const result = await inject(registry, provider, { projectDir, servers: ["target"] });
    expect.soft(result).toEqual({ provider, configPath, serversInjected: ["target"], alreadyPresent: existing ? ["target"] : [] });
    const written = await readFile(configPath, "utf-8");
    expect(written.startsWith(prefix)).toBe(true);
    // Fixed-fixture line count only; the independent parser probe proves table identity.
    const expectedOccurrences = prefix.includes("[mcp_servers.target]") && prefix.startsWith("note") ? 2 : 1;
    expect(written.split("\n").filter(line => /^\[\s*mcp_servers\s*\.\s*(?:target|"target")\s*\]$/.test(line))).toHaveLength(expectedOccurrences);
    expect(written).toContain('command = "new"');
    expect(written).not.toContain('command = "old"');
  });
  const tomlKeys = [
    { name: "alpha.beta", key: '"alpha.beta"' },
    { name: "two words", key: '"two words"' },
    { name: 'quote"name', key: String.raw`"quote\"name"` },
    { name: "slash\\name", key: String.raw`"slash\\name"` },
    { name: "close]name", key: '"close]name"' },
    { name: "café", key: '"café"' },
  ];
  it.each(tomlImplementations.flatMap(implementation => (["codex", "openai"] as const).flatMap(provider => tomlKeys.map(sample => ({ ...implementation, provider, ...sample })))))("creates and updates literal server key $name in $implementation $provider TOML", async ({ inject, provider, name, key }) => {
    const configPath = getProviderConfigPath(provider, projectDir);
    const prefix = '# retain\nmodel = "synthetic"\n';
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, prefix);
    await registry.add({ name, type: "stdio", command: "first", args: ["literal"] });
    for (const command of ["first", "second"]) {
      await registry.update(name, { command });
      expect(await inject(registry, provider, { projectDir, servers: [name] })).toEqual({
        provider, configPath, serversInjected: [name], alreadyPresent: command === "first" ? [] : [name],
      });
      expect(await readFile(configPath, "utf-8")).toBe(prefix +
        `\n[mcp_servers.${key}]\ncommand = "${command}"\nargs = ["literal"]\nstartup_timeout_sec = 10.0\ntool_timeout_sec = 60.0` +
        // Source-range replacement preserves the existing final newline.
        "\n");
    }
  });
  it.each(tomlImplementations.flatMap(implementation => (["codex", "openai"] as const).flatMap(provider => ["$$", "$&", "$`", "$'"].map(value => ({ ...implementation, provider, value })))))("preserves literal replacement token $value in existing $implementation $provider TOML", async ({ inject, provider, value }) => {
    const configPath = getProviderConfigPath(provider, projectDir);
    const prefix = '# retain prefix\nmodel = "synthetic"\n\n';
    const suffix = '\n[mcp_servers.unrelated]\ncommand = "keep"\n';
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, prefix + '[mcp_servers.local]\ncommand = "old"' + suffix);
    await registry.add({ name: "local", type: "stdio", command: value, args: [value] });
    expect(await inject(registry, provider, { projectDir, servers: ["local"] })).toEqual({
      provider, configPath, serversInjected: ["local"], alreadyPresent: ["local"],
    });
    expect(await readFile(configPath, "utf-8")).toBe(prefix +
      `[mcp_servers.local]\ncommand = "${value}"\nargs = ["${value}"]\nstartup_timeout_sec = 10.0\ntool_timeout_sec = 60.0` + suffix);
  });
  it.each(tomlImplementations.flatMap(implementation => (["codex", "openai"] as const).flatMap(provider => tomlStrings.map(sample => ({ ...implementation, provider, ...sample })))))("encodes $label in $implementation $provider TOML values", async ({ inject, provider, value, encoded }) => {
    await registry.add({ name: "local", type: "stdio", command: value, args: [value] });
    await registry.add({ name: "remote", type: "http", url: value });
    const result = await inject(registry, provider, { projectDir, servers: ["local", "remote"] });
    expect(await readFile(result.configPath, "utf-8")).toBe(
      `\n\n[mcp_servers.local]\ncommand = ${encoded}\nargs = [${encoded}]\nstartup_timeout_sec = 10.0\ntool_timeout_sec = 60.0` +
      `\n\n[mcp_servers.remote]\nurl = ${encoded}\nstartup_timeout_sec = 10.0\ntool_timeout_sec = 60.0\n`,
    );
  });

  it.each(tomlImplementations.flatMap(implementation => (["codex", "openai"] as const).flatMap(provider => ["\ud800", "\udfff"].map(value => ({ ...implementation, provider, value })))))("rejects malformed Unicode for $implementation $provider before writing config", async ({ inject, provider, value }) => {
    await registry.add({ name: "malformed", type: "stdio", command: value });
    await expect(inject(registry, provider, { projectDir, servers: ["malformed"] })).rejects.toThrow("TOML values must be strings containing valid Unicode scalar values");
    expect(existsSync(getProviderConfigPath(provider, projectDir))).toBe(false);
    expect((await new McpServerRegistry(tempDir).get("malformed"))?.injectedProviders).toEqual([]);
  });

  it("should record injection in registry", async () => {
    await injectServers(registry, "claude-code", { projectDir });

    const fortemi = await registry.get("fortemi");
    expect(fortemi!.injectedProviders).toContain("claude-code");

    const providers = await registry.getInjectedProviders();
    expect(providers).toContain("claude-code");
  });
});

describe("getProviderConfigPath", () => {
  it("should return correct paths for each provider", () => {
    expect(getProviderConfigPath("claude-code", "/project")).toContain(
      ".claude/settings.local.json",
    );
    expect(getProviderConfigPath("cursor", "/project")).toContain(
      ".cursor/mcp.json",
    );
    expect(getProviderConfigPath("factory")).toContain(".factory/mcp.json");
    expect(getProviderConfigPath("codex")).toContain(".codex/config.toml");
    expect(getProviderConfigPath("windsurf")).toContain(
      "windsurf/mcp_config.json",
    );
    expect(getProviderConfigPath("warp")).toContain(".warp/mcp.json");
  });
});

describe("SUPPORTED_PROVIDERS", () => {
  it("should include all expected providers", () => {
    expect(SUPPORTED_PROVIDERS).toContain("claude-code");
    expect(SUPPORTED_PROVIDERS).toContain("cursor");
    expect(SUPPORTED_PROVIDERS).toContain("factory");
    expect(SUPPORTED_PROVIDERS).toContain("codex");
    expect(SUPPORTED_PROVIDERS).toContain("opencode");
    expect(SUPPORTED_PROVIDERS).toContain("windsurf");
    expect(SUPPORTED_PROVIDERS).toContain("warp");
  });
});
