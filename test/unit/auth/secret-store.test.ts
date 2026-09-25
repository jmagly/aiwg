import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretStore, MemorySecretStore, type CommandRunner } from "../../../src/auth/credential-store.js";

const temp: string[] = [];
afterEach(() => { for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("raw secret store", () => {
  it("uses the caller identity on every native backend and passes the secret on stdin only", async () => {
    for (const [platform, command] of [["linux", "secret-tool"], ["darwin", "security"], ["win32", "powershell.exe"]] as const) {
      const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "c2VjcmV0\n", stderr: "", exitCode: 0 });
      const store = createSecretStore({ platform, runner: run, service: "effects.aiwg.io", account: "ledger/local/example" });
      expect(await store.loadSecret()).toBe("c2VjcmV0");
      await store.saveSecret("c2VjcmV0");
      await store.deleteSecret();
      expect(run.mock.calls.every(([cmd]) => cmd === command)).toBe(true);
      const argv = run.mock.calls.map(([, args]) => args.join(" ")).join("\n");
      expect(argv).toContain("effects.aiwg.io");
      expect(argv).toContain("ledger/local/example");
      expect(argv).not.toContain("c2VjcmV0");
      expect(run.mock.calls[1][2]).toBe("c2VjcmV0");
      expect(store.metadata.location).toContain("effects.aiwg.io/ledger/local/example");
    }
  });

  it("maps a missing native entry to null and refuses multi-line values", async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
    const store = createSecretStore({ platform: "linux", runner: run, service: "effects.aiwg.io", account: "a" });
    expect(await store.loadSecret()).toBeNull();
    await expect(store.saveSecret("line\nbreak")).rejects.toThrow(/single-line/);
    const memory = new MemorySecretStore();
    expect(await memory.loadSecret()).toBeNull();
    await memory.saveSecret("value");
    expect(await memory.loadSecret()).toBe("value");
    expect(JSON.stringify(memory)).not.toContain("value");
  });

  it("uses the 0600 file fallback only on explicit opt-in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aiwg-secret-store-"));
    temp.push(dir);
    const pathname = path.join(dir, "nested", "ledger.key");
    const refused = createSecretStore({ useFile: true, pathname, service: "s", account: "a" });
    await expect(refused.loadSecret()).rejects.toThrow(/explicit opt-in/);
    const store = createSecretStore({ useFile: true, allowFile: true, pathname, service: "s", account: "a" });
    expect(await store.loadSecret()).toBeNull();
    await store.saveSecret("abc");
    expect(statSync(pathname).mode & 0o777).toBe(0o600);
    expect(await store.loadSecret()).toBe("abc");
    await store.deleteSecret();
    expect(await store.loadSecret()).toBeNull();
    expect(() => createSecretStore({ useFile: true, allowFile: true, service: "s", account: "a" })).toThrow(/pathname/);
  });
});
