// App-owned Flue tools backed by AIWG's contained MCP operations.
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

/* Transport spike: Flue 2.3.0's documented trusted-code escape hatch
 * (@flue/runtime/dist/index.mjs:744-750) still calls new URL(definition.url)
 * and constructs HTTP/SSE internally (dist/mcp-CYraeuuF.mjs:44-56,114-125).
 * It accepts neither a custom transport nor stdio. SDK 2.0.0 Client plus
 * StdioClientTransport works against src/mcp/server.mjs (SDK dist/stdio.mjs,
 * package.json exports["./stdio"]). No listener, gateway, or model is needed.
 * Each call owns and closes its child, including failures/cancellation.
 * Verified with tools/testing/flue-lab-smoke.mjs against a read-only lab copy.
 *
 * MCP schemas remain authoritative: discovery.mjs discover.phrase -> query,
 * discover.type -> type; *-show.name -> name, section.items -> section.
 * Show fixes rules/with_rule_bodies=true. Artifact-write projects path/content,
 * deliberately omitting project_dir so tool data cannot change project scope.
 * test/unit/providers/flue-tools.test.ts compares these schema projections;
 * the lab smoke also compares actual Valibot JSON Schema against tools/list.
 */
export const AIWG_TOOL_NAMES = Object.freeze([
  'aiwg_discover', 'aiwg_show', 'aiwg_artifact_write',
] as const);

export interface AiwgToolOptions {
  /** Trusted app configuration only; never populate these from tool inputs. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Create an isolated set for an app/project; defaults use the installed aiwg. */
export function createAiwgTools(options: AiwgToolOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  // Inherit only SDK-safe process settings and AIWG path settings, not model keys.
  const env = getDefaultEnvironment();
  for (const key of ['AIWG_ROOT', 'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, options.env, { AIWG_MCP_TOOLSETS: '' });

  async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // AIWG serves MCP 2025-11-25; avoid SDK 2's disposable newer-era probe child.
    const client = new Client({ name: 'aiwg-flue', version: '1.0.0' }, {
      versionNegotiation: { mode: 'legacy' },
    });
    const transport = new StdioClientTransport({
      command: options.command ?? 'aiwg', args: options.args ?? ['mcp', 'serve'],
      cwd, env, stderr: 'inherit',
    });
    try {
      await client.connect(transport);
      signal?.throwIfAborted();
      const result = await client.callTool({ name, arguments: args }, { signal, timeout: 180_000 });
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      const output = result.structuredContent === undefined ? text
        : [text, JSON.stringify(result.structuredContent)].filter(Boolean).join('\n');
      if (result.isError) throw new Error(output || `AIWG MCP tool ${name} failed`);
      return { output };
    } finally {
      await client.close();
    }
  }

  const aiwg_discover = defineTool({
    name: AIWG_TOOL_NAMES[0],
    description: 'Find AIWG capabilities and their governing checks. Follow with aiwg_show.',
    input: v.strictObject({
      query: v.string(),
      type: v.optional(v.picklist(['skill', 'agent', 'command', 'rule', 'flow', 'runbook', 'template', 'behavior'])),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: ({ data, signal }) => call('discover', {
      phrase: data.query, ...(data.type === undefined ? {} : { type: data.type }),
    }, signal),
  });
  const aiwg_show = defineTool({
    name: AIWG_TOOL_NAMES[1],
    description: 'Fetch an AIWG card plus governing rule bodies; optionally drill into one heading. Types: skill, agent, command, rule.',
    input: v.strictObject({
      type: v.picklist(['skill', 'agent', 'command', 'rule']),
      name: v.string(), section: v.optional(v.string()),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: ({ data, signal }) => call(`${data.type}-show`, {
      name: data.name, rules: true, with_rule_bodies: true,
      ...(data.section === undefined ? {} : { section: [data.section] }),
    }, signal),
  });
  const aiwg_artifact_write = defineTool({
    name: AIWG_TOOL_NAMES[2],
    description: 'Write an artifact relative to this project’s configured artifact root. AIWG enforces containment.',
    input: v.strictObject({ path: v.string(), content: v.string() }),
    annotations: { readOnlyHint: false, openWorldHint: false },
    run: ({ data, signal }) => call('artifact-write', { path: data.path, content: data.content }, signal),
  });
  return { aiwg_discover, aiwg_show, aiwg_artifact_write };
}

export const { aiwg_discover, aiwg_show, aiwg_artifact_write } = createAiwgTools();
