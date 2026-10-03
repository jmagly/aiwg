export type McpCredentialPolicy = 'literal' | 'references' | 'none';

interface CredentialBearingServer {
  name: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
  envFrom?: Record<string, string>;
  auth?: { clientSecret?: string };
  oauth?: { clientSecret?: string };
}

export const ENV_REFERENCE_SYNTAX: Readonly<Record<string, string | null>>;
export const CREDENTIAL_POLICIES: readonly McpCredentialPolicy[];
export function validateEnvReferenceName(name: string): void;
export function renderCredentialMaps(
  server: CredentialBearingServer,
  provider: string,
): { env?: Record<string, string>; headers?: Record<string, string> };
export function credentialPolicyViolations(server: CredentialBearingServer, policy?: McpCredentialPolicy): string[];
export function assertCredentialPolicy(servers: CredentialBearingServer[], policy?: McpCredentialPolicy): void;
export function resolveCredentialPolicy(options?: {
  flag?: string;
  registryPolicy?: string;
  env?: Record<string, string | undefined>;
}): McpCredentialPolicy;
