/** Desktop environment comparison helpers shared by TS diagnostics and the ESM loader. */
export function workerEnvironmentValue(name: string, value: string | undefined): string | undefined;
export function workerEnvironmentScope(environment: Record<string, string>): Record<string, string>;
export function workerDesktopEnvironmentBindings(environment: Record<string, string>): Record<string, string>;
export function changedWorkerDesktopEnvironment(installation: {
  environmentNames?: unknown; environmentBindings?: unknown;
}, environment: NodeJS.ProcessEnv): string[];
