import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  syncFortemiCoreIndex,
  getFortemiCoreExecutableSkillStatus,
  getFortemiCoreSyncStatus,
} from "../../../src/artifacts/fortemi-core-sync.js";
import { buildAiwgFortemiIndexExport } from "../../../src/artifacts/browser-export.js";
import { collectIndexStatus } from "../../../src/artifacts/index-status.js";
import { main } from "../../../src/artifacts/cli.js";
import {
  GRAPH_CONFIGS,
  BUILTIN_GRAPH_CONFIGS,
  getGraphIndexDir,
} from "../../../src/artifacts/types.js";
import type {
  ArtifactIndex,
  DependencyGraph,
  MetadataEntry,
} from "../../../src/artifacts/types.js";

function resetRegistry(): void {
  for (const k of Object.keys(GRAPH_CONFIGS)) {
    if (!(k in BUILTIN_GRAPH_CONFIGS)) delete GRAPH_CONFIGS[k];
  }
}

function entry(overrides: Partial<MetadataEntry> = {}): MetadataEntry {
  return {
    path: "agentic/code/addons/aiwg-utils/skills/aiwg-doctor/SKILL.md",
    type: "skill",
    phase: "operations",
    title: "AIWG Doctor",
    name: "aiwg-doctor",
    tags: ["aiwg"],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    checksum: "abcdef1234567890",
    summary: "Run workspace health diagnostics.",
    dependencies: [],
    dependents: [],
    triggers: ["doctor"],
    capability: "Diagnose the AIWG workspace.",
    ...overrides,
  };
}

function writeProjectIndex(root: string, metadataEntry: MetadataEntry): void {
  const dir = getGraphIndexDir(root, "project");
  fs.mkdirSync(dir, { recursive: true });
  const index: ArtifactIndex = {
    version: "1.0.0",
    builtAt: "2026-01-03T00:00:00.000Z",
    buildTimeMs: 1,
    entries: { [metadataEntry.path]: metadataEntry },
  };
  const graph: DependencyGraph = {
    [metadataEntry.path]: { upstream: [], downstream: [] },
  };
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, "dependencies.json"), JSON.stringify(graph));
}

