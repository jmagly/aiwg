/**
 * Regression tests for the MCP configuration series fix-first review.
 *
 * Each test below fails without its corresponding production fix. All
 * filesystem work stays under temporary directories: HOME/USERPROFILE and
 * every AIWG location are redirected, so the real home directory is never
 * touched.
 *
 * @source @src/mcp/config-file.mjs
 * @source @src/mcp/credentials.mjs
 * @source @src/mcp/config-layers.mjs
 * @source @src/mcp/omp-config.mjs
 * @source @src/mcp/registry.ts
 * @source @src/mcp/registry.mjs
 * @source @src/mcp/cli.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { McpServerRegistry, injectServers, buildServerConfig } from "../../../src/mcp/registry.js";
import { McpServerRegistry as RuntimeRegistry, injectServers as runtimeInjectServers, buildServerConfig as runtimeBuildServerConfig } from "../../../src/mcp/registry.mjs";
import {
  assertProjectCredentials,
  assertSupportedScope,
  isPathInsideDir,
  projectCredentialRemedy,
} from "../../../src/mcp/config-file.mjs";
import {
  credentialLikeArgs,
  credentialPolicyViolations,
  isCredentialReferenceValue,
  redactCredentialArgs,
} from "../../../src/mcp/credentials.mjs";
import { resolveConfigLayers } from "../../../src/mcp/config-layers.mjs";
import { manageOmpMcp } from "../../../src/mcp/omp-config.mjs";

const cliPath = resolve(__dirname, "../../../src/mcp/cli.mjs");

let root: string;
let homeDir: string;
let configDir: string;
let projectDir: string;
let savedEnv: Record<string, string | undefined>;

const registryImplementations = [
  { implementation: "TypeScript", Registry: McpServerRegistry, inject: injectServers, build: buildServerConfig },
  { implementation: "runtime", Registry: RuntimeRegistry, inject: runtimeInjectServers, build: runtimeBuildServerConfig as typeof buildServerConfig },
];

beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    GROK_HOME: process.env.GROK_HOME,
    AIWG_CONFIG: process.env.AIWG_CONFIG,
    AIWG_CONFIG_LAYERS: process.env.AIWG_CONFIG_LAYERS,
    AIWG_MCP_CREDENTIAL_POLICY: process.env.AIWG_MCP_CREDENTIAL_POLICY,
  };
  root = mkdtempSync(join(tmpdir(), "aiwg-mcp-series-fixes-"));
  homeDir = join(root, "home");
  configDir = join(root, "config");
  projectDir = join(root, "project");
  for (const dir of [homeDir, configDir, projectDir]) mkdirSync(dir, { recursive: true });
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.CODEX_HOME;
  delete process.env.GROK_HOME;
  delete process.env.AIWG_CONFIG;
  delete process.env.AIWG_CONFIG_LAYERS;
  delete process.env.AIWG_MCP_CREDENTIAL_POLICY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function writeRegistryFile(dir: string, servers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  writeFileSync(join(dir, "mcp-servers.json"), JSON.stringify({
    apiVersion: "aiwg.io/v1",
    kind: "McpServerRegistry",
    servers,
    ...extra,
  }));
}

function runCli(args: string[], cwd = projectDir, extraEnv: Record<string, string> = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: homeDir, AIWG_CONFIG: configDir, TMPDIR: root, ...extraEnv },
  });
}

/** Like runCli, but returns the result instead of throwing, for refusal probes. */
function runCliWithOutput(args: string[], cwd = projectDir, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: homeDir, AIWG_CONFIG: configDir, TMPDIR: root, ...extraEnv },
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("1. scope follows the resolved destination", () => {
  const secretServer = {
    name: "vault",
    type: "stdio",
    command: "vault-server",
    env: { VAULT_TOKEN: "SYNTHETIC-LITERAL-TOKEN" },
  };

  it.each([["cursor"], ["opencode"]])("%s refuses --scope user instead of writing the project file", async provider => {
    for (const { implementation, inject, Registry } of registryImplementations) {
      const dir = join(root, `config-${implementation}`);
      mkdirSync(dir, { recursive: true });
      const registry = new Registry(dir);
      await registry.add({ ...secretServer, name: `${provider}-secret` } as never);
      await expect(inject(registry as never, provider as never, { projectDir, scope: "user" } as never))
        .rejects.toThrow(/no user-scope destination/);
      expect(existsSync(join(projectDir, provider === "cursor" ? ".cursor/mcp.json" : "opencode.json"))).toBe(false);
    }
  });

  it("cursor --scope user cannot escape through a symlinked parent", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(projectDir, ".cursor"));
    for (const { implementation, inject, Registry } of registryImplementations) {
      const dir = join(root, `config-escape-${implementation}`);
      mkdirSync(dir, { recursive: true });
      const registry = new Registry(dir);
      await registry.add({ ...secretServer, name: "cursor-escape" } as never);
      await expect(inject(registry as never, "cursor" as never, { projectDir, scope: "user" } as never))
        .rejects.toThrow(/no user-scope destination/);
    }
    expect(existsSync(join(outside, "mcp.json"))).toBe(false);
  });

  it("project refusal names the provider's real private destination", () => {
    const remedy = projectCredentialRemedy("claude-code", projectDir);
    expect(remedy).toContain(join(homeDir, ".claude.json"));
  });

  it("project refusal for Cursor points at references, not ~/.claude.json", () => {
    expect(projectCredentialRemedy("cursor", projectDir)).toContain("--header-env");
    expect(projectCredentialRemedy("cursor", projectDir)).not.toContain(".claude.json");
    expect(() => assertProjectCredentials(
      [{ name: "vault", env: { VAULT_TOKEN: "SYNTHETIC-LITERAL-TOKEN" } }],
      join(projectDir, ".cursor/mcp.json"),
      projectCredentialRemedy("cursor", projectDir),
    )).toThrow(/--header-env/);
  });

  it("isPathInsideDir distinguishes project from home destinations", () => {
    expect(isPathInsideDir(join(projectDir, ".cursor/mcp.json"), projectDir)).toBe(true);
    expect(isPathInsideDir(join(homeDir, ".claude.json"), projectDir)).toBe(false);
  });

  it("assertSupportedScope passes genuine home destinations", () => {
    expect(() => assertSupportedScope("factory", "user", join(homeDir, ".factory/mcp.json"), projectDir)).not.toThrow();
  });
});

