import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthCredentials, CredentialStore, CredentialMetadata } from "./types.js";

export interface CommandResult { stdout: string; stderr: string; exitCode: number }
export type CommandRunner = (command: string, args: string[], stdin?: string) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (command, args, stdin = "") => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  const collect = (target: Buffer[], chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 1024 * 1024) child.kill();
    else target.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  child.once("error", reject);
  child.stdin.once("error", (error: NodeJS.ErrnoException) => {
    // A short-lived credential helper may close stdin before Node flushes the
    // payload. Its process exit remains the authoritative command result.
    if (error.code !== "EPIPE") reject(error);
  });
  child.once("close", (code) => resolve({
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    exitCode: code ?? 1,
  }));
  child.stdin.end(stdin);
});

function parseCredentials(raw: string): AuthCredentials {
  const value = JSON.parse(raw) as Partial<AuthCredentials>;
  if (!value.accessToken?.startsWith("aiwg_at_") || !value.refreshToken?.startsWith("aiwg_rt_")
      || value.tokenType !== "Bearer" || !Array.isArray(value.scope) || !value.expiresAt) {
    throw new Error("stored AIWG credentials are invalid");
  }
  return value as AuthCredentials;
}

export const DEFAULT_CREDENTIAL_SERVICE = "releases.aiwg.io";
export const DEFAULT_CREDENTIAL_ACCOUNT = "aiwg-cli";

/** Native secret-store coordinates. Defaults to the AIWG release credential entry. */
export interface CredentialStoreIdentity { service?: string; account?: string }

function resolveIdentity(identity: CredentialStoreIdentity = {}): { service: string; account: string } {
  const service = identity.service ?? DEFAULT_CREDENTIAL_SERVICE;
  const account = identity.account ?? DEFAULT_CREDENTIAL_ACCOUNT;
  for (const [label, value] of [["service", service], ["account", account]] as const) {
    // Values reach native helpers as argv entries or PowerShell string literals; refuse
    // empty values and control characters rather than depend on each helper's parsing.
    if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`credential store ${label} must be a non-empty string without control characters`);
    }
  }
  return { service, account };
}

/** Quote a value as a PowerShell single-quoted string literal. */
function powershellLiteral(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
}

/**
 * A raw secret held by the same native helpers as the AIWG release credential,
 * under a caller-chosen identity. Used for secrets that are not OAuth token
 * pairs, such as the effect ledger signing key. Values are never logged.
 */
export interface SecretStore {
  readonly metadata: CredentialMetadata;
  loadSecret(): Promise<string | null>;
  saveSecret(value: string): Promise<void>;
  deleteSecret(): Promise<void>;
}

abstract class NativeCredentialStore implements CredentialStore, SecretStore {
  abstract readonly metadata: CredentialMetadata;
  protected readonly service: string;
  protected readonly account: string;
  constructor(protected readonly run: CommandRunner = defaultCommandRunner, identity: CredentialStoreIdentity = {}) {
    ({ service: this.service, account: this.account } = resolveIdentity(identity));
  }
  protected abstract loadRaw(): Promise<string | null>;
  protected abstract saveRaw(value: string): Promise<void>;
  abstract delete(): Promise<void>;
  async load(): Promise<AuthCredentials | null> { const raw = await this.loadRaw(); return raw === null ? null : this.parse(raw); }
  async save(credentials: AuthCredentials): Promise<void> { await this.saveRaw(JSON.stringify(credentials)); }
  async loadSecret(): Promise<string | null> { const raw = await this.loadRaw(); return raw === null ? null : raw.trim(); }
  async saveSecret(value: string): Promise<void> { await this.saveRaw(requireSecretValue(value)); }
  async deleteSecret(): Promise<void> { await this.delete(); }
  protected parse(raw: string): AuthCredentials { return parseCredentials(raw.trim()); }
}

function requireSecretValue(value: string): string {
  if (typeof value !== "string" || !value || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("secret value must be a non-empty single-line string");
  }
  return value;
}

