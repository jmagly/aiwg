import type { ToolDefinition } from '@flue/runtime';
export declare const AIWG_TOOL_NAMES: readonly ['aiwg_discover', 'aiwg_show', 'aiwg_artifact_write'];
export interface AiwgToolOptions { command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; }
export interface AiwgTools { aiwg_discover: ToolDefinition; aiwg_show: ToolDefinition; aiwg_artifact_write: ToolDefinition; }
export declare function createAiwgTools(options?: AiwgToolOptions): AiwgTools;
export declare const aiwg_discover: ToolDefinition, aiwg_show: ToolDefinition, aiwg_artifact_write: ToolDefinition;