describe("1b. destination-derived scope and containment apply to every write path", () => {
  it("generic 'install cursor --scope user' cannot escape through a symlinked .cursor directory", () => {
    const outside = join(root, "outside-install-cursor");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(projectDir, ".cursor"));
    const result = runCliWithOutput(["install", "cursor", "--scope", "user"]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(outside, "mcp.json"))).toBe(false);
  });

  it("generic 'install opencode --scope user' cannot escape through a symlinked .opencode directory", () => {
    const outside = join(root, "outside-install-opencode");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(projectDir, ".opencode"));
    const result = runCliWithOutput(["install", "opencode", "--scope", "user"]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(outside, "opencode.json"))).toBe(false);
    expect(existsSync(join(outside, "opencode.jsonc"))).toBe(false);
  });

  it("'install omp --scope user' cannot escape when PI_CODING_AGENT_DIR resolves inside the project", () => {
    const outside = join(root, "outside-install-omp");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(projectDir, ".omp"));
    const result = runCliWithOutput(
      ["install", "omp", "--project", projectDir, "--scope", "user"],
      projectDir,
      { PI_CODING_AGENT_DIR: join(projectDir, ".omp") },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(join(outside, "mcp.json"))).toBe(false);
  });

  it("'uninject --provider omp --scope user' cannot escape when PI_CODING_AGENT_DIR resolves inside the project", () => {
    const outside = join(root, "outside-uninject-omp");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "mcp.json"), JSON.stringify({ mcpServers: { aiwg: { command: "aiwg" } } }));
    writeFileSync(join(outside, "mcp.json.aiwg-ownership.json"), JSON.stringify({ schema: "aiwg.omp-mcp-ownership.v1", servers: {} }));
    symlinkSync(outside, join(projectDir, ".omp"));
    const before = readFileSync(join(outside, "mcp.json"), "utf-8");
    const result = runCliWithOutput(
      ["uninject", "--provider", "omp", "--project", projectDir, "--scope", "user", "--servers", "aiwg"],
      projectDir,
      { PI_CODING_AGENT_DIR: join(projectDir, ".omp") },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(outside, "mcp.json"), "utf-8")).toBe(before);
  });
});

