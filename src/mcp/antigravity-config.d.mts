// Typed boundary for shared Antigravity project plugin preparation.
export function resolveAntigravityConfigPath(
  projectDir?: string,
  options?: { scope?: 'user' | 'project' },
): string;

export function prepareAntigravityConfig(
  provider: string,
  configPath: string,
  existing: Record<string, unknown>,
  location?: { projectDir?: string; scope?: 'user' | 'project' },
): Promise<{
  config: Record<string, unknown>;
  writes: Array<{ file: string; content: string; options: { projectRoot: string } }>;
  warnings: string[];
}>;
