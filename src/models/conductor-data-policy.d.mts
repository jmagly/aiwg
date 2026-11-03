// Types for the portable conductor input guard.
import type { WorkerSelectionPolicy } from './types.js';
import type { ParallelismConfig } from '../config/aiwg-config.js';
export const LOCAL_ONLY_PATH_PATTERN: string;
export function validLocalOnlyPath(value: unknown): boolean;
export function collectLocalOnlyPaths(policy?: WorkerSelectionPolicy, parallelism?: ParallelismConfig): string[];
export function conductorWorkerTrees(root: string): string[];
export function conductorToolDenial(event: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string }, root: string, paths: string[], workerTrees?: string[]): string | null;
export function runConductorDataHook(root: string, paths: string[], denyWorkerExecution?: boolean): void;
