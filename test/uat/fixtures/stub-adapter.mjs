/**
 * Stub Provider Adapter for UAT Testing
 *
 * Wraps stub-agent.mjs so the external Ralph orchestrator can run a full
 * end-to-end loop without invoking a real agent CLI. Registered under the
 * name 'stub' and 'test'.
 */

import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirnameFile = dirname(__filename);
// Resolve project root from test/uat/fixtures/ → ../../..
const projectRoot = resolve(__dirnameFile, '../../..');

const { ProviderAdapter, registerProvider } = await import(
  join(projectRoot, 'tools/ralph-external/lib/provider-adapter.mjs')
);

const STUB_AGENT = resolve(__dirnameFile, 'stub-agent.mjs');

export class StubAdapter extends ProviderAdapter {
  getBinary() {
    // Use node to run the stub script
    return process.execPath;
  }

  getName() {
    return 'stub';
  }

  getCapabilities() {
    return {
      streamJson: false,
      sessionResume: false,
      budgetControl: false,
      systemPrompt: false,
      agentMode: false,
      mcpConfig: false,
      maxTurns: false,
    };
  }

  buildSessionArgs(options) {
    // First arg to node must be the script path
    return [STUB_AGENT];
  }

  buildAnalysisArgs(options) {
    return [STUB_AGENT, '--print', options.prompt];
  }

  mapModel(genericModel) {
    return genericModel;
  }

  async isAvailable() {
    return true;
  }

  async getVersion() {
    return 'stub-1.0.0';
  }

  parseOutput(stdout) {
    return { completed: stdout.includes('SUCCESS'), output: stdout };
  }

  getEnvOverrides() {
    // Fixture controls are explicit adapter configuration, never inherited by
    // production providers through the session environment allowlist.
    const fixtureEnv = Object.fromEntries(
      ['UAT_STUB_OUTPUT', 'UAT_STUB_USAGE', 'UAT_LOG_FILE']
        .filter(name => process.env[name] !== undefined)
        .map(name => [name, process.env[name]])
    );
    return { CI: 'true', ...fixtureEnv };
  }

  getTranscriptPath() {
    return null;
  }
}

// Register under both 'stub' and 'test' names
registerProvider('stub', () => new StubAdapter());
registerProvider('test', () => new StubAdapter());
