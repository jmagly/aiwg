import type { Stats } from 'node:fs';

export function assertConfigDestination(file: string, projectRoot?: string): Promise<Stats | null>;
export function isUserMcpScope(provider: string, scope?: string): boolean;
export function assertProjectCredentials(servers: Array<{ name: string; url?: string; env?: Record<string, string>; headers?: Record<string, string> }>, configPath: string): void;
export function assertConfigObject(config: unknown, serversKey: string): void;
export function writeConfigAtomic(file: string, content: string, options?: { userScope?: boolean; projectRoot?: string }): Promise<void>;
