import { renderCredentialMaps } from './credentials.mjs';
import { getMcpInjectionDefinition, normalizeRuntimeProviderId } from '../providers/provider-definitions.mjs';

export function buildServerConfig(server, provider) {
  const mcpDefinition = getMcpInjectionDefinition(provider);
  // TOML providers render references through their own named keys in
  // buildServerToml; unconditional interpolation would refuse them here even
  // though the TOML writer handles them.
  const { env, headers } = mcpDefinition?.serverConfigFormat === 'toml'
    ? {}
    : renderCredentialMaps(server, normalizeRuntimeProviderId(provider) || provider);

  switch (mcpDefinition?.serverConfigFormat) {
    case 'claude-code': {
      if (server.type === 'stdio') {
        return {
          command: server.command,
          args: server.args || [],
          ...(env ? { env } : {}),
        };
      }
      // Claude Code skips a url entry that has no type.
      return {
        type: server.type,
        url: server.url,
        ...(headers ? { headers } : {}),
      };
    }
    case 'antigravity': {
      if (server.type === 'stdio') {
        return { command: server.command, args: server.args || [], ...(env ? { env } : {}) };
      }
      return { url: server.url, ...(headers ? { headers } : {}) };
    }
    case 'standard': {
      if (server.type === 'stdio') {
        return {
          command: server.command,
          args: server.args || [],
          ...(env ? { env } : {}),
        };
      }
      return {
        url: server.url,
        ...(headers ? { headers } : {}),
      };
    }

    case 'factory': {
      if (server.type === 'stdio') {
        return {
          type: 'stdio',
          command: server.command,
          args: server.args || [],
          disabled: false,
          ...(env ? { env } : {}),
        };
      }
      return {
        type: server.type,
        url: server.url,
        disabled: false,
        ...(headers ? { headers } : {}),
      };
    }

    case 'opencode': {
      if (server.type === 'stdio') {
        // opencode names a local server's variables `environment`.
        return {
          type: 'local',
          command: [server.command, ...(server.args || [])],
          ...(env ? { environment: env } : {}),
        };
      }
      return {
        type: 'remote',
        url: server.url,
        ...(headers ? { headers } : {}),
      };
    }

    case 'toml':
      return {};

    default:
      return {};
  }
}
