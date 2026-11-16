export function withDeploymentInputSession<T>(work: () => Promise<T>): Promise<T>;
export function deploymentSessionInput<T>(key: string, create: () => T, dispose: (value: T) => void): T | undefined;
