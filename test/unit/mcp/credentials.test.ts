/**
 * MCP credential references and credential policy.
 *
 * Golden files under test/fixtures/mcp-credential-references hold the exact
 * entry each harness receives for test/fixtures/mcp-credential-references/servers.json.
 *
 * @source @src/mcp/credentials.mjs
 * @source @src/mcp/registry.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildServerConfig, buildServerToml, type McpServerDefinition, type InjectProvider } from "../../../src/mcp/registry.js";
import { buildServerConfig as runtimeBuildServerConfig, buildServerToml as runtimeBuildServerToml } from "../../../src/mcp/registry.mjs";
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
