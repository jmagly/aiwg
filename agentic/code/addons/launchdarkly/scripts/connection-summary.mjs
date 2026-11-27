/**
 * AIWG guidance: never serialize raw tool output for a connection check.
 * The caller supplies private read success and configured transport/region.
 * All other fields (including nested credentials and tool text) are discarded.
 * Vendor trust guidance: https://launchdarkly.com/docs/home/getting-started/mcp-hosted.md
 */
export function connectionSummary(input) {
  const transports = ['hosted-mcp', 'local-mcp', 'ldcli', 'rest'];
  const regions = ['commercial', 'eu', 'federal'];
  const transport = transports.includes(input?.transport) ? input.transport : 'unknown';
  const region = regions.includes(input?.region) ? input.region : 'unknown';
  return {
    success: input?.succeeded === true && transport !== 'unknown' && region !== 'unknown'
      && !(transport === 'hosted-mcp' && region !== 'commercial'),
    transport,
    region,
  };
}
