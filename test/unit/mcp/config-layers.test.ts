/**
 * Layered MCP configuration roots (AIWG_CONFIG_LAYERS) and profile `extends`.
 *
 * @source @src/mcp/config-layers.mjs
 * @source @src/mcp/registry.ts
 * @source @src/mcp/profiles.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { McpServerRegistry } from "../../../src/mcp/registry.js";
import { McpServerRegistry as RuntimeServerRegistry } from "../../../src/mcp/registry.mjs";
import { McpProfileRegistry } from "../../../src/mcp/profiles.js";
import { McpProfileRegistry as RuntimeProfileRegistry } from "../../../src/mcp/profiles.mjs";
import { resolveConfigLayers, resolveProfileExtends } from "../../../src/mcp/config-layers.mjs";

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

describe("resolveProfileExtends", () => {
  it("refuses a cycle and a missing base", () => {
    expect(() => resolveProfileExtends("a", { a: { extends: ["b"], servers: [] }, b: { extends: ["a"], servers: [] } }))
      .toThrow("Profile extends cycle: a -> b -> a");
    expect(() => resolveProfileExtends("a", { a: { extends: ["missing"], servers: [] } }))
      .toThrow('Profile "a" extends "missing", which is not defined in any configuration layer.');
  });
});

describe.each([
  { implementation: "TypeScript", Servers: McpServerRegistry, Profiles: McpProfileRegistry },
  {
    implementation: "runtime",
    Servers: RuntimeServerRegistry as unknown as typeof McpServerRegistry,
    Profiles: RuntimeProfileRegistry as unknown as typeof McpProfileRegistry,
  },
])("$implementation layered registries", ({ Servers, Profiles }) => {
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
    expect(existsSync(join(root, "home"))).toBe(false);
  });
});