export class MacOsKeychainStore extends NativeCredentialStore {
  readonly metadata = { provider: "macos-keychain", location: `Keychain:${this.service}/${this.account}` } as const;
  protected async loadRaw() {
    const result = await this.run("security", ["find-generic-password", "-a", this.account, "-s", this.service, "-w"]);
    return result.exitCode === 44 ? null : result.exitCode === 0 ? result.stdout : Promise.reject(new Error("macOS Keychain read failed"));
  }
  protected async saveRaw(value: string) {
    const result = await this.run("security", ["add-generic-password", "-U", "-a", this.account, "-s", this.service, "-w"], value);
    if (result.exitCode !== 0) throw new Error("macOS Keychain write failed");
  }
  async delete() { await this.run("security", ["delete-generic-password", "-a", this.account, "-s", this.service]); }
}

export class LinuxSecretServiceStore extends NativeCredentialStore {
  readonly metadata = { provider: "linux-secret-service", location: `SecretService:${this.service}/${this.account}` } as const;
  protected async loadRaw() {
    const result = await this.run("secret-tool", ["lookup", "service", this.service, "account", this.account]);
    return result.exitCode === 1 ? null : result.exitCode === 0 ? result.stdout : Promise.reject(new Error("Linux Secret Service read failed"));
  }
  protected async saveRaw(value: string) {
    const result = await this.run("secret-tool", ["store", `--label=AIWG ${this.service}`, "service", this.service, "account", this.account], value);
    if (result.exitCode !== 0) throw new Error("Linux Secret Service write failed");
  }
  async delete() { await this.run("secret-tool", ["clear", "service", this.service, "account", this.account]); }
}

// Scripts are built from the store identity; the default identity yields the exact
// scripts used before the identity became configurable.
const windowsRead = (target: string) => `$v=New-Object Windows.Security.Credentials.PasswordVault;try{$c=$v.Retrieve(${target});$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{exit 1}`;
const windowsWrite = (target: string) => `$s=[Console]::In.ReadToEnd();$v=New-Object Windows.Security.Credentials.PasswordVault;$v.Add((New-Object Windows.Security.Credentials.PasswordCredential(${target},$s)))`;
const windowsDelete = (target: string) => `$v=New-Object Windows.Security.Credentials.PasswordVault;try{$c=$v.Retrieve(${target});$v.Remove($c)}catch{}`;

export class WindowsCredentialManagerStore extends NativeCredentialStore {
  readonly metadata = { provider: "windows-credential-manager", location: `CredentialManager:${this.service}/${this.account}` } as const;
  private get target() { return `${powershellLiteral(this.service)},${powershellLiteral(this.account)}`; }
  private execute(script: string, stdin = "") { return this.run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], stdin); }
  protected async loadRaw() { const result = await this.execute(windowsRead(this.target)); return result.exitCode === 1 ? null : result.exitCode === 0 ? result.stdout : Promise.reject(new Error("Windows Credential Manager read failed")); }
  protected async saveRaw(value: string) { if ((await this.execute(windowsWrite(this.target), value)).exitCode !== 0) throw new Error("Windows Credential Manager write failed"); }
  async delete() { await this.execute(windowsDelete(this.target)); }
}