describe("Fortemi Core static index sync (#1687)", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiwg-fortemi-core-sync-"));
    vi.stubEnv("HOME", path.join(tmp, "home"));
    prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(tmp, "xdg");
    resetRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    resetRegistry();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("serializes records separately and preserves exact JSON bytes and checksums (#3185)", () => {
    writeProjectIndex(tmp, entry());
    const indexPath = path.join(getGraphIndexDir(tmp, "project"), "metadata.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    for (let i = 0; i < 24; i++) {
      const record = entry({ path: `.aiwg/references/${i}.md`, summary: '引用 😀 "\\\n'.repeat(1024) });
      index.entries[record.path] = record;
    }
    fs.writeFileSync(indexPath, JSON.stringify(index));
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      // Simulate V8's aggregate string limit without allocating half a GB.
      if (value?.items || (Array.isArray(value) && value.length > 10)) {
        throw new RangeError("Invalid string length");
      }
      return stringify(value, replacer, space);
    });
    const manifest = syncFortemiCoreIndex(tmp, { generatedAt: "2026-01-05T00:00:00.000Z" });
    spy.mockRestore();
    const bytes = fs.readFileSync(path.join(tmp, manifest.export_path), "utf-8");
    expect(bytes).toBe(stringify(JSON.parse(bytes), null, 2) + "\n");
    expect(manifest.item_count).toBe(25);
    expect(manifest.export_checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(syncFortemiCoreIndex(tmp).status).toBe("unchanged");
  });

  it("serializes an empty export with the existing JSON format", () => {
    writeProjectIndex(tmp, entry());
    const indexPath = path.join(getGraphIndexDir(tmp, "project"), "metadata.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    index.entries = {};
    fs.writeFileSync(indexPath, JSON.stringify(index));
    const manifest = syncFortemiCoreIndex(tmp);
    const bytes = fs.readFileSync(path.join(tmp, manifest.export_path), "utf-8");
    expect(bytes).toBe(JSON.stringify(JSON.parse(bytes), null, 2) + "\n");
    expect(manifest.item_count).toBe(0);
  });

  it("rejects invalid serialization chunk limits before writing an export", () => {
    writeProjectIndex(tmp, entry());
    for (const maxChunkChars of [0, 63, 64.5, Infinity, NaN]) {
      expect(() => syncFortemiCoreIndex(tmp, { maxChunkChars }))
        .toThrow("maxChunkChars must be an integer of at least 64");
    }
    expect(fs.existsSync(path.join(tmp, ".aiwg", ".index", "fortemi-core"))).toBe(false);
  });

  it("preserves the previous export and cleans partial output on write failure", () => {
    writeProjectIndex(tmp, entry());
    const previous = syncFortemiCoreIndex(tmp);
    const exportPath = path.join(tmp, previous.export_path);
    const before = fs.readFileSync(exportPath);
    const write = fs.writeSync;
    let writes = 0;
    vi.spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      if (++writes === 2) throw new Error("disk full");
      return Reflect.apply(write, fs, args);
    }) as typeof fs.writeSync);
    expect(() => syncFortemiCoreIndex(tmp)).toThrow("disk full");
    expect(fs.readFileSync(exportPath)).toEqual(before);
    expect(fs.readdirSync(path.dirname(exportPath)).sort())
      .toEqual(["aiwg-fortemi-index-v2.json", "manifest.json"]);
  });

  for (const json of [false, true]) {
    it(`sync --all reports a failed graph and syncs later graphs (json=${json})`, async () => {
      vi.stubEnv("HOME", path.join(tmp, "home"));
      vi.spyOn(process, "cwd").mockReturnValue(tmp);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      writeProjectIndex(tmp, entry());
      const codebaseDir = getGraphIndexDir(tmp, "codebase");
      fs.mkdirSync(codebaseDir, { recursive: true });
      fs.copyFileSync(path.join(getGraphIndexDir(tmp, "project"), "metadata.json"), path.join(codebaseDir, "metadata.json"));
      const cacheRoot = path.join(tmp, ".aiwg", ".index", "fortemi-core");
      fs.mkdirSync(cacheRoot, { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, "project"), "blocked directory");
      const previousExitCode = process.exitCode;
      try {
        await main(["sync", "--all", ...(json ? ["--json"] : [])]);
        expect(process.exitCode).toBe(1);
        expect(fs.existsSync(path.join(cacheRoot, "codebase", "manifest.json"))).toBe(true);
        if (json) {
          const report = JSON.parse(log.mock.calls.at(-1)![0]);
          expect(report.failures).toEqual([expect.objectContaining({ graph: "project", error: expect.any(String) })]);
          expect(report.manifests.map((item: { graph: string }) => item.graph)).toContain("codebase");
        } else {
          expect(error).toHaveBeenCalledWith(expect.stringContaining("project: failed"));
          expect(log).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
        }
      } finally {
        process.exitCode = previousExitCode;
      }
    });
  }

  it("build --all exits non-zero on project sync failure and still syncs codebase", async () => {
    vi.stubEnv("HOME", path.join(tmp, "home"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.mkdirSync(path.join(tmp, ".aiwg", "references"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".aiwg", "references", "one.md"), "# One\n");
    fs.mkdirSync(path.join(tmp, "src"));
    fs.writeFileSync(path.join(tmp, "src", "one.ts"), "export const one = 1;\n");
    const cacheRoot = path.join(tmp, ".aiwg", ".index", "fortemi-core");
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "project"), "blocked directory");
    const previousExitCode = process.exitCode;
    try {
      await main(["build", "--all"]);
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Fortemi Core project sync failed:"));
      expect(fs.existsSync(path.join(cacheRoot, "codebase", "manifest.json"))).toBe(true);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("materializes a deterministic v2 export and reports unchanged incremental syncs", () => {
    writeProjectIndex(tmp, entry());

    const first = syncFortemiCoreIndex(tmp, {
      repo: "roctinam/aiwg",
      privacy: "sanitized",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });
    const second = syncFortemiCoreIndex(tmp, {
      repo: "roctinam/aiwg",
      privacy: "sanitized",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("unchanged");
    expect(second.export_checksum).toBe(first.export_checksum);
    expect(second.skos_coverage).toEqual({
      records_with_concepts: 1,
      total_records: 1,
      ratio: 1,
    });
    const exported = JSON.parse(
      fs.readFileSync(path.join(tmp, second.export_path), "utf-8"),
    );
    expect(exported.schema_version).toBe("aiwg.fortemi.index.export.v2");
    expect(exported.items[0].type).toBe("aiwg.skill");
    expect(exported.items[0].skos_concepts.length).toBeGreaterThan(0);
  });

  it("chunks a synthetic large graph below an injected serialization ceiling (#3185)", () => {
    const limit = 8192;
    const source = ".aiwg/references/large.md";
    fs.mkdirSync(path.join(tmp, path.dirname(source)), { recursive: true });
    // Include Unicode pairs, lone surrogates, quotes and escaped control characters.
    fs.writeFileSync(path.join(tmp, source), '# Large\n' + 'a🧪"\\\t\n'.repeat(4000));
    const metadataEntry = entry({ path: source, title: "Unicode 🧪", summary: "\ud800\u0000\n" });
    writeProjectIndex(tmp, metadataEntry);
    const indexFile = path.join(getGraphIndexDir(tmp, "project"), "metadata.json");
    const index = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as ArtifactIndex;
    for (let i = 0; i < 40; i++) {
      const file = `.aiwg/references/item-${i}.md`;
      index.entries[file] = entry({ path: file, title: `Item ${i}` });
    }
    fs.writeFileSync(indexFile, JSON.stringify(index));
    const options = { graph: "project", generatedAt: "2026-01-05T00:00:00.000Z", maxChunkChars: 512 };
    const expected = JSON.stringify(buildAiwgFortemiIndexExport(tmp, { ...options, schemaVersion: "v2" }), null, 2) + "\n";
    expect(expected.length).toBeGreaterThan(limit * 10);

    const stringify = JSON.stringify;
    const guard = vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const serialized = stringify(...args);
      if (serialized && serialized.length > limit) throw new RangeError("Invalid string length (injected ceiling)");
      return serialized;
    });
    const writes = vi.spyOn(fs, "writeSync");
    const manifest = syncFortemiCoreIndex(tmp, options);
    const repeated = syncFortemiCoreIndex(tmp, options);
    expect(repeated.status).toBe("unchanged");
    expect(repeated.export_checksum).toBe(manifest.export_checksum);
    guard.mockRestore();
    const actual = fs.readFileSync(path.join(tmp, manifest.export_path), "utf-8");
    expect(actual).toBe(expected);
    expect(manifest.item_count).toBe(41);
    expect(manifest.export_checksum).toBe(createHash("sha256").update(actual).digest("hex"));
    expect(writes.mock.calls.length).toBeGreaterThan(10);
    for (const call of writes.mock.calls) {
      const chunk = call[1];
      if (Buffer.isBuffer(chunk)) expect(chunk.toString("utf-8").length).toBeLessThanOrEqual(options.maxChunkChars);
    }
    expect(getFortemiCoreSyncStatus(tmp)).toMatchObject({ built: true, stale: false });
  });

  it("preserves the previous cache and removes partial output after a write failure (#3185)", () => {
    writeProjectIndex(tmp, entry());
    const first = syncFortemiCoreIndex(tmp);
    const file = path.join(tmp, first.export_path);
    const before = fs.readFileSync(file, "utf-8");
    const manifestPath = path.join(path.dirname(file), "manifest.json");
    const manifestBefore = fs.readFileSync(manifestPath, "utf-8");
    const write = vi.spyOn(fs, "writeSync").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => syncFortemiCoreIndex(tmp)).toThrow("disk full");
    write.mockRestore();
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(manifestBefore);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["aiwg-fortemi-index-v2.json", "manifest.json"]);
  });

  it("detects source executable skills whose prebuilt records lost runtime metadata (#2210)", () => {
    const sourcePath = "agentic/code/addons/test-pack/skills/executable/SKILL.md";
    fs.mkdirSync(path.join(tmp, path.dirname(sourcePath)), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, sourcePath),
      "---\nname: executable\nscript:\n  entrypoint: scripts/run.mjs\n  runtime: node\n---\n# Executable\n",
    );
    const prebuiltDir = path.join(tmp, "prebuilt", "fortemi-core", "framework");
    fs.mkdirSync(prebuiltDir, { recursive: true });
    const record = {
      id: "aiwg:skill:test",
      type: "aiwg.skill",
      name: "executable",
      source: { path: sourcePath },
      search: { frontmatter: {} },
    };
    fs.writeFileSync(
      path.join(prebuiltDir, "aiwg-fortemi-index-v2.json"),
      JSON.stringify({ schema_version: "aiwg.fortemi.index.export.v2", items: [record] }),
    );

    expect(getFortemiCoreExecutableSkillStatus("framework", tmp)).toEqual({
      sourceExecutableCount: 1,
      packagedExecutableCount: 0,
      missing: ["executable"],
    });
    record.search.frontmatter = {
      aiwg_script: { entrypoint: "scripts/run.mjs", runtime: "node" },
    } as typeof record.search.frontmatter;
    fs.writeFileSync(
      path.join(prebuiltDir, "aiwg-fortemi-index-v2.json"),
      JSON.stringify({ schema_version: "aiwg.fortemi.index.export.v2", items: [record] }),
    );
    expect(getFortemiCoreExecutableSkillStatus("framework", tmp).missing).toEqual([]);
  });

  it("reports unchanged for normal re-syncs when only the generated timestamp would differ", () => {
    writeProjectIndex(tmp, entry());

    const first = syncFortemiCoreIndex(tmp, {
      repo: "roctinam/aiwg",
      privacy: "sanitized",
    });
    const second = syncFortemiCoreIndex(tmp, {
      repo: "roctinam/aiwg",
      privacy: "sanitized",
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("unchanged");
    expect(second.generated_at).toBe(first.generated_at);
    expect(second.export_checksum).toBe(first.export_checksum);
  });

  it("updates the cache when indexed records change", () => {
    writeProjectIndex(tmp, entry());
    const first = syncFortemiCoreIndex(tmp, {
      generatedAt: "2026-01-05T00:00:00.000Z",
    });
    writeProjectIndex(
      tmp,
      entry({
        summary: "Run deeper workspace health diagnostics.",
        checksum: "1234567890abcdef",
        updated: "2026-01-06T00:00:00.000Z",
      }),
    );
    const second = syncFortemiCoreIndex(tmp, {
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    expect(second.status).toBe("updated");
    expect(second.export_checksum).not.toBe(first.export_checksum);
  });

  it("keeps status quiet until a project opts in by creating a Fortemi Core cache", () => {
    writeProjectIndex(tmp, entry());
    expect(getFortemiCoreSyncStatus(tmp).optedIn).toBe(false);
    expect(collectIndexStatus(tmp).fortemiCore.optedIn).toBe(false);

    syncFortemiCoreIndex(tmp, { generatedAt: "2026-01-05T00:00:00.000Z" });
    const status = collectIndexStatus(tmp).fortemiCore;

    expect(status.optedIn).toBe(true);
    expect(status.built).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.itemCount).toBe(1);
  });

  it("reports the Fortemi Core cache stale when the export file is missing", () => {
    writeProjectIndex(tmp, entry());
    syncFortemiCoreIndex(tmp, { generatedAt: "2026-01-05T00:00:00.000Z" });

    const statusBefore = getFortemiCoreSyncStatus(tmp);
    fs.rmSync(statusBefore.exportPath);

    const status = collectIndexStatus(tmp).fortemiCore;
    expect(status.optedIn).toBe(true);
    expect(status.built).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.reason).toBe("manifest exists but export file is missing");
  });

  it("reports the Fortemi Core cache stale when the manifest JSON is corrupt", () => {
    const cacheDir = path.join(tmp, ".aiwg", ".index", "fortemi-core", "project");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "manifest.json"), "{ not json");

    const direct = getFortemiCoreSyncStatus(tmp);
    expect(direct.optedIn).toBe(true);
    expect(direct.built).toBe(false);
    expect(direct.stale).toBe(true);
    expect(direct.reason).toContain("manifest file is unreadable");

    const status = collectIndexStatus(tmp).fortemiCore;
    expect(status.optedIn).toBe(true);
    expect(status.built).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.reason).toContain("manifest file is unreadable");
  });

  it("reports the Fortemi Core cache stale when the source graph is rebuilt later", () => {
    writeProjectIndex(tmp, entry());
    syncFortemiCoreIndex(tmp, { generatedAt: "2026-01-05T00:00:00.000Z" });

    writeProjectIndex(
      tmp,
      entry({
        updated: "2026-01-06T00:00:00.000Z",
        checksum: "1234567890abcdef",
      }),
    );
    const indexPath = path.join(
      getGraphIndexDir(tmp, "project"),
      "metadata.json",
    );
    const rebuilt = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    rebuilt.builtAt = "2026-01-06T00:00:00.000Z";
    fs.writeFileSync(indexPath, JSON.stringify(rebuilt));

    const status = collectIndexStatus(tmp).fortemiCore;
    expect(status.optedIn).toBe(true);
    expect(status.built).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.sourceIndexBuiltAt).toBe("2026-01-03T00:00:00.000Z");
    expect(status.reason).toBe(
      "source index is newer than the Fortemi Core static cache",
    );
  });

  it("reports the Fortemi Core cache stale when the export JSON is corrupt", () => {
    writeProjectIndex(tmp, entry());
    syncFortemiCoreIndex(tmp, { generatedAt: "2026-01-05T00:00:00.000Z" });

    const statusBefore = getFortemiCoreSyncStatus(tmp);
    fs.writeFileSync(statusBefore.exportPath, "{ not json");

    const status = collectIndexStatus(tmp).fortemiCore;
    expect(status.optedIn).toBe(true);
    expect(status.built).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.reason).toContain("export file is unreadable");
  });

  it("reports the Fortemi Core cache stale when the export checksum drifts", () => {
    writeProjectIndex(tmp, entry());
    syncFortemiCoreIndex(tmp, { generatedAt: "2026-01-05T00:00:00.000Z" });

    const statusBefore = getFortemiCoreSyncStatus(tmp);
    const exported = JSON.parse(fs.readFileSync(statusBefore.exportPath, "utf-8"));
    exported.items = [];
    fs.writeFileSync(statusBefore.exportPath, JSON.stringify(exported, null, 2) + "\n");

    const status = collectIndexStatus(tmp).fortemiCore;
    expect(status.optedIn).toBe(true);
    expect(status.built).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.reason).toBe("export checksum does not match manifest");
  });

  it("reports the Fortemi Core cache stale when the export schema drifts", () => {
    writeProjectIndex(tmp, entry());
    syncFortemiCoreIndex(tmp, { generatedAt: "2026-01-05T00:00:00.000Z" });

    const statusBefore = getFortemiCoreSyncStatus(tmp);
    const exported = JSON.parse(fs.readFileSync(statusBefore.exportPath, "utf-8"));
    exported.schema_version = "aiwg.fortemi.index.export.v1";
    const exportText = JSON.stringify(exported, null, 2) + "\n";
    fs.writeFileSync(statusBefore.exportPath, exportText);

    const manifest = JSON.parse(fs.readFileSync(statusBefore.manifestPath, "utf-8"));
    manifest.export_checksum = createHash("sha256").update(exportText).digest("hex");
    fs.writeFileSync(statusBefore.manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const status = collectIndexStatus(tmp).fortemiCore;
    expect(status.optedIn).toBe(true);
    expect(status.built).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.reason).toBe(
      "export schema 'aiwg.fortemi.index.export.v1' does not match manifest 'aiwg.fortemi.index.export.v2'",
    );
  });
});
