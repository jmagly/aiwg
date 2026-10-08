/**
 * `aiwg mcp inject` CLI rendering tests.
 *
 * Runs the real CLI against a temporary AIWG_CONFIG and HOME and compares the
 * rendered provider files byte for byte.
 *
 * @source @src/mcp/cli.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync,
  chmodSync, lstatSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

function runCliWithOutput(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: homeDir, AIWG_CONFIG: configDir, TMPDIR: root, ...env },
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
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

  it.each([false, true])("refuses literal env and header values without printing them (existing=%s)", existing => {
    writeRegistry({
      local: { name: "local", type: "stdio", command: "synthetic-command", env: { API_TOKEN: "canary-value-123" } },
      remote: { name: "remote", type: "http", url: "https://synthetic.example/mcp", headers: { Authorization: "Bearer canary-hdr-456" } },
    });

    const destination = join(projectDir, ".mcp.json");
    const original = '{ "mcpServers": {}, "preference": "keep" }\n';
    if (existing) writeFileSync(destination, original);
    const before = readFileSync(join(configDir, "mcp-servers.json"), "utf-8");
    const result = runCliWithOutput(["inject", "--provider", "claude"]);
    expect(result.status).toBe(1);
    if (existing) expect(readFileSync(destination, "utf-8")).toBe(original);
    else expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(configDir, "mcp-servers.json"), "utf-8")).toBe(before);
    expect(result.stderr).toContain("--scope user");
    expect(result.stderr).toContain("local has literal env/header values (API_TOKEN)");
    expect(result.stderr).toContain("remote has literal env/header values (Authorization)");
    expect(result.stderr).toContain(".mcp.json");
    expect(`${result.stdout}${result.stderr}`).not.toContain("canary-value-123");
    expect(`${result.stdout}${result.stderr}`).not.toContain("canary-hdr-456");
  });

  it("allows literal values at user scope and creates a private config", () => {
    writeRegistry({
      local: { name: "local", type: "stdio", command: "synthetic-command", env: { API_TOKEN: "canary-value-123" } },
    });
    const result = runCliWithOutput(["inject", "--provider", "claude", "--scope", "user"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Refusing");
    const destination = join(homeDir, ".claude.json");
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(destination, "utf-8")).mcpServers.local.env.API_TOKEN).toBe("canary-value-123");
  });

  it("allows servers without literal env or headers", () => {
    const result = runCliWithOutput(["inject", "--provider", "claude"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Refusing");
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

  it("writes default ephemeral files inside a private directory under TMPDIR", () => {
    const stdout = runCli(["inject", "--provider", "claude", "--ephemeral"]);
    const out = stdout.match(/^claude-code: (.+)$/m)![1];
    expect(dirname(dirname(out))).toBe(root);
    expect(basename(dirname(out))).toMatch(/^aiwg-mcp-/);
    expect(basename(out)).toBe("custom-claude-code.json");
    expect(JSON.parse(readFileSync(out, "utf-8")).mcpServers.remote.url).toBe("https://synthetic.example/mcp");
    if (process.platform !== "win32") {
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(out)).mode & 0o777).toBe(0o700);
    }
  });

  it.each([false, true])("writes owner-only --out files (pre-existing: %s)", preExisting => {
    const out = join(root, "ephemeral.json");
    if (preExisting) {
      writeFileSync(out, "old config");
      if (process.platform !== "win32") chmodSync(out, 0o644);
    }
    runCli(["inject", "--provider", "claude", "--ephemeral", "--out", out]);
    expect(JSON.parse(readFileSync(out, "utf-8")).mcpServers).toHaveProperty("remote");
    if (process.platform !== "win32") expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("refuses symlink --out paths without modifying the target", () => {
    const target = join(root, "target.json");
    const out = join(root, "ephemeral.json");
    writeFileSync(target, "untouched");
    symlinkSync(target, out);
    const result = runCliWithOutput(["inject", "--provider", "claude", "--ephemeral", "--out", out]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to write ephemeral MCP config to symbolic link");
    expect(readFileSync(target, "utf-8")).toBe("untouched");
    expect(lstatSync(out).isSymbolicLink()).toBe(true);
  });

  it("writes nothing for ephemeral dry runs, with or without --out", () => {
    const before = readdirSync(root);
    runCli(["inject", "--provider", "claude", "--ephemeral", "--dry-run"]);
    const out = join(root, "new-dir", "ephemeral.json");
    runCli(["inject", "--provider", "claude", "--ephemeral", "--out", out, "--dry-run"]);
    expect(readdirSync(root)).toEqual(before);
    expect(existsSync(out)).toBe(false);
  });
});

describe("aiwg mcp credential display", () => {
  it.each(["add", "update"])("redacts URL userinfo and prints only env/header keys on %s", command => {
    const name = command === "add" ? "new-remote" : "remote";
    const result = runCliWithOutput([command, name, "--url", "https://user:canary-pass-789@example.test/mcp",
      "--env", "TOKEN=canary-env-123", "--headers", "Authorization=canary-header-456"]);
    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("https://***@example.test/mcp");
    expect(output).toContain("env: TOKEN");
    expect(output).toContain("headers: Authorization");
    for (const value of ["canary-pass-789", "user:", "canary-env-123", "canary-header-456"]) expect(output).not.toContain(value);
    const entry = JSON.parse(readFileSync(join(configDir, "mcp-servers.json"), "utf-8")).servers[name];
    expect(entry.env.TOKEN).toBe("canary-env-123");
    expect(entry.headers.Authorization).toBe("canary-header-456");
  });

  it.each(['add', 'update'].flatMap(command => ['--env', '--headers', '--url'].map(flag => ({ command, flag }))))(
    'parses $flag before the name on $command without exposing its value', ({ command, flag }) => {
      const value = flag === '--url' ? 'https://user:order-canary@example.test/mcp' : 'TOKEN=order-canary';
      const name = command === 'add' ? 'new-remote' : 'remote';
      const result = runCliWithOutput([command, flag, value, name, '--type', 'http', '--url',
        'https://user:order-canary@example.test/mcp']);
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('order-canary');
      expect(result.stdout).toContain(`${command === 'add' ? 'Added' : 'Updated'} MCP server: ${name}`);
      expect(JSON.parse(readFileSync(join(configDir, 'mcp-servers.json'), 'utf-8')).servers[name].name).toBe(name);
    });

  it('does not treat a header value as the name on a missing-server update', () => {
    const result = runCliWithOutput(['update', '--headers', 'Authorization=error-canary', 'missing']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('missing');
    expect(result.stdout + result.stderr).not.toContain('error-canary');
  });

  it.each(['add', 'update'])('redacts malformed URL userinfo on %s', command => {
    const result = runCliWithOutput([command, command === 'add' ? 'new-remote' : 'remote', '--url', 'https://user:malformed-canary@bad host/mcp']);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('malformed-canary');
    expect(result.stdout + result.stderr).not.toContain('user:');
  });

  it.each(["list", "profile show"])("redacts URL userinfo and omits env/header values in %s", command => {
    writeRegistry({
      remote: { name: "remote", type: "http", url: "https://user:canary-pass-789@example.test/mcp",
        headers: { Authorization: "canary-header-456" } },
      local: { name: "local", type: "stdio", command: "synthetic-command", env: { TOKEN: "canary-env-123" } },
    });
    runCli(["profile", "add", "test-profile", "--servers", "remote,local"]);
    const stdout = runCli(command === "list" ? ["list"] : ["profile", "show", "test-profile"]);
    expect(stdout).toContain("https://***@example.test/mcp");
    for (const value of ["canary-pass-789", "user:", "canary-header-456", "canary-env-123"]) {
      expect(stdout).not.toContain(value);
    }
  });

  it("leaves URLs without userinfo and unparseable URLs unchanged", () => {
    writeRegistry({
      plain: { name: "plain", type: "http", url: "https://example.test:443/mcp" },
      invalid: { name: "invalid", type: "http", url: "not a URL" },
    });
    const stdout = runCli(["list"]);
    expect(stdout).toContain("URL: https://example.test:443/mcp");
    expect(stdout).toContain("URL: not a URL");
  });
});

describe("aiwg mcp install claude", () => {
  it.each([undefined, "configured-root"])("default project install succeeds without env (AIWG_ROOT=%s)", aiwgRoot => {
    const result = runCliWithOutput(["install", "claude"], aiwgRoot ? { AIWG_ROOT: aiwgRoot } : {});
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(projectDir, ".mcp.json"), "utf-8"))).toEqual({
      mcpServers: { aiwg: { command: "aiwg", args: ["mcp", "serve"] } },
    });
  });

  it.each([undefined, "configured-root"])("writes private user config with env only when AIWG_ROOT is set (%s)", aiwgRoot => {
    const result = runCliWithOutput(["install", "claude", "--scope", "user"], aiwgRoot ? { AIWG_ROOT: aiwgRoot } : {});
    expect(result.status).toBe(0);
    const destination = join(homeDir, ".claude.json");
    expect(JSON.parse(readFileSync(destination, "utf-8")).mcpServers.aiwg).toEqual({
      command: "aiwg", args: ["mcp", "serve"], ...(aiwgRoot ? { env: { AIWG_ROOT: aiwgRoot } } : {}),
    });
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(existsSync(join(projectDir, ".mcp.json"))).toBe(false);
  });

  it("refuses malformed .mcp.json and leaves it byte-identical", () => {
    const destination = join(projectDir, ".mcp.json");
    const damaged = '{ "mcpServers": { damaged config\n';
    writeFileSync(destination, damaged);
    const result = runCliWithOutput(["install", "claude", projectDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Refusing to overwrite malformed MCP config ${destination}: invalid JSON`);
    expect(readFileSync(destination, "utf-8")).toBe(damaged);
  });
});

const installDestinations = [
  { target: "claude", file: ".mcp.json" },
  { target: "claude", file: ".claude.json", home: true, args: ["--scope", "user"] },
  { target: "cursor", file: ".cursor/mcp.json" },
  { target: "factory", file: ".factory/mcp.json" },
  { target: "factory", file: ".factory/mcp.json", home: true },
  { target: "codex", file: ".codex/config.toml", home: true },
  { target: "openai", file: ".codex/config.toml", home: true },
  { target: "windsurf", file: ".codeium/windsurf/mcp_config.json", home: true },
  { target: "vscode", file: ".vscode/mcp.json" },
  { target: "copilot", file: ".vscode/mcp.json" },
  { target: "opencode", file: "opencode.json" },
  { target: "opencode", file: ".opencode/opencode.json" },
  { target: "opencode", file: ".opencode/opencode.jsonc" },
  { target: "omp", file: ".omp/mcp.json" },
  { target: "oh-my-pi", file: ".omp/mcp.json" },
];

describe("MCP config write safety", () => {
  it.each(["codex", "openai"])("atomically replaces existing private %s TOML during persistent injection", provider => {
    const destination = join(homeDir, ".codex/config.toml");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, 'model = "keep-model"\n[mcp_servers.existing]\ncommand = "keep"\n');
    chmodSync(destination, 0o644);
    const before = statSync(destination);
    runCli(["inject", "--provider", provider]);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(statSync(destination).ino).not.toBe(before.ino);
    const completed = readFileSync(destination, "utf-8");
    expect(completed).toContain('model = "keep-model"');
    expect(completed).toContain('[mcp_servers.existing]');
    expect(completed).toContain('[mcp_servers.remote]');
    expect(readdirSync(dirname(destination))).toEqual(["config.toml"]);
  });

  it.each(["codex", "openai"].flatMap(provider => [false, true].map(dangling => ({ provider, dangling }))))(
    "refuses persistent $provider TOML symlinks (dangling=$dangling)", ({ provider, dangling }) => {
      const destination = join(homeDir, ".codex/config.toml");
      const outside = join(root, "outside.toml");
      mkdirSync(dirname(destination), { recursive: true });
      if (!dangling) writeFileSync(outside, 'model = "untouched"\n');
      symlinkSync(outside, destination);
      const result = runCliWithOutput(["inject", "--provider", provider]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("symlink");
      expect(lstatSync(destination).isSymbolicLink()).toBe(true);
      if (dangling) expect(existsSync(outside)).toBe(false);
      else expect(readFileSync(outside, "utf-8")).toBe('model = "untouched"\n');
    },
  );

  it.each([false, true])("refuses inject through a project .mcp.json symlink (dangling=%s)", dangling => {
    const destination = join(projectDir, ".mcp.json");
    const outside = join(root, "outside.json");
    const original = '{ "mcpServers": {}, "keep": true }\n';
    if (!dangling) writeFileSync(outside, original);
    symlinkSync(outside, destination);
    const registry = readFileSync(join(configDir, "mcp-servers.json"), "utf-8");
    const result = runCliWithOutput(["inject", "--provider", "claude"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(destination);
    expect(result.stderr).toContain("symlink");
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    if (dangling) expect(existsSync(outside)).toBe(false);
    else expect(readFileSync(outside, "utf-8")).toBe(original);
    expect(readFileSync(join(configDir, "mcp-servers.json"), "utf-8")).toBe(registry);
  });

  it.each(["symlink", "credentials"])("preflights --all before any writes on %s refusal", reason => {
    writeRegistry({ local: { name: "local", type: "stdio", command: "synthetic-command", injectedProviders: ["cursor", "claude-code"], ...(reason === "credentials" ? { env: { API_TOKEN: "canary-value-123" } } : {}) } });
    const outside = join(root, "outside.json");
    if (reason === "symlink") {
      writeFileSync(outside, '{}\n');
      symlinkSync(outside, join(projectDir, ".mcp.json"));
    }
    const before = readFileSync(join(configDir, "mcp-servers.json"), "utf-8");
    const result = runCliWithOutput(["inject", "--all"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason === "symlink" ? "symlink" : "API_TOKEN");
    expect(`${result.stdout}${result.stderr}`).not.toContain("canary-value-123");
    expect(existsSync(join(projectDir, ".cursor"))).toBe(false);
    expect(readFileSync(join(configDir, "mcp-servers.json"), "utf-8")).toBe(before);
    if (reason === "symlink") expect(readFileSync(outside, "utf-8")).toBe('{}\n');
    else expect(existsSync(join(projectDir, ".mcp.json"))).toBe(false);
  });

  it("preserves OpenCode JSONC entries containing URL strings", () => {
    const destination = join(projectDir, ".opencode/opencode.jsonc");
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, '// keep existing server\n{ "mcp": { "existing": { "url": "https://synthetic.example/mcp" } } }\n');
    runCli(["install", "opencode", projectDir]);
    expect(JSON.parse(readFileSync(destination, "utf-8")).mcp).toMatchObject({ existing: { url: "https://synthetic.example/mcp" }, aiwg: { type: "local" } });
  });

  it.each(installDestinations.filter(({ home, file }) => !home && file.includes("/")))(
    "refuses install $target through symlinked parent of $file", ({ target, file }) => {
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(projectDir, file.split("/")[0]));
      const result = runCliWithOutput(["install", target, projectDir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/symlink/);
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  const jsonInstalls = installDestinations.filter(({ target }) => !["codex", "openai"].includes(target));
  const invalidObjects = [null, [], "canary", 7, false];
  it.each(jsonInstalls.flatMap(destination => invalidObjects.flatMap(value => [
    { ...destination, original: JSON.stringify(value) },
    { ...destination, original: JSON.stringify({
      [destination.target === "opencode" ? "mcp" : ["vscode", "copilot"].includes(destination.target) ? "servers" : "mcpServers"]: value,
    }) },
  ])))("refuses install $target at $file with invalid object shape $original", ({ target, file, home, args = [], original }) => {
    const destination = join(home ? homeDir : projectDir, file);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, original);
    const before = statSync(destination);
    const result = runCliWithOutput(["install", target, home ? "." : projectDir, ...args]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/object/);
    expect(readFileSync(destination, "utf-8")).toBe(original);
    expect(statSync(destination).ino).toBe(before.ino);
  });

  it.each(installDestinations)("refuses install $target through $file (home=$home)", ({ target, file, home, args = [] }) => {
    const destination = join(home ? homeDir : projectDir, file);
    const outside = join(root, "outside.json");
    const original = '{ "mcpServers": {}, "keep": true }\n';
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(outside, original);
    symlinkSync(outside, destination);
    const result = runCliWithOutput(["install", target, home ? "." : projectDir, ...args]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(destination);
    expect(result.stderr).toContain("symlink");
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf-8")).toBe(original);
  });

  it.each(["inject", "install"])("%s makes existing user config private and preserves other entries with atomic replacement", command => {
    const destination = join(homeDir, ".claude.json");
    writeFileSync(destination, JSON.stringify({ preferences: { keep: true }, mcpServers: { existing: { command: "keep" } } }));
    chmodSync(destination, 0o644);
    const before = statSync(destination);
    const args = command === "inject" ? ["inject", "--provider", "claude"] : ["install", "claude"];
    runCli([...args, "--scope", "user"]);
    const after = statSync(destination);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before.ino);
    expect(JSON.parse(readFileSync(destination, "utf-8"))).toMatchObject({ preferences: { keep: true }, mcpServers: { existing: { command: "keep" } } });
    expect(readdirSync(homeDir)).toEqual([".claude.json"]);
  });

  it.each(installDestinations.filter(destination => destination.home && destination.target !== "claude"))("creates private install config for $target", ({ target, file }) => {
    runCli(["install", target]);
    expect(statSync(join(homeDir, file)).mode & 0o777).toBe(0o600);
  });
});
