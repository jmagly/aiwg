export type McpCredentialPolicy = 'literal' | 'references' | 'none';

interface CredentialBearingServer {
  name: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
  envFrom?: Record<string, string>;
  auth?: { clientSecret?: string; tokenUrl?: string; redirectUri?: string; resource?: string };
  oauth?: { clientSecret?: string; tokenUrl?: string; redirectUri?: string; resource?: string };
}

export const ENV_REFERENCE_SYNTAX: Readonly<Record<string, string | null>>;
export const CREDENTIAL_POLICIES: readonly McpCredentialPolicy[];
export function urlCarriesUserinfo(url?: string): boolean;
export function credentialLikeQueryParams(url?: string, options?: { includeReferences?: boolean }): string[];
export function credentialLikeFragmentParams(url?: string, options?: { includeReferences?: boolean }): string[];
export function isCredentialReferenceValue(value: unknown): boolean;
export function credentialLikeArgs(args?: string[], options?: { includeReferences?: boolean }): string[];
export function redactCredentialArgs(args?: string[]): string[] | undefined;
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
  floorPolicy?: string;
  floorSource?: string;
  env?: Record<string, string | undefined>;
}): McpCredentialPolicy;

export function stricterCredentialPolicy(
  a: McpCredentialPolicy | undefined,
  b: McpCredentialPolicy | undefined,
): McpCredentialPolicy | undefined;

export function warnCredentialPolicyRelaxation(candidate: McpCredentialPolicy, floor: McpCredentialPolicy, source?: string): void;
export function warnDroppedOverlayPolicy(candidate: McpCredentialPolicy, floor: McpCredentialPolicy, source?: string): void;
export function resetCredentialPolicyWarnings(): void;

export const INSTALL_POLICY_EXEMPT_ENV: Readonly<Record<string, readonly string[]>>;
export function installPolicyCheckedServer(name: string, server: CredentialBearingServer): CredentialBearingServer;

export function redactCredentialText(value: string): string;
export function redactCredentialRecord<T>(value: T): T;
