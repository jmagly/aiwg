/**
 * `aiwg mcp inject` CLI rendering tests.
 *
 * Runs the real CLI against a temporary AIWG_CONFIG and HOME and compares the
 * rendered provider files byte for byte.
 *
 * @source @src/mcp/cli.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliPath = resolve(__dirname, "../../../src/mcp/cli.mjs");

let root: string;
let configDir: string;
let homeDir: string;
let projectDir: string;

function writeRegistry(servers: Record<string, unknown>) {
  writeFileSync(join(configDir, "mcp-servers.json"), JSON.stringify({
    apiVersion: "aiwg.io/v1",
    kind: "McpServerRegistry",
    servers,
  }));
}

function runCli(args: string[]) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: homeDir, AIWG_CONFIG: configDir, TMPDIR: root },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiwg-mcp-cli-"));
  configDir = join(root, "config");
  homeDir = join(root, "home");
  projectDir = join(root, "project");
  for (const dir of [configDir, homeDir, projectDir]) mkdirSync(dir, { recursive: true });
  writeRegistry({
    remote: { name: "remote", type: "http", url: "https://synthetic.example/mcp" },
    local: { name: "local", type: "stdio", command: "synthetic-command", args: ["--flag"] },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("aiwg mcp inject --provider claude", () => {
  it("writes .mcp.json with typed HTTP entries and leaves .claude/ alone", () => {
    runCli(["inject", "--provider", "claude"]);
    expect(existsSync(join(projectDir, ".claude"))).toBe(false);
    expect(JSON.parse(readFileSync(join(projectDir, ".mcp.json"), "utf-8"))).toEqual({
      mcpServers: {
        remote: { type: "http", url: "https://synthetic.example/mcp" },
        local: { command: "synthetic-command", args: ["--flag"] },
      },
    });
  });

  it("writes an ephemeral --mcp-config file in Claude Code's entry shape", () => {
    const out = join(root, "ephemeral.json");
    const stdout = runCli(["inject", "--provider", "claude", "--ephemeral", "--out", out]);
    expect(stdout).toContain(`claude --mcp-config ${out}`);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual({
      mcpServers: {
        remote: { type: "http", url: "https://synthetic.example/mcp" },
        local: { command: "synthetic-command", args: ["--flag"] },
      },
    });
  });

  it("writes an ephemeral opencode file in opencode's entry shape", () => {
    const out = join(root, "opencode.json");
    runCli(["inject", "--provider", "opencode", "--ephemeral", "--out", out]);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual({
      mcp: {
        remote: { type: "remote", url: "https://synthetic.example/mcp" },
        local: { type: "local", command: ["synthetic-command", "--flag"] },
      },
    });
  });
});

describe("aiwg mcp install claude", () => {
  it("writes the AIWG server to .mcp.json", () => {
    runCli(["install", "claude", projectDir]);
    const written = JSON.parse(readFileSync(join(projectDir, ".mcp.json"), "utf-8"));
    expect(written.mcpServers.aiwg).toMatchObject({ command: "aiwg", args: ["mcp", "serve"] });
    expect(existsSync(join(projectDir, ".claude", "settings.local.json"))).toBe(false);
  });
});
