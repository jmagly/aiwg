import { readFileSync } from 'node:fs';

// Provider-owned session policy; single-shot worker allowlists stay independent.
const { providers } = JSON.parse(readFileSync(
  new URL('../../../agentic/code/providers/model-capabilities.v1.json', import.meta.url), 'utf8'));

const baseNames = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE',
  'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TMPDIR', 'TMP', 'TEMP',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'CI', 'NO_COLOR', 'FORCE_COLOR',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
]);

/** Build the legacy full-session environment. Explicit adapter overrides win. */
export function buildSessionEnvironment(provider = 'claude', envOverrides = {}, env = process.env) {
  const providerNames = new Set(providers[provider]?.sessionEnvAllowlist ?? []);
  const inherited = Object.fromEntries(Object.entries(env).filter(([name, value]) => {
    if (value === undefined) return false;
    // Windows names are case insensitive; proxy tools also use lowercase names.
    const baseName = name.toUpperCase();
    return baseNames.has(baseName) || /^(LC_|XDG_|GIT_)/.test(baseName)
      || providerNames.has(name);
  }));
  return { ...inherited, ...envOverrides };
}
