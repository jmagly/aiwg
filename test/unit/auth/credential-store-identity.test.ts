import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CREDENTIAL_ACCOUNT,
  DEFAULT_CREDENTIAL_SERVICE,
  createCredentialStore,
  type CommandRunner,
} from "../../../src/auth/credential-store.js";

const credentials = {
  accessToken: "aiwg_at_fixture_access",
  refreshToken: "aiwg_rt_fixture_refresh",
  tokenType: "Bearer" as const,
  scope: ["releases:read"],
  expiresAt: "2030-01-01T00:00:00.000Z",
};

async function exercise(platform: NodeJS.Platform, identity: { service?: string; account?: string } = {}) {
  const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: JSON.stringify(credentials), stderr: "", exitCode: 0 });
  const store = createCredentialStore({ platform, runner: run, ...identity });
  await store.load();
  await store.save(credentials);
  await store.delete();
  return { metadata: store.metadata, calls: run.mock.calls.map(([command, args]) => [command, args]) };
}

// The exact helper invocations before the identity became configurable.
const LEGACY = {
  darwin: {
    metadata: { provider: "macos-keychain", location: "Keychain:releases.aiwg.io/aiwg-cli" },
    calls: [
      ["security", ["find-generic-password", "-a", "aiwg-cli", "-s", "releases.aiwg.io", "-w"]],
      ["security", ["add-generic-password", "-U", "-a", "aiwg-cli", "-s", "releases.aiwg.io", "-w"]],
      ["security", ["delete-generic-password", "-a", "aiwg-cli", "-s", "releases.aiwg.io"]],
    ],
  },
  linux: {
    metadata: { provider: "linux-secret-service", location: "SecretService:releases.aiwg.io/aiwg-cli" },
    calls: [
      ["secret-tool", ["lookup", "service", "releases.aiwg.io", "account", "aiwg-cli"]],
      ["secret-tool", ["store", "--label=AIWG releases.aiwg.io", "service", "releases.aiwg.io", "account", "aiwg-cli"]],
      ["secret-tool", ["clear", "service", "releases.aiwg.io", "account", "aiwg-cli"]],
    ],
  },
  win32: {
    metadata: { provider: "windows-credential-manager", location: "CredentialManager:releases.aiwg.io/aiwg-cli" },
    calls: [
      "$v=New-Object Windows.Security.Credentials.PasswordVault;try{$c=$v.Retrieve('releases.aiwg.io','aiwg-cli');$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{exit 1}",
      "$s=[Console]::In.ReadToEnd();$v=New-Object Windows.Security.Credentials.PasswordVault;$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('releases.aiwg.io','aiwg-cli',$s)))",
      "$v=New-Object Windows.Security.Credentials.PasswordVault;try{$c=$v.Retrieve('releases.aiwg.io','aiwg-cli');$v.Remove($c)}catch{}",
    ].map((script) => ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]]),
  },
} as const;

describe("configurable credential store identity (#2716)", () => {
  it("keeps the legacy defaults", () => {
    expect(DEFAULT_CREDENTIAL_SERVICE).toBe("releases.aiwg.io");
    expect(DEFAULT_CREDENTIAL_ACCOUNT).toBe("aiwg-cli");
  });

  it.each(["darwin", "linux", "win32"] as const)("invokes the %s helper exactly as before with no identity", async (platform) => {
    expect(await exercise(platform)).toEqual(LEGACY[platform]);
  });

  it("uses a configured service and account on every backend", async () => {
    const identity = { service: "effects.aiwg.io", account: "project-1" };
    expect(await exercise("darwin", identity)).toEqual({
      metadata: { provider: "macos-keychain", location: "Keychain:effects.aiwg.io/project-1" },
      calls: [
        ["security", ["find-generic-password", "-a", "project-1", "-s", "effects.aiwg.io", "-w"]],
        ["security", ["add-generic-password", "-U", "-a", "project-1", "-s", "effects.aiwg.io", "-w"]],
        ["security", ["delete-generic-password", "-a", "project-1", "-s", "effects.aiwg.io"]],
      ],
    });
    expect(await exercise("linux", identity)).toEqual({
      metadata: { provider: "linux-secret-service", location: "SecretService:effects.aiwg.io/project-1" },
      calls: [
        ["secret-tool", ["lookup", "service", "effects.aiwg.io", "account", "project-1"]],
        ["secret-tool", ["store", "--label=AIWG effects.aiwg.io", "service", "effects.aiwg.io", "account", "project-1"]],
        ["secret-tool", ["clear", "service", "effects.aiwg.io", "account", "project-1"]],
      ],
    });
    const windows = await exercise("win32", identity);
    expect(windows.metadata).toEqual({ provider: "windows-credential-manager", location: "CredentialManager:effects.aiwg.io/project-1" });
    for (const [, args] of windows.calls) {
      expect(args.at(-1)).toContain("'effects.aiwg.io','project-1'");
      expect(args.at(-1)).not.toContain("releases.aiwg.io");
    }
  });

  it("overrides only the field that is supplied", async () => {
    expect((await exercise("linux", { account: "project-2" })).metadata.location).toBe("SecretService:releases.aiwg.io/project-2");
    expect((await exercise("linux", { service: "effects.aiwg.io" })).metadata.location).toBe("SecretService:effects.aiwg.io/aiwg-cli");
  });

  it("quotes PowerShell literals and refuses unsafe identities", async () => {
    const windows = await exercise("win32", { service: "svc", account: "o'brien\u2019s" });
    expect(windows.calls[0][1].at(-1)).toContain("'svc','o''brien\u2019\u2019s'");
    expect(() => createCredentialStore({ platform: "linux", service: "" })).toThrow(/service must be a non-empty string/);
    expect(() => createCredentialStore({ platform: "linux", account: "a\nb" })).toThrow(/account must be a non-empty string/);
  });
});
