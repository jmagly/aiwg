import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  discoverCapability,
  queryIndex,
  showArtifact,
} from "../../../src/artifacts/query-engine.js";
import { buildIndex } from "../../../src/artifacts/index-builder.js";
import { main as indexCliMain } from "../../../src/artifacts/cli.js";
import { showDeps } from "../../../src/artifacts/dep-graph.js";
import { showNeighbors } from "../../../src/artifacts/graph-query.js";
import {
  getFortemiCoreSyncStatus,
  syncFortemiCoreIndex,
} from "../../../src/artifacts/fortemi-core-sync.js";
import * as fortemiSync from "../../../src/artifacts/fortemi-core-sync.js";
import {
  loadFortemiCoreExport,
  loadFortemiCoreMetadataEntries,
} from "../../../src/artifacts/fortemi-core-query-adapter.js";
import type {
  ArtifactIndex,
  DependencyGraph,
  GraphType,
  IndexStats,
  MetadataEntry,
} from "../../../src/artifacts/types.js";
import { getGraphIndexDir } from "../../../src/artifacts/types.js";

function entry(overrides: Partial<MetadataEntry>): MetadataEntry {
  return {
    path: ".aiwg/skills/intake-wizard/SKILL.md",
    type: "skill",
    phase: "requirements",
    title: "Intake Wizard",
    name: "intake-wizard",
    tags: ["intake"],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    checksum: "abcdef1234567890",
    summary: "Collect structured intake forms.",
    dependencies: [],
    dependents: [],
    triggers: ["start intake", "collect intake"],
    capability: "Create and validate project intake forms.",
    ...overrides,
  };
}

function writeProjectGraph(
  root: string,
  entries: MetadataEntry[],
  dependencies?: DependencyGraph,
  graphName = "project",
): void {
  const graphDir = getGraphIndexDir(root, graphName as GraphType);
  fs.mkdirSync(graphDir, { recursive: true });
  const index: ArtifactIndex = {
    version: "1.0.0",
    builtAt: "2026-01-03T00:00:00.000Z",
    buildTimeMs: 1,
    entries: Object.fromEntries(entries.map((item) => [item.path, item])),
  };
  const graph: DependencyGraph =
    dependencies ??
    Object.fromEntries(
      entries.map((item) => [item.path, { upstream: [], downstream: [] }]),
    );
  fs.writeFileSync(path.join(graphDir, "metadata.json"), JSON.stringify(index));
  fs.writeFileSync(
    path.join(graphDir, "dependencies.json"),
    JSON.stringify(graph),
  );
  const stats: IndexStats = {
    version: "1.0.0",
    builtAt: index.builtAt,
    buildTimeMs: index.buildTimeMs,
    totalArtifacts: entries.length,
    byPhase: {},
    byType: {},
    tagDistribution: {},
    graphMetrics: {
      totalEdges: Object.values(graph).reduce(
        (total, edges) =>
          total + edges.upstream.length + edges.downstream.length,
        0,
      ),
      orphanedArtifacts: Object.values(graph).filter(
        (edges) => edges.upstream.length === 0 && edges.downstream.length === 0,
      ).length,
      mostReferenced: null,
    },
  };
  for (const item of entries) {
    stats.byPhase[item.phase] = (stats.byPhase[item.phase] ?? 0) + 1;
    stats.byType[item.type] = (stats.byType[item.type] ?? 0) + 1;
    for (const tag of item.tags) {
      stats.tagDistribution[tag] = (stats.tagDistribution[tag] ?? 0) + 1;
    }
  }
  fs.writeFileSync(path.join(graphDir, "stats.json"), JSON.stringify(stats));
  for (const item of entries) {
    fs.mkdirSync(path.join(root, path.dirname(item.path)), { recursive: true });
    fs.writeFileSync(
      path.join(root, item.path),
      `# ${item.title}\n\n${item.summary}\n`,
    );
  }
}

