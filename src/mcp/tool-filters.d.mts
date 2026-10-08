import type { ConfigWrite } from './config-file.mjs';

export interface ToolFilters {
  deny: string[];
  allow: string[];
}

export interface ToolFilterPlan {
  serverFields: Record<string, Record<string, unknown>>;
  tomlLines: Record<string, string[]>;
  topLevel: { tools?: Record<string, boolean> };
  claudePermissions: { deny: string[]; allow: string[] } | null;
  warnings: string[];
}

export function resolveToolFilters(
  profile: { providerOverrides?: Record<string, { toolDeny?: string[]; toolAllow?: string[] }> } | undefined,
  provider: string,
): ToolFilters;
export function hasToolFilters(filters: ToolFilters | undefined | null): boolean;
export function parseToolPattern(pattern: string): { server: string; tool: string } | null;
export function planToolFilters(provider: string, serverNames: string[], filters: ToolFilters): ToolFilterPlan;
export function applyJsonToolFilterPlan(
  config: Record<string, unknown>,
  serversKey: string,
  plan: ToolFilterPlan,
): Record<string, unknown>;
export function claudeSettingsPath(projectDir?: string, scope?: 'user' | 'project'): string;
export interface ClaudePermissionOptions {
  dryRun?: boolean;
  userScope?: boolean;
  projectRoot?: string;
  managedDir?: string;
  sidecar?: boolean;
  mcpPath?: string;
}
export function prepareClaudePermissions(
  settingsPath: string,
  permissions: { deny: string[]; allow: string[] },
  options?: ClaudePermissionOptions,
): Promise<{ merged: Record<string, unknown>; active: boolean; warnings: string[]; writes: ConfigWrite[]; commit(): Promise<void> }>;
export function mergeClaudePermissions(
  settingsPath: string,
  permissions: { deny: string[]; allow: string[] },
  options?: ClaudePermissionOptions,
): Promise<Record<string, unknown>>;
