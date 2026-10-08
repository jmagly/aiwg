/**
 * MCP credential references and credential policy.
 *
 * Golden files under test/fixtures/mcp-credential-references hold the exact
 * entry each harness receives for test/fixtures/mcp-credential-references/servers.json.
 *
 * @source @src/mcp/credentials.mjs
 * @source @src/mcp/registry.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "os";
import { join, resolve, sep } from "node:path";
import { stripMcpServers } from "../../../src/mcp/toml-strip-mcp.mjs";
import { parseTOML } from "toml-eslint-parser";
import { ensureRuntimeHome, writeProfileConfig, launchWithProfile, loginInProfile, removeRuntimeHome } from "../../../src/mcp/adapters/codex-runtime.js";

vi.mock("os", async importOriginal => {
  const os = await importOriginal<typeof import("os")>();
  return { ...os, homedir: vi.fn(() => os.tmpdir()) };
});
vi.mock("child_process", async importOriginal => {
  const childProcess = await importOriginal<typeof import("child_process")>();
  return { ...childProcess, spawnSync: vi.fn(() => ({ status: 0 })) };
});

import { McpServerRegistry, injectServers, getProviderConfigPath, buildServerConfig, buildServerToml, type McpServerDefinition, type InjectProvider } from "../../../src/mcp/registry.js";
import { McpServerRegistry as RuntimeRegistry, injectServers as runtimeInjectServers, getProviderConfigPath as runtimeGetProviderConfigPath, buildServerConfig as runtimeBuildServerConfig, buildServerToml as runtimeBuildServerToml } from "../../../src/mcp/registry.mjs";
import {
  assertCredentialPolicy,
  credentialPolicyViolations,
  resolveCredentialPolicy,
} from "../../../src/mcp/credentials.mjs";

const fixtures = resolve(__dirname, "../../fixtures/mcp-credential-references");
const servers = JSON.parse(readFileSync(join(fixtures, "servers.json"), "utf-8")) as McpServerDefinition[];
const cliPath = resolve(__dirname, "../../../src/mcp/cli.mjs");

const implementations = [
  { implementation: "TypeScript", build: buildServerConfig, toml: buildServerToml },
  {
    implementation: "runtime",
    build: runtimeBuildServerConfig as typeof buildServerConfig,
    toml: runtimeBuildServerToml as typeof buildServerToml,
  },
];

describe.each(implementations)("$implementation credential reference rendering", ({ build, toml }) => {
  it.each(["claude-code", "cursor", "windsurf", "factory", "opencode"] as InjectProvider[])("matches the %s golden file", provider => {
    const rendered = Object.fromEntries(servers.map(server => [server.name, build(server, provider)]));
    expect(rendered).toEqual(JSON.parse(readFileSync(join(fixtures, `${provider}.golden.json`), "utf-8")));
  });

  it("matches the codex golden file", () => {
    expect(servers.map(server => toml(server)).join("\n\n") + "\n").toBe(readFileSync(join(fixtures, "codex.golden.toml"), "utf-8"));
  });

  it.each(["antigravity", "warp"] as InjectProvider[])("refuses references for %s, which documents no interpolation", provider => {
    expect(() => build(servers[1], provider)).toThrow(/documents no environment interpolation/);
    expect(() => build(servers[0], provider)).toThrow(/documents no environment interpolation/);
  });

  it("renders literal-only servers unchanged for harnesses without interpolation", () => {
    expect(build({ name: "plain", type: "http", url: "https://plain.example/mcp" }, "antigravity")).toEqual({ serverUrl: "https://plain.example/mcp" });
  });

  it("refuses a Codex env-from that renames the variable", () => {
    expect(() => toml({ name: "x", type: "stdio", command: "x", envFrom: { TOKEN: "OTHER" } })).toThrow(/under their own name only/);
  });
});

describe("credential policy", () => {
  const literal: McpServerDefinition = { name: "literal", type: "http", url: "https://user:pass@literal.example/mcp", headers: { Authorization: "Bearer synthetic" } };
  const referenced: McpServerDefinition = { name: "referenced", type: "http", url: "https://ref.example/mcp", headerEnv: { Authorization: "REF_TOKEN" } };
  const bare: McpServerDefinition = { name: "bare", type: "stdio", command: "bare" };

  it("names every literal field under references", () => {
    expect(credentialPolicyViolations(literal, "references")).toEqual(["headers", "url userinfo"]);
    expect(credentialPolicyViolations(referenced, "references")).toEqual([]);
    expect(credentialPolicyViolations({ name: "s", type: "stdio", command: "s", env: { A: "1" } }, "references")).toEqual(["env"]);
  });

  it("forbids references too under none", () => {
    expect(credentialPolicyViolations(referenced, "none")).toEqual(["headerEnv"]);
    expect(credentialPolicyViolations({ name: "s", type: "stdio", command: "s", envFrom: { A: "A" } }, "none")).toEqual(["envFrom"]);
    expect(credentialPolicyViolations(bare, "none")).toEqual([]);
  });

  it("reports every offending server in one error", () => {
    expect(() => assertCredentialPolicy([literal, referenced, bare], "none"))
      .toThrow("Refusing to render MCP servers with credentials: literal (headers, url userinfo); referenced (headerEnv)");
  });

  it("resolves flag, then environment, then registry, then literal", () => {
    expect(resolveCredentialPolicy({ env: {} })).toBe("literal");
    expect(resolveCredentialPolicy({ registryPolicy: "references", env: {} })).toBe("references");
    expect(resolveCredentialPolicy({ registryPolicy: "references", env: { AIWG_MCP_CREDENTIAL_POLICY: "none" } })).toBe("none");
    expect(resolveCredentialPolicy({ flag: "references", registryPolicy: "none", env: { AIWG_MCP_CREDENTIAL_POLICY: "none" } })).toBe("references");
    expect(() => resolveCredentialPolicy({ flag: "lax", env: {} })).toThrow(/Unknown MCP credential policy/);
  });
});

describe("Codex runtime-home config permissions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aiwg-codex-runtime-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.stubEnv("CODEX_HOME", join(root, ".codex"));
    vi.mocked(homedir).mockReturnValue(root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("uses CODEX_HOME for persistent and runtime paths without changing HOME", async () => {
    const codexDir = join(root, "custom-codex");
    vi.stubEnv("CODEX_HOME", codexDir);
    mkdirSync(codexDir);
    writeFileSync(join(codexDir, "config.toml"), 'model = "custom-home"\n');
    for (const getPath of [getProviderConfigPath, runtimeGetProviderConfigPath]) {
      for (const provider of ["codex", "openai"] as const) {
        expect(getPath(provider, root)).toBe(join(codexDir, "config.toml"));
      }
    }
    await writeProfileConfig("custom-home", []);
    expect(readFileSync(join(codexDir, "roles-runtime/custom-home/config.toml"), "utf-8"))
      .toContain('model = "custom-home"');
    expect(existsSync(join(root, ".codex"))).toBe(false);
  });

  it("launches and logs in with the profile CODEX_HOME rather than an inherited home", async () => {
    const runtimeHome = await ensureRuntimeHome("isolated");
    vi.mocked(spawnSync).mockClear();
    launchWithProfile("isolated", ["--version"]);
    await loginInProfile("isolated");
    expect(spawnSync).toHaveBeenCalledTimes(2);
    for (const [, , options] of vi.mocked(spawnSync).mock.calls) {
      expect(options?.env?.HOME).toBe(runtimeHome);
      expect(options?.env?.CODEX_HOME).toBe(runtimeHome);
    }
  });

  it.each([false, true])("writes owner-only config.toml (pre-existing: %s)", async preExisting => {
    const configPath = join(root, ".codex", "roles-runtime", "test-profile", "config.toml");
    if (preExisting) {
      mkdirSync(join(root, ".codex", "roles-runtime", "test-profile"), { recursive: true });
      writeFileSync(configPath, "old config");
      if (process.platform !== "win32") chmodSync(configPath, 0o644);
    }
    const before = preExisting ? statSync(configPath) : null;
    await writeProfileConfig("test-profile", [{
      name: "remote", type: "http", url: "https://example.test/mcp",
      headers: { Authorization: "Bearer synthetic" },
    }]);
    expect(readFileSync(configPath, "utf-8")).toContain("Bearer synthetic");
    if (before) expect(statSync(configPath).ino).not.toBe(before.ino);
    expect(readdirSync(join(configPath, ".."))).toEqual(["config.toml"]);
    if (process.platform !== "win32") {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(configPath, "..")).mode & 0o777).toBe(0o700);
    }
  });
});

describe("Codex global MCP subtree isolation", () => {
  let root: string;
  const baseForms = [
    'mcp_servers = { x = { url = "https://base.example/mcp", http_headers = { Authorization = "Bearer base-secret" } } }',
    'mcp_servers.x.url = "https://base.example/mcp"\nmcp_servers.x.http_headers.Authorization = "Bearer base-secret"',
    '[mcp_servers]\nx = { url = "https://base.example/mcp", http_headers = { Authorization = "Bearer base-secret" } }',
    '["mcp_servers"."x"]\nurl = "https://base.example/mcp"\nhttp_headers = { Authorization = "Bearer base-secret" }',
    "[ 'mcp_servers' . 'x' ]\nurl = 'https://base.example/mcp'\nhttp_headers = { Authorization = 'Bearer base-secret' }",
    '[[ mcp_servers.x ]]\nurl = "https://base.example/mcp"\nhttp_headers = { Authorization = "Bearer base-secret" }',
    '[mcp_servers.x.http_headers]\nAuthorization = "Bearer base-secret"',
    '"mcp_\\u0073ervers".x.url = "https://base.example/mcp"\n"mcp_servers".x.http_headers.Authorization = "Bearer base-secret"',
    'mcp_servers = {\n x = { url = "https://base.example/mcp",\n http_headers = { Authorization = "Bearer base-secret" } }\n}',
    '[mcp_servers.x]\nargs = [\n "https://base.example/mcp", # ] not a delimiter\n "Bearer base-secret",\n]\nnotes = """\n[preferences]\nBearer base-secret\n"""',
    "[mcp_servers.x]\nnotes = '''\n[preferences]\nBearer base-secret\n'''",
  ];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aiwg-codex-strip-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.stubEnv("CODEX_HOME", join(root, ".codex"));
    vi.mocked(homedir).mockReturnValue(root);
    mkdirSync(join(root, ".codex"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('supports a symlinked global .codex home while keeping runtime directories private', async () => {
    rmSync(join(root, '.codex'), { recursive: true });
    const target = join(root, 'dotfiles-codex');
    mkdirSync(target);
    symlinkSync(target, join(root, '.codex'));
    writeFileSync(join(target, 'config.toml'), 'model = "keep"\n');
    await ensureRuntimeHome('test');
    await writeProfileConfig('test', []);
    expect(readFileSync(join(target, 'roles-runtime/test/config.toml'), 'utf-8')).toContain('model = "keep"');
    expect(statSync(join(target, 'roles-runtime/test')).mode & 0o777).toBe(0o700);
  });

  it.each(['..', '../escape', 'nested/name', 'nested\\name', '/absolute', ''])('rejects unsafe runtime profile name %s before filesystem access', async profile => {
    await expect(ensureRuntimeHome(profile)).rejects.toThrow(/Invalid profile name/);
    await expect(writeProfileConfig(profile, [])).rejects.toThrow(/Invalid profile name/);
    expect(() => launchWithProfile(profile)).toThrow(/Invalid profile name/);
    await expect(loginInProfile(profile)).rejects.toThrow(/Invalid profile name/);
    await expect(removeRuntimeHome(profile)).rejects.toThrow(/Invalid profile name/);
    expect(readdirSync(join(root, '.codex'))).toEqual([]);
  });

  it.each(['\n', '\r\n'])('preserves unrelated multiline MCP-looking text with %j endings', newline => {
    const base = ['model = "keep"', 'notes = """', '[mcp_servers.fake]', '"""',
      "literal = '''", '[mcp_servers.other]', "'''", '[preferences]', 'keep = true', ''].join(newline);
    expect(stripMcpServers(base)).toBe(base);
    expect(stripMcpServers(base + '[mcp_servers.old]' + newline + 'command = "remove"' + newline)).toBe(base);
  });

  it.each(baseForms.flatMap(base => ["none", "references"].map(policy => ({ base, policy }))))(
    "removes the complete base MCP subtree under $policy: $base", async ({ base, policy }) => {
      const safe = 'model = "keep-model"\nnotes = """\n[mcp_servers.fake]\nnot a header\n"""\n';
      const tail = '\n[preferences]\nkeep = [\n "one",\n { text = "[mcp_servers.fake]" },\n]\n';
      writeFileSync(join(root, ".codex/config.toml"), safe + base + tail);
      const selected: McpServerDefinition = { name: "selected", type: "http", url: "https://selected.example/mcp",
        ...(policy === "references" ? { headerEnv: { Authorization: "SELECTED_TOKEN" } } : {}) };
      await writeProfileConfig("test", [selected], { credentialPolicy: policy as "none" | "references" });
      const completed = readFileSync(join(root, ".codex/roles-runtime/test/config.toml"), "utf-8");
      expect(completed).toContain(safe.trimEnd());
      expect(completed).toContain(tail.trimEnd());
      expect(completed).toContain('[mcp_servers.selected]');
      expect(completed).not.toContain("base.example");
      expect(completed).not.toContain("base-secret");
      expect(completed).not.toMatch(/mcp_servers[.\"]+x/);
      const tables = parseTOML(completed, { tomlVersion: '1.1.0' }).body[0].body;
      expect(tables.filter(node => node.type === 'TOMLTable' && node.resolvedKey[0] === 'mcp_servers')
        .map(node => node.type === 'TOMLTable' ? node.resolvedKey : [])).toEqual([['mcp_servers', 'selected']]);
      if (policy === "references") expect(completed).toContain('Authorization = "SELECTED_TOKEN"');
    },
  );

  it.each([
    'notes = """unterminated', "notes = '''unterminated", 'notes = "unterminated',
    'args = ["one",', 'args = { x = ["one" }', '[mcp_servers.x',
    'not a TOML key/value', 'model = "ok" mcp_servers.x.url = "base-secret"',
    'mcp_servers = { x = { url = "base-secret" }',
  ])("fails closed on malformed base config: %s", async base => {
    writeFileSync(join(root, ".codex/config.toml"), base);
    const destination = join(root, ".codex/roles-runtime/test/config.toml");
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, "previous-runtime");
    await expect(writeProfileConfig("test", [], { credentialPolicy: "none" })).rejects.toThrow(/Refusing to copy base Codex config/);
    expect(readFileSync(destination, "utf-8")).toBe("previous-runtime");
    expect(readdirSync(join(destination, ".."))).toEqual(["config.toml"]);
  });

  it.each(["home", "config", "parent", "dangling-home", "dangling-config"])("refuses symlinked runtime %s", async kind => {
    const runtime = join(root, ".codex/roles-runtime/test");
    const outside = join(root, "outside");
    if (!kind.startsWith("dangling")) mkdirSync(outside);
    if (kind === "parent") symlinkSync(outside, join(root, ".codex/roles-runtime"));
    else if (kind.endsWith("home")) {
      mkdirSync(join(runtime, ".."));
      symlinkSync(outside, runtime);
    } else {
      mkdirSync(runtime, { recursive: true });
      if (kind === "config") writeFileSync(join(outside, "config.toml"), "untouched");
      symlinkSync(join(outside, "config.toml"), join(runtime, "config.toml"));
    }
    await expect(ensureRuntimeHome("test")).rejects.toThrow(/symlink/);
    await expect(writeProfileConfig("test", [])).rejects.toThrow(/symlink/);
    if (kind === "config") expect(readFileSync(join(outside, "config.toml"), "utf-8")).toBe("untouched");
    else if (!kind.startsWith("dangling")) expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(kind === "parent" ? join(root, ".codex/roles-runtime") : kind.endsWith("home") ? runtime : join(runtime, "config.toml")).isSymbolicLink()).toBe(true);
  });

  it("renders credentials and filters in the same server table and returns unsupported-filter warnings", async () => {
    const warnings = await writeProfileConfig("combined", [
      { name: "remote", type: "http", url: "https://example.test/mcp", headerEnv: { Authorization: "TOKEN" } },
      { name: "local", type: "stdio", command: "local", envFrom: { LOCAL_TOKEN: "LOCAL_TOKEN" } },
    ], {
      credentialPolicy: "references",
      toolFilters: { deny: ["remote__delete", "remote__admin_*", "local__*"], allow: ["remote__list"] },
    });
    const configPath = join(root, ".codex", "roles-runtime", "combined", "config.toml");
    const text = readFileSync(configPath, "utf-8");
    const [remote, local] = text.split("[mcp_servers.local]");
    expect(remote).toContain('env_http_headers = { Authorization = "TOKEN" }');
    expect(remote).toContain('enabled_tools = ["list"]');
    expect(remote).toContain('disabled_tools = ["delete"]');
    expect(local).toContain('env_vars = ["LOCAL_TOKEN"]');
    expect(local).toContain("enabled = false");
    expect(warnings).toEqual([expect.stringContaining('remote__admin_*')]);
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("refuses credentials before creating a runtime home even with filters", async () => {
    await expect(writeProfileConfig("refused", servers, {
      credentialPolicy: "none",
      toolFilters: { deny: ["tracker__delete"], allow: [] },
    })).rejects.toThrow(/Refusing to render/);
    expect(existsSync(join(root, ".codex", "roles-runtime"))).toBe(false);
    expect(readdirSync(join(root, ".codex"))).toEqual([]);
  });

  describe.each([
    { implementation: "TypeScript", Registry: McpServerRegistry, inject: injectServers },
    { implementation: "runtime", Registry: RuntimeRegistry as unknown as typeof McpServerRegistry, inject: runtimeInjectServers as typeof injectServers },
  ])("$implementation combined persistent rendering", ({ Registry, inject }) => {
    it.each(["codex", "claude-code", "opencode", "factory"] as InjectProvider[])("renders references and filters for %s", async provider => {
      const registry = new Registry(join(root, "registry"));
      await registry.add({ name: "remote", type: "http", url: "https://example.test/mcp", headerEnv: { Authorization: "TOKEN" } });
      const result = await inject(registry, provider, {
        projectDir: root, credentialPolicy: "references",
        toolFilters: { deny: ["remote__delete"], allow: provider === "claude-code" ? [] : ["remote__list"] },
      });
      expect(result.configPath.startsWith(root + sep)).toBe(true);
      const text = readFileSync(result.configPath, "utf-8");
      if (provider === "codex") {
        expect(text).toContain('env_http_headers = { Authorization = "TOKEN" }');
        expect(text).toContain('disabled_tools = ["delete"]');
        expect(text).toContain('enabled_tools = ["list"]');
      } else {
        const config = JSON.parse(text);
        if (provider === "opencode") {
          expect(config.mcp.remote.headers.Authorization).toBe("{env:TOKEN}");
          expect(config.tools).toEqual({ remote_delete: false, remote_list: true, "remote_*": false });
        } else {
          expect(config.mcpServers.remote.headers.Authorization).toBe("${TOKEN}");
          if (provider === "factory") expect(config.mcpServers.remote.disabledTools).toEqual(["delete"]);
          else expect(JSON.parse(readFileSync(result.settingsPath!, "utf-8")).permissions)
            .toEqual({ deny: ["mcp__remote__delete"] });
        }
      }
      expect(result.warnings?.length).toBe(provider === "factory" ? 1 : 0);
    });

    it("refuses credentials before writing either Claude file", async () => {
      const registry = new Registry(join(root, "registry"));
      await registry.add({ name: "remote", type: "http", url: "https://example.test/mcp", headerEnv: { Authorization: "TOKEN" } });
      await expect(inject(registry, "claude-code", {
        projectDir: root, credentialPolicy: "none",
        toolFilters: { deny: ["remote__delete"], allow: [] },
      })).rejects.toThrow(/Refusing to render/);
      expect(existsSync(join(root, ".mcp.json"))).toBe(false);
      expect(existsSync(join(root, ".claude"))).toBe(false);
    });
  });
});

describe("aiwg mcp inject credential flags", () => {
  let root: string;
  let configDir: string;
  let projectDir: string;
  const canary = "synthetic-canary-value-7f3a";

  function run(args: string[], extraEnv: Record<string, string> = {}) {
    return execFileSync(process.execPath, [cliPath, ...args], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: join(root, "home"), AIWG_CONFIG: configDir, TMPDIR: root, TRACKER_AUTHORIZATION: canary, ...extraEnv },
    });
  }

  function runFailing(args: string[], extraEnv: Record<string, string> = {}) {
    try {
      run(args, extraEnv);
    } catch (error) {
      return error as { status: number; stderr: string };
    }
    throw new Error("expected the CLI to fail");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aiwg-mcp-cred-"));
    configDir = join(root, "config");
    projectDir = join(root, "project");
    for (const dir of [configDir, projectDir, join(root, "home")]) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function registry(entries: McpServerDefinition[], credentialPolicy?: string) {
    writeFileSync(join(configDir, "mcp-servers.json"), JSON.stringify({
      apiVersion: "aiwg.io/v1",
      kind: "McpServerRegistry",
      ...(credentialPolicy ? { credentialPolicy } : {}),
      servers: Object.fromEntries(entries.map(entry => [entry.name, entry])),
    }));
  }

  it.each(['references', 'none'])('refuses malformed URL userinfo under %s without writing or printing it', policy => {
    registry([{ name: 'remote', type: 'http', url: 'https://user:malformed-canary@bad host/mcp' }], policy);
    const failure = runFailing(['inject', '--provider', 'codex']);
    expect(failure.stderr).toContain('url userinfo');
    expect(failure.stderr).not.toContain('malformed-canary');
    expect(existsSync(join(root, 'home/.codex/config.toml'))).toBe(false);
  });

  it.each(['auth', 'oauth'])('refuses userinfo in OMP %s tokenUrl under references', field => {
    registry([{ name: 'remote', type: 'http', url: 'https://example.test/mcp',
      [field]: { ...(field === 'auth' ? { type: 'oauth' } : {}), tokenUrl: 'https://client:oauth-canary@idp.example/token' },
    }], 'references');
    const failure = runFailing(['inject', '--provider', 'omp']);
    expect(failure.stderr).toContain(`${field}.tokenUrl userinfo`);
    expect(failure.stderr).not.toContain('oauth-canary');
    expect(existsSync(join(projectDir, '.omp/mcp.json'))).toBe(false);
  });

  it("--strict-credentials renders references and never the variable's value", () => {
    registry([{ name: "tracker", type: "http", url: "https://tracker.example/mcp", headerEnv: { Authorization: "TRACKER_AUTHORIZATION" } }]);
    run(["inject", "--provider", "claude", "--strict-credentials"]);
    const written = readFileSync(join(projectDir, ".mcp.json"), "utf-8");
    expect(written).not.toContain(canary);
    expect(JSON.parse(written).mcpServers.tracker.headers).toEqual({ Authorization: "${TRACKER_AUTHORIZATION}" });
  });

  it("--strict-credentials refuses a literal header and writes nothing", () => {
    registry([{ name: "leaky", type: "http", url: "https://leaky.example/mcp", headers: { Authorization: "Bearer literal" } }]);
    const failure = runFailing(["inject", "--provider", "claude", "--strict-credentials"]);
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain("leaky (headers)");
    expect(existsSync(join(projectDir, ".mcp.json"))).toBe(false);
  });

  it("--no-credentials refuses references, including in --ephemeral mode", () => {
    registry([servers[1]]);
    const out = join(root, "ephemeral.json");
    const failure = runFailing(["inject", "--provider", "claude", "--ephemeral", "--out", out, "--no-credentials"]);
    expect(failure.stderr).toContain("tracker (headers, headerEnv)");
    expect(existsSync(out)).toBe(false);
  });

  it("--no-credentials passes a server that carries none", () => {
    registry([{ name: "bare", type: "http", url: "https://bare.example/mcp" }]);
    const out = join(root, "ephemeral.json");
    run(["inject", "--provider", "claude", "--ephemeral", "--out", out, "--no-credentials"]);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual({ mcpServers: { bare: { type: "http", url: "https://bare.example/mcp" } } });
  });

  it("applies the registry policy set by credential-policy, and the environment overrides it", () => {
    registry([{ name: "leaky", type: "stdio", command: "leaky", env: { TOKEN: "literal" } }]);
    run(["credential-policy", "references"]);
    expect(run(["credential-policy"]).trim()).toBe("references");
    expect(runFailing(["inject", "--provider", "cursor"]).stderr).toContain("leaky (env)");
    run(["inject", "--provider", "cursor"], { AIWG_MCP_CREDENTIAL_POLICY: "literal" });
    expect(JSON.parse(readFileSync(join(projectDir, ".cursor/mcp.json"), "utf-8")).mcpServers.leaky.env).toEqual({ TOKEN: "literal" });
  });

  it("stores --env-from as a variable name only", () => {
    registry([]);
    run(["add", "github", "--type", "stdio", "--command", "github-mcp-server", "--env-from", "GITHUB_TOKEN=GITHUB_TOKEN"]);
    const stored = JSON.parse(readFileSync(join(configDir, "mcp-servers.json"), "utf-8")).servers.github;
    expect(stored.envFrom).toEqual({ GITHUB_TOKEN: "GITHUB_TOKEN" });
    expect(stored.env).toBeUndefined();
  });
});
