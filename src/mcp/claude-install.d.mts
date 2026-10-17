import type { ConfigWrite } from './config-file.mjs';
export function claudeDesktopConfigPath(platform?: string, env?: NodeJS.ProcessEnv): string;
export function resolveClaudeInstallTarget(target: string, scope: string, env?: NodeJS.ProcessEnv): string;
export function legacyClaudeMigration(projectDir: string): Promise<ConfigWrite[]>;
