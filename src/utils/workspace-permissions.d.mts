// Type declarations for the shared Node permission policy.
import type { Stats } from 'node:fs';
export function readAcl(file: string): string | null;
export function groupSharedWorkspace(directory: string): { directory: string; gid: number } | null;
export function workspaceDirectoryMode(directory: string, fallback?: number): number;
export function workspaceFileMode(file: string, fallback?: number): number;
export function preserveWorkspaceReplacement(original: string, temporary: string, workspaceDirectory?: string): void;
export function workspacePermissionsAllowed(info: Pick<Stats, 'mode' | 'gid'>, directory: string): boolean;
