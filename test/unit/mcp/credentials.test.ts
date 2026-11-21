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
import { spawnSync, spawn } from "child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from 'node:url';
import { tmpdir } from "node:os";
import { homedir } from "os";
import { join, resolve, sep } from "node:path";
import { stripMcpServers } from "../../../src/mcp/toml-strip-mcp.mjs";
import { parseTOML } from "toml-eslint-parser";
import { ensureRuntimeHome, writeProfileConfig, launchWithProfile, loginInProfile, removeRuntimeHome } from "../../../src/mcp/adapters/codex-runtime.js";
import { isInteractive } from "../../../src/cli/env.js";
import { resolveSyncProcessTimeoutMs } from "../../../src/process/bounded-child-process.mjs";

vi.mock("os", async importOriginal => {
  const os = await importOriginal<typeof import("os")>();
  const homedir = vi.fn(() => os.tmpdir());
  return { ...os, homedir, default: { ...os, homedir } };
});

// Spies through to the real implementation by default; the "stays alive
// until the deadline" test below overrides it with `mockReturnValueOnce` so
// that test does not need to wait out the real 120s network-tier bound.
vi.mock("../../../src/process/bounded-child-process.mjs", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/process/bounded-child-process.mjs")>();
  return { ...actual, resolveSyncProcessTimeoutMs: vi.fn(actual.resolveSyncProcessTimeoutMs) };
});

/**
 * A minimal fake async child: a real `EventEmitter` (so `.on`/`.removeListener`
 * behave exactly like Node's own `ChildProcess`, which `spawnCodexLoginWithApiKey()`'s
 * settle()/cleanup path relies on) with a `stdin` that is itself an
 * `EventEmitter` exposing `write`/`end` (used by `loginInProfile`'s
 * credential-safe API-key path, #3062 second review finding 1, go/no-go
 * review blocker 2) and a `kill()`. `end(chunk, callback)` invokes the
 * callback synchronously with no error by default — tests exercising the
 * EPIPE/timeout paths override `spawn`'s mock implementation, or call
 * `child.stdin.emit('error', ...)`/replace `end`, per test. `exitCode`/
 * `signalCode` are updated by `setExit()` before emitting `'exit'`, exactly
 * as Node itself does, so the production code's "is the child still alive"
 * check sees the right answer. Defaults to emitting `exit(0, null)` on the
 * next microtask; tests needing a different outcome override `spawn`'s mock
 * implementation per call.
 */
function makeFakeAsyncChild() {
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdin.write = vi.fn();
  stdin.end = vi.fn((...callArgs: unknown[]) => {
    const callback = callArgs.find((value): value is (err?: Error | null) => void => typeof value === "function");
    callback?.();
    return stdin;
  });
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: typeof stdin;
    stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    setExit(code: number | null, signal: NodeJS.Signals | null): void;
  };
  // A spawned child has a PID; signalChild() refuses to signal one without.
  child.pid = 424242;
  child.stdin = stdin;
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.setExit(null, signal ?? "SIGTERM");
  });
  child.setExit = (code, signal) => {
    child.exitCode = code;
    child.signalCode = signal;
  };
  return child;
}

