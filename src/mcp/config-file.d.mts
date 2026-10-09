import type { Stats } from 'node:fs';

export function assertNoSymlinkParents(file: string, configRoot?: string): Promise<void>;
export function assertConfigDestination(file: string, projectRoot?: string): Promise<Stats | null>;
export function isUserMcpScope(provider: string, scope?: string): boolean;
export function assertProjectCredentials(servers: Array<{ name: string; url?: string; env?: Record<string, string>; headers?: Record<string, string> }>, configPath: string): void;
export function assertConfigObject(config: unknown, serversKey: string): void;
export interface ConfigWriteOptions {
  userScope?: boolean;
  rejectSymlinkParents?: boolean;
  symlinkRoot?: string;
  projectRoot?: string;
  newFileMode?: number;
  mode?: number;
}
export interface ConfigWrite {
  file: string;
  content: string | Uint8Array;
  options?: ConfigWriteOptions;
}
export function writeConfigAtomic(file: string, content: string | Uint8Array, options?: ConfigWriteOptions): Promise<void>;
export function canonicalConfigPath(file: string): Promise<string>;
export function prepareConfigWrite(file: string, options?: ConfigWriteOptions): Promise<void>;
export function writeConfigTransaction(writes: ConfigWrite[]): Promise<void>;
