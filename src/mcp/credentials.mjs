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

// A supported environment-reference value in any documented harness syntax:
// ${NAME} (claude/factory/omp/grok), ${env:NAME} (cursor/windsurf),
// {env:NAME} (opencode). Such a value names a variable; it is not a secret.
const CREDENTIAL_REFERENCE_VALUE = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$\{env:[A-Za-z_][A-Za-z0-9_]*\}|\{env:[A-Za-z_][A-Za-z0-9_]*\})$/;

/** True when the value is a supported reference form rather than a literal secret. */
export function isCredentialReferenceValue(value) {
  return typeof value === 'string' && CREDENTIAL_REFERENCE_VALUE.test(value);
}

// One scanner supplies both policy findings and display replacements. Spans
// retain offsets into the original text so malformed URLs and encoded keys
// cannot disappear during URL normalization.
const CREDENTIAL_ARG_NAME = /^(api[-_]?key|access[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|secret|password|passwd|token)$/i;
const CREDENTIAL_QUERY_NAME = /(?:^|[-_.])(?:api[-_]?key|access[-_]?key|private[-_]?key|signing[-_]?key|encryption[-_]?key|secret[-_]?key|api[-_]?token|access[-_]?token|auth[-_]?token|session[-_]?id|client[-_]?secret|token|secret|password|passwd|pwd|passcode|auth|authorization|signature|jwt|bearer|credential|credentials)(?:$|[-_.])/i;

function credentialName(key) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  // Dot and bracket nesting are structural; underscores/hyphens are word
  // separators, so sort_key/cache-key stay ordinary parameter names.
  return normalized.split(/[.\[\]]/).some(part =>
    /^(?:key|sig)$/.test(part) || CREDENTIAL_QUERY_NAME.test(part.replace(/[_\s]+/g, '-')));
}

function literalValue(value, includeReferences) {
  return value !== '' && (includeReferences || !isCredentialReferenceValue(value));
}