export class FileCredentialStore implements CredentialStore {
  readonly metadata: CredentialMetadata;
  constructor(readonly pathname: string, readonly explicitlyAllowed: boolean) {
    this.pathname = path.resolve(pathname);
    this.metadata = { provider: "file", location: this.pathname };
  }
  private assertAllowed() { if (!this.explicitlyAllowed) throw new Error("credential file fallback requires --allow-file-store or AIWG_AUTH_ALLOW_FILE_STORE=1"); }
  async load() {
    this.assertAllowed();
    try {
      const stat = await fs.lstat(this.pathname);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("credential file must be a non-symlink mode-0600 regular file");
      return parseCredentials(await fs.readFile(this.pathname, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async save(credentials: AuthCredentials) {
    this.assertAllowed();
    await fs.mkdir(path.dirname(this.pathname), { recursive: true, mode: 0o700 });
    const temporary = `${this.pathname}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, this.pathname);
    await fs.chmod(this.pathname, 0o600);
  }
  async delete() { this.assertAllowed(); await fs.unlink(this.pathname).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly metadata = { provider: "memory", location: "injected-memory-store" } as const;
  value: AuthCredentials | null = null;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(value: AuthCredentials) { this.value = structuredClone(value); }
  async delete() { this.value = null; }
}

export function defaultCredentialFile(): string {
  const root = process.env.XDG_CONFIG_HOME || (process.platform === "win32" ? process.env.APPDATA : undefined) || path.join(os.homedir(), ".config");
  return path.join(root, "aiwg", "credentials", "resource-auth.json");
}

export function createCredentialStore(options: { platform?: NodeJS.Platform; useFile?: boolean; allowFile?: boolean; pathname?: string; runner?: CommandRunner } & CredentialStoreIdentity = {}): CredentialStore {
  if (options.useFile) return new FileCredentialStore(options.pathname || defaultCredentialFile(), options.allowFile === true);
  const platform = options.platform || process.platform;
  const identity = { service: options.service, account: options.account };
  if (platform === "darwin") return new MacOsKeychainStore(options.runner, identity);
  if (platform === "win32") return new WindowsCredentialManagerStore(options.runner, identity);
  if (platform === "linux") return new LinuxSecretServiceStore(options.runner, identity);
  throw new Error("no native credential store is available; explicitly opt in to the mode-0600 file fallback");
}

/** Mode-0600 file secret, used only on explicit opt-in (tests, or hosts without a native store). */
export class FileSecretStore implements SecretStore {
  readonly metadata: CredentialMetadata;
  constructor(readonly pathname: string, readonly explicitlyAllowed: boolean) {
    this.pathname = path.resolve(pathname);
    this.metadata = { provider: "file", location: this.pathname };
  }
  private assertAllowed() { if (!this.explicitlyAllowed) throw new Error("secret file fallback requires an explicit opt-in"); }
  async loadSecret() {
    this.assertAllowed();
    try {
      const stat = await fs.lstat(this.pathname);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("secret file must be a non-symlink mode-0600 regular file");
      return (await fs.readFile(this.pathname, "utf8")).trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async saveSecret(value: string) {
    this.assertAllowed();
    requireSecretValue(value);
    await fs.mkdir(path.dirname(this.pathname), { recursive: true, mode: 0o700 });
    const temporary = `${this.pathname}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, this.pathname);
    await fs.chmod(this.pathname, 0o600);
  }
  async deleteSecret() { this.assertAllowed(); await fs.unlink(this.pathname).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}

export class MemorySecretStore implements SecretStore {
  readonly metadata = { provider: "memory", location: "injected-memory-store" } as const;
  #value: string | null = null;
  async loadSecret() { return this.#value; }
  async saveSecret(value: string) { this.#value = requireSecretValue(value); }
  async deleteSecret() { this.#value = null; }
}

/**
 * Raw-secret store on the host secret service. `service` and `account` name the
 * entry; callers pick an identity distinct from the release credential.
 */
export function createSecretStore(options: { platform?: NodeJS.Platform; useFile?: boolean; allowFile?: boolean; pathname?: string; runner?: CommandRunner } & Required<CredentialStoreIdentity>): SecretStore {
  if (options.useFile) {
    if (!options.pathname) throw new Error("secret file fallback requires an explicit pathname");
    return new FileSecretStore(options.pathname, options.allowFile === true);
  }
  const platform = options.platform || process.platform;
  const identity = { service: options.service, account: options.account };
  if (platform === "darwin") return new MacOsKeychainStore(options.runner, identity);
  if (platform === "win32") return new WindowsCredentialManagerStore(options.runner, identity);
  if (platform === "linux") return new LinuxSecretServiceStore(options.runner, identity);
  throw new Error("no native secret store is available; explicitly opt in to the mode-0600 file fallback");
}