vi.mock("child_process", async importOriginal => {
  const childProcess = await importOriginal<typeof import("child_process")>();
  return {
    ...childProcess,
    spawnSync: vi.fn(() => ({ status: 0 })),
    spawn: vi.fn(() => {
      const child = makeFakeAsyncChild();
      queueMicrotask(() => {
        child.setExit(0, null);
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    }),
  };
});
// Defaults to an attached terminal (#3062) so pre-existing tests exercising
// launchWithProfile/loginInProfile without a terminal-awareness angle keep
// their original behavior; the dedicated headless tests override this.
vi.mock("../../../src/cli/env.js", () => ({ isInteractive: vi.fn(() => true) }));

import { McpServerRegistry, injectServers, getProviderConfigPath, buildServerConfig, buildServerToml, type McpServerDefinition, type InjectProvider } from "../../../src/mcp/registry.js";
import { McpServerRegistry as RuntimeRegistry, injectServers as runtimeInjectServers, getProviderConfigPath as runtimeGetProviderConfigPath, buildServerConfig as runtimeBuildServerConfig, buildServerToml as runtimeBuildServerToml } from "../../../src/mcp/registry.mjs";
import {
  assertCredentialPolicy,
  credentialPolicyViolations,
  installPolicyCheckedServer,
  INSTALL_POLICY_EXEMPT_ENV,
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
  it.each(["claude-code", "cursor", "devin", "factory", "opencode"] as InjectProvider[])("matches the %s golden file", provider => {
    const rendered = Object.fromEntries(servers.map(server => [server.name, build(server, provider)]));
    expect(rendered).toEqual(JSON.parse(readFileSync(join(fixtures, `${provider === "devin" ? "windsurf" : provider}.golden.json`), "utf-8")));
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

  it.each([null, "", false, 0])("refuses invalid present registry/flag policy %s", value => {
    for (const field of ["flag", "registryPolicy"] as const) {
      expect(() => resolveCredentialPolicy({ [field]: value, env: {} } as unknown as
        Parameters<typeof resolveCredentialPolicy>[0])).toThrow("Unknown MCP credential policy");
    }
    if (value === "") {
      expect(resolveCredentialPolicy({ registryPolicy: "none", env: { AIWG_MCP_CREDENTIAL_POLICY: "" } })).toBe("none");
    } else {
      expect(() => resolveCredentialPolicy({ env: { AIWG_MCP_CREDENTIAL_POLICY: value } } as unknown as
        Parameters<typeof resolveCredentialPolicy>[0])).toThrow("Unknown MCP credential policy");
    }
  });

  it("refuses an invalid floor policy", () => {
    expect(() => resolveCredentialPolicy({ floorPolicy: "lax", env: {} } as unknown as
      Parameters<typeof resolveCredentialPolicy>[0])).toThrow("Unknown MCP credential policy");
  });

  it("warns once per process per value an organisation floor refuses to relax", () => {
    // With no floorPolicy, a flag/env/registry relaxation is a plain default
    // override (see "lets a flag or the environment..." below) and never
    // warns: only an attempt to relax below an enforced floor does.
    const helper = pathToFileURL(resolve(__dirname, "../../../src/mcp/credentials.mjs")).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { resolveCredentialPolicy } from ${JSON.stringify(helper)};
      const warnings = [];
      console.warn = message => warnings.push(message);
      for (let i = 0; i < 3; i++) {
        resolveCredentialPolicy({ floorPolicy: 'none', flag: 'literal', env: {} });
        resolveCredentialPolicy({ floorPolicy: 'references', flag: 'literal', env: {} });
        resolveCredentialPolicy({ floorPolicy: 'none', flag: 'references', env: {} });
      }
      process.stdout.write(JSON.stringify(warnings));
    `], { encoding: "utf-8", timeout: 60_000 });
    expect(JSON.parse(output)).toEqual([
      expect.stringContaining('policy "literal"'), expect.stringContaining('policy "references"'),
    ]);
  });

  it("lets a flag or the environment relax or tighten a personal stored policy, with no floor", () => {
    expect(resolveCredentialPolicy({ env: {} })).toBe("literal");
    expect(resolveCredentialPolicy({ registryPolicy: "references", env: {} })).toBe("references");
    // The environment tightens a personal policy.
    expect(resolveCredentialPolicy({ registryPolicy: "references", env: { AIWG_MCP_CREDENTIAL_POLICY: "none" } })).toBe("none");
    // A flag relaxes a stricter personal policy and a stricter environment value - with no floor,
    // the most specific source (the flag) wins outright, not the strictest value (#280 restored).
    expect(resolveCredentialPolicy({ flag: "references", registryPolicy: "none", env: { AIWG_MCP_CREDENTIAL_POLICY: "none" } })).toBe("references");
    // The environment relaxes a personal policy for the same reason.
    expect(resolveCredentialPolicy({ registryPolicy: "references", env: { AIWG_MCP_CREDENTIAL_POLICY: "literal" } })).toBe("literal");
    // A flag beats the environment regardless of which is stricter.
    expect(resolveCredentialPolicy({ flag: "literal", registryPolicy: "none", env: { AIWG_MCP_CREDENTIAL_POLICY: "none" } })).toBe("literal");
    expect(resolveCredentialPolicy({ flag: "none", registryPolicy: "literal", env: { AIWG_MCP_CREDENTIAL_POLICY: "literal" } })).toBe("none");
    expect(() => resolveCredentialPolicy({ flag: "lax", env: {} })).toThrow(/Unknown MCP credential policy/);
  });

  it("holds an organisation floor that a personal policy, flag or environment value cannot relax", () => {
    // Every non-floor source trying "literal" stays at the "references" floor.
    expect(resolveCredentialPolicy({ floorPolicy: "references", registryPolicy: "literal", env: {} })).toBe("references");
    expect(resolveCredentialPolicy({ floorPolicy: "references", env: { AIWG_MCP_CREDENTIAL_POLICY: "literal" } })).toBe("references");
    expect(resolveCredentialPolicy({ floorPolicy: "references", flag: "literal", env: {} })).toBe("references");
    // Stricter than the floor is always allowed, from any source.
    expect(resolveCredentialPolicy({ floorPolicy: "references", flag: "none", env: {} })).toBe("none");
    // The same attempt relaxes freely once no floor is in play.
    expect(resolveCredentialPolicy({ registryPolicy: "references", flag: "literal", env: {} })).toBe("literal");
  });

  it("names the enforcing layer's config file in the relaxation warning, once per process per value", () => {
    const helper = pathToFileURL(resolve(__dirname, "../../../src/mcp/credentials.mjs")).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { resolveCredentialPolicy } from ${JSON.stringify(helper)};
      const warnings = [];
      console.warn = message => warnings.push(message);
      resolveCredentialPolicy({ floorPolicy: 'references', floorSource: '/synthetic/org/mcp-servers.json', flag: 'literal', env: {} });
      resolveCredentialPolicy({ floorPolicy: 'references', floorSource: '/synthetic/org/mcp-servers.json', flag: 'literal', env: {} });
      process.stdout.write(JSON.stringify(warnings));
    `], { encoding: "utf-8", timeout: 60_000 });
    const warnings = JSON.parse(output);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/synthetic/org/mcp-servers.json');
    expect(warnings[0]).toContain('policy "literal"');
    expect(warnings[0]).toContain('floor "references"');
  });
});

describe("install-generated server credential exemption", () => {
  it("exempts only AIWG_ROOT on the built-in aiwg entry", () => {
    expect(INSTALL_POLICY_EXEMPT_ENV).toEqual({ aiwg: ["AIWG_ROOT"] });
    const checked = installPolicyCheckedServer("aiwg", {
      command: "aiwg", args: ["mcp", "serve"], env: { AIWG_ROOT: "/synthetic/install/root" },
    });
    expect(checked).toEqual({ name: "aiwg", command: "aiwg", args: ["mcp", "serve"], env: undefined });
    expect(credentialPolicyViolations(checked, "references")).toEqual([]);
    expect(credentialPolicyViolations(checked, "none")).toEqual([]);
    expect(() => assertCredentialPolicy([checked], "references")).not.toThrow();
    expect(() => assertCredentialPolicy([checked], "none")).not.toThrow();
  });

  it("refuses any other literal env/header on an installed definition under references and none", () => {
    // A second, non-exempt key on the same exempt entry is still a violation.
    const extraKey = installPolicyCheckedServer("aiwg", {
      command: "aiwg", args: ["mcp", "serve"],
      env: { AIWG_ROOT: "/synthetic/install/root", OTHER_TOKEN: "synthetic-secret" },
    });
    expect(extraKey.env).toEqual({ OTHER_TOKEN: "synthetic-secret" });
    expect(credentialPolicyViolations(extraKey, "references")).toEqual(["env"]);
    expect(() => assertCredentialPolicy([extraKey], "references")).toThrow(/Refusing to render/);
    expect(() => assertCredentialPolicy([extraKey], "none")).toThrow(/Refusing to render/);

    // The exemption is scoped to the "aiwg" name - the same key on any other
    // install-generated server name is not exempt.
    const otherServer = installPolicyCheckedServer("other", { command: "x", env: { AIWG_ROOT: "/x" } });
    expect(otherServer.env).toEqual({ AIWG_ROOT: "/x" });
    expect(() => assertCredentialPolicy([otherServer], "references")).toThrow(/Refusing to render/);
    expect(() => assertCredentialPolicy([otherServer], "none")).toThrow(/Refusing to render/);

    // A literal header (never exempt) on the built-in entry is also refused.
    const literalHeader = installPolicyCheckedServer("aiwg", {
      command: "aiwg", args: ["mcp", "serve"], headers: { Authorization: "Bearer synthetic" },
    });
    expect(() => assertCredentialPolicy([literalHeader], "references")).toThrow(/Refusing to render/);
    expect(() => assertCredentialPolicy([literalHeader], "none")).toThrow(/Refusing to render/);
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
    vi.mocked(isInteractive).mockReturnValue(true);
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

  it.each(["legacy", "xdg", "explicit"])("preserves %s AIWG configuration across the profile HOME change", async (kind) => {
    vi.stubEnv("AIWG_CONFIG", "");
    const configDir = kind === "legacy" ? join(root, ".aiwg")
      : kind === "xdg" ? join(root, ".config", "aiwg") : join(root, "operator-config");
    mkdirSync(configDir, { recursive: true });
    if (kind === "explicit") vi.stubEnv("AIWG_CONFIG", configDir);
    writeFileSync(join(configDir, "installation.json"), JSON.stringify({ runMode: "development" }));
    const runtimeHome = await ensureRuntimeHome("isolated");
    vi.mocked(spawnSync).mockClear();
    launchWithProfile("isolated", ["--version"]);
    await loginInProfile("isolated");
    expect(spawnSync).toHaveBeenCalledTimes(2);
    for (const [, , options] of vi.mocked(spawnSync).mock.calls) {
      expect(options?.env?.AIWG_CONFIG).toBe(configDir);
      expect(options?.env?.HOME).toBe(runtimeHome);
      expect(options?.env?.CODEX_HOME).toBe(runtimeHome);
    }
    expect(process.env.HOME).toBe(root);
  });

  describe("headless launch/login (#3062)", () => {
    it("bounds `codex exec <prompt>` instead of handing over the terminal, with or without a tty", async () => {
      const runtimeHome = await ensureRuntimeHome("isolated");
      for (const attached of [false, true]) {
        vi.mocked(isInteractive).mockReturnValue(attached);
        vi.mocked(spawnSync).mockClear();
        const result = launchWithProfile("isolated", ["exec", "do the thing"]);
        expect(result.status).toBe(0);
        expect(spawnSync).toHaveBeenCalledTimes(1);
        const [command, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
        expect(command).toBe("codex");
        expect(args).toEqual(["exec", "do the thing"]);
        expect(options?.timeout).toBeGreaterThan(0);
        expect(options?.env?.HOME).toBe(runtimeHome);
        // Bounded calls never inherit stdin regardless of the requested stdio.
        expect(Array.isArray(options?.stdio) ? options.stdio[0] : options?.stdio).toBe("ignore");
      }
    });

    it("refuses to launch the interactive TUI without a terminal, spawning nothing", async () => {
      await ensureRuntimeHome("isolated");
      vi.mocked(isInteractive).mockReturnValue(false);
      vi.mocked(spawnSync).mockClear();
      expect(() => launchWithProfile("isolated")).toThrow(/requires one to be attached/);
      expect(() => launchWithProfile("isolated", ["--version"])).toThrow(/requires one to be attached/);
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it("launches the interactive TUI unchanged when a terminal is attached", async () => {
      await ensureRuntimeHome("isolated");
      vi.mocked(isInteractive).mockReturnValue(true);
      vi.mocked(spawnSync).mockClear();
      const result = launchWithProfile("isolated", ["--version"]);
      expect(result.status).toBe(0);
      const [command, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
      expect(command).toBe("codex");
      expect(args).toEqual(["--version"]);
      expect(options?.timeout).toBeUndefined();
      expect(options?.stdio).toBe("inherit");
    });

    it("logs in non-interactively via --with-api-key when apiKeyEnv is given, without a terminal", async () => {
      const runtimeHome = await ensureRuntimeHome("isolated");
      vi.mocked(isInteractive).mockReturnValue(false);
      vi.stubEnv("AIWG_TEST_CODEX_KEY", "sk-test-secret-value");
      vi.mocked(spawn).mockClear();
      await loginInProfile("isolated", { apiKeyEnv: "AIWG_TEST_CODEX_KEY" });
      // #3062 second review, finding 1: this path is now an async `spawn()`
      // (never `spawnSync`'s `input` option, which a NODE_DEBUG=child_process
      // dump would print) — see test/unit/mcp/codex-login-credential-safety.test.ts
      // for the end-to-end diagnostic-safety probe.
      expect(spawn).toHaveBeenCalledTimes(1);
      const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
      expect(command).toBe("codex");
      expect(args).toEqual(["login", "--with-api-key"]);
      // The key is written to the live stdin stream, never passed as a
      // spawn option (there is no `input` option on async `spawn`).
      expect((options as { input?: unknown } | undefined)?.input).toBeUndefined();
      const child = vi.mocked(spawn).mock.results[0]!.value as ReturnType<typeof makeFakeAsyncChild>;
      // go/no-go review blocker 2: write()+end() collapsed into a single
      // end(chunk, callback) call — the callback (always provided, for the
      // EPIPE/write-failure path) is the second argument.
      expect(child.stdin.end).toHaveBeenCalledWith("sk-test-secret-value", expect.any(Function));
      expect(options?.env?.HOME).toBe(runtimeHome);
      // The named variable is removed from the child's own environment —
      // it must only ever reach the child over stdin.
      expect(options?.env?.AIWG_TEST_CODEX_KEY).toBeUndefined();
      // The secret must never appear on argv, nor (by construction) any
      // env value.
      expect(args.join(" ")).not.toContain("sk-test-secret-value");
      expect(Object.values(options?.env ?? {})).not.toContain("sk-test-secret-value");
    });

    it("errors when apiKeyEnv names an unset variable, without spawning anything", async () => {
      await ensureRuntimeHome("isolated");
      vi.mocked(isInteractive).mockReturnValue(false);
      expect(process.env.AIWG_TEST_CODEX_KEY_UNSET).toBeUndefined();
      vi.mocked(spawnSync).mockClear();
      await expect(loginInProfile("isolated", { apiKeyEnv: "AIWG_TEST_CODEX_KEY_UNSET" }))
        .rejects.toThrow(/AIWG_TEST_CODEX_KEY_UNSET.*is not set/);
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('waits for close and redacts credentials split across trailing diagnostic chunks', async () => {
      await ensureRuntimeHome('isolated');
      const key = 'synthetic-split-output-key';
      vi.mocked(spawn).mockImplementationOnce(() => {
        const child = makeFakeAsyncChild();
        queueMicrotask(() => {
          child.setExit(0, null);
          child.emit('exit', 0, null);
          child.stdout.emit('data', Buffer.from(`accepted ${key.slice(0, 9)}`));
          child.stdout.emit('data', Buffer.from(`${key.slice(9)}\n`));
          child.stderr.emit('data', Buffer.from(`diagnostic ${key}\n`));
          child.emit('close', 0, null);
        });
        return child;
      });
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await loginInProfile('isolated', { apiKey: key });
        expect(stdout.mock.calls.map(call => String(call[0])).join('')).toContain('accepted [redacted]');
        expect(stderr.mock.calls.map(call => String(call[0])).join('')).toContain('diagnostic [redacted]');
        expect([...stdout.mock.calls, ...stderr.mock.calls].map(call => String(call[0])).join('')).not.toContain(key);
      } finally { stdout.mockRestore(); stderr.mockRestore(); }
    });

    it('kills a login child whose combined diagnostics exceed the output cap', async () => {
      await ensureRuntimeHome('isolated');
      const child = makeFakeAsyncChild();
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.alloc(512 * 1024, 'x'));
          child.stderr.emit('data', Buffer.alloc(512 * 1024 + 1, 'y'));
        });
        return child;
      });
      await expect(loginInProfile('isolated', { apiKey: 'synthetic-output-cap-key' })).rejects.toThrow('1 MiB limit');
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(child.stdout.destroy).toHaveBeenCalledOnce();
      expect(child.stderr.destroy).toHaveBeenCalledOnce();
    });

    it("refuses the interactive OAuth login without a terminal and without apiKeyEnv, spawning nothing", async () => {
      await ensureRuntimeHome("isolated");
      vi.mocked(isInteractive).mockReturnValue(false);
      vi.mocked(spawnSync).mockClear();
      await expect(loginInProfile("isolated")).rejects.toThrow(/requires an interactive terminal, or a key supplied via/);
      expect(spawnSync).not.toHaveBeenCalled();
    });

    // go/no-go review blocker 2: a child that exits before ever reading
    // stdin raises EPIPE on the *stdin stream* (never on the child object),
    // which — without the stdin 'error' listener this test pins — is an
    // unhandled 'error' event and therefore an uncaught exception, not a
    // normal rejected promise. Reproduces the exact scenario the review's
    // live probe hit.
    it("a child that exits before reading stdin settles with a normal error, not an uncaught exception", async () => {
      await ensureRuntimeHome("isolated");
      vi.mocked(isInteractive).mockReturnValue(false);
      vi.stubEnv("AIWG_TEST_CODEX_KEY", "sk-test-secret-value");
      vi.mocked(spawn).mockImplementationOnce(() => {
        const child = makeFakeAsyncChild();
        // The child "exits before reading stdin": our write to its stdin
        // fails (EPIPE) and is reported through the end() callback — the
        // secondary `onStdinError` listener's own swallowing of EPIPE is
        // covered separately by the next test, without this one also
        // racing the exit microtask below over which listener is still
        // attached when it fires.
        child.stdin.end = vi.fn((...callArgs: unknown[]) => {
          const callback = callArgs.find(
            (value): value is (err?: Error | null) => void => typeof value === "function",
          );
          const err = Object.assign(new Error("EPIPE"), { code: "EPIPE" });
          callback?.(err);
          return child.stdin;
        });
        queueMicrotask(() => {
          child.setExit(1, null);
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
        });
        return child;
      });
      // A normal rejection (asserted below) — not an uncaught exception —
      // is the property this test exists to pin. If the EPIPE were
      // unhandled, this `await expect(...).rejects` would never observe a
      // rejection at all; Vitest would instead report an unhandled error
      // for the whole run.
      await expect(loginInProfile("isolated", { apiKeyEnv: "AIWG_TEST_CODEX_KEY" }))
        .rejects.toThrow(/codex login --with-api-key/);
    });

    // go/no-go review blocker 2: a child that closes its own stdin (so our
    // write fails with EPIPE) but never exits must still resolve via the
    // deadline — the EPIPE must not pre-empt or corrupt that timeout path.
    // `resolveSyncProcessTimeoutMs` is shrunk for this one call so the test
    // does not wait out the real 120s network-tier bound.
    it("a child that closes stdin and stays alive is killed and times out, not left hanging or crashing", async () => {
      await ensureRuntimeHome("isolated");
      vi.mocked(isInteractive).mockReturnValue(false);
      vi.stubEnv("AIWG_TEST_CODEX_KEY", "sk-test-secret-value");
      vi.mocked(resolveSyncProcessTimeoutMs).mockReturnValueOnce(50);
      let killedWith: NodeJS.Signals | undefined;
      vi.mocked(spawn).mockImplementationOnce(() => {
        const child = makeFakeAsyncChild();
        child.stdin.end = vi.fn(() => {
          const err = Object.assign(new Error("EPIPE"), { code: "EPIPE" });
          queueMicrotask(() => child.stdin.emit("error", err));
          return child.stdin;
        });
        child.kill = vi.fn((signal?: NodeJS.Signals) => {
          killedWith = signal as NodeJS.Signals;
          child.setExit(null, killedWith);
          // Real `ChildProcess#kill` does not itself emit 'exit' — the
          // kernel's SIGKILL delivery does, asynchronously. Not emitting it
          // here is deliberate: this call must settle from the timeout
          // path alone, not from a kill-triggered 'exit'.
          return true;
        });
        return child;
      });
      await expect(loginInProfile("isolated", { apiKeyEnv: "AIWG_TEST_CODEX_KEY" }))
        .rejects.toThrow(/exceeded the 'network' tier bound/);
      expect(killedWith).toBe("SIGKILL");
    });
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

  it.each([
    { credentialPolicy: undefined, label: "an omitted policy" },
    { credentialPolicy: "literal" as const, label: "an explicit literal policy" },
  ])("resolves and enforces an organisation floor itself, so $label cannot write literals below it", async ({ credentialPolicy }) => {
    // A direct API call (bypassing the session/CLI layer that would normally
    // resolve this) still cannot write below a "references" floor it is given.
    await expect(writeProfileConfig("floor-direct", servers, {
      ...(credentialPolicy !== undefined ? { credentialPolicy } : {}),
      floorPolicy: "references",
    })).rejects.toThrow(/Refusing to render/);
    expect(existsSync(join(root, ".codex", "roles-runtime"))).toBe(false);
    expect(readdirSync(join(root, ".codex"))).toEqual([]);
  });

  it("behaves as before when an explicit policy already satisfies the floor", async () => {
    const warnings = await writeProfileConfig("floor-satisfied", [
      { name: "remote", type: "http", url: "https://example.test/mcp", headerEnv: { Authorization: "TOKEN" } },
    ], { credentialPolicy: "references", floorPolicy: "references" });
    expect(warnings).toEqual([]);
    const configPath = join(root, ".codex", "roles-runtime", "floor-satisfied", "config.toml");
    expect(readFileSync(configPath, "utf-8")).toContain('env_http_headers = { Authorization = "TOKEN" }');
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

  it("applies the registry policy, which the environment may relax with no floor to enforce it", () => {
    registry([{ name: "leaky", type: "stdio", command: "leaky", env: { TOKEN: "literal" } }]);
    run(["credential-policy", "references"]);
    expect(run(["credential-policy"]).trim()).toBe("references");
    expect(runFailing(["inject", "--provider", "cursor"]).stderr).toContain("leaky (env)");
    // A single registry (no AIWG_CONFIG_LAYERS) has no organisation floor, so
    // AIWG_MCP_CREDENTIAL_POLICY may relax the stored "references" policy back
    // to "literal" for this invocation - restoring the pre-floor, single-registry
    // behavior (#280). Ephemeral output avoids the separate, unrelated refusal
    // of literal credentials in a project-committed config file.
    const out = join(root, "ephemeral.json");
    run(["inject", "--provider", "cursor", "--ephemeral", "--out", out], { AIWG_MCP_CREDENTIAL_POLICY: "literal" });
    expect(JSON.parse(readFileSync(out, "utf-8")).mcpServers.leaky.env).toEqual({ TOKEN: "literal" });
  });

  it("stores --env-from as a variable name only", () => {
    registry([]);
    run(["add", "github", "--type", "stdio", "--command", "github-mcp-server", "--env-from", "GITHUB_TOKEN=GITHUB_TOKEN"]);
    const stored = JSON.parse(readFileSync(join(configDir, "mcp-servers.json"), "utf-8")).servers.github;
    expect(stored.envFrom).toEqual({ GITHUB_TOKEN: "GITHUB_TOKEN" });
    expect(stored.env).toBeUndefined();
  });
});