function scanCredentialText(value, { includeReferences = false } = {}) {
  if (typeof value !== 'string') return [];
  const hits = [];
  // Authority-only userinfo, including URLs embedded in --url=... argv.
  for (const match of value.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/g)) {
    const at = match[1].lastIndexOf('@');
    if (at >= 0) {
      const start = match.index + match[0].length - match[1].length;
      hits.push({ start, end: start + at, kind: 'userinfo', credential: true });
    }
  }
  // WHATWG URL parsing accepts special-scheme authorities with one/no slash
  // or backslashes. Use its userinfo decision, retaining original-text offsets
  // for redaction. The raw scan above still covers malformed hosts.
  const offsets = [];
  let normalized = '';
  for (let index = 0; index < value.length; index++) {
    if (/[\t\r\n]/.test(value[index])) continue;
    offsets.push(index);
    normalized += value[index];
  }
  for (const match of normalized.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:/g)) {
    try {
      const candidate = normalized.slice(match.index);
      const parsed = new URL(candidate);
      if (!parsed.username && !parsed.password) continue;
      const authority = /^[A-Za-z][A-Za-z0-9+.-]*:[/\\]*([^/\\?#]*)/.exec(candidate);
      const at = authority?.[1].lastIndexOf('@') ?? -1;
      if (at < 0) continue;
      const start = match.index + authority[0].length - authority[1].length;
      hits.push({ start: offsets[start], end: offsets[start + at], kind: 'userinfo', credential: true });
    } catch { /* Malformed URLs are handled by the raw scanner. */ }
  }
  const hash = value.indexOf('#');
  const query = value.indexOf('?');
  const regions = [];
  if (query >= 0 && (hash < 0 || query < hash)) regions.push({ start: query + 1, end: hash < 0 ? value.length : hash, kind: 'query' });
  if (hash >= 0) regions.push({ start: hash + 1, end: value.length, kind: 'fragment' });
  for (const region of regions) {
    // Scan both sides of '?' in a fragment: #token=secret?view=full and
    // #/callback?token=secret must both retain the secret assignment.
    const text = value.slice(region.start, region.end);
    for (const match of text.matchAll(region.kind === 'fragment' ? /[^&?]+/g : /[^&]+/g)) {
      const equals = match[0].indexOf('=');
      if (equals < 0) continue;
      const start = region.start + match.index + equals + 1;
      // '?' can start fragment routing, but it is also part of an assignment
      // value. Classify the entire value before deciding whether to redact it.
      const nextPair = value.indexOf('&', start);
      const valueEnd = region.kind === 'fragment'
        ? (nextPair < 0 ? region.end : nextPair)
        : region.start + match.index + match[0].length;
      const assignment = match[0].slice(0, equals + 1) + value.slice(start, valueEnd);
      const [[key, decoded]] = new URLSearchParams(assignment.replace(/[\t\r\n]/g, ''));
      const credential = credentialName(key) && literalValue(decoded, includeReferences);
      // A credential value may itself contain '?'. Redact the whole value
      // through the next '&', including any fragment routing suffix.
      const end = region.kind === 'fragment' && credential
        ? valueEnd
        : region.start + match.index + match[0].length;
      hits.push({ start, end, kind: region.kind, key, credential });
    }
  }
  const header = /^\s*([^:]+):\s*(.*)$/.exec(value);
  if (header && credentialName(header[1])) {
    const content = header[2];
    const credential = content.replace(/^(?:Bearer|Basic)\s+/i, '');
    if (literalValue(credential, includeReferences)) {
      hits.push({ start: value.length - content.length, end: value.length, kind: 'header', credential: true });
    }
  }
  const assignment = /^(?:--header=|-H=?)?([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/s.exec(value);
  if (assignment && credentialName(assignment[1]) && literalValue(assignment[2], includeReferences)) {
    hits.push({ start: value.length - assignment[2].length, end: value.length, kind: 'assignment', credential: true });
  }
  // curl accepts both --header=Authorization: ... and -HAuthorization: ... .
  const inlineHeader = /^(?:--header=|-H=?)(.+:.+)$/s.exec(value);
  if (inlineHeader) {
    const offset = value.length - inlineHeader[1].length;
    for (const hit of scanCredentialText(inlineHeader[1], { includeReferences })) {
      hits.push({ ...hit, start: offset + hit.start, end: offset + hit.end });
    }
  }
  return hits;
}

function redactSpans(value, hits) {
  if (typeof value !== 'string') return value;
  const sorted = hits.filter(hit => hit.end > hit.start).sort((a, b) => a.start - b.start);
  const spans = [];
  for (const hit of sorted) {
    const previous = spans.at(-1);
    if (previous && hit.start <= previous.end) previous.end = Math.max(previous.end, hit.end);
    else spans.push({ start: hit.start, end: hit.end });
  }
  let result = '';
  let end = 0;
  for (const span of spans) {
    result += value.slice(end, span.start) + '***';
    end = span.end;
  }
  return result + value.slice(end);
}

/** Redact URL, fragment, header, and assignment credentials in display text. */
export function redactCredentialText(value) {
  if (typeof value !== 'string') return value;
  const hits = scanCredentialText(value);
  // Keep historical display behavior of masking all URL query values too.
  return redactSpans(value, hits.filter(hit => hit.credential || hit.kind === 'query'));
}

function credentialArgHits(args, options = {}) {
  const hits = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== 'string') continue;
    for (const hit of scanCredentialText(arg, options)) {
      if (hit.credential) hits.push({ ...hit, index, length: 1 });
    }
    const flag = /^--?([^=]+)(?:=(.*))?$/s.exec(arg);
    if (!flag || !CREDENTIAL_ARG_NAME.test(flag[1])) continue;
    if (flag[2] !== undefined) {
      if (literalValue(flag[2], options.includeReferences)) {
        hits.push({ index, length: 1, start: arg.indexOf('=') + 1, end: arg.length });
      }
    } else {
      const next = args[index + 1];
      if (typeof next === 'string' && !next.startsWith('--') && literalValue(next, options.includeReferences)) {
        hits.push({ index, length: 2, start: 0, end: next.length });
      }
    }
  }
  return hits;
}

export function credentialLikeArgs(args, options = {}) {
  if (!Array.isArray(args)) return [];
  return [...new Set(credentialArgHits(args, options).map(({ index, length }) =>
    length === 1 ? args[index] : `${args[index]} ${args[index + 1]}`))];
}

export function redactCredentialArgs(args) {
  if (!Array.isArray(args)) return args;
  const byIndex = new Map();
  for (const hit of credentialArgHits(args)) {
    const index = hit.index + hit.length - 1;
    if (!byIndex.has(index)) byIndex.set(index, []);
    byIndex.get(index).push(hit);
  }
  return args.map((arg, index) => redactSpans(arg, byIndex.get(index) || []));
}

export function urlCarriesUserinfo(url) {
  return scanCredentialText(url).some(hit => hit.kind === 'userinfo' && hit.credential);
}

export function credentialLikeQueryParams(url, options = {}) {
  return [...new Set(scanCredentialText(url, options).filter(hit => hit.kind === 'query' && hit.credential).map(hit => hit.key))];
}

export function credentialLikeFragmentParams(url, options = {}) {
  return [...new Set(scanCredentialText(url, options).filter(hit => hit.kind === 'fragment' && hit.credential).map(hit => hit.key))];
}

/** Recursively redact display records, including JSON output and literal maps. */
export function redactCredentialRecord(value, field) {
  if (field === 'args') return redactCredentialArgs(value);
  if (Array.isArray(value)) return value.map(item => redactCredentialRecord(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      ['env', 'headers'].includes(field) || key === 'clientSecret'
        ? (item === '' || isCredentialReferenceValue(item) ? item : '***')
        : redactCredentialRecord(item, key)]));
  }
  return redactCredentialText(value);
}

