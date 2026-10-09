/**
 * Layered MCP configuration roots (AIWG_CONFIG_LAYERS) and profile `extends`.
 *
 * @source @src/mcp/config-layers.mjs
 * @source @src/mcp/registry.ts
 * @source @src/mcp/profiles.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import { writeProfileConfig } from "../../../src/mcp/adapters/codex-runtime.js";
import { resolveToolFilters } from "../../../src/mcp/tool-filters.mjs";
import { resolveCredentialPolicy } from "../../../src/mcp/credentials.mjs";
import { McpServerRegistry, injectServers } from "../../../src/mcp/registry.js";
import { McpServerRegistry as RuntimeServerRegistry, injectServers as runtimeInjectServers } from "../../../src/mcp/registry.mjs";
import { McpProfileRegistry } from "../../../src/mcp/profiles.js";
import { McpProfileRegistry as RuntimeProfileRegistry } from "../../../src/mcp/profiles.mjs";
import { isCaseInsensitivePath, resolveConfigLayers, resolveProfileExtends } from "../../../src/mcp/config-layers.mjs";

// Emulate the filesystem case probe so the unsafe missing-path case is covered on Linux too.
const caseProbe = vi.hoisted(() => ({ insensitive: false, path: "" }));
vi.mock("fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const path = await actual.mkdtemp(...args);
      caseProbe.path = String(path);
      return path;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      if (caseProbe.insensitive && caseProbe.path &&
        path === join(dirname(caseProbe.path), basename(caseProbe.path).toUpperCase())) {
        return actual.lstat(caseProbe.path);
      }
      return actual.lstat(...args);
    },
  };
});

const cliPath = resolve(__dirname, "../../../src/mcp/cli.mjs");

let root: string;
let org: string;
let identity: string;

function write(dir: string, file: string, data: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2) + "\n");
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf-8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiwg-mcp-layers-"));
  org = join(root, "org");
  identity = join(root, "identity");
  write(org, "mcp-servers.json", {
    apiVersion: "aiwg.io/v1",
    kind: "McpServerRegistry",
    servers: {
      github: { name: "github", type: "http", url: "https://github.example/mcp", headerEnv: { Authorization: "GITHUB_AUTHORIZATION" } },
      tracker: { name: "tracker", type: "http", url: "https://tracker.org.example/mcp" },
    },
  });
  write(org, "mcp-profiles.json", {
    apiVersion: "aiwg.io/v1",
    kind: "McpProfileRegistry",
    profiles: {
      "org-base": {
        name: "org-base",
        servers: ["github"],
        providerOverrides: { "*": { toolDeny: ["github__delete_repo"] }, codex: { toolAllow: ["github__list_repos"] } },
      },
    },
  });
  write(identity, "mcp-servers.json", {
    apiVersion: "aiwg.io/v1",
    kind: "McpServerRegistry",
    servers: { tracker: { name: "tracker", type: "http", url: "https://tracker.acme.example/mcp" } },
  });
  write(identity, "mcp-profiles.json", {
    apiVersion: "aiwg.io/v1",
    kind: "McpProfileRegistry",
    profiles: {
      "acme-dev": {
        name: "acme-dev",
        extends: ["org-base"],
        servers: ["tracker"],
        providerOverrides: { "*": { toolDeny: ["tracker__close_all"] }, codex: { toolAllow: ["github__get_file"] } },
      },
    },
  });
  vi.stubEnv("AIWG_CONFIG_LAYERS", [org, identity].join(delimiter));
});

afterEach(() => {
  caseProbe.insensitive = false;
  caseProbe.path = "";
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveConfigLayers", () => {
  it("splits on the platform delimiter, lowest precedence first", () => {
    expect(resolveConfigLayers(undefined, { AIWG_CONFIG_LAYERS: ["a", " b ", ""].join(delimiter) })).toEqual([resolve("a"), resolve("b")]);
  });

  it("keeps single-directory behaviour when unset or when a directory is passed explicitly", () => {
    expect(resolveConfigLayers(undefined, {})).toBeNull();
    expect(resolveConfigLayers("/explicit", { AIWG_CONFIG_LAYERS: "a" })).toBeNull();
  });
});

describe("filesystem case overlap", () => {
  it("refuses differently cased missing paths on an insensitive filesystem", async () => {
    caseProbe.insensitive = true;
    vi.stubEnv("AIWG_CONFIG_LAYERS", [join(root, "CaseLayer"), join(root, "caselayer", "child")].join(delimiter));
    const registry = new McpServerRegistry();
    await registry.load();
    await expect(registry.save()).rejects.toThrow("overlapping MCP configuration layer targets");
    expect(existsSync(join(root, "caselayer"))).toBe(false);
    expect(existsSync(caseProbe.path)).toBe(false);
  });

  it("probes the nearest existing ancestor without retaining probe files", async () => {
    const insensitive = await isCaseInsensitivePath(join(root, "missing", "child"));
    vi.stubEnv("AIWG_CONFIG_LAYERS", [join(root, "CaseLayer"), join(root, "caselayer", "child")].join(delimiter));
    const registry = new McpServerRegistry();
    await registry.load();
    if (insensitive) {
      await expect(registry.save()).rejects.toThrow("overlapping");
    } else {
      await registry.save();
    }
    await expect((await import("node:fs/promises")).readdir(root).then(entries =>
      entries.filter(name => name.startsWith(".aiwg-case-probe")))).resolves.toEqual([]);
  });
});

describe("resolveProfileExtends", () => {
  it("refuses a cycle and a missing base", () => {
    expect(() => resolveProfileExtends("a", { a: { extends: ["b"], servers: [] }, b: { extends: ["a"], servers: [] } }))
      .toThrow("Profile extends cycle: a -> b -> a");
    expect(() => resolveProfileExtends("a", { a: { extends: ["missing"], servers: [] } }))
      .toThrow('Profile "a" extends "missing", which is not defined in any configuration layer.');
  });
});

describe.each([
  { implementation: "TypeScript", Servers: McpServerRegistry, Profiles: McpProfileRegistry, inject: injectServers },
  {
    implementation: "runtime",
    inject: runtimeInjectServers as typeof injectServers,
    Servers: RuntimeServerRegistry as unknown as typeof McpServerRegistry,
    Profiles: RuntimeProfileRegistry as unknown as typeof McpProfileRegistry,
  },
])("$implementation layered registries", ({ Servers, Profiles, inject }) => {
  it("injects zero servers for an empty profile filter in persistent mode", async () => {
    const profiles = new Profiles();
    await profiles.add({ name: "minimal", servers: [] });
    const result = await inject(new Servers(), "cursor", {
      projectDir: root, servers: (await profiles.resolve("minimal"))!.servers,
    });
    expect(result.serversInjected).toEqual([]);
    expect(existsSync(result.configPath)).toBe(false);
  });

  it.each([undefined, "literal"] as const)("enforces the registry floor for injection option %s", async option => {
    write(org, "mcp-servers.json", { credentialPolicy: "none", servers: {
      token: { name: "token", type: "stdio", command: "token", env: { TOKEN: "secret" } },
    } });
    await expect(inject(new Servers(), "cursor", {
      projectDir: root, servers: ["token"], credentialPolicy: option,
    })).rejects.toThrow("Refusing to render");
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
  });

  it("refuses base removal and names dependents in every layer", async () => {
    write(org, "mcp-profiles.json", { profiles: {
      "org-child": { name: "org-child", servers: [], extends: ["base"] },
    } });
    write(identity, "mcp-profiles.json", { profiles: {
      base: { name: "base", servers: [] },
      "identity-child": { name: "identity-child", servers: [], extends: ["base"] },
    } });
    const profiles = new Profiles();
    const before = read(identity, "mcp-profiles.json");
    await expect(profiles.remove("base")).rejects.toThrow('Cannot remove profile "base": extended by org-child, identity-child.');
    expect(await profiles.resolve("identity-child")).toBeDefined();
    expect(read(identity, "mcp-profiles.json")).toBe(before);
    await expect(new Profiles(identity).remove("base")).rejects.toThrow("identity-child");
  });

  it("preserves explicit policy writes equal to the floor over an ignored overlay", async () => {
    write(org, "mcp-servers.json", { credentialPolicy: "references", servers: {} });
    write(identity, "mcp-servers.json", { credentialPolicy: "literal", servers: {} });
    const servers = new Servers();
    await servers.setCredentialPolicy("references");
    expect(JSON.parse(read(identity, "mcp-servers.json")).credentialPolicy).toBe("references");
    await servers.add({ name: "bare", type: "stdio", command: "bare" });
    expect(JSON.parse(read(identity, "mcp-servers.json")).credentialPolicy).toBe("references");
  });

  it("refuses a relaxed policy passed directly to save", async () => {
    write(org, "mcp-servers.json", { credentialPolicy: "none", servers: {} });
    const servers = new Servers();
    const before = read(identity, "mcp-servers.json");
    await expect(servers.save({ ...(await servers.load()), credentialPolicy: "literal" })).rejects.toThrow("Cannot relax");
    expect(await servers.getCredentialPolicy()).toBe("none");
    expect(read(identity, "mcp-servers.json")).toBe(before);
  });

  it.each([null, "", false, 0, "LITERAL"])("names layer paths for invalid policy %s", async policy => {
    for (const dir of [org, identity]) {
      const before = read(dir, "mcp-servers.json");
      write(dir, "mcp-servers.json", { credentialPolicy: policy, servers: {} });
      const servers = new Servers();
      await expect(servers.load()).rejects.toThrow(join(dir, "mcp-servers.json"));
      await expect(servers.load()).rejects.toThrow("Unknown MCP credential policy");
      await expect(new Servers(dir).load()).rejects.toThrow(join(dir, "mcp-servers.json"));
      writeFileSync(join(dir, "mcp-servers.json"), before);
    }
  });

  it("does not change cached data or ownership on any rejected mutation", async () => {
    const servers = new Servers();
    const profiles = new Profiles();
    const serverBefore = structuredClone(await servers.load());
    const profileBefore = structuredClone(await profiles.load());
    const orgBefore = [read(org, "mcp-servers.json"), read(org, "mcp-profiles.json")];
    for (const collection of ["servers", "profiles"]) {
      const filename = `mcp-${collection}.json`;
      rmSync(join(identity, filename));
      symlinkSync(join(org, filename), join(identity, filename));
    }
    const file = join(root, "import.json");
    writeFileSync(file, JSON.stringify({ profiles: { imported: { name: "imported", servers: [] } } }));
    const mutations = [
      () => servers.add({ name: "unsaved", type: "stdio", command: "unsaved" }),
      () => servers.update("tracker", { description: "unsaved" }),
      () => servers.remove("tracker"),
      () => servers.recordInjection("tracker", "cursor"),
      () => servers.setCredentialPolicy("none"),
      () => profiles.add({ name: "unsaved", servers: [] }),
      () => profiles.edit("acme-dev", { description: "unsaved" }),
      () => profiles.remove("acme-dev"),
      () => profiles.importFrom(file),
      () => profiles.initPresets(),
    ];
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toThrow("overlapping");
      expect(await servers.load()).toEqual(serverBefore);
      expect(await profiles.load()).toEqual(profileBefore);
    }
    expect([read(org, "mcp-servers.json"), read(org, "mcp-profiles.json")]).toEqual(orgBefore);
    // A later successful save must not persist any previously refused mutation.
    for (const collection of ["servers", "profiles"]) {
      rmSync(join(identity, `mcp-${collection}.json`));
    }
    await servers.save();
    await profiles.save();
    expect(await servers.get("unsaved")).toBeUndefined();
    expect(await profiles.get("imported")).toBeUndefined();
    expect(await servers.getCredentialPolicy()).toBeUndefined();
  });

  it("merges servers by name with the later layer winning", async () => {
    const servers = new Servers();
    expect(servers.getPath()).toBe(join(identity, "mcp-servers.json"));
    expect((await servers.get("tracker"))?.url).toBe("https://tracker.acme.example/mcp");
    expect((await servers.get("github"))?.headerEnv).toEqual({ Authorization: "GITHUB_AUTHORIZATION" });
  });

  it("resolves extends across layers: servers base first, deny accumulates, allow from the most derived", async () => {
    const profiles = new Profiles();
    expect(await profiles.resolve("acme-dev")).toMatchObject({
      servers: ["github", "tracker"],
      providerOverrides: {
        "*": { toolDeny: ["github__delete_repo", "tracker__close_all"] },
        codex: { toolAllow: ["github__get_file"] },
      },
    });
    expect((await profiles.get("acme-dev"))?.servers).toEqual(["tracker"]);
    expect((await profiles.resolveServers("acme-dev", new Servers()) as { url: string }[]).map(server => server.url))
      .toEqual(["https://github.example/mcp", "https://tracker.acme.example/mcp"]);
  });

  it("writes only to the last layer and never copies an unchanged lower entry into it", async () => {
    const orgServers = read(org, "mcp-servers.json");
    const servers = new Servers();
    await servers.add({ name: "notes", type: "stdio", command: "notes-mcp" });
    await servers.recordInjection("github", "claude-code");
    expect(read(org, "mcp-servers.json")).toBe(orgServers);
    expect(Object.keys(JSON.parse(read(identity, "mcp-servers.json")).servers)).toEqual(["tracker", "notes"]);

    await servers.update("github", { url: "https://github.acme.example/mcp" });
    expect(JSON.parse(read(identity, "mcp-servers.json")).servers.github.url).toBe("https://github.acme.example/mcp");
    expect(read(org, "mcp-servers.json")).toBe(orgServers);
  });

  it("keeps inherited credential policy live without copying it on a server write", async () => {
    const orgData = JSON.parse(read(org, "mcp-servers.json"));
    write(org, "mcp-servers.json", { ...orgData, credentialPolicy: "references" });
    const orgBefore = read(org, "mcp-servers.json");
    const servers = new Servers();
    expect(await servers.getCredentialPolicy()).toBe("references");

    await servers.add({ name: "notes", type: "stdio", command: "notes-mcp" });
    await servers.recordInjection("github", "codex");
    expect(JSON.parse(read(identity, "mcp-servers.json"))).not.toHaveProperty("credentialPolicy");
    expect(read(org, "mcp-servers.json")).toBe(orgBefore);

    write(org, "mcp-servers.json", { ...orgData, credentialPolicy: "none" });
    servers.clearCache();
    expect(await servers.getCredentialPolicy()).toBe("none");
  });

  it.each(["references", "none"] as const)("persists an explicit credential policy of %s", async (policy) => {
    const orgData = JSON.parse(read(org, "mcp-servers.json"));
    write(org, "mcp-servers.json", { ...orgData, credentialPolicy: "references" });
    const orgBefore = read(org, "mcp-servers.json");
    const servers = new Servers();

    await servers.setCredentialPolicy(policy);
    expect(JSON.parse(read(identity, "mcp-servers.json")).credentialPolicy).toBe(policy);
    expect(read(org, "mcp-servers.json")).toBe(orgBefore);
    expect(await new Servers().getCredentialPolicy()).toBe(policy);

    write(org, "mcp-servers.json", { ...orgData, credentialPolicy: "none" });
    servers.clearCache();
    expect(await servers.getCredentialPolicy()).toBe("none");
  });

  it("writes only the format fields and its own entries into a fresh write layer", async () => {
    rmSync(join(identity, "mcp-profiles.json"));
    const orgData = JSON.parse(read(org, "mcp-profiles.json"));
    write(org, "mcp-profiles.json", { ...orgData, orgOnlySetting: "org" });
    const orgBefore = read(org, "mcp-profiles.json");
    const profiles = new Profiles();
    await profiles.add({ name: "notes", servers: [] });
    const written = JSON.parse(read(identity, "mcp-profiles.json"));
    expect(Object.keys(written).sort()).toEqual(["apiVersion", "kind", "profiles"]);
    expect(written).toMatchObject({ apiVersion: "aiwg.io/v1", kind: "McpProfileRegistry" });
    expect(Object.keys(written.profiles)).toEqual(["notes"]);
    expect(read(org, "mcp-profiles.json")).toBe(orgBefore);
    expect(await new Profiles().load()).toMatchObject({ apiVersion: "aiwg.io/v1", kind: "McpProfileRegistry" });
  });

  it("persists owned, changed and new top-level fields while retaining fresh defaults", async () => {
    const profiles = new Profiles();
    const data = await profiles.load();
    data.apiVersion = "aiwg.io/v2";
    await profiles.add({ name: "notes", servers: [] });
    expect(JSON.parse(read(identity, "mcp-profiles.json"))).toMatchObject({
      apiVersion: "aiwg.io/v2", kind: "McpProfileRegistry",
    });

    rmSync(join(identity, "mcp-profiles.json"));
    const fresh = new Profiles();
    const freshData = await fresh.load();
    freshData.apiVersion = "aiwg.io/v2";
    await fresh.add({ name: "notes", servers: [] });
    expect(JSON.parse(read(identity, "mcp-profiles.json"))).toHaveProperty("apiVersion", "aiwg.io/v2");

    rmSync(join(org, "mcp-profiles.json"));
    rmSync(join(identity, "mcp-profiles.json"));
    await new Profiles().add({ name: "notes", servers: [] });
    expect(JSON.parse(read(identity, "mcp-profiles.json"))).toMatchObject({
      apiVersion: "aiwg.io/v1", kind: "McpProfileRegistry",
    });
  });

  it.each([
    { orgPolicy: "references", identityPolicy: "literal", effective: "references" },
    { orgPolicy: "literal", identityPolicy: "none", effective: "none" },
  ] as const)("enforces $orgPolicy with overlay $identityPolicy as $effective", async ({ orgPolicy, identityPolicy, effective }) => {
    write(org, "mcp-servers.json", { ...JSON.parse(read(org, "mcp-servers.json")), credentialPolicy: orgPolicy });
    write(identity, "mcp-servers.json", { ...JSON.parse(read(identity, "mcp-servers.json")), credentialPolicy: identityPolicy });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const servers = new Servers();
    expect(await servers.getCredentialPolicy()).toBe(effective);
    expect(resolveCredentialPolicy({ registryPolicy: await servers.getCredentialPolicy(),
      env: { AIWG_MCP_CREDENTIAL_POLICY: "literal" } })).toBe(effective);
    await servers.recordInjection("github", "codex");
    if (identityPolicy === "literal") {
      expect(JSON.parse(read(identity, "mcp-servers.json"))).not.toHaveProperty("credentialPolicy");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Dropping ignored"));
    } else {
      expect(JSON.parse(read(identity, "mcp-servers.json")).credentialPolicy).toBe(identityPolicy);
    }
    warning.mockRestore();
  });

  it("keeps the strictest lower policy live across three layers without copying it", async () => {
    const team = join(root, "team");
    write(org, "mcp-servers.json", { ...JSON.parse(read(org, "mcp-servers.json")), credentialPolicy: "none" });
    write(team, "mcp-servers.json", { credentialPolicy: "literal", servers: {} });
    vi.stubEnv("AIWG_CONFIG_LAYERS", [org, team, identity].join(delimiter));
    const servers = new Servers();
    expect(await servers.getCredentialPolicy()).toBe("none");
    await servers.recordInjection("github", "codex");
    expect(JSON.parse(read(identity, "mcp-servers.json"))).not.toHaveProperty("credentialPolicy");
  });

  it("refuses policy-setting commands below the lower-layer floor without writing", async () => {
    write(org, "mcp-servers.json", { ...JSON.parse(read(org, "mcp-servers.json")), credentialPolicy: "references" });
    const before = read(identity, "mcp-servers.json");
    await expect(new Servers().setCredentialPolicy("literal")).rejects.toThrow('Cannot relax MCP credential policy floor "references"');
    expect(read(identity, "mcp-servers.json")).toBe(before);
  });

  it("allows maintainers to change their own policy within the lower-layer floor", async () => {
    const servers = new Servers();
    await servers.setCredentialPolicy("none");
    await servers.setCredentialPolicy("literal");
    expect(await new Servers().getCredentialPolicy()).toBe("literal");
  });

  it("refreshes server ownership after add, update and copy-up on one instance", async () => {
    const servers = new Servers();
    await servers.add({ name: "new", type: "stdio", command: "new" });
    await servers.update("new", { description: "changed" });
    await servers.remove("new");
    await servers.update("tracker", { description: "changed" });
    await servers.remove("tracker");
    await servers.update("github", { description: "copied up" });
    await servers.remove("github");
    expect(JSON.parse(read(identity, "mcp-servers.json")).servers).toEqual({});
    expect((await servers.get("github"))?.url).toBe("https://github.example/mcp");
    await expect(servers.add({ name: "github", type: "stdio", command: "duplicate" })).rejects.toThrow("already exists");
    await expect(servers.remove("github")).rejects.toThrow("lower configuration layer");
  });

  it("refreshes profile ownership after add, edit and copy-up on one instance", async () => {
    const profiles = new Profiles();
    await profiles.add({ name: "new", servers: [] });
    await profiles.edit("new", { description: "changed" });
    await profiles.remove("new");
    await profiles.edit("acme-dev", { description: "changed" });
    await profiles.remove("acme-dev");
    await profiles.edit("org-base", { description: "copied up" });
    await profiles.remove("org-base");
    expect(JSON.parse(read(identity, "mcp-profiles.json")).profiles).toEqual({});
    expect(await profiles.get("org-base")).toBeDefined();
    await expect(profiles.add({ name: "org-base", servers: [] })).rejects.toThrow("already exists");
    await expect(profiles.remove("org-base")).rejects.toThrow("lower configuration layer");
  });

  it("does not claim ownership of copy-ups when a save is refused", async () => {
    const servers = new Servers();
    const profiles = new Profiles();
    await servers.load();
    await profiles.load();
    for (const collection of ["servers", "profiles"]) {
      const filename = `mcp-${collection}.json`;
      rmSync(join(identity, filename));
      symlinkSync(join(org, filename), join(identity, filename));
    }
    await expect(servers.update("github", { description: "copy-up" })).rejects.toThrow("overlapping");
    await expect(servers.remove("github")).rejects.toThrow("lower configuration layer");
    await expect(profiles.edit("org-base", { description: "copy-up" })).rejects.toThrow("overlapping");
    await expect(profiles.remove("org-base")).rejects.toThrow("lower configuration layer");
  });

  it.each(["servers", "profiles"])("refuses a symlinked identity %s file pointing to the organisation", async collection => {
    const filename = `mcp-${collection}.json`;
    const before = read(org, filename);
    rmSync(join(identity, filename));
    symlinkSync(join(org, filename), join(identity, filename));
    if (collection === "servers") {
      const servers = new Servers();
      await expect(servers.update("github", { description: "changed" })).rejects.toThrow(/overlapping|symlink/);
    } else {
      const profiles = new Profiles();
      await expect(profiles.edit("org-base", { description: "changed" })).rejects.toThrow(/overlapping|symlink/);
    }
    expect(read(org, filename)).toBe(before);
  });

  it.each(["servers", "profiles"])("refuses unrelated symlinked %s destinations", async collection => {
    const filename = `mcp-${collection}.json`;
    const outside = join(root, filename);
    const before = read(identity, filename);
    writeFileSync(outside, before);
    rmSync(join(identity, filename));
    symlinkSync(outside, join(identity, filename));
    const registry = collection === "servers" ? new Servers() : new Profiles();
    await registry.load();
    await expect(registry.save()).rejects.toThrow("destination is a symlink");
    expect(readFileSync(outside, "utf-8")).toBe(before);
  });

  it.each(["servers", "profiles"])("refuses dangling lower-layer %s aliases to a new write file", async collection => {
    const filename = `mcp-${collection}.json`;
    rmSync(join(org, filename));
    rmSync(join(identity, filename));
    symlinkSync(join(identity, filename), join(org, filename));
    const registry = collection === "servers" ? new Servers() : new Profiles();
    await registry.load();
    await expect(registry.save()).rejects.toThrow("overlapping MCP configuration layer targets");
    expect(existsSync(join(identity, filename))).toBe(false);
  });

  it("checks other-layer profile file aliases before writing servers", async () => {
    rmSync(join(org, "mcp-profiles.json"));
    symlinkSync(join(identity, "mcp-servers.json"), join(org, "mcp-profiles.json"));
    const before = read(identity, "mcp-servers.json");
    const servers = new Servers();
    await servers.load();
    await expect(servers.save()).rejects.toThrow("overlapping MCP configuration layer targets");
    expect(read(identity, "mcp-servers.json")).toBe(before);
  });

  it.each(["servers", "profiles"])("allows symlinked config directories and ancestors for %s", async collection => {
    const actual = join(root, "actual");
    mkdirSync(actual);
    const alias = join(root, "alias");
    symlinkSync(actual, alias, "dir");
    for (const writeDir of [alias, join(alias, "missing-child")]) {
      vi.stubEnv("AIWG_CONFIG_LAYERS", [org, writeDir].join(delimiter));
      const registry = collection === "servers" ? new Servers() : new Profiles();
      await registry.load();
      await registry.save();
      expect(existsSync(join(writeDir, `mcp-${collection}.json`))).toBe(true);
      // Single-directory registries also allow dotfile-manager aliases.
      const single = collection === "servers" ? new Servers(writeDir) : new Profiles(writeDir);
      await single.load();
      await single.save();
    }
  });

  it.each(["servers", "profiles"])("refuses duplicate, aliased and nested layer targets for %s", async collection => {
    const alias = join(root, "org-alias");
    symlinkSync(org, alias, "dir");
    const before = read(org, `mcp-${collection}.json`);
    for (const writeDir of [org, alias, join(org, "child")]) {
      vi.stubEnv("AIWG_CONFIG_LAYERS", [org, writeDir].join(delimiter));
      const registry = collection === "servers" ? new Servers() : new Profiles();
      await registry.load();
      await expect(registry.save()).rejects.toThrow("overlapping MCP configuration layer targets");
    }
    expect(read(org, `mcp-${collection}.json`)).toBe(before);
    expect(existsSync(join(org, "child"))).toBe(false);
  });

  it.each([
    { label: "self-cycle", imported: { a: { name: "a", extends: ["a"], servers: [] } }, error: "a -> a" },
    { label: "two-cycle", imported: { a: { name: "a", extends: ["b"], servers: [] }, b: { name: "b", extends: ["a"], servers: [] } }, error: "a -> b -> a" },
    { label: "missing-base", imported: { a: { name: "a", extends: ["missing"], servers: [] } }, error: 'extends "missing"' },
    { label: "cycle through existing layers", imported: { "org-base": { name: "org-base", extends: ["acme-dev"], servers: [] } }, error: "org-base -> acme-dev -> org-base" },
  ])("refuses imported $label before mutating disk or cache", async ({ imported, error }) => {
    const profiles = new Profiles();
    const before = read(identity, "mcp-profiles.json");
    const cachedBefore = JSON.stringify(await profiles.load());
    const file = join(root, "import.json");
    writeFileSync(file, JSON.stringify({ profiles: { valid: { name: "valid", servers: [] }, ...imported } }));
    await expect(profiles.importFrom(file)).rejects.toThrow(error);
    expect(read(identity, "mcp-profiles.json")).toBe(before);
    expect(JSON.stringify(await profiles.load())).toBe(cachedBefore);
  });

  it("validates existing profiles even when the import does not touch them", async () => {
    write(org, "mcp-profiles.json", { profiles: { broken: { name: "broken", servers: [], extends: ["missing"] } } });
    const file = join(root, "import.json");
    writeFileSync(file, JSON.stringify({ profiles: { valid: { name: "valid", servers: [] } } }));
    const before = read(identity, "mcp-profiles.json");
    await expect(new Profiles().importFrom(file)).rejects.toThrow('Profile "broken" extends "missing"');
    expect(read(identity, "mcp-profiles.json")).toBe(before);
  });

  it("imports a valid chain with forward references and bases across layers", async () => {
    const file = join(root, "import.json");
    writeFileSync(file, JSON.stringify({ profiles: {
      leaf: { name: "leaf", servers: [], extends: ["middle"] },
      middle: { name: "middle", servers: [], extends: ["acme-dev"] },
    } }));
    const profiles = new Profiles();
    expect(await profiles.importFrom(file)).toEqual({ added: 2, updated: 0 });
    expect((await profiles.resolve("leaf"))?.servers).toEqual(["github", "tracker"]);
    await profiles.remove("leaf");
  });

  it.each(["claude", "codex"] as const)("renders inherited tool denies and references in persistent %s injection", async provider => {
    const projectDir = join(root, "project");
    mkdirSync(projectDir);
    vi.stubEnv("CODEX_HOME", join(root, "codex"));
    const servers = new Servers();
    const profiles = new Profiles();
    const profile = await profiles.resolve("acme-dev");
    const result = await inject(servers, provider, {
      projectDir, servers: profile!.servers,
      toolFilters: resolveToolFilters(profile, provider), credentialPolicy: "references",
    });
    if (provider === "claude") {
      const settings = JSON.parse(readFileSync(join(projectDir, ".claude/settings.local.json"), "utf-8"));
      expect(settings.permissions.deny).toContain("mcp__github__delete_repo");
      const config = JSON.parse(readFileSync(result.configPath, "utf-8"));
      expect(config.mcpServers.github.headers.Authorization).toBe("${GITHUB_AUTHORIZATION}");
    } else {
      const toml = readFileSync(result.configPath, "utf-8");
      expect(toml).toContain('disabled_tools = ["delete_repo"]');
      expect(toml).toContain('Authorization = "GITHUB_AUTHORIZATION"');
    }
  });

  it("passes inherited filters and credential references into Codex runtime TOML", async () => {
    vi.stubEnv("CODEX_HOME", join(root, "codex-home"));
    const profiles = new Profiles();
    const servers = await profiles.resolveServers("acme-dev", new Servers());
    await writeProfileConfig("acme-dev", servers as import("../../../src/mcp/registry.js").McpServerDefinition[], {
      toolFilters: resolveToolFilters(await profiles.resolve("acme-dev"), "codex"), credentialPolicy: "references",
    });
    const toml = readFileSync(join(root, "codex-home/roles-runtime/acme-dev/config.toml"), "utf-8");
    expect(toml).toContain('disabled_tools = ["delete_repo"]');
    expect(toml).toContain('Authorization = "GITHUB_AUTHORIZATION"');
  });

  it("refuses to remove an entry defined only in a lower layer", async () => {
    await expect(new Servers().remove("github")).rejects.toThrow('Server "github" is defined in a lower configuration layer; remove it there.');
    await expect(new Profiles().remove("org-base")).rejects.toThrow('Profile "org-base" is defined in a lower configuration layer; remove it there.');
  });

  it("refuses a profile whose base does not exist, without writing", async () => {
    const before = read(identity, "mcp-profiles.json");
    await expect(new Profiles().add({ name: "broken", servers: [], extends: ["nope"] }))
      .rejects.toThrow('Profile "broken" extends "nope", which is not defined in any configuration layer.');
    expect(read(identity, "mcp-profiles.json")).toBe(before);
  });
});

describe("aiwg mcp inject from layered roots", () => {
  it("floor-checks the CLI policy-setting command without writing", () => {
    write(org, "mcp-servers.json", { credentialPolicy: "references", servers: {} });
    const before = read(identity, "mcp-servers.json");
    let error: Error | undefined;
    try {
      execFileSync(process.execPath, [cliPath, "credential-policy", "literal"], {
        cwd: root, encoding: "utf-8", timeout: 60_000, stdio: "pipe",
        env: { PATH: process.env.PATH, HOME: join(root, "home"), AIWG_CONFIG_LAYERS: [org, identity].join(delimiter) },
      });
    } catch (caught) { error = caught as Error; }
    expect(error?.message).toContain('Cannot relax MCP credential policy floor "references"');
    expect(read(identity, "mcp-servers.json")).toBe(before);
    expect(existsSync(join(root, "home"))).toBe(false);
  });

  it("injects zero servers for an empty profile through the persistent CLI", () => {
    write(identity, "mcp-profiles.json", { profiles: { minimal: { name: "minimal", servers: [] } } });
    const before = read(identity, "mcp-servers.json");
    try {
      execFileSync(process.execPath, [cliPath, "inject", "--provider", "cursor", "--profile", "minimal"], {
        cwd: root, encoding: "utf-8", timeout: 60_000, stdio: "pipe",
        env: { PATH: process.env.PATH, HOME: join(root, "home"), AIWG_CONFIG_LAYERS: [org, identity].join(delimiter) },
      });
    } catch (error) { expect((error as Error).message).toContain("No servers to inject"); }
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
    expect(read(identity, "mcp-servers.json")).toBe(before);
  });

  it("renders an ephemeral config for an identity profile that extends an organisation profile", () => {
    const orgFiles = [read(org, "mcp-servers.json"), read(org, "mcp-profiles.json")];
    const identityFiles = [read(identity, "mcp-servers.json"), read(identity, "mcp-profiles.json")];
    const out = join(root, "acme.json");
    execFileSync(process.execPath, [cliPath, "inject", "--provider", "claude", "--profile", "acme-dev", "--ephemeral", "--out", out], {
      cwd: root,
      encoding: "utf-8",
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: join(root, "home"), AIWG_CONFIG_LAYERS: [org, identity].join(delimiter) },
    });
    const servers = JSON.parse(readFileSync(out, "utf-8")).mcpServers;
    expect(Object.keys(servers)).toEqual(["github", "tracker"]);
    expect(servers.tracker.url).toBe("https://tracker.acme.example/mcp");
    expect([read(org, "mcp-servers.json"), read(org, "mcp-profiles.json")]).toEqual(orgFiles);
    expect([read(identity, "mcp-servers.json"), read(identity, "mcp-profiles.json")]).toEqual(identityFiles);
    const settings = JSON.parse(readFileSync(out.replace(/\.json$/, ".settings.json"), "utf-8"));
    expect(settings.permissions.deny).toContain("mcp__github__delete_repo");
    expect(servers.github.headers.Authorization).toBe("${GITHUB_AUTHORIZATION}");
    expect(existsSync(join(root, "home"))).toBe(false);
  });
});