describe("5. project-scope refusal checks values, not occupancy", () => {
  const configPath = () => join(projectDir, ".cursor/mcp.json");

  it("allows reference forms and empty strings", () => {
    expect(() => assertProjectCredentials([{
      name: "ok",
      env: { FROM_DOLLAR: "${VAULT_TOKEN}", FROM_ENV: "${env:VAULT_TOKEN}", FROM_BRACE: "{env:VAULT_TOKEN}", EMPTY: "" },
      headers: { Authorization: "${env:VAULT_TOKEN}" },
    }], configPath())).not.toThrow();
  });

  it("rejects literal strings", () => {
    expect(() => assertProjectCredentials(
      [{ name: "vault", env: { VAULT_TOKEN: "SYNTHETIC-LITERAL-TOKEN" } }], configPath()))
      .toThrow(/literal env values \(VAULT_TOKEN\)/);
    expect(() => assertProjectCredentials(
      [{ name: "vault", headers: { Authorization: "Bearer SYNTHETIC" } }], configPath()))
      .toThrow(/literal headers values \(Authorization\)/);
  });

  it("rejects non-string values with a schema-style error", () => {
    expect(() => assertProjectCredentials(
      [{ name: "vault", env: { VAULT_TOKEN: 0 } }], configPath())).toThrow(/must be a string/);
    expect(() => assertProjectCredentials(
      [{ name: "vault", headers: { Authorization: null } }], configPath())).toThrow(/must be a string/);
  });

  it("rejects literal auth/oauth values (OMP secrets)", () => {
    expect(() => assertProjectCredentials(
      [{ name: "vault", oauth: { clientSecret: "SYNTHETIC-OAUTH-SECRET" } }], configPath()))
      .toThrow(/literal oauth values \(clientSecret\)/);
    expect(() => assertProjectCredentials(
      [{ name: "vault", auth: { type: "apikey", clientSecret: "SYNTHETIC-API-SECRET" } }], configPath()))
      .toThrow(/literal auth values \(clientSecret\)/);
    expect(() => assertProjectCredentials(
      [{ name: "flow", auth: { type: "oauth" } }], configPath())).not.toThrow();
  });
});

