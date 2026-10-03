/**
 * MCP credential rendering and policy.
 *
 * A registry entry carries credentials in two ways:
 *   - literal values in `env` / `headers` (and OMP `auth` / `oauth` secrets)
 *   - references: `headerEnv` (header -> variable) and `envFrom`
 *     (server variable -> variable), which name a variable the harness
 *     resolves when it starts the server. Only the variable name is written.
 *
 * Each harness spells a reference differently; ENV_REFERENCE_SYNTAX holds the
 * documented form. `null` means the harness documents no interpolation in its
 * MCP config, so a reference cannot be rendered and injection refuses.
 */

const ENV_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keyed by normalized MCP provider id.
 * Sources (checked 2026-10-03):
 *   claude-code  https://code.claude.com/docs/en/mcp (command, args, env, url, headers)
 *   cursor       https://cursor.com/docs/context/mcp (command, args, env, url, headers)
 *   windsurf     https://docs.devin.ai/desktop/cascade/mcp (command, args, env, url, headers)
 *   factory      https://docs.factory.com/cli/configuration/mcp (env and headers values only)
 *   opencode     https://opencode.ai/docs/config (any string value)
 *   antigravity  https://antigravity.google/docs/mcp (no interpolation documented)
 *   warp         https://docs.warp.dev/agent-platform/capabilities/mcp/ (no interpolation documented)
 *   codex        named keys instead of interpolation (env_vars, env_http_headers)
 */
export const ENV_REFERENCE_SYNTAX = Object.freeze({
  'claude-code': '${NAME}',
  claude: '${NAME}',
  cursor: '${env:NAME}',
  windsurf: '${env:NAME}',
  factory: '${NAME}',
  opencode: '{env:NAME}',
  omp: '${NAME}',
  'grok-build': '${NAME}',
  antigravity: null,
  agy: null,
  warp: null,
});

export const CREDENTIAL_POLICIES = Object.freeze(['literal', 'references', 'none']);

export function validateEnvReferenceName(name) {
  if (!ENV_REFERENCE_NAME.test(name)) {
    throw new Error(`Invalid MCP environment variable reference "${name}"`);
  }
}

function hasEntries(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

function hasReferences(server) {
  return hasEntries(server.headerEnv) || hasEntries(server.envFrom);
}

/**
 * Render the env and headers maps a JSON harness receives, with references in
 * the harness's own syntax. Throws when the server carries references and the
 * harness has no documented syntax for them.
 */
export function renderCredentialMaps(server, provider) {
  const env = server.env ? { ...server.env } : undefined;
  const headers = server.headers ? { ...server.headers } : undefined;
  if (!hasReferences(server)) return { env, headers };

  const syntax = ENV_REFERENCE_SYNTAX[provider];
  if (!syntax) {
    throw new Error(
      `MCP server "${server.name}" uses environment references (header-env/env-from), ` +
      `but ${provider} documents no environment interpolation in its MCP config. ` +
      'Refusing to render it rather than writing the secret value or dropping the reference.',
    );
  }
  const reference = name => {
    validateEnvReferenceName(name);
    return syntax.replace('NAME', name);
  };
  const renderedEnv = { ...(env || {}) };
  for (const [key, name] of Object.entries(server.envFrom || {})) renderedEnv[key] = reference(name);
  const renderedHeaders = { ...(headers || {}) };
  for (const [header, name] of Object.entries(server.headerEnv || {})) renderedHeaders[header] = reference(name);
  return {
    env: Object.keys(renderedEnv).length > 0 ? renderedEnv : undefined,
    headers: Object.keys(renderedHeaders).length > 0 ? renderedHeaders : undefined,
  };
}

function urlCarriesUserinfo(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/**
 * List the fields of a server that the policy forbids.
 *
 *   literal     nothing is forbidden
 *   references  literal env/headers values, URL userinfo, and literal
 *               auth/oauth secrets are forbidden; header-env/env-from are allowed
 *   none        every credential-bearing field is forbidden, references included
 */
export function credentialPolicyViolations(server, policy) {
  if (policy === 'literal' || policy === undefined) return [];
  const violations = [];
  if (hasEntries(server.env)) violations.push('env');
  if (hasEntries(server.headers)) violations.push('headers');
  if (urlCarriesUserinfo(server.url)) violations.push('url userinfo');
  if (server.auth?.clientSecret) violations.push('auth.clientSecret');
  if (server.oauth?.clientSecret) violations.push('oauth.clientSecret');
  if (policy === 'none') {
    if (hasEntries(server.headerEnv)) violations.push('headerEnv');
    if (hasEntries(server.envFrom)) violations.push('envFrom');
    if (server.auth) violations.push('auth');
    if (server.oauth) violations.push('oauth');
  }
  return [...new Set(violations)];
}

/** Throw if any server violates the policy; names every offending server and field. */
export function assertCredentialPolicy(servers, policy) {
  if (!CREDENTIAL_POLICIES.includes(policy ?? 'literal')) {
    throw new Error(`Unknown MCP credential policy "${policy}". Use one of: ${CREDENTIAL_POLICIES.join(', ')}`);
  }
  const offenders = servers
    .map(server => ({ name: server.name, fields: credentialPolicyViolations(server, policy) }))
    .filter(entry => entry.fields.length > 0);
  if (offenders.length === 0) return;
  const detail = offenders.map(entry => `${entry.name} (${entry.fields.join(', ')})`).join('; ');
  const remedy = policy === 'none'
    ? 'Credential policy "none" renders no credential-bearing field at all.'
    : 'Credential policy "references" renders only header-env/env-from references; move literal values into environment variables.';
  throw new Error(`Refusing to render MCP servers with credentials: ${detail}. ${remedy}`);
}

/**
 * Resolve the effective policy. Precedence: CLI flag, then
 * AIWG_MCP_CREDENTIAL_POLICY, then the registry's credentialPolicy, then literal.
 */
export function resolveCredentialPolicy({ flag, registryPolicy, env = process.env } = {}) {
  const policy = flag || env.AIWG_MCP_CREDENTIAL_POLICY || registryPolicy || 'literal';
  if (!CREDENTIAL_POLICIES.includes(policy)) {
    throw new Error(`Unknown MCP credential policy "${policy}". Use one of: ${CREDENTIAL_POLICIES.join(', ')}`);
  }
  return policy;
}
