/**
 * Subcommand Handlers Tests
 *
 * Tests for MCP, catalog, plugin, and other subcommand handlers.
 *
 * @source @src/cli/handlers/subcommands.ts
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @issue #33
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HandlerContext } from "../../../../src/cli/handlers/types.js";
import { researchQueryCommand } from "../../../../src/extensions/commands/definitions.js";
import { PROJECT_LOCAL_SEARCH_PATHS_ENV } from "../../../../src/extensions/project-local-paths.js";

const ARTIFACT_ENV_KEYS = [
  "AIWG_ARTIFACTS_PATH",
  "AIWG_PROJECT_ARTIFACTS_PATH",
  "AIWG_PROJECT_AIWG_DIR",
  PROJECT_LOCAL_SEARCH_PATHS_ENV,
] as const;

let originalEnv: Partial<Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined>> = {};

// Mock script runner
const mockRun = vi.fn().mockResolvedValue({ exitCode: 0 });

vi.mock("../../../../src/cli/handlers/script-runner.js", () => ({
  createScriptRunner: vi.fn(() => ({
    run: mockRun,
  })),
}));

// Mock channel manager
const { mockGetFrameworkRoot } = vi.hoisted(() => ({
  mockGetFrameworkRoot: vi.fn(),
}));
vi.mock("../../../../src/channel/manager.mjs", () => ({
  getFrameworkRoot: mockGetFrameworkRoot,
}));

// Mock MCP CLI module
const mockMcpMain = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../../src/mcp/cli.mjs", () => ({
  main: mockMcpMain,
}));

// Mock catalog CLI module
const mockCatalogMain = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../../src/catalog/cli.mjs", () => ({
  main: mockCatalogMain,
}));

// Mock artifact index CLI module
const mockIndexMain = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../../src/artifacts/cli.js", () => ({
  main: mockIndexMain,
}));

// Mock config CLI module
const mockConfigMain = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../../src/config/cli.js", () => ({
  main: mockConfigMain,
}));

// Mock ops CLI module
const mockOpsMain = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../../src/ops/cli.js", () => ({
  main: mockOpsMain,
}));

// Import handlers after mocks are set up
import {
  mcpHandler,
  catalogHandler,
  listHandler,
  removeHandler,
  newProjectHandler,
  installPluginHandler,
  uninstallPluginHandler,
  pluginStatusHandler,
  packagePluginHandler,
  packageAllPluginsHandler,
  indexHandler,
  discoverHandler,
  showHandler,
  configHandler,
  opsHandler,
  newBundleHandler,
  subcommandHandlers,
} from "../../../../src/cli/handlers/subcommands.js";

describe("Subcommand Handlers", () => {
  let mockContext: HandlerContext;

  beforeEach(() => {
    originalEnv = {};
    for (const key of ARTIFACT_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockRun.mockResolvedValue({ exitCode: 0 });
    mockGetFrameworkRoot.mockResolvedValue("/mock/framework/root");
    mockContext = {
      args: [],
      rawArgs: [],
      cwd: "/mock/cwd",
      frameworkRoot: "/mock/framework/root",
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of ARTIFACT_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("mcpHandler", () => {
    it("should have correct metadata", () => {
      expect(mcpHandler.id).toBe("aiwg-mcp-server");
      expect(mcpHandler.category).toBe("mcp");
      expect(mcpHandler.aliases).toEqual(["mcp", "aiwg-mcp"]);
      expect(mcpHandler.name).toBe("AIWG MCP Server");
      expect(mcpHandler.description).toMatch(/MCP server commands/i);
    });

    it("should handle dynamic import, subcommands, success, and errors", async () => {
      // Test dynamic import and call
      mockContext.args = ["serve", "--transport", "stdio"];
      await mcpHandler.execute(mockContext);
      expect(mockMcpMain).toHaveBeenCalledWith([
        "serve",
        "--transport",
        "stdio",
      ]);

      // Test multiple subcommands
      const subcommands = ["serve", "install", "info"];
      for (const subcmd of subcommands) {
        vi.clearAllMocks();
        mockContext.args = [subcmd];
        await mcpHandler.execute(mockContext);
        expect(mockMcpMain).toHaveBeenCalledWith([subcmd]);
      }

      // Test success
      vi.clearAllMocks();
      mockContext.args = [];
      const successResult = await mcpHandler.execute(mockContext);
      expect(successResult.exitCode).toBe(0);

      // Test error handling
      const testError = new Error("MCP failed");
      mockMcpMain.mockRejectedValueOnce(testError);
      const errorResult = await mcpHandler.execute(mockContext);
      expect(errorResult.exitCode).toBe(1);
      expect(errorResult.error).toBe(testError);
      expect(errorResult.message).toMatch(/MCP command failed/i);
    });
  });

  describe("catalogHandler", () => {
    it("should have correct metadata", () => {
      expect(catalogHandler.id).toBe("catalog");
      expect(catalogHandler.category).toBe("catalog");
      expect(catalogHandler.aliases).toEqual([]);
      expect(catalogHandler.name).toBe("Model Catalog");
      expect(catalogHandler.description).toMatch(/model catalog/i);
    });

    it("should handle dynamic import, subcommands, success, and errors", async () => {
      // Test dynamic import and call
      mockContext.args = ["list", "--provider", "anthropic"];
      await catalogHandler.execute(mockContext);
      expect(mockCatalogMain).toHaveBeenCalledWith([
        "list",
        "--provider",
        "anthropic",
      ]);

      // Test multiple subcommands
      const subcommands = ["list", "info", "search"];
      for (const subcmd of subcommands) {
        vi.clearAllMocks();
        mockContext.args = [subcmd];
        await catalogHandler.execute(mockContext);
        expect(mockCatalogMain).toHaveBeenCalledWith([subcmd]);
      }

      // Test success
      vi.clearAllMocks();
      mockContext.args = [];
      const successResult = await catalogHandler.execute(mockContext);
      expect(successResult.exitCode).toBe(0);

      // Test error handling
      const testError = new Error("Catalog failed");
      mockCatalogMain.mockRejectedValueOnce(testError);
      const errorResult = await catalogHandler.execute(mockContext);
      expect(errorResult.exitCode).toBe(1);
      expect(errorResult.error).toBe(testError);
      expect(errorResult.message).toMatch(/catalog command failed/i);
    });
  });

  describe("listHandler", () => {
    it("should have correct metadata and use registry", async () => {
      expect(listHandler.id).toBe("list");
      expect(listHandler.category).toBe("framework");
      expect(listHandler.aliases).toEqual(["ls"]);
      expect(listHandler.name).toBe("List Frameworks");
      expect(listHandler.description).toMatch(/list.*framework/i);

      // listHandler now uses the extension registry first
      const result = await listHandler.execute(mockContext);
      expect(result.exitCode).toBe(0);
    });

    describe("multi-provider detection (#1530)", () => {
      // These tests cover the regression where `aiwg list` hard-coded
      // .claude/ paths and reported zero extensions in non-Claude workspaces.
      // They run against real filesystem tmp dirs because the handler's
      // provider detection uses sync fs calls on absolute paths.
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");

      let tmpDir: string;
      let restoreRegistry: () => void;

      beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwg-list-1530-"));
        // Reset the singleton registry between scenarios so detection runs
        // fresh against each tmp workspace.
        const { getRegistry } =
          await import("../../../../src/extensions/registry.js");
        const reg = getRegistry();
        const before = reg.size;
        reg.clear?.();
        restoreRegistry = () => {
          // best-effort: re-assertion would require fixture reload; OK to no-op
          void before;
        };
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        restoreRegistry?.();
      });

      it("returns the empty-workspace message when no provider artifact dirs exist", async () => {
        const result = await listHandler.execute({
          ...mockContext,
          cwd: tmpDir,
        });
        expect(result.exitCode).toBe(0);
        expect(result.message).toMatch(
          /No agents, skills, or commands deployed/,
        );
        expect(result.message).toMatch(/aiwg use sdlc/);
      });

      it("errors when --provider names a provider that is not deployed", async () => {
        // Seed only .codex/ so --provider claude returns the not-deployed error
        fs.mkdirSync(path.join(tmpDir, ".codex", "agents"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(tmpDir, ".codex", "agents", "stub.md"),
          "---\nname: stub\ndescription: stub\n---\n",
        );

        const result = await listHandler.execute({
          ...mockContext,
          cwd: tmpDir,
          args: ["--provider", "claude"],
        });
        expect(result.exitCode).toBe(1);
        expect(result.message).toMatch(/'claude' is not deployed/);
      });
    });
  });

  describe("removeHandler", () => {
    it("should have correct metadata and delegate to uninstaller", async () => {
      mockContext.args = ["sdlc"];
      expect(removeHandler.id).toBe("remove");
      expect(removeHandler.category).toBe("framework");
      expect(removeHandler.aliases).toEqual([]);
      expect(removeHandler.name).toBe("Remove Framework");
      expect(removeHandler.description).toMatch(/remove.*framework/i);

      await removeHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/plugin-uninstaller-cli.mjs",
        mockContext.args,
        { cwd: mockContext.cwd },
      );
    });

    it("returns a usage error for --provider without a framework id", async () => {
      const result = await removeHandler.execute({
        ...mockContext,
        args: ["--provider", "claude"],
      });

      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/framework or bundle id required/i);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("rejects --provider before the fallback plugin uninstaller for non-project-local ids", async () => {
      const result = await removeHandler.execute({
        ...mockContext,
        args: ["sdlc", "--provider", "claude"],
      });

      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/--provider is only supported/i);
      expect(result.message).toContain("#1610");
      expect(mockRun).not.toHaveBeenCalled();
    });
  });

  describe("newProjectHandler", () => {
    it("should have correct metadata and delegate to new-project script", async () => {
      expect(newProjectHandler.id).toBe("new");
      expect(newProjectHandler.category).toBe("project");
      expect(newProjectHandler.aliases).toEqual(["-new", "--new"]);
      expect(newProjectHandler.name).toBe("New Project");
      expect(newProjectHandler.description).toMatch(/new project|scaffold/i);

      await newProjectHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/install/new-project.mjs",
        mockContext.args,
        { cwd: mockContext.cwd },
      );
    });
  });

  describe("newBundleHandler", () => {
    it("infers provider bundles from the new-provider alias", async () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwg-new-provider-"));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const result = await newBundleHandler.execute({
          ...mockContext,
          cwd: tmpDir,
          rawArgs: ["new-provider", "custom-provider"],
          args: ["custom-provider"],
        });

        expect(result.exitCode).toBe(0);
        const manifestPath = path.join(tmpDir, ".aiwg", "providers", "custom-provider", "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        expect(manifest.type).toBe("provider");
        expect(manifest.providerConfig).toEqual({ extends: "claude", displayName: "custom-provider" });
        const fortemiManifestPath = path.join(tmpDir, ".aiwg", ".index", "fortemi-core", "project", "manifest.json");
        const fortemiManifest = JSON.parse(fs.readFileSync(fortemiManifestPath, "utf-8"));
        expect(fortemiManifest.backend).toBe("fortemi-core");
        expect(fortemiManifest.graph).toBe("project");
        expect(fortemiManifest.item_count).toBeGreaterThan(0);
      } finally {
        logSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("installPluginHandler", () => {
    it("should have correct metadata and delegate to installer", async () => {
      expect(installPluginHandler.id).toBe("install-plugin");
      expect(installPluginHandler.category).toBe("plugin");
      expect(installPluginHandler.aliases).toEqual([
        "-install-plugin",
        "--install-plugin",
      ]);
      expect(installPluginHandler.name).toBe("Install Plugin");
      expect(installPluginHandler.description).toMatch(/install.*plugin/i);

      await installPluginHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/plugin-installer-cli.mjs",
        mockContext.args,
        { cwd: mockContext.cwd, env: { AIWG_ROOT: "/mock/framework/root" } },
      );
    });
  });

  describe("uninstallPluginHandler", () => {
    it("should have correct metadata and delegate to uninstaller", async () => {
      expect(uninstallPluginHandler.id).toBe("uninstall-plugin");
      expect(uninstallPluginHandler.category).toBe("plugin");
      expect(uninstallPluginHandler.aliases).toEqual([
        "-uninstall-plugin",
        "--uninstall-plugin",
      ]);
      expect(uninstallPluginHandler.name).toBe("Uninstall Plugin");
      expect(uninstallPluginHandler.description).toMatch(/uninstall.*plugin/i);

      await uninstallPluginHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/plugin-uninstaller-cli.mjs",
        mockContext.args,
        { cwd: mockContext.cwd },
      );
    });
  });

  describe("pluginStatusHandler", () => {
    it("should have correct metadata and delegate to status script", async () => {
      expect(pluginStatusHandler.id).toBe("plugin-status");
      expect(pluginStatusHandler.category).toBe("plugin");
      expect(pluginStatusHandler.aliases).toEqual([
        "-plugin-status",
        "--plugin-status",
      ]);
      expect(pluginStatusHandler.name).toBe("Plugin Status");
      expect(pluginStatusHandler.description).toMatch(/plugin.*status/i);

      await pluginStatusHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/plugin-status-cli.mjs",
        mockContext.args,
        { cwd: mockContext.cwd },
      );
    });
  });

  describe("packagePluginHandler", () => {
    it("should have correct metadata", () => {
      expect(packagePluginHandler.id).toBe("package-plugin");
      expect(packagePluginHandler.category).toBe("plugin");
      expect(packagePluginHandler.aliases).toEqual([
        "-package-plugin",
        "--package-plugin",
      ]);
      expect(packagePluginHandler.name).toBe("Package Plugin");
      expect(packagePluginHandler.description).toMatch(/package.*plugin/i);
    });

    it("should delegate to packager with various args", async () => {
      // Single plugin
      mockContext.args = ["my-plugin"];
      await packagePluginHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/package-plugins.mjs",
        ["--plugin", "my-plugin"],
        { cwd: mockContext.cwd },
      );

      // Positional public name with supported flags
      vi.clearAllMocks();
      mockContext.args = ["plugin1", "--provider", "codex", "--dry-run"];
      await packagePluginHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/package-plugins.mjs",
        ["--plugin", "plugin1", "--provider", "codex", "--dry-run"],
        { cwd: mockContext.cwd },
      );
    });

    it("preserves the legacy explicit --plugin compatibility form", async () => {
      mockContext.args = ["--plugin", "sdlc", "--dry-run"];
      await packagePluginHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/package-plugins.mjs",
        ["--plugin", "sdlc", "--dry-run"],
        { cwd: mockContext.cwd },
      );
    });

    it("returns public AIWG help without exposing the internal node script", async () => {
      mockContext.args = ["--help"];
      const result = await packagePluginHandler.execute(mockContext);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain("aiwg package-plugin <name>");
      expect(result.message).not.toContain("node tools/plugin");
      expect(mockRun).not.toHaveBeenCalled();
    });
  });

  describe("packageAllPluginsHandler", () => {
    it("should have correct metadata", () => {
      expect(packageAllPluginsHandler.id).toBe("package-all-plugins");
      expect(packageAllPluginsHandler.category).toBe("plugin");
      expect(packageAllPluginsHandler.aliases).toEqual([
        "-package-all-plugins",
        "--package-all-plugins",
      ]);
      expect(packageAllPluginsHandler.name).toBe("Package All Plugins");
      expect(packageAllPluginsHandler.description).toMatch(
        /package all.*plugins/i,
      );
    });

    it("should delegate to packager with --all flag", async () => {
      // No args - just --all
      await packageAllPluginsHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/package-plugins.mjs",
        ["--all"],
        { cwd: mockContext.cwd },
      );

      // With additional args
      vi.clearAllMocks();
      mockContext.args = ["--provider", "codex", "--dry-run"];
      await packageAllPluginsHandler.execute(mockContext);
      expect(mockRun).toHaveBeenCalledWith(
        "tools/plugin/package-plugins.mjs",
        ["--all", "--provider", "codex", "--dry-run"],
        { cwd: mockContext.cwd },
      );
    });

    it("returns public AIWG help", async () => {
      mockContext.args = ["--help"];
      const result = await packageAllPluginsHandler.execute(mockContext);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain("aiwg package-all-plugins");
      expect(result.message).not.toContain("node tools/plugin");
      expect(mockRun).not.toHaveBeenCalled();
    });
  });

  describe("indexHandler", () => {
    it("propagates a partial sync failure reported by the index CLI (#3185)", async () => {
      const previousExitCode = process.exitCode;
      try {
        mockIndexMain.mockImplementationOnce(async () => { process.exitCode = 1; });
        mockContext.args = ["sync", "--all"];
        expect((await indexHandler.execute(mockContext)).exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
    });

    it("should have correct metadata", () => {
      expect(indexHandler.id).toBe("index");
      expect(indexHandler.category).toBe("index");
      expect(indexHandler.aliases).toEqual([]);
      expect(indexHandler.name).toBe("Artifact Index");
      expect(indexHandler.description).toMatch(/artifact index/i);
    });

    it("should handle dynamic import, subcommands, success, and errors", async () => {
      // Test dynamic import and call
      mockContext.args = ["build", "--force"];
      await indexHandler.execute(mockContext);
      expect(mockIndexMain).toHaveBeenCalledWith(["build", "--force"]);

      // Test multiple subcommands
      const subcommands = ["build", "query", "deps", "stats"];
      for (const subcmd of subcommands) {
        vi.clearAllMocks();
        mockContext.args = [subcmd];
        await indexHandler.execute(mockContext);
        expect(mockIndexMain).toHaveBeenCalledWith([subcmd]);
      }

      // Test success
      vi.clearAllMocks();
      mockContext.args = [];
      const successResult = await indexHandler.execute(mockContext);
      expect(successResult.exitCode).toBe(0);

      // Test error handling
      const testError = new Error("Index failed");
      mockIndexMain.mockRejectedValueOnce(testError);
      const errorResult = await indexHandler.execute(mockContext);
      expect(errorResult.exitCode).toBe(1);
      expect(errorResult.error).toBe(testError);
      expect(errorResult.message).toMatch(/index command failed/i);
    });
  });

  describe("discoverHandler", () => {
    it("forwards top-level discover args, including Fortemi backend selection", async () => {
      mockContext.args = [
        "static retrieval",
        "--backend",
        "fortemi-core",
        "--json",
      ];

      const result = await discoverHandler.execute(mockContext);

      expect(result.exitCode).toBe(0);
      expect(mockIndexMain).toHaveBeenCalledWith([
        "discover",
        "static retrieval",
        "--backend",
        "fortemi-core",
        "--json",
      ]);
    });
  });

  describe("showHandler", () => {
    it("forwards top-level show args, including Fortemi backend selection", async () => {
      mockContext.args = [
        "skill",
        "research-query",
        "--backend",
        "fortemi-core",
        "--json",
      ];

      const result = await showHandler.execute(mockContext);

      expect(result.exitCode).toBe(0);
      expect(mockIndexMain).toHaveBeenCalledWith([
        "show",
        "skill",
        "research-query",
        "--backend",
        "fortemi-core",
        "--json",
      ]);
    });
  });

  describe("configHandler", () => {
    it("should have correct metadata", () => {
      expect(configHandler.id).toBe("config");
      expect(configHandler.category).toBe("config");
      expect(configHandler.aliases).toEqual([]);
      expect(configHandler.name).toBe("Config");
      expect(configHandler.description).toMatch(/config/i);
    });

    it("should handle dynamic import, subcommands, success, and errors", async () => {
      // Test dynamic import and call
      mockContext.args = ["get", "defaults.provider"];
      await configHandler.execute(mockContext);
      expect(mockConfigMain).toHaveBeenCalledWith(["get", "defaults.provider"]);

      // Test multiple subcommands
      const subcommands = ["get", "set", "list", "validate", "reset", "path"];
      for (const subcmd of subcommands) {
        vi.clearAllMocks();
        mockContext.args = [subcmd];
        await configHandler.execute(mockContext);
        expect(mockConfigMain).toHaveBeenCalledWith([subcmd]);
      }

      // Test success
      vi.clearAllMocks();
      mockContext.args = [];
      const successResult = await configHandler.execute(mockContext);
      expect(successResult.exitCode).toBe(0);

      // Test error handling
      const testError = new Error("Config failed");
      mockConfigMain.mockRejectedValueOnce(testError);
      const errorResult = await configHandler.execute(mockContext);
      expect(errorResult.exitCode).toBe(1);
      expect(errorResult.error).toBe(testError);
      expect(errorResult.message).toMatch(/config command failed/i);
    });
  });

  describe("opsHandler", () => {
    it("should have correct metadata", () => {
      expect(opsHandler.id).toBe("ops");
      expect(opsHandler.category).toBe("ops");
      expect(opsHandler.aliases).toEqual([]);
      expect(opsHandler.name).toBe("Ops");
      expect(opsHandler.description).toMatch(/ops/i);
    });

    it("should handle dynamic import, subcommands, success, and errors", async () => {
      // Test dynamic import and call
      mockContext.args = ["init", "--silent"];
      await opsHandler.execute(mockContext);
      expect(mockOpsMain).toHaveBeenCalledWith(["init", "--silent"]);

      // Test multiple subcommands
      const subcommands = ["init", "status", "use", "list", "push"];
      for (const subcmd of subcommands) {
        vi.clearAllMocks();
        mockContext.args = [subcmd];
        await opsHandler.execute(mockContext);
        expect(mockOpsMain).toHaveBeenCalledWith([subcmd]);
      }

      // Test success
      vi.clearAllMocks();
      mockContext.args = [];
      const successResult = await opsHandler.execute(mockContext);
      expect(successResult.exitCode).toBe(0);

      // Test error handling
      const testError = new Error("Ops failed");
      mockOpsMain.mockRejectedValueOnce(testError);
      const errorResult = await opsHandler.execute(mockContext);
      expect(errorResult.exitCode).toBe(1);
      expect(errorResult.error).toBe(testError);
      expect(errorResult.message).toMatch(/ops command failed/i);
    });
  });

  describe("newBundleHandler", () => {
    it("syncs the Fortemi Core project cache before claiming immediate discovery", async () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwg-new-bundle-"));
      const originalXdgDataHome = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = path.join(tmpDir, "xdg-data");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        mockContext = {
          ...mockContext,
          cwd: tmpDir,
          args: ["fortemi-rulepack", "--starter", "rule"],
          rawArgs: ["new-bundle", "fortemi-rulepack", "--starter", "rule"],
        };

        const result = await newBundleHandler.execute(mockContext);

        expect(result.exitCode).toBe(0);
        expect(
          fs.existsSync(
            path.join(
              tmpDir,
              ".aiwg",
              ".index",
              "fortemi-core",
              "project",
              "manifest.json",
            ),
          ),
        ).toBe(true);
        expect(logSpy.mock.calls.flat().join("\n")).toContain(
          'Discoverable now via:  aiwg discover "fortemi-rulepack"',
        );
      } finally {
        logSpy.mockRestore();
        if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgDataHome;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("subcommandHandlers array", () => {
    it("should export all subcommand handlers with correct IDs", () => {
      expect(subcommandHandlers).toHaveLength(33);

      const handlerIds = subcommandHandlers.map((h) => h.id);
      const expectedIds = [
        "aiwg-mcp-server",
        "catalog",
        "list",
        "remove",
        "new",
        "session",
        "feedback",
        "install-plugin",
        "uninstall-plugin",
        "plugin-status",
        "package-plugin",
        "package-all-plugins",
        "index",
        "discover",
        "show",
        "features",
        "skills",
        "config",
        "ops",
        "storage",
        "activity-log",
        "kb",
        "memory",
        "reflections",
        "provenance",
        "research-store",
        "research-query",
        "chunk",
        "fanout",
        "rlm-prep",
        "rlm-search",
        "rlm-status",
        "rlm-cache",
      ];

      for (const expectedId of expectedIds) {
        expect(handlerIds).toContain(expectedId);
      }
    });

    it("all handlers should have required properties", () => {
      for (const handler of subcommandHandlers) {
        expect(handler.id).toBeDefined();
        expect(handler.name).toBeDefined();
        expect(handler.description).toBeDefined();
        expect(handler.category).toBeDefined();
        expect(handler.aliases).toBeDefined();
        expect(Array.isArray(handler.aliases)).toBe(true);
        expect(typeof handler.execute).toBe("function");
      }
    });

    it("handlers should have correct categories", () => {
      // Plugin handlers
      const pluginHandlers = subcommandHandlers.filter((h) =>
        h.id.includes("plugin"),
      );
      for (const handler of pluginHandlers) {
        expect(handler.category).toBe("plugin");
      }

      // Framework handlers
      const frameworkHandlers = subcommandHandlers.filter((h) =>
        ["list", "remove"].includes(h.id),
      );
      for (const handler of frameworkHandlers) {
        expect(handler.category).toBe("framework");
      }

      // Specific handlers
      const specificCategories = [
        { id: "aiwg-mcp-server", category: "mcp" },
        { id: "catalog", category: "catalog" },
        { id: "new", category: "project" },
        { id: "index", category: "index" },
      ];
      for (const { id, category } of specificCategories) {
        const handler = subcommandHandlers.find((h) => h.id === id);
        expect(handler?.category).toBe(category);
      }
    });

    it("documents research-query save support in provider command metadata", () => {
      const metadata = researchQueryCommand.metadata as {
        commandHint?: { argumentHint?: string; allowedTools?: string[] };
      };

      expect(metadata.commandHint?.argumentHint).toContain("--save");
      expect(metadata.commandHint?.allowedTools).toContain("Write");
    });
  });

  describe("handler error handling", () => {
    it("list handler should return success when registry is available", async () => {
      const result = await listHandler.execute(mockContext);
      expect(result.exitCode).toBe(0);
    });

    it("index handler should wrap errors in HandlerResult", async () => {
      const indexError = new Error("Import failed");
      mockIndexMain.mockRejectedValueOnce(indexError);
      const indexResult = await indexHandler.execute(mockContext);
      expect(indexResult.exitCode).toBe(1);
      expect(indexResult.error).toBe(indexError);
      expect(indexResult.message).toBeDefined();
    });

    it("mcp and catalog handlers should wrap errors in HandlerResult", async () => {
      // MCP handler error
      const mcpError = new Error("Import failed");
      mockMcpMain.mockRejectedValueOnce(mcpError);
      const mcpResult = await mcpHandler.execute(mockContext);
      expect(mcpResult.exitCode).toBe(1);
      expect(mcpResult.error).toBe(mcpError);
      expect(mcpResult.message).toBeDefined();

      // Catalog handler error
      const catalogError = new Error("Import failed");
      mockCatalogMain.mockRejectedValueOnce(catalogError);
      const catalogResult = await catalogHandler.execute(mockContext);
      expect(catalogResult.exitCode).toBe(1);
      expect(catalogResult.error).toBe(catalogError);
      expect(catalogResult.message).toBeDefined();
    });
  });
});