describe("4. value-aware credential argument detection", () => {
  it("flags --flag=value and --flag value forms with literal values", () => {
    expect(credentialLikeArgs(["--api-key=SYNTHETIC-KEY"])).toEqual(["--api-key=SYNTHETIC-KEY"]);
    expect(credentialLikeArgs(["--token", "SYNTHETIC-TOKEN"])).toEqual(["--token SYNTHETIC-TOKEN"]);
    expect(credentialLikeArgs(["serve", "--password", "SYNTHETIC-PW", "--verbose"])).toEqual(["--password SYNTHETIC-PW"]);
  });

  it("ignores bare flags, empty values and reference values", () => {
    expect(credentialLikeArgs(["--token"])).toEqual([]);
    expect(credentialLikeArgs(["--token", "--verbose"])).toEqual([]);
    expect(credentialLikeArgs(["--token="])).toEqual([]);
    expect(credentialLikeArgs(["--token", ""])).toEqual([]);
    expect(credentialLikeArgs(["--token", "${VAULT_TOKEN}"])).toEqual([]);
    expect(credentialLikeArgs(["--token=${VAULT_TOKEN}"])).toEqual([]);
    expect(credentialLikeArgs(["--token={env:VAULT_TOKEN}"])).toEqual([]);
  });

  it("ignores secret locations and short flags but detects credential assignments", () => {
    expect(credentialLikeArgs(["--token-file", "path"])).toEqual([]);
    expect(credentialLikeArgs(["--password-stdin"])).toEqual([]);
    expect(credentialLikeArgs(["--secret-name", "VAULT_TOKEN"])).toEqual([]);
    expect(credentialLikeArgs(["-p", "SYNTHETIC-PW"])).toEqual([]);
    expect(credentialLikeArgs(["API_KEY=SYNTHETIC-KEY"])).toEqual(["API_KEY=SYNTHETIC-KEY"]);
  });

  it("restores single-dash long names and leading-hyphen values detected by the parent commit", () => {
    // Regression: both forms were detected by the pre-series detector and
    // silently stopped being detected by the value-aware rewrite.
    expect(credentialLikeArgs(["-token", "SYNTHETIC-TOKEN"])).toEqual(["-token SYNTHETIC-TOKEN"]);
    expect(credentialLikeArgs(["--token", "-SYNTHETIC-TOKEN"])).toEqual(["--token -SYNTHETIC-TOKEN"]);
    // --token=-VALUE already worked; keep it working.
    expect(credentialLikeArgs(["--token=-SYNTHETIC-TOKEN"])).toEqual(["--token=-SYNTHETIC-TOKEN"]);
    // Still excluded: short aliases, bare flags, and a genuinely following long flag.
    expect(credentialLikeArgs(["-p", "SYNTHETIC-PW"])).toEqual([]);
    expect(credentialLikeArgs(["--token", "--verbose"])).toEqual([]);
    expect(credentialLikeArgs(["--token"])).toEqual([]);
  });

  it("project refusal and restrictive policies cover single-dash names and hyphen-led values", () => {
    expect(() => assertProjectCredentials(
      [{ name: "vault", args: ["-token", "SYNTHETIC-TOKEN"] }], join(projectDir, ".cursor/mcp.json")))
      .toThrow(/credential-like args \(-token\)/);
    expect(() => assertProjectCredentials(
      [{ name: "vault", args: ["--token", "-SYNTHETIC-TOKEN"] }], join(projectDir, ".cursor/mcp.json")))
      .toThrow(/credential-like args \(--token\)/);
    expect(credentialPolicyViolations({ name: "vault", args: ["-token", "SYNTHETIC-TOKEN"] }, "references")).toContain("args");
    expect(credentialPolicyViolations({ name: "vault", args: ["--token", "-SYNTHETIC-TOKEN"] }, "none")).toContain("args");
  });

  it("redacts single-dash names and hyphen-led values", () => {
    expect(redactCredentialArgs(["-token", "SYNTHETIC-TOKEN"])).toEqual(["-token", "***"]);
    expect(redactCredentialArgs(["--token", "-SYNTHETIC-TOKEN"])).toEqual(["--token", "***"]);
  });

  it("isCredentialReferenceValue accepts every documented syntax", () => {
    expect(isCredentialReferenceValue("${VAR}")).toBe(true);
    expect(isCredentialReferenceValue("${env:VAR}")).toBe(true);
    expect(isCredentialReferenceValue("{env:VAR}")).toBe(true);
    expect(isCredentialReferenceValue("literal")).toBe(false);
    expect(isCredentialReferenceValue("")).toBe(false);
  });

  it("restrictive policies cover arguments", () => {
    const server = { name: "vault", args: ["--token", "SYNTHETIC-TOKEN"] };
    expect(credentialPolicyViolations(server, "literal")).toEqual([]);
    expect(credentialPolicyViolations(server, undefined)).toEqual([]);
    expect(credentialPolicyViolations(server, "references")).toContain("args");
    expect(credentialPolicyViolations(server, "none")).toContain("args");
    expect(credentialPolicyViolations({ name: "clean", args: ["--token", "${VAULT_TOKEN}"] }, "references")).not.toContain("args");
  });

  it("redactCredentialArgs masks only detected values", () => {
    expect(redactCredentialArgs(["--token=SYNTHETIC", "--verbose"])).toEqual(["--token=***", "--verbose"]);
    expect(redactCredentialArgs(["--token", "SYNTHETIC", "--verbose"])).toEqual(["--token", "***", "--verbose"]);
    expect(redactCredentialArgs(["--token", "${VAULT_TOKEN}"])).toEqual(["--token", "${VAULT_TOKEN}"]);
    expect(redactCredentialArgs(["-p", "SYNTHETIC"])).toEqual(["-p", "SYNTHETIC"]);
  });
});