describe("Fortemi Core discover/show parity adapter (#1688)", () => {
  let tmp: string;
  let originalXdgDataHome: string | undefined;
  let originalAiwgRoot: string | undefined;
  let originalHome: string | undefined;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiwg-fortemi-discover-"));
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    originalAiwgRoot = process.env.AIWG_ROOT;
    originalHome = process.env.HOME;
    process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data");
    process.env.AIWG_ROOT = tmp;
    process.env.HOME = path.join(tmp, "home");
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stdoutSpy.mockRestore();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalAiwgRoot === undefined) delete process.env.AIWG_ROOT;
    else process.env.AIWG_ROOT = originalAiwgRoot;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function readConsoleJson(): any {
    return JSON.parse(consoleSpy.mock.calls.map((call) => call[0]).join(""));
  }

  function readStdoutJson(): any {
    return JSON.parse(stdoutSpy.mock.calls.map((call) => call[0]).join(""));
  }

  function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  it.each(['absent', 'stale', 'corrupt'])(
    'keeps a pre-existing bundle discoverable and showable with a %s project cache (#2155)',
    async (cacheState) => {
      const skillPath = '.aiwg/extensions/fortemi-roadmap/skills/fortemi-roadmap-skill/SKILL.md';
      fs.mkdirSync(path.dirname(path.join(tmp, skillPath)), { recursive: true });
      fs.writeFileSync(path.join(tmp, skillPath), [
        '---', 'name: fortemi-roadmap-skill',
        'description: Advance the project roadmap',
        'triggers:', '  - "advance roadmap"', '---',
        '# Project Roadmap', '', 'Follow the required project roadmap procedure.',
      ].join('\n'));
      // An existing workspace has a local index, without going through new-bundle.
      await buildIndex(tmp, { graph: 'project', quiet: true });
      if (cacheState !== 'absent') {
        syncFortemiCoreIndex(tmp, { graph: 'project' });
        const status = getFortemiCoreSyncStatus(tmp, 'project');
        if (cacheState === 'corrupt') {
          fs.writeFileSync(status.exportPath, '{broken');
        } else {
          const metadataPath = path.join(getGraphIndexDir(tmp, 'project'), 'metadata.json');
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          metadata.builtAt = new Date(Date.now() + 60_000).toISOString();
          fs.writeFileSync(metadataPath, JSON.stringify(metadata));
        }
        expect(getFortemiCoreSyncStatus(tmp, 'project').stale).toBe(true);
      } else {
        expect(getFortemiCoreSyncStatus(tmp, 'project').optedIn).toBe(false);
      }
      // A healthy framework export used to mask the missing project graph.
      writeProjectGraph(tmp, [entry({
        path: 'agentic/code/addons/roadmap/skills/packaged-roadmap/SKILL.md',
        name: 'packaged-roadmap', title: 'Packaged Roadmap',
      })], undefined, 'framework');
      syncFortemiCoreIndex(tmp, { graph: 'framework' });
      consoleSpy.mockClear();
      consoleErrorSpy.mockClear();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
      try {
        await indexCliMain(['discover', 'advance roadmap', '--json']);
        const found = readConsoleJson();
        expect(found.results[0].name).toBe('fortemi-roadmap-skill');
        expect(found.results[0].provenance).toEqual({ graph: 'project', scope: 'project' });
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('using the local project index'));
        for (const name of ['fortemi-roadmap-skill', found.results[0].id]) {
          consoleSpy.mockClear();
          consoleErrorSpy.mockClear();
          await indexCliMain(['show', 'skill', name, '--json']);
          expect(readConsoleJson().content).toContain('Follow the required project roadmap procedure.');
          expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        }
      } finally {
        cwdSpy.mockRestore();
      }
    },
  );

  it.each(['missing', 'empty'])('warns when the project cache is absent and its index is %s', async (state) => {
    fs.mkdirSync(path.join(tmp, '.aiwg/extensions/existing/skills'), { recursive: true });
    if (state === 'empty') writeProjectGraph(tmp, []);
    writeProjectGraph(tmp, [entry({
      path: 'agentic/code/addons/intake/skills/intake-wizard/SKILL.md',
    })], undefined, 'framework');
    syncFortemiCoreIndex(tmp, { graph: 'framework' });
    consoleSpy.mockClear();
    consoleErrorSpy.mockClear();
    await discoverCapability(tmp, { phrase: 'intake', json: true });
    expect(readConsoleJson().results[0].name).toBe('intake-wizard');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('aiwg index build --graph project'));
    consoleSpy.mockClear();
    consoleErrorSpy.mockClear();
    await showArtifact(tmp, { name: 'intake-wizard', json: true, backend: 'fortemi-core' });
    expect(readConsoleJson().content).toContain('Intake Wizard');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes the project Fortemi Core cache after index build", async () => {
    const skillDir = path.join(tmp, ".aiwg", "addons", "schema-registry", "skills", "schema-registry");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: schema-registry",
        "description: Maintain schema registry artifacts",
        "---",
        "# Schema Registry",
        "",
        "Maintain schema registry artifacts for project-local bundles.",
        "",
      ].join("\n"),
    );

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      await indexCliMain(["build", "--graph", "project"]);
    } finally {
      cwdSpy.mockRestore();
    }

    const status = getFortemiCoreSyncStatus(tmp, "project");
    expect(status.built).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.itemCount).toBeGreaterThan(0);
    consoleSpy.mockClear();

    await showArtifact(tmp, {
      typeFilter: ["skill"],
      name: "schema-registry",
      json: true,
      graph: "project",
      backend: "fortemi-core",
    });
    const shown = readConsoleJson();
    expect(shown.path).toContain("schema-registry");
    expect(shown.content).toContain("# Schema Registry");
  });

  it("refreshes the framework Fortemi Core cache after a framework graph build", async () => {
    writeProjectGraph(tmp, [], undefined, "framework");
    syncFortemiCoreIndex(tmp, { graph: "framework" });
    const skillDir = path.join(tmp, "agentic", "code", "frameworks", "kairos", "skills", "kairos-probe");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: kairos-probe",
        "description: Probe a Kairos node",
        "triggers:",
        '  - "kairos conformance probe"',
        "---",
        "# Kairos Probe",
        "",
        "Probe a Kairos node for conformance.",
        "",
      ].join("\n"),
    );

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      await indexCliMain(["build", "--graph", "framework"]);
    } finally {
      cwdSpy.mockRestore();
    }

    const status = getFortemiCoreSyncStatus(tmp, "framework");
    expect(status.built).toBe(true);
    expect(status.stale).toBe(false);
    consoleSpy.mockClear();

    await discoverCapability(tmp, {
      phrase: "kairos conformance probe",
      json: true,
      backend: "fortemi-core",
    });
    expect(readConsoleJson().results[0].name).toBe("kairos-probe");
    consoleSpy.mockClear();

    await showArtifact(tmp, {
      typeFilter: ["skill"],
      name: "kairos-probe",
      json: true,
      backend: "fortemi-core",
    });
    expect(readConsoleJson().content).toContain("# Kairos Probe");
  });

  it("reports a stale shared framework cache even with a healthy project cache", async () => {
    writeProjectGraph(tmp, [entry({
      path: "agentic/code/frameworks/kairos/skills/kairos-probe/SKILL.md",
      name: "kairos-probe",
      title: "Kairos Probe",
    })], undefined, "framework");
    syncFortemiCoreIndex(tmp, { graph: "framework" });

    const metadataPath = path.join(getGraphIndexDir(tmp, "framework"), "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    metadata.builtAt = new Date(Date.now() + 60_000).toISOString();
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));

    const loaded = loadFortemiCoreExport(tmp, "framework");
    expect(loaded.exported).toBeUndefined();
    expect(loaded.reason).toContain("source index is newer");
    expect(loaded.reason).toContain("aiwg index sync --graph framework");
    writeProjectGraph(tmp, [entry({})]);
    syncFortemiCoreIndex(tmp, { graph: "project" });
    consoleSpy.mockClear();
    await discoverCapability(tmp, { phrase: "intake", json: true });
    expect(readConsoleJson().results.length).toBeGreaterThan(0);
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toContain("source index is newer");
    consoleSpy.mockClear();
    consoleErrorSpy.mockClear();
    await showArtifact(tmp, { name: "intake-wizard", json: true, backend: "fortemi-core" });
    expect(readConsoleJson().content).toContain("Intake Wizard");
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toContain("source index is newer");
  });

  it.each([
    { explicitGraph: undefined, resourceSource: 'local' },
    { explicitGraph: 'framework', resourceSource: 'local' },
    { explicitGraph: 'project', resourceSource: 'local' },
    { explicitGraph: undefined, resourceSource: 'auto' },
  ] as const)(
    'discovers current data instead of a stale cache (graph=$explicitGraph, resources=$resourceSource)',
    async ({ explicitGraph, resourceSource }) => {
      const web = await import('../../../src/resources/web-release.js');
      const resolveWeb = vi.spyOn(web, 'resolveWebRelease')
        .mockRejectedValue(new Error('Unexpected web resolution in offline discovery test'));
      const graph = explicitGraph ?? 'framework';
      const old = entry({ name: 'retired-intake', title: 'Retired Intake' });
      writeProjectGraph(tmp, [old], undefined, graph);
      syncFortemiCoreIndex(tmp, { graph });
      const current = entry({
        path: 'agentic/code/frameworks/test/skills/current-intake/SKILL.md',
        name: 'current-intake', title: 'Current Intake',
      });
      writeProjectGraph(tmp, [current], undefined, graph);
      const metadataPath = path.join(getGraphIndexDir(tmp, graph), 'metadata.json');
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      metadata.builtAt = '2026-01-04T00:00:00.000Z';
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      expect(getFortemiCoreSyncStatus(tmp, graph).stale).toBe(true);
      consoleSpy.mockClear();

      await discoverCapability(tmp, { phrase: 'intake', graph: explicitGraph, resourceSource, json: true });
      const result = readConsoleJson();
      expect(result.results.map((item: { name: string }) => item.name)).toEqual(['current-intake']);
      expect(result.results[0].provenance.graph).toBe(graph);
      expect(consoleErrorSpy.mock.calls.flat().join('\n')).toContain(`using the local ${graph} index`);
      expect(resolveWeb).not.toHaveBeenCalled();
    },
  );

  it('uses current framework data when the packaged cache predates the source index', async () => {
    writeProjectGraph(tmp, [entry({ name: 'packaged-intake' })], undefined, 'framework');
    syncFortemiCoreIndex(tmp, { graph: 'framework' });
    const status = getFortemiCoreSyncStatus(tmp, 'framework');
    const exportPath = path.join(tmp, 'packaged-export.json');
    fs.copyFileSync(status.exportPath, exportPath);
    fs.rmSync(status.location, { recursive: true });
    // Model a valid packaged export without mutating the installed package.
    vi.spyOn(fortemiSync, 'getFortemiCorePrebuiltStatus').mockReturnValue({
      ...status, source: 'prebuilt', exportPath,
    });
    writeProjectGraph(tmp, [entry({
      name: 'current-only-intake', title: 'Current Only Intake',
    })], undefined, 'framework');
    const metadataPath = path.join(getGraphIndexDir(tmp, 'framework'), 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.builtAt = '2026-01-04T00:00:00.000Z';
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    expect(getFortemiCoreSyncStatus(tmp, 'framework').optedIn).toBe(false);
    const loaded = loadFortemiCoreExport(tmp, 'framework');
    expect(loaded.exported).toBeUndefined();
    expect(loaded.reason).toContain('source index is newer');
    consoleSpy.mockClear();

    await discoverCapability(tmp, { phrase: 'intake', json: true });
    expect(readConsoleJson().results.map((item: { name: string }) => item.name)).toEqual(['current-only-intake']);
  });

  it("points plain-text Fortemi no-match output to index sync", async () => {
    writeProjectGraph(tmp, [], undefined, "framework");
    syncFortemiCoreIndex(tmp, { graph: "framework" });

    await discoverCapability(tmp, {
      phrase: "missing framework phrase",
      graph: "framework",
      backend: "fortemi-core",
    });

    const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("No discovery matches");
    expect(output).toContain("aiwg index sync --graph framework");
    expect(output).not.toContain("aiwg index build");
  });

  it("returns parity-ranked discover results from the Fortemi Core cache", async () => {
    const entries = [
      entry({}),
      entry({
        path: ".aiwg/skills/deploy-checklist/SKILL.md",
        title: "Deploy Checklist",
        name: "deploy-checklist",
        tags: ["release"],
        summary: "Prepare production release checks.",
        triggers: ["ship release"],
        capability: "Prepare deployment readiness checks.",
      }),
    ];
    writeProjectGraph(tmp, entries);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await discoverCapability(tmp, {
      phrase: "collect intake forms",
      graph: "project",
      json: true,
      limit: 2,
    });
    const local = readConsoleJson();
    consoleSpy.mockClear();

    await discoverCapability(tmp, {
      phrase: "collect intake forms",
      graph: "project",
      json: true,
      limit: 2,
      backend: "fortemi-core",
    });
    const fortemi = readConsoleJson();

    expect(fortemi.query.backend).toBe("fortemi-core");
    expect(fortemi.results.map((result: any) => result.path)).toEqual(
      local.results.map((result: any) => result.path),
    );
    expect(fortemi.results[0].title).toBe("Intake Wizard");
  });

  it("defaults capability discover and show to the framework graph on Fortemi Core", async () => {
    const projectSkill = entry({
      path: ".aiwg/skills/project-intake/SKILL.md",
      title: "Project Intake",
      name: "project-intake",
      summary: "Collect project intake notes.",
      triggers: ["project intake"],
      capability: "Collect project intake notes.",
    });
    const frameworkSkill = entry({
      path: "agentic/code/frameworks/sdlc-complete/skills/doc-sync/SKILL.md",
      title: "Doc Sync",
      name: "doc-sync",
      tags: ["documentation", "sync"],
      summary: "Synchronize code changes into documentation.",
      triggers: ["doc sync code to docs", "sync docs"],
      capability: "Keep documentation aligned with implementation changes.",
    });
    writeProjectGraph(tmp, [projectSkill], undefined, "project");
    writeProjectGraph(tmp, [frameworkSkill], undefined, "framework");
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });
    syncFortemiCoreIndex(tmp, {
      graph: "framework",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await discoverCapability(tmp, {
      phrase: "doc sync code to docs",
      json: true,
      limit: 3,
    });
    const discover = readConsoleJson();
    expect(discover.query.backend).toBe("fortemi-core");
    expect(discover.query.graph).toBe("capability-default");
    expect(discover.results[0].path).toContain(frameworkSkill.path);
    consoleSpy.mockClear();

    await showArtifact(tmp, {
      typeFilter: ["skill"],
      name: "doc-sync",
      json: true,
      backend: "fortemi-core",
    });
    const shown = readConsoleJson();
    expect(shown.path).toContain(frameworkSkill.path);
    expect(shown.content).toContain("# Doc Sync");
  });

  it("CLI discover returns stable ids instead of paths, and show metadata exposes paths on demand", async () => {
    const frameworkSkill = entry({
      path: "agentic/code/frameworks/sdlc-complete/skills/doc-sync/SKILL.md",
      title: "Doc Sync",
      name: "doc-sync",
      tags: ["documentation", "sync"],
      summary: "Synchronize code changes into documentation.",
      triggers: ["doc sync code to docs", "sync docs"],
      capability: "Keep documentation aligned with implementation changes.",
    });
    writeProjectGraph(tmp, [frameworkSkill], undefined, "framework");
    syncFortemiCoreIndex(tmp, {
      graph: "framework",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      await indexCliMain([
        "discover",
        "doc sync code to docs",
        "--json",
        "--limit",
        "1",
      ]);
      const discover = readConsoleJson();
      consoleSpy.mockClear();

      expect(discover.results[0].id).toMatch(/^aiwg:skill:[a-f0-9]{16}$/);
      expect(discover.results[0]).not.toHaveProperty("path");
      expect(discover.results[0].name).toBe("doc-sync");

      await indexCliMain([
        "show",
        "metadata",
        discover.results[0].id,
        "--json",
      ]);
      const metadata = readConsoleJson();
      consoleSpy.mockClear();

      expect(metadata.id).toBe(discover.results[0].id);
      expect(metadata.metadata.id).toBe(discover.results[0].id);
      expect(metadata.metadata.source.path).toBe(frameworkSkill.path);
      expect(metadata.paths.indexed).toBe(frameworkSkill.path);
      expect(metadata.paths.absolute).toContain(frameworkSkill.path);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("CLI discover supports explicit JSON format switches and readable text output", async () => {
    const frameworkSkill = entry({
      path: "agentic/code/frameworks/sdlc-complete/skills/doc-sync/SKILL.md",
      title: "Doc Sync",
      name: "doc-sync",
      tags: ["documentation", "sync"],
      summary: "Synchronize code changes into documentation.",
      triggers: ["doc sync code to docs", "sync docs"],
      capability: "Keep documentation aligned with implementation changes.",
    });
    writeProjectGraph(tmp, [frameworkSkill], undefined, "framework");
    syncFortemiCoreIndex(tmp, {
      graph: "framework",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      await indexCliMain([
        "discover",
        "doc sync code to docs",
        "--format",
        "json",
        "--compact",
        "--limit",
        "1",
      ]);
      const compactJson = consoleSpy.mock.calls.map((call) => call[0]).join("");
      const compact = JSON.parse(compactJson);
      consoleSpy.mockClear();

      expect(compactJson).not.toContain("\n");
      expect(compact.results[0].id).toMatch(/^aiwg:skill:[a-f0-9]{16}$/);
      expect(compact.results[0]).not.toHaveProperty("path");

      await indexCliMain([
        "discover",
        "doc sync code to docs",
        "--limit",
        "1",
      ]);
      const text = consoleSpy.mock.calls.map((call) => call[0]).join("\n");
      consoleSpy.mockClear();

      expect(text).toContain("1. Doc Sync");
      expect(text).toContain("type: skill  score:");
      expect(text).toContain(`id: ${compact.results[0].id}`);
      expect(text).toContain("show: aiwg show skill");
      expect(text).not.toContain(frameworkSkill.path);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("discovers and shows operational behavior, template, flow, and runbook assets from Fortemi Core", async () => {
    const behavior = entry({
      path: ".aiwg/addons/fleet/behaviors/quiet-bot/BEHAVIOR.md",
      type: "behavior",
      title: "Quiet Bot",
      name: "quiet-bot",
      tags: ["chat", "fleet"],
      summary: "Mention-only group chat behavior for budget-sensitive bot fleets.",
      triggers: ["quiet bot", "mention only bot"],
      capability: "Respond only when mentioned in shared bot channels.",
    });
    const template = entry({
      path: ".aiwg/templates/codex/config.toml.aiwg-template",
      type: "template",
      title: "Codex Config Template",
      name: "config.toml",
      tags: ["codex", "template"],
      summary: "Codex config toml provider template for agent runtime setup.",
      triggers: ["codex config toml"],
      capability: "Seed Codex runtime config from a project template.",
    });
    const flow = entry({
      path: ".aiwg/flows/flow-release.playbook.yaml",
      type: "flow",
      title: "Release Flow",
      name: "flow-release",
      tags: ["release"],
      summary: "Run the release gate sequence and publish artifacts.",
      triggers: ["release flow"],
      capability: "Coordinate release verification and publishing.",
    });
    const runbook = entry({
      path: ".aiwg/runbooks/certificate-rotation.md",
      type: "runbook",
      kind: "Runbook",
      sourceType: "template",
      title: "Certificate Rotation Runbook",
      name: "certificate-rotation",
      tags: ["pki", "operations"],
      summary: "Rotate expiring service certificates without interrupting clients.",
      capability: "Rotate and verify service certificates with a tested rollback.",
      searchTerms: ["issue replacement certificate", "verify served serial", "restore prior certificate"],
    });
    writeProjectGraph(tmp, [behavior, template, flow, runbook], undefined, "project");
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await discoverCapability(tmp, {
      phrase: "quiet bot mention only",
      graph: "project",
      json: true,
      limit: 5,
      backend: "fortemi-core",
    });
    const broad = readConsoleJson();
    consoleSpy.mockClear();
    const behaviorHit = broad.results.find((result: any) => result.type === "behavior");
    expect(behaviorHit?.name).toBe("quiet-bot");

    await discoverCapability(tmp, {
      phrase: "codex config toml",
      typeFilter: ["template"],
      graph: "project",
      json: true,
      limit: 5,
      backend: "fortemi-core",
    });
    const focused = readConsoleJson();
    consoleSpy.mockClear();
    expect(focused.results[0].type).toBe("template");
    expect(focused.results[0].name).toBe("config.toml");

    await discoverCapability(tmp, {
      phrase: "restore prior certificate",
      typeFilter: ["runbook"],
      graph: "project",
      json: true,
      limit: 5,
      backend: "fortemi-core",
    });
    const runbookFocused = readConsoleJson();
    consoleSpy.mockClear();
    expect(runbookFocused.results[0].type).toBe("runbook");
    expect(runbookFocused.results[0].name).toBe("certificate-rotation");
    const roundTrippedRunbook = loadFortemiCoreMetadataEntries(tmp, "project").entries
      .find((item) => item.type === "runbook");
    expect(roundTrippedRunbook).toMatchObject({
      kind: "Runbook",
      sourceType: "template",
      searchTerms: expect.arrayContaining(["restore prior certificate"]),
    });

    await discoverCapability(tmp, {
      phrase: "restore prior certificate",
      graph: "project",
      json: true,
      limit: 5,
      backend: "fortemi-core",
    });
    const broadRunbook = readConsoleJson();
    consoleSpy.mockClear();
    expect(broadRunbook.results.some((result: any) => result.type === "runbook")).toBe(true);

    await discoverCapability(tmp, {
      phrase: "quiet bot",
      graph: "project",
      limit: 1,
      backend: "fortemi-core",
      includePaths: false,
    });
    const text = consoleSpy.mock.calls.map((call) => call[0]).join("\n");
    consoleSpy.mockClear();
    expect(text).toContain("show: aiwg show behavior");

    for (const [type, name, expected] of [
      ["behavior", "quiet-bot", "Mention-only group chat behavior"],
      ["template", "config.toml", "Codex config toml provider template"],
      ["flow", "flow-release", "Run the release gate sequence"],
      ["runbook", "certificate-rotation", "Rotate expiring service certificates"],
    ] as const) {
      await showArtifact(tmp, {
        typeFilter: [type],
        name,
        json: true,
        graph: "project",
        backend: "fortemi-core",
      });
      const shown = readConsoleJson();
      consoleSpy.mockClear();
      expect(shown.type).toBe(type);
      expect(shown.content).toContain(expected);
    }
  });

  it("deduplicates plugin mirror copies from discover results before limiting", async () => {
    const sourceSkill = entry({
      path: "agentic/code/frameworks/sdlc-complete/skills/artifact-lookup/SKILL.md",
      title: "artifact-lookup",
      name: "artifact-lookup",
      tags: ["artifact", "test"],
      summary: "Search and navigate SDLC artifacts by topic, type, phase, or tag using the aiwg index CLI.",
      triggers: ["find my test plan", "where is artifact"],
      capability: "Search and navigate SDLC artifacts by topic, type, phase, or tag using the aiwg index CLI.",
    });
    const pluginMirror = entry({
      ...sourceSkill,
      path: "agentic/code/plugins/sdlc/skills/artifact-lookup/SKILL.md",
    });
    const codexMirror = entry({
      ...sourceSkill,
      path: "agentic/code/plugins/codex-sdlc/skills/artifact-lookup/SKILL.md",
    });
    const otherSkill = entry({
      path: "agentic/code/frameworks/sdlc-complete/skills/test-plan/SKILL.md",
      title: "Test Plan",
      name: "test-plan",
      tags: ["test"],
      summary: "Create test plans for SDLC work.",
      triggers: ["test plan"],
      capability: "Create test plans for SDLC work.",
    });
    writeProjectGraph(tmp, [sourceSkill, pluginMirror, codexMirror, otherSkill], undefined, "framework");
    syncFortemiCoreIndex(tmp, {
      graph: "framework",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await discoverCapability(tmp, {
      phrase: "test",
      json: true,
      limit: 5,
      backend: "fortemi-core",
    });
    const discovered = readConsoleJson();
    consoleSpy.mockClear();

    const artifactLookup = discovered.results.filter((result: any) => result.name === "artifact-lookup");
    expect(artifactLookup).toHaveLength(1);
    expect(artifactLookup[0].path).toContain(sourceSkill.path);
    expect(discovered.results.map((result: any) => result.name)).toContain("test-plan");
  });

  it("keeps path lookup as a secondary show parameter after id lookup", async () => {
    const frameworkSkill = entry({
      path: "agentic/code/frameworks/sdlc-complete/skills/doc-sync/SKILL.md",
      title: "Doc Sync",
      name: "doc-sync",
      tags: ["documentation", "sync"],
      summary: "Synchronize code changes into documentation.",
      triggers: ["doc sync code to docs", "sync docs"],
      capability: "Keep documentation aligned with implementation changes.",
    });
    writeProjectGraph(tmp, [frameworkSkill], undefined, "framework");
    syncFortemiCoreIndex(tmp, {
      graph: "framework",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await showArtifact(tmp, {
      typeFilter: ["skill"],
      name: frameworkSkill.path,
      json: true,
      backend: "fortemi-core",
    });
    const shown = readConsoleJson();
    consoleSpy.mockClear();

    expect(shown.path).toContain(frameworkSkill.path);
    expect(shown.content).toContain("# Doc Sync");
  });

  it("includes project-local custom skills in default Fortemi Core capability discovery", async () => {
    const customSkill = entry({
      path: ".aiwg/skills/custom-review/SKILL.md",
      title: "Custom Review",
      name: "custom-review",
      tags: ["custom", "review"],
      summary: "Run the team's custom review workflow.",
      triggers: ["custom review workflow", "team review"],
      capability: "Run project-local custom review workflow.",
    });
    const frameworkSkill = entry({
      path: "agentic/code/frameworks/sdlc-complete/skills/doc-sync/SKILL.md",
      title: "Doc Sync",
      name: "doc-sync",
      tags: ["documentation", "sync"],
      summary: "Synchronize code changes into documentation.",
      triggers: ["doc sync"],
      capability: "Keep documentation aligned with implementation changes.",
    });
    writeProjectGraph(tmp, [customSkill], undefined, "project");
    writeProjectGraph(tmp, [frameworkSkill], undefined, "framework");
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });
    syncFortemiCoreIndex(tmp, {
      graph: "framework",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await discoverCapability(tmp, {
      phrase: "custom review workflow",
      json: true,
      limit: 3,
    });
    const discover = readConsoleJson();
    expect(discover.query.backend).toBe("fortemi-core");
    expect(discover.query.graph).toBe("capability-default");
    expect(discover.results[0].path).toContain(customSkill.path);
    consoleSpy.mockClear();

    await showArtifact(tmp, {
      typeFilter: ["skill"],
      name: "custom-review",
      json: true,
      backend: "fortemi-core",
    });
    const shown = readConsoleJson();
    expect(shown.path).toContain(customSkill.path);
    expect(shown.content).toContain("# Custom Review");
  });

  it("includes user-global custom skills in default Fortemi Core capability discovery and show", async () => {
    const userSkillDir = path.join(process.env.HOME!, ".aiwg", "skills", "user-custom-review");
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSkillDir, "SKILL.md"),
      [
        "---",
        "name: user-custom-review",
        "description: Run the user's global custom review workflow.",
        "triggers:",
        "  - user custom review",
        "---",
        "# User Custom Review",
        "",
        "Review from the user-global skill sidecar.",
        "",
      ].join("\n"),
    );

    await buildIndex(tmp, { graph: "user", force: true });
    const manifest = syncFortemiCoreIndex(tmp, {
      graph: "user",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });
    consoleSpy.mockClear();
    expect(manifest.export_path).toContain("fortemi-core/user");
    expect(getFortemiCoreSyncStatus(tmp, "user").location).toContain(
      path.join("xdg-data", "aiwg", "index", "fortemi-core", "user"),
    );

    await discoverCapability(tmp, {
      phrase: "user custom review",
      json: true,
      limit: 3,
    });
    const discover = readConsoleJson();
    expect(discover.query.graph).toBe("capability-default");
    expect(discover.results[0]).toMatchObject({
      title: "User Custom Review",
      provenance: { graph: "user", scope: "user" },
    });
    expect(discover.results[0].path).toContain("user-custom-review/SKILL.md");
    consoleSpy.mockClear();

    await showArtifact(tmp, {
      typeFilter: ["skill"],
      name: "user-custom-review",
      json: true,
      backend: "fortemi-core",
    });
    const shown = readConsoleJson();
    expect(shown.path).toContain("user-custom-review/SKILL.md");
    expect(shown.provenance).toEqual({ graph: "user", scope: "user" });
    expect(shown.content).toContain("# User Custom Review");
    consoleSpy.mockClear();

    await discoverCapability(tmp, {
      phrase: "user custom review",
      json: true,
      limit: 3,
      backend: "local",
    });
    const local = readConsoleJson();
    expect(local.results[0]).toMatchObject({
      title: "User Custom Review",
      provenance: { graph: "user", scope: "user" },
    });
  });

  it("gives project-local capabilities precedence over user and packaged duplicates", async () => {
    const projectSkill = entry({
      path: ".aiwg/skills/shared-review/SKILL.md",
      title: "Project Shared Review",
      name: "shared-review",
      summary: "Project-specific shared review.",
      triggers: ["shared review"],
      capability: "Run the project shared review.",
    });
    const frameworkSkill = entry({
      path: "agentic/code/frameworks/sdlc-complete/skills/shared-review/SKILL.md",
      title: "Framework Shared Review",
      name: "shared-review",
      summary: "Framework shared review.",
      triggers: ["shared review"],
      capability: "Run the packaged shared review.",
    });
    const userSkillDir = path.join(process.env.HOME!, ".aiwg", "skills", "shared-review");
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSkillDir, "SKILL.md"),
      [
        "---",
        "name: shared-review",
        "description: User shared review.",
        "triggers:",
        "  - shared review",
        "---",
        "# User Shared Review",
        "",
      ].join("\n"),
    );

    writeProjectGraph(tmp, [projectSkill], undefined, "project");
    writeProjectGraph(tmp, [frameworkSkill], undefined, "framework");
    await buildIndex(tmp, { graph: "user", force: true });
    syncFortemiCoreIndex(tmp, { graph: "project", generatedAt: "2026-01-05T00:00:00.000Z" });
    syncFortemiCoreIndex(tmp, { graph: "framework", generatedAt: "2026-01-05T00:00:00.000Z" });
    syncFortemiCoreIndex(tmp, { graph: "user", generatedAt: "2026-01-05T00:00:00.000Z" });
    consoleSpy.mockClear();

    await discoverCapability(tmp, {
      phrase: "shared review",
      json: true,
      limit: 3,
    });
    const discover = readConsoleJson();
    expect(discover.results.map((result: any) => result.provenance.scope)).toEqual(["project"]);
    expect(discover.results[0].title).toBe("Project Shared Review");
    consoleSpy.mockClear();

    await showArtifact(tmp, {
      typeFilter: ["skill"],
      name: "shared-review",
      json: true,
      backend: "fortemi-core",
    });
    const shown = readConsoleJson();
    expect(shown.title).toBe("Project Shared Review");
    expect(shown.provenance).toEqual({ graph: "project", scope: "project" });
  });

  it("lets project config disable user-global capability sidecars by default", async () => {
    const userSkillDir = path.join(process.env.HOME!, ".aiwg", "skills", "blocked-global-review");
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSkillDir, "SKILL.md"),
      [
        "---",
        "name: blocked-global-review",
        "description: User global review blocked by project config.",
        "triggers:",
        "  - blocked global review",
        "---",
        "# Blocked Global Review",
        "",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(tmp, ".aiwg"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".aiwg", "aiwg.config"),
      JSON.stringify({ version: "1", index: { userIndices: { enabled: false } } }),
    );
    const projectSkill = entry({
      path: ".aiwg/skills/local-only/SKILL.md",
      title: "Local Only",
      name: "local-only",
      summary: "Local capability keeps the default search available.",
      triggers: ["local only"],
      capability: "Local-only capability.",
    });
    writeProjectGraph(tmp, [projectSkill], undefined, "project");
    await buildIndex(tmp, { graph: "user", force: true });
    syncFortemiCoreIndex(tmp, { graph: "project", generatedAt: "2026-01-05T00:00:00.000Z" });
    syncFortemiCoreIndex(tmp, { graph: "user", generatedAt: "2026-01-05T00:00:00.000Z" });
    consoleSpy.mockClear();

    await discoverCapability(tmp, {
      phrase: "blocked global review",
      json: true,
      limit: 3,
    });
    const blocked = readConsoleJson();
    expect(blocked.results.some((result: any) => result.provenance.scope === "user")).toBe(false);
    expect(blocked.results.some((result: any) => result.path.includes("blocked-global-review"))).toBe(false);
    consoleSpy.mockClear();

    await discoverCapability(tmp, {
      phrase: "blocked global review",
      graph: "user",
      json: true,
      limit: 3,
    });
    const explicit = readConsoleJson();
    expect(explicit.results[0].provenance).toEqual({ graph: "user", scope: "user" });
  });

  it("fetches exact bodies and preserves ambiguous-name diagnostics", async () => {
    const entries = [
      entry({}),
      entry({
        path: ".aiwg/commands/intake-wizard.md",
        type: "command",
        title: "Intake Wizard Command",
        name: "intake-wizard",
        summary: "Run the intake wizard command.",
      }),
    ];
    writeProjectGraph(tmp, entries);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await showArtifact(tmp, {
      name: ".aiwg/skills/intake-wizard/SKILL.md",
      graph: "project",
      json: true,
      backend: "fortemi-core",
    });
    const fetched = readConsoleJson();
    expect(fetched.content).toContain("# Intake Wizard");
    consoleSpy.mockClear();

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(
        showArtifact(tmp, {
          name: "intake-wizard",
          graph: "project",
          json: true,
          backend: "fortemi-core",
        }),
      ).rejects.toThrow("process.exit");
      const ambiguous = readConsoleJson();
      expect(ambiguous.ambiguous).toBe(true);
      expect(ambiguous.matches.map((match: any) => match.type).sort()).toEqual([
        "command",
        "skill",
      ]);
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("fails explicitly when the Fortemi Core cache is unavailable", async () => {
    // Explicit operator queries must not silently switch to this valid index.
    writeProjectGraph(tmp, [entry({})]);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        discoverCapability(tmp, {
          phrase: "collect intake forms",
          graph: "project",
          json: true,
          backend: "fortemi-core",
        }),
      ).rejects.toThrow("process.exit");
      const parsed = readConsoleJson();
      expect(parsed.hint).toContain("aiwg index sync");
      expect(parsed.hint).toContain(
        "pass '--backend local' to use the legacy local index",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleSpy.mockClear();
      await expect(showArtifact(tmp, {
        name: 'intake-wizard', typeFilter: ['skill'], graph: 'project',
        json: true, backend: 'fortemi-core',
      })).rejects.toThrow('process.exit');
      expect(readConsoleJson().error).toContain('aiwg index sync');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("fails explicitly when the Fortemi Core cache has the wrong schema", async () => {
    writeProjectGraph(tmp, [entry({})]);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });
    const status = getFortemiCoreSyncStatus(tmp);
    const wrongSchemaExport = JSON.stringify({
        schema_version: "aiwg.fortemi.index.export.v1",
        generated_at: "2026-01-05T00:00:00.000Z",
        source: { repo: "test", privacy: "sanitized" },
        items: [],
      });
    fs.writeFileSync(status.exportPath, wrongSchemaExport);
    const manifest = JSON.parse(fs.readFileSync(status.manifestPath, "utf-8"));
    fs.writeFileSync(
      status.manifestPath,
      JSON.stringify(
        {
          ...manifest,
          export_checksum: sha256(wrongSchemaExport),
        },
        null,
        2,
      ) + "\n",
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        discoverCapability(tmp, {
          phrase: "collect intake forms",
          graph: "project",
          json: true,
          backend: "fortemi-core",
        }),
      ).rejects.toThrow("process.exit");
      const parsed = readConsoleJson();
      expect(parsed.hint).toContain(
        "export schema 'aiwg.fortemi.index.export.v1' does not match manifest 'aiwg.fortemi.index.export.v2'",
      );
      expect(parsed.hint).toContain(
        "Re-run 'aiwg index sync'",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("fails explicitly when the Fortemi Core cache export is corrupt", async () => {
    writeProjectGraph(tmp, [entry({})]);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });
    const status = getFortemiCoreSyncStatus(tmp);
    fs.writeFileSync(status.exportPath, "{ not json");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        discoverCapability(tmp, {
          phrase: "collect intake forms",
          graph: "project",
          json: true,
          backend: "fortemi-core",
        }),
      ).rejects.toThrow("process.exit");
      const parsed = readConsoleJson();
      expect(parsed.hint).toContain("export file is unreadable");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("treats a valid empty Fortemi Core cache as an empty index", async () => {
    writeProjectGraph(tmp, []);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await queryIndex(
      tmp,
      {},
      { graph: "project", json: true, backend: "fortemi-core" },
    );
    const metadata = readConsoleJson();
    expect(metadata.query.backend).toBe("fortemi-core");
    expect(metadata.total).toBe(0);
    expect(metadata.results).toEqual([]);
    expect(metadata).not.toHaveProperty("hint");
    consoleSpy.mockClear();

    await queryIndex(
      tmp,
      { text: "retrieval", fulltext: true },
      { graph: "project", json: true, backend: "fortemi-core" },
    );
    const fulltext = readConsoleJson();
    expect(fulltext.query.backend).toBe("fortemi-core");
    expect(fulltext.mode).toBe("fulltext");
    expect(fulltext.total).toBe(0);
    expect(fulltext.results).toEqual([]);
    expect(fulltext).not.toHaveProperty("hint");
    consoleSpy.mockClear();

    await discoverCapability(tmp, {
      phrase: "intake workflow",
      graph: "project",
      json: true,
      backend: "fortemi-core",
    });
    const discover = readConsoleJson();
    expect(discover.query.backend).toBe("fortemi-core");
    expect(discover.total).toBe(0);
    expect(discover.results).toEqual([]);
    expect(discover.hint).toContain(
      "among 0 Fortemi Core static-cache capabilities",
    );
    expect(discover.hint).toContain(
      "aiwg index sync",
    );
    consoleSpy.mockClear();

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(
        showArtifact(tmp, {
          type: "skill",
          name: "intake-wizard",
          graph: "project",
          backend: "fortemi-core",
        }),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy.mock.calls.join("\n")).toContain(
        'Error: no artifact found matching "intake-wizard".',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("preserves index query filters and fulltext behavior on the Fortemi Core backend", async () => {
    const entries = [
      entry({}),
      entry({
        path: ".aiwg/architecture/search-adr.md",
        type: "adr",
        phase: "architecture",
        title: "Search Architecture",
        name: "search-architecture",
        tags: ["search"],
        summary: "Choose browser-only retrieval parity for the search architecture.",
        capability: undefined,
        triggers: undefined,
      }),
    ];
    writeProjectGraph(tmp, entries);
    fs.writeFileSync(
      path.join(tmp, ".aiwg", "architecture", "search-adr.md"),
      "# Search Architecture\n\nThe body mentions browser-only retrieval parity.\n",
    );
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await queryIndex(
      tmp,
      { text: "search architecture", type: "adr", tags: ["search"] },
      { graph: "project", json: true },
    );
    const local = readConsoleJson();
    consoleSpy.mockClear();

    await queryIndex(
      tmp,
      { text: "search architecture", type: "adr", tags: ["search"] },
      { graph: "project", json: true, backend: "fortemi-core" },
    );
    const fortemi = readConsoleJson();
    expect(fortemi.query.backend).toBe("fortemi-core");
    expect(fortemi.results.map((result: any) => result.path)).toEqual(
      local.results.map((result: any) => result.path),
    );

    consoleSpy.mockClear();
    await queryIndex(
      tmp,
      { text: "browser-only retrieval parity", fulltext: true },
      { graph: "project", json: true, backend: "fortemi-core" },
    );
    const fulltext = readConsoleJson();
    expect(fulltext.mode).toBe("fulltext");
    expect(fulltext.results[0].path).toBe(".aiwg/architecture/search-adr.md");
    expect(fulltext.results[0].matched).toContain("browser-only");
  });

  it("discovers, filters, and shows indexed project-local rules on Fortemi Core", async () => {
    const rule = entry({
      path: ".aiwg/extensions/acme-rules/rules/acme-review.md",
      type: "rule",
      phase: "other",
      title: "Acme Review Rule",
      name: "acme-review",
      tags: ["governance", "kernel-routing"],
      summary: "Route kernel rule discovery through metadata filters.",
      triggers: undefined,
      capability: "Apply the Acme review rule during rule discovery.",
    });
    const skill = entry({
      path: ".aiwg/extensions/acme-rules/skills/acme-review/SKILL.md",
      type: "skill",
      title: "Acme Review Skill",
      name: "acme-review",
      tags: ["governance"],
      summary: "Skill with a similar name that must not satisfy rule filters.",
      capability: "Run the Acme review workflow.",
    });
    writeProjectGraph(tmp, [rule, skill]);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await discoverCapability(tmp, {
      phrase: "kernel rule discovery metadata filters",
      typeFilter: ["rule"],
      json: true,
      backend: "fortemi-core",
    });
    const discovered = readConsoleJson();
    expect(discovered.query.backend).toBe("fortemi-core");
    expect(discovered.query.graph).toBe("capability-default");
    expect(discovered.query.types).toEqual(["rule"]);
    expect(discovered.results[0]).toMatchObject({
      path: rule.path,
      type: "rule",
      name: "acme-review",
    });
    expect(discovered.results).not.toContainEqual(
      expect.objectContaining({ path: skill.path }),
    );
    consoleSpy.mockClear();

    await queryIndex(
      tmp,
      { text: "kernel rule discovery", type: "rule", tags: ["kernel-routing"] },
      { graph: "project", json: true, backend: "fortemi-core" },
    );
    const filtered = readConsoleJson();
    expect(filtered.query.backend).toBe("fortemi-core");
    expect(filtered.results.map((result: any) => result.path)).toEqual([
      rule.path,
    ]);
    consoleSpy.mockClear();

    await showArtifact(tmp, {
      typeFilter: ["rule"],
      name: "acme-review",
      json: true,
      backend: "fortemi-core",
    });
    const shown = readConsoleJson();
    expect(shown.path).toBe(path.join(tmp, rule.path));
    expect(shown.type).toBe("rule");
    expect(shown.content).toContain("# Acme Review Rule");
  });

  it("serves Fortemi fulltext from the static cache when source files are unavailable", async () => {
    const architecture = entry({
      path: ".aiwg/architecture/search-adr.md",
      type: "adr",
      phase: "architecture",
      title: "Search Architecture",
      name: "search-architecture",
      tags: ["search", "static-cache"],
      summary: "Static cache summary without the source-only search phrase.",
    });
    const requirement = entry({
      path: ".aiwg/requirements/UC-001.md",
      type: "use-case",
      phase: "requirements",
      title: "Retrieval Requirement",
      name: "retrieval-requirement",
      tags: ["retrieval"],
      summary: "Define retrieval acceptance criteria.",
    });
    writeProjectGraph(tmp, [architecture, requirement]);
    fs.writeFileSync(
      path.join(tmp, architecture.path),
      "# Search Architecture\n\nSource-only static cache phrase: browser-only retrieval parity survives source removal.\n",
    );
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });
    fs.rmSync(path.join(tmp, architecture.path));

    await queryIndex(
      tmp,
      {
        text: "browser-only retrieval parity",
        fulltext: true,
        type: "adr",
        phase: "architecture",
        tags: ["search", "static-cache"],
        path: ".aiwg/architecture/*.md",
      },
      { graph: "project", json: true, backend: "fortemi-core" },
    );

    const fulltext = readConsoleJson();
    expect(fulltext.query.backend).toBe("fortemi-core");
    expect(fulltext.mode).toBe("fulltext");
    expect(fulltext.results).toHaveLength(1);
    expect(fulltext.results[0]).toMatchObject({
      path: architecture.path,
      type: "adr",
      phase: "architecture",
      title: "Search Architecture",
    });
    expect(fulltext.results[0].matched).toEqual(
      expect.arrayContaining(["browser-only", "retrieval"]),
    );
  });

  it("preserves stats, status/list, export, and sync through the public index CLI", async () => {
    const entries = [
      entry({}),
      entry({
        path: ".aiwg/architecture/search-adr.md",
        type: "adr",
        phase: "architecture",
        title: "Search Architecture",
        name: "search-architecture",
        tags: ["search"],
        summary: "Choose the search architecture.",
      }),
    ];
    writeProjectGraph(tmp, entries);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);

    try {
      await indexCliMain(["stats", "--graph", "project", "--json"]);
      const stats = readConsoleJson();
      expect(stats.totalArtifacts).toBe(2);
      expect(stats.byType).toMatchObject({ skill: 1, adr: 1 });
      consoleSpy.mockClear();

      await indexCliMain(["status", "--json"]);
      const statusBeforeSync = readConsoleJson();
      expect(statusBeforeSync.orphanIndexDirs).toEqual([]);
      expect(statusBeforeSync.fortemiCore.optedIn).toBe(false);
      expect(
        statusBeforeSync.graphs.find((graph: any) => graph.name === "project"),
      ).toMatchObject({ built: true, entries: 2 });
      consoleSpy.mockClear();

      await indexCliMain(["list", "--json"]);
      const listAlias = readConsoleJson();
      expect(listAlias.graphs).toEqual(statusBeforeSync.graphs);
      expect(listAlias.fortemiCore).toEqual(statusBeforeSync.fortemiCore);
      consoleSpy.mockClear();

      await indexCliMain([
        "export",
        "--format",
        "fortemi",
        "--graph",
        "project",
        "--schema-version",
        "v2",
      ]);
      const exported = readStdoutJson();
      expect(exported.schema_version).toBe("aiwg.fortemi.index.export.v2");
      expect(new Set(exported.items.map((item: any) => item.type))).toEqual(
        new Set(["aiwg.skill", "aiwg.artifact"]),
      );
      stdoutSpy.mockClear();

      await indexCliMain([
        "sync",
        "--backend",
        "fortemi-core",
        "--graph",
        "project",
        "--generated-at",
        "2026-01-05T00:00:00.000Z",
        "--json",
      ]);
      const manifest = readConsoleJson();
      expect(manifest).toMatchObject({
        backend: "fortemi-core",
        graph: "project",
        item_count: 2,
      });
      consoleSpy.mockClear();

      await indexCliMain(["status", "--json"]);
      const statusAfterSync = readConsoleJson();
      expect(statusAfterSync.fortemiCore).toMatchObject({
        optedIn: true,
        built: true,
        stale: false,
        itemCount: 2,
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("routes semantic CLI queries through the Fortemi Core static cache", async () => {
    const entries = [
      entry({
        path: ".aiwg/research/references/REF-001.md",
        type: "research-ref",
        phase: "research",
        title: "REF-001 Static Retrieval Evaluation",
        name: "REF-001",
        tags: ["retrieval", "grade-high"],
        summary:
          "GRADE: High. Static retrieval parity evidence with chunk matching.",
      }),
      entry({
        path: ".aiwg/architecture/search-adr.md",
        type: "adr",
        phase: "architecture",
        title: "Search Architecture",
        name: "search-architecture",
        tags: ["search"],
        summary: "Choose browser-only retrieval architecture.",
      }),
    ];
    writeProjectGraph(tmp, entries);
    fs.writeFileSync(
      path.join(tmp, ".aiwg", "research", "references", "REF-001.md"),
      "# REF-001 Static Retrieval Evaluation\n\nGRADE: High. Citation chunk supports static retrieval parity.\n",
    );
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      await indexCliMain([
        "query",
        "static retrieval grade citation",
        "--semantic",
        "--backend",
        "fortemi-core",
        "--graph",
        "project",
        "--json",
      ]);
    } finally {
      cwdSpy.mockRestore();
    }

    const semantic = readConsoleJson();
    expect(semantic.query.backend).toBe("fortemi-core");
    expect(semantic.mode).toBe("semantic");
    expect(semantic.results[0]).toMatchObject({
      path: ".aiwg/research/references/REF-001.md",
      type: "research-ref",
      title: "REF-001 Static Retrieval Evaluation",
    });
    expect(semantic.results[0].matched).toContain("chunks");
  });

  it("routes hybrid CLI queries with filters through the Fortemi Core static cache", async () => {
    const entries = [
      entry({
        path: ".aiwg/research/references/REF-001.md",
        type: "research-ref",
        phase: "research",
        title: "REF-001 Static Retrieval Evaluation",
        name: "REF-001",
        tags: ["retrieval", "grade-high"],
        summary:
          "GRADE: High. Static retrieval parity evidence with chunk matching.",
      }),
      entry({
        path: ".aiwg/architecture/search-adr.md",
        type: "adr",
        phase: "architecture",
        title: "Search Architecture",
        name: "search-architecture",
        tags: ["search"],
        summary: "Choose browser-only retrieval architecture.",
      }),
    ];
    writeProjectGraph(tmp, entries);
    fs.writeFileSync(
      path.join(tmp, ".aiwg", "architecture", "search-adr.md"),
      "# Search Architecture\n\nStatic retrieval architecture uses filtered hybrid matching.\n",
    );
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      await indexCliMain([
        "query",
        "static retrieval architecture",
        "--hybrid",
        "--backend",
        "fortemi-core",
        "--graph",
        "project",
        "--type",
        "adr",
        "--tags",
        "search",
        "--path",
        ".aiwg/architecture",
        "--json",
      ]);
    } finally {
      cwdSpy.mockRestore();
    }

    const hybrid = readConsoleJson();
    expect(hybrid.query.backend).toBe("fortemi-core");
    expect(hybrid.mode).toBe("hybrid");
    expect(hybrid.results).toHaveLength(1);
    expect(hybrid.results[0]).toMatchObject({
      path: ".aiwg/architecture/search-adr.md",
      type: "adr",
      title: "Search Architecture",
    });
    expect(hybrid.results[0].matched).toEqual(
      expect.arrayContaining(["path", "type", "tags"]),
    );
  });

  it("rejects a backend flag without a value in the public CLI", async () => {
    writeProjectGraph(tmp, [entry({})]);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain(["query", "intake", "--backend"]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --backend must be local or fortemi-core",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("rejects a graph flag without a value in the public CLI", async () => {
    writeProjectGraph(tmp, [entry({})]);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain(["query", "intake", "--graph"]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --graph requires a graph name",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await expect(
        indexCliMain(["query", "intake", "--graph", "--json"]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --graph requires a graph name",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("parses positional graph operands after Fortemi backend flags in the public CLI", async () => {
    const refA = entry({
      path: ".aiwg/research/references/REF-001.md",
      type: "research-ref",
      title: "REF-001 Agent Retrieval Evaluation",
      name: "REF-001",
      tags: ["grade-high", "retrieval"],
      summary: "GRADE: High. Evaluates retrieval quality for agent systems.",
    });
    const refB = entry({
      path: ".aiwg/research/references/REF-002.md",
      type: "research-ref",
      title: "REF-002 Citation Baseline",
      name: "REF-002",
      tags: ["grade-moderate"],
      summary: "GRADE: Moderate. Establishes a citation baseline.",
    });
    const dependencies: DependencyGraph = {
      [refA.path]: {
        upstream: [{ path: refB.path, type: "cites" }],
        downstream: [],
      },
      [refB.path]: {
        upstream: [],
        downstream: [{ path: refA.path, type: "cites" }],
      },
    };
    writeProjectGraph(tmp, [refA, refB], dependencies);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    try {
      await indexCliMain([
        "deps",
        "--backend",
        "fortemi-core",
        refA.path,
        "--graph",
        "project",
        "--direction",
        "upstream",
        "--edge-type",
        "cites",
        "--json",
      ]);
      const deps = readConsoleJson();
      expect(deps.backend).toBe("fortemi-core");
      expect(deps.artifact).toBe(refA.path);
      expect(deps.upstream).toEqual([refB.path]);
      consoleSpy.mockClear();

      await indexCliMain([
        "neighbors",
        "--backend",
        "fortemi-core",
        "--graph",
        "project",
        "REF-001",
        "--direction",
        "in",
        "--edge-type",
        "cites",
        "--json",
      ]);
      const neighbors = readConsoleJson();
      expect(neighbors.backend).toBe("fortemi-core");
      expect(neighbors.node).toBe(refA.path);
      expect(neighbors.neighbors).toEqual([refB.path]);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("rejects invalid graph traversal direction flags in the public CLI", async () => {
    const refA = entry({
      path: ".aiwg/research/references/REF-001.md",
      type: "research-ref",
      title: "REF-001 Agent Retrieval Evaluation",
      name: "REF-001",
      tags: ["grade-high", "retrieval"],
      summary: "GRADE: High. Evaluates retrieval quality for agent systems.",
    });
    const refB = entry({
      path: ".aiwg/research/references/REF-002.md",
      type: "research-ref",
      title: "REF-002 Citation Baseline",
      name: "REF-002",
      tags: ["grade-moderate"],
      summary: "GRADE: Moderate. Establishes a citation baseline.",
    });
    writeProjectGraph(tmp, [refA, refB]);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain([
          "deps",
          refA.path,
          "--backend",
          "fortemi-core",
          "--direction",
          "sideways",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --direction must be upstream, downstream, or both",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await expect(
        indexCliMain([
          "neighbors",
          "--graph",
          "project",
          "--node",
          "REF-001",
          "--backend",
          "fortemi-core",
          "--direction",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --direction must be in, out, or both",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("rejects missing graph traversal operand values in the public CLI", async () => {
    const refA = entry({
      path: ".aiwg/research/references/REF-001.md",
      type: "research-ref",
      title: "REF-001 Agent Retrieval Evaluation",
      name: "REF-001",
      tags: ["grade-high", "retrieval"],
      summary: "GRADE: High. Evaluates retrieval quality for agent systems.",
    });
    const refB = entry({
      path: ".aiwg/research/references/REF-002.md",
      type: "research-ref",
      title: "REF-002 Citation Baseline",
      name: "REF-002",
      tags: ["grade-moderate"],
      summary: "GRADE: Moderate. Establishes a citation baseline.",
    });
    writeProjectGraph(tmp, [refA, refB]);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain([
          "neighbors",
          "--graph",
          "project",
          "--node",
          "--backend",
          "fortemi-core",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --node is required for neighbors command",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await expect(
        indexCliMain([
          "set",
          "--graph",
          "project",
          "--op",
          "intersection",
          "--node-a",
          "--node-b",
          "REF-002",
          "--backend",
          "fortemi-core",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --node-a and --node-b are required",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("rejects missing graph traversal option values in the public CLI", async () => {
    const refA = entry({
      path: ".aiwg/research/references/REF-001.md",
      type: "research-ref",
      title: "REF-001 Agent Retrieval Evaluation",
      name: "REF-001",
      tags: ["grade-high", "retrieval"],
      summary: "GRADE: High. Evaluates retrieval quality for agent systems.",
    });
    const refB = entry({
      path: ".aiwg/research/references/REF-002.md",
      type: "research-ref",
      title: "REF-002 Citation Baseline",
      name: "REF-002",
      tags: ["grade-moderate"],
      summary: "GRADE: Moderate. Establishes a citation baseline.",
    });
    writeProjectGraph(tmp, [refA, refB]);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain([
          "deps",
          refA.path,
          "--backend",
          "fortemi-core",
          "--depth",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --depth must be a positive integer",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await expect(
        indexCliMain([
          "neighbors",
          "--graph",
          "project",
          "--node",
          "REF-001",
          "--backend",
          "fortemi-core",
          "--edge-type",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --edge-type requires a value",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("rejects missing Fortemi sync option values in the public CLI", async () => {
    writeProjectGraph(tmp, [entry({})]);

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain([
          "sync",
          "--backend",
          "fortemi-core",
          "--repo",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --repo requires a value",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await expect(
        indexCliMain([
          "sync",
          "--backend",
          "fortemi-core",
          "--privacy",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --privacy must be private, sanitized, or public",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("rejects missing Fortemi export option values in the public CLI", async () => {
    writeProjectGraph(tmp, [entry({})]);

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain([
          "export",
          "--format",
          "fortemi",
          "--schema-version",
          "--graph",
          "project",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --schema-version requires a value",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await expect(
        indexCliMain([
          "export",
          "--format",
          "fortemi",
          "--out",
          "--graph",
          "project",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --out requires a file path",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("rejects missing Fortemi query filter values in the public CLI", async () => {
    writeProjectGraph(tmp, [entry({})]);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain([
          "query",
          "intake",
          "--backend",
          "fortemi-core",
          "--hybrid",
          "--type",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --type requires a value",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await expect(
        indexCliMain([
          "query",
          "intake",
          "--backend",
          "fortemi-core",
          "--semantic",
          "--limit",
          "0",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --limit must be a positive integer",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("rejects missing Fortemi discover filter values in the public CLI", async () => {
    writeProjectGraph(tmp, [entry({})]);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try {
      await expect(
        indexCliMain([
          "discover",
          "intake",
          "--backend",
          "fortemi-core",
          "--type",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --type requires a value",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await expect(
        indexCliMain([
          "discover",
          "intake",
          "--backend",
          "fortemi-core",
          "--limit",
          "many",
          "--json",
        ]),
      ).rejects.toThrow("process.exit");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error: --limit must be a positive integer",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("preserves research citation graph traversal on the Fortemi Core backend", async () => {
    const refA = entry({
      path: ".aiwg/research/references/REF-001.md",
      type: "research-ref",
      title: "REF-001 Agent Retrieval Evaluation",
      name: "REF-001",
      tags: ["grade-high", "retrieval"],
      summary: "GRADE: High. Evaluates retrieval quality for agent systems.",
    });
    const refB = entry({
      path: ".aiwg/research/references/REF-002.md",
      type: "research-ref",
      title: "REF-002 Citation Baseline",
      name: "REF-002",
      tags: ["grade-moderate"],
      summary: "GRADE: Moderate. Establishes a citation baseline.",
    });
    const profile = entry({
      path: ".aiwg/research/profiles/PROF-001.md",
      type: "research-profile",
      title: "PROF-001 Retrieval Authors",
      name: "PROF-001",
      tags: ["profile"],
      summary: "Research profile connected to retrieval evaluation sources.",
    });
    const dependencies: DependencyGraph = {
      [refA.path]: {
        upstream: [{ path: refB.path, type: "cites" }],
        downstream: [{ path: profile.path, type: "profiles" }],
      },
      [refB.path]: {
        upstream: [],
        downstream: [{ path: refA.path, type: "cites" }],
      },
      [profile.path]: {
        upstream: [{ path: refA.path, type: "profiles" }],
        downstream: [],
      },
    };
    writeProjectGraph(tmp, [refA, refB, profile], dependencies);
    syncFortemiCoreIndex(tmp, {
      graph: "project",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await queryIndex(
      tmp,
      { text: "retrieval", type: "research-ref", tags: ["grade-high"] },
      { graph: "project", json: true, backend: "fortemi-core" },
    );
    const query = readConsoleJson();
    expect(query.results[0].path).toBe(refA.path);
    expect(query.results[0].summary).toContain("GRADE: High");
    consoleSpy.mockClear();

    await showDeps(tmp, refA.path, {
      graph: "project",
      direction: "upstream",
      edgeType: "cites",
      json: true,
      backend: "fortemi-core",
    });
    const deps = readConsoleJson();
    expect(deps.backend).toBe("fortemi-core");
    expect(deps.upstream).toEqual([refB.path]);
  });

  it("preserves KB and semantic-memory neighbor traversal on the Fortemi Core backend", async () => {
    const kbPage = entry({
      path: ".aiwg/kb/concepts/retrieval.md",
      type: "kb-page",
      title: "Retrieval",
      name: "retrieval",
      tags: ["kb", "concept"],
      summary: "Knowledge-base concept page for retrieval.",
    });
    const memoryEntry = entry({
      path: ".aiwg/memory/entries/retrieval-note.md",
      type: "memory-entry",
      title: "Retrieval Note",
      name: "retrieval-note",
      tags: ["memory"],
      summary: "Semantic-memory entry captured from retrieval work.",
    });
    const dependencies: DependencyGraph = {
      [kbPage.path]: {
        upstream: [{ path: memoryEntry.path, type: "references" }],
        downstream: [],
      },
      [memoryEntry.path]: {
        upstream: [],
        downstream: [{ path: kbPage.path, type: "references" }],
      },
    };
    writeProjectGraph(tmp, [kbPage, memoryEntry], dependencies, "kb");
    syncFortemiCoreIndex(tmp, {
      graph: "kb",
      generatedAt: "2026-01-05T00:00:00.000Z",
    });

    await showNeighbors(tmp, {
      graph: "kb",
      node: "retrieval.md",
      direction: "in",
      edgeType: "references",
      json: true,
      backend: "fortemi-core",
    });
    const neighbors = readConsoleJson();
    expect(neighbors.backend).toBe("fortemi-core");
    expect(neighbors.node).toBe(kbPage.path);
    expect(neighbors.neighbors).toEqual([memoryEntry.path]);
  });
});