/**
 * List the fields of a server that the policy forbids.
 *
 *   literal     nothing is forbidden
 *   references  literal env/headers values, literal auth argument values, URL
 *               userinfo/query/fragment credentials, and literal auth/oauth secrets are forbidden;
 *               header-env/env-from are allowed
 *   none        every credential-bearing field is forbidden, references included
 */
export function credentialPolicyViolations(server, policy) {
  if (policy === 'literal' || policy === undefined) return [];
  const violations = [];
  if (hasEntries(server.env)) violations.push('env');
  if (hasEntries(server.headers)) violations.push('headers');
  if (credentialLikeArgs(server.args, { includeReferences: policy === 'none' }).length > 0) violations.push('args');
  if (urlCarriesUserinfo(server.url)) violations.push('url userinfo');
  if (credentialLikeQueryParams(server.url, { includeReferences: policy === 'none' }).length) violations.push('url query credentials');
  if (credentialLikeFragmentParams(server.url, { includeReferences: policy === 'none' }).length) violations.push('url fragment credentials');
  for (const field of ['auth', 'oauth']) {
    for (const key of ['tokenUrl', 'redirectUri', 'resource']) {
      if (urlCarriesUserinfo(server[field]?.[key])) violations.push(`${field}.${key} userinfo`);
      if (credentialLikeQueryParams(server[field]?.[key], { includeReferences: policy === 'none' }).length) {
        violations.push(`${field}.${key} query credentials`);
      }
      if (credentialLikeFragmentParams(server[field]?.[key], { includeReferences: policy === 'none' }).length) {
        violations.push(`${field}.${key} fragment credentials`);
      }
    }
  }
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

// Relaxations can be encountered repeatedly while loading layers and rendering.
const warnedRelaxations = new Set();

/**
 * `source`, when given, is the enforcing layer's config file path (never a
 * credential value - just a filesystem path) and is named in the message so
 * the operator knows which layer to change. Deduplicates once per process
 * per attempted `candidate` value, independent of `source`.
 */
export function warnCredentialPolicyRelaxation(candidate, floor, source) {
  if (warnedRelaxations.has(candidate)) return;
  warnedRelaxations.add(candidate);
  const location = source ? ` (set in ${source})` : '';
  console.warn(`Ignoring MCP credential policy "${candidate}": cannot relax credential policy floor "${floor}"${location}.`);
}

// Tracked separately from warnedRelaxations: this is a distinct message
// (the overlay is being dropped from the write layer on save), not the
// resolver's generic relaxation message, but follows the same once-per-value rule.
const warnedDroppedOverlays = new Set();

export function warnDroppedOverlayPolicy(candidate, floor, source) {
  if (warnedDroppedOverlays.has(candidate)) return;
  warnedDroppedOverlays.add(candidate);
  const location = source ? ` (set in ${source})` : '';
  console.warn(`Dropping ignored MCP overlay credential policy "${candidate}": cannot relax credential policy floor "${floor}"${location}.`);
}

/**
 * Test-only: clears the per-process relaxation-warning dedup state. Each of
 * these warnings is designed to fire once per process per attempted value,
 * which is exactly what a long-running CLI/session process needs - but a
 * test file that exercises the same candidate value more than once (for
 * example running the same scenario against both the `.ts` and `.mjs`
 * registry implementations) needs to reset it between cases to observe the
 * warning each time, since both implementations share this module's state.
 */
export function resetCredentialPolicyWarnings() {
  warnedRelaxations.clear();
  warnedDroppedOverlays.clear();
}

function validatePolicyValue(candidate) {
  if (!CREDENTIAL_POLICIES.includes(candidate)) {
    throw new Error(`Unknown MCP credential policy "${candidate}". Use one of: ${CREDENTIAL_POLICIES.join(', ')}`);
  }
}

/**
 * Resolve a credential policy for one invocation.
 *
 * `registryPolicy` (the personal/stored policy), `env`
 * (AIWG_MCP_CREDENTIAL_POLICY) and `flag` compose as a default: the most
 * specific source wins outright, including a relaxation. `flag` overrides
 * `env`, which overrides `registryPolicy`, which overrides the built-in
 * `literal` default - a flag or the environment may freely relax or tighten
 * a personal stored policy.
 *
 * `floorPolicy`, when given, is an enforced policy from a lower (shared or
 * organisation) configuration layer - the strictest value declared in any
 * such layer. It cannot be relaxed by `registryPolicy`, `env` or `flag`,
 * only tightened further. An attempt to relax below it is ignored, with a
 * warning once per process per attempted value, and the floor is used
 * instead. `floorSource` (the enforcing layer's config file path) is named
 * in that warning when given.
 */
export function resolveCredentialPolicy({ flag, registryPolicy, floorPolicy, floorSource, env = process.env } = {}) {
  let policy = 'literal';
  // Whether any of registryPolicy/env/flag actually supplied a value, as
  // opposed to `policy` merely sitting at the built-in default. The default
  // landing below an enforced floor is ordinary inheritance, not a
  // relaxation attempt, and must not warn.
  let explicit = false;
  // An empty environment string is unset; empty layer/flag values are errors.
  const envPolicy = env.AIWG_MCP_CREDENTIAL_POLICY === '' ? undefined : env.AIWG_MCP_CREDENTIAL_POLICY;
  for (const candidate of [registryPolicy, envPolicy, flag]) {
    if (candidate === undefined) continue;
    validatePolicyValue(candidate);
    policy = candidate;
    explicit = true;
  }
  if (floorPolicy !== undefined) {
    validatePolicyValue(floorPolicy);
    if (CREDENTIAL_POLICIES.indexOf(policy) < CREDENTIAL_POLICIES.indexOf(floorPolicy)) {
      if (explicit) warnCredentialPolicyRelaxation(policy, floorPolicy, floorSource);
      policy = floorPolicy;
    }
  }
  return policy;
}

/**
 * The stricter of two credential policies; `undefined` means no preference
 * and defers to the other side. Folds an organisation floor across several
 * lower configuration layers (each layer's own declared value is validated).
 */
export function stricterCredentialPolicy(a, b) {
  if (a !== undefined) validatePolicyValue(a);
  if (b !== undefined) validatePolicyValue(b);
  if (a === undefined) return b;
  if (b === undefined) return a;
  return CREDENTIAL_POLICIES.indexOf(a) >= CREDENTIAL_POLICIES.indexOf(b) ? a : b;
}

/**
 * Env keys install-generated server definitions may carry as literal values
 * without tripping credential-policy checks, keyed by the server name that
 * may carry them. `AIWG_ROOT` is an install-generated, non-secret filesystem
 * path (the AIWG installation directory) embedded in the built-in "aiwg"
 * server's own `env`, not an authorization credential - unlike a registry
 * server's `env`, which always comes from the operator and is never exempt.
 * The exemption is scoped to this exact server name and key; it does not
 * weaken the check for any other env/header field or any other server.
 */
export const INSTALL_POLICY_EXEMPT_ENV = Object.freeze({ aiwg: Object.freeze(['AIWG_ROOT']) });

/**
 * View an install-generated server definition for a credential-policy
 * check, with `INSTALL_POLICY_EXEMPT_ENV[name]` removed from `env` first.
 * Use only for install-generated definitions (`aiwg mcp install`); registry
 * servers rendered by `aiwg mcp inject` must never pass through this - their
 * `env` is operator-supplied and always subject to the full check.
 */
export function installPolicyCheckedServer(name, server) {
  const exempt = INSTALL_POLICY_EXEMPT_ENV[name];
  if (!exempt || !hasEntries(server.env)) return { name, ...server };
  const env = Object.fromEntries(Object.entries(server.env).filter(([key]) => !exempt.includes(key)));
  return { name, ...server, env: Object.keys(env).length > 0 ? env : undefined };
}