describe("2. OMP ancestor protection, private modes and auth refusal", () => {
  const stdioServer = { name: "helper", type: "stdio", command: "helper-bin" };

  it("rejects a symlinked ancestor on inject even without projectRoot", async () => {
    const outside = join(root, "outside");
    mkdirSync(join(outside, ".omp"), { recursive: true });
    symlinkSync(join(outside, ".omp"), join(projectDir, ".omp"));
    await expect(manageOmpMcp(join(projectDir, ".omp/mcp.json"), [stdioServer], {}))
      .rejects.toThrow(/symlink/i);
  });

  it("rejects a symlinked ancestor on uninject even without projectRoot", async () => {
    const outside = join(root, "outside-uninject");
    mkdirSync(join(outside, ".omp"), { recursive: true });
    symlinkSync(join(outside, ".omp"), join(projectDir, ".omp"));
    await expect(manageOmpMcp(join(projectDir, ".omp/mcp.json"), [], { remove: ["helper"] }))
      .rejects.toThrow(/symlink/i);
  });

  it("writes OMP files carrying auth material at 0600", async () => {
    const configPath = join(projectDir, ".omp/mcp.json");
    const result = await manageOmpMcp(configPath, [{
      ...stdioServer,
      oauth: { clientSecret: "SYNTHETIC-OAUTH-SECRET" },
    }], { userScope: false, projectRoot: projectDir });
    expect(result.serversInjected).toEqual(["helper"]);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${configPath}.aiwg-ownership.json`).mode & 0o777).toBe(0o600);
  });

  it("project inject refuses literal OMP oauth secrets", async () => {
    for (const { implementation, inject, Registry } of registryImplementations) {
      const dir = join(root, `config-omp-${implementation}`);
      mkdirSync(dir, { recursive: true });
      const registry = new Registry(dir);
      await registry.add({
        name: "omp-secret",
        type: "stdio",
        command: "helper-bin",
        oauth: { clientSecret: "SYNTHETIC-OAUTH-SECRET" },
      } as never);
      await expect(inject(registry as never, "omp" as never, { projectDir } as never))
        .rejects.toThrow(/literal oauth values/);
      expect(existsSync(join(projectDir, ".omp/mcp.json"))).toBe(false);
    }
  });
});

describe("3. registry file modes", () => {
  const server = { name: "vault", type: "http", url: "https://synthetic.example/mcp" };

  it.each(registryImplementations)("$implementation creates a new registry file at 0600", async ({ Registry }) => {
    const registry = new Registry(configDir);
    await registry.add(server as never);
    expect(statSync(join(configDir, "mcp-servers.json")).mode & 0o777).toBe(0o600);
  });

  it.each(registryImplementations)("$implementation preserves a shared existing mode", async ({ Registry }) => {
    writeRegistryFile(configDir, {});
    chmodSync(join(configDir, "mcp-servers.json"), 0o640);
    const registry = new Registry(configDir);
    await registry.add(server as never);
    expect(statSync(join(configDir, "mcp-servers.json")).mode & 0o777).toBe(0o640);
  });

  it.each(registryImplementations)("$implementation keeps the active identity layer file at 0600", async ({ Registry }) => {
    const org = join(root, "org");
    const identity = join(root, "identity");
    mkdirSync(org, { recursive: true });
    mkdirSync(identity, { recursive: true });
    writeRegistryFile(org, {});
    process.env.AIWG_CONFIG_LAYERS = [org, identity].join(":");
    const registry = new Registry();
    await registry.add(server as never);
    expect(statSync(join(identity, "mcp-servers.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(org, "mcp-servers.json"))).toBe(true);
  });
});

describe("6. fresh layered save loads ownership first", () => {
  it.each(registryImplementations)("$implementation never copies inherited entries or policy", async ({ Registry }) => {
    const org = join(root, "org");
    const identity = join(root, "identity");
    mkdirSync(org, { recursive: true });
    mkdirSync(identity, { recursive: true });
    writeRegistryFile(org, {
      inherited: { name: "inherited", type: "http", url: "https://synthetic.example/mcp" },
    }, { credentialPolicy: "references" });
    process.env.AIWG_CONFIG_LAYERS = [org, identity].join(":");

    const loader = new Registry();
    const merged = structuredClone(await loader.load());
    const fresh = new Registry();
    await fresh.save(merged as never);

    const written = JSON.parse(readFileSync(join(identity, "mcp-servers.json"), "utf-8"));
    expect(written.servers).toEqual({});
    expect(written).not.toHaveProperty("credentialPolicy");
  });
});

describe("7. override removal cannot silently re-expose qualification", () => {
  const qualified = {
    name: "worker-svc",
    type: "stdio",
    command: "/usr/bin/worker",
    workerQualification: {
      serverDigest: "SYNTHETIC-DIGEST",
      adapterDigest: "SYNTHETIC-DIGEST",
      profile: "synthetic",
      cliVersion: "0.0.0",
      scopeDigest: "SYNTHETIC-DIGEST",
      fixtureDigest: "SYNTHETIC-DIGEST",
      requiredControls: [],
    },
  };

  function layeredDirs() {
    const org = join(root, "org");
    const identity = join(root, "identity");
    mkdirSync(org, { recursive: true });
    mkdirSync(identity, { recursive: true });
    return { org, identity };
  }

  it.each(registryImplementations)("$implementation refuses to remove an override of a qualified entry", async ({ Registry }) => {
    const { org, identity } = layeredDirs();
    writeRegistryFile(org, { "worker-svc": qualified });
    process.env.AIWG_CONFIG_LAYERS = [org, identity].join(":");
    const registry = new Registry();
    await (registry as unknown as { update(n: string, u: unknown): Promise<void> })
      .update("worker-svc", { command: "/usr/bin/worker-v2" });
    await expect((registry as unknown as { remove(n: string): Promise<void> }).remove("worker-svc"))
      .rejects.toThrow(/re-expose its qualification/);
  });

  it.each(registryImplementations)("$implementation still removes an override of an unqualified entry", async ({ Registry }) => {
    const { org, identity } = layeredDirs();
    const { workerQualification: droppedQualification, ...unqualified } = qualified;
    expect(droppedQualification.serverDigest).toBe("SYNTHETIC-DIGEST");
    writeRegistryFile(org, { "worker-svc": unqualified });
    process.env.AIWG_CONFIG_LAYERS = [org, identity].join(":");
    const registry = new Registry();
    await (registry as unknown as { update(n: string, u: unknown): Promise<void> })
      .update("worker-svc", { command: "/usr/bin/worker-v2" });
    await (registry as unknown as { remove(n: string): Promise<void> }).remove("worker-svc");
    const names = (await (registry as unknown as { list(): Promise<Array<{ name: string }>> }).list()).map(s => s.name);
    expect(names).toContain("worker-svc");
  });
});

describe("9. Windows current-drive-relative layer paths", () => {
  it("refuses \\org entries on every platform", () => {
    expect(() => resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: "\\org" }))
      .toThrow(/current-drive-relative/);
  });

  it("still accepts absolute entries", () => {
    expect(resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: root })).toEqual([resolve(root)]);
  });

  it("refuses /org root-relative entries under Windows path semantics, with either separator", () => {
    expect(() => resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: "/org" }, { platform: "win32" }))
      .toThrow(/current-drive-relative/);
    expect(() => resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: "\\org" }, { platform: "win32" }))
      .toThrow(/current-drive-relative/);
  });

  it("keeps /org valid on POSIX even though Windows path semantics refuse it", () => {
    expect(resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: "/org" })).toEqual([resolve("/org")]);
  });

  it("keeps drive-qualified and UNC paths under Windows path semantics", () => {
    expect(() => resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: "C:\\org" }, { platform: "win32" })).not.toThrow();
    expect(resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: "C:\\org" }, { platform: "win32" })).toHaveLength(1);
    expect(() => resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: "\\\\server\\share" }, { platform: "win32" })).not.toThrow();
    expect(resolveConfigLayers(null, { AIWG_CONFIG_LAYERS: "\\\\server\\share" }, { platform: "win32" })).toHaveLength(1);
  });
});

describe("10. Codex envFrom rendering agrees across implementations", () => {
  const server = {
    name: "codex-svc",
    type: "stdio",
    command: "codex-helper",
    envFrom: { VAULT_TOKEN: "VAULT_TOKEN" },
  };

  it.each(registryImplementations)("$implementation renders Codex envFrom without throwing", ({ build }) => {
    expect(build(server as never, "codex" as never)).toEqual({});
  });
});

describe("8. list/update output redaction", () => {
  beforeEach(() => {
    writeRegistryFile(configDir, {
      stdio: {
        name: "stdio",
        type: "stdio",
        command: "helper-bin",
        args: ["--token", "SYNTHETIC-ARG-TOKEN", "--flag"],
      },
      remote: {
        name: "remote",
        type: "http",
        url: "https://operator:SYNTHETIC-URL-PW@synthetic.example/mcp?token=SYNTHETIC-QUERY&mode=fast",
      },
    });
  });

  it("list masks arg values, userinfo and query values", () => {
    const output = runCli(["list"]);
    expect(output).toContain("--token ***");
    expect(output).toContain("token=***");
    expect(output).toContain("mode=fast");
    expect(output).toContain("***@synthetic.example");
    expect(output).not.toContain("SYNTHETIC-ARG-TOKEN");
    expect(output).not.toContain("SYNTHETIC-URL-PW");
    expect(output).not.toContain("SYNTHETIC-QUERY");
  });

  it("update masks arg values and query values in the echo", () => {
    const output = runCli(["update", "stdio", "--args", "--token,SYNTHETIC-UPDATE"]);
    expect(output).toContain("***");
    expect(output).not.toContain("SYNTHETIC-UPDATE");
    const urlOutput = runCli(["update", "remote", "--url", "https://synthetic.example/mcp?token=SYNTHETIC-UPDATE-QUERY"]);
    expect(urlOutput).toContain("token=***");
    expect(urlOutput).not.toContain("SYNTHETIC-UPDATE-QUERY");
  });
});
