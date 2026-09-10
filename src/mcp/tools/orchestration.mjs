/**
 * AIWG MCP Orchestration Toolsets
 *
 * First-class MCP surface for the post-#1533 Flow/Mission primitives.
 * These stay opt-in because running flows/missions can trigger writes,
 * shell commands, long-running work, and cross-stack dispatch.
 *
 * @issues #1584 #1539 #1546
 */

import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AIWG_ROOT, mcpError, mcpJson, runAiwgCli } from '../helpers.mjs';

function candidateAiwgRoots() {
  const roots = [
    AIWG_ROOT,
    process.cwd(),
  ];
  return [...new Set(roots.map((r) => path.resolve(r)).filter(Boolean))];
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findFrameworkRoot() {
  for (const root of candidateAiwgRoots()) {
    const frameworksRoot = path.join(root, 'agentic/code/frameworks');
    if (await pathExists(frameworksRoot)) return { aiwgRoot: root, frameworksRoot };
  }
  throw new Error('Could not locate agentic/code/frameworks under AIWG_ROOT or current working directory.');
}

async function walk(dir, predicate, out = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, predicate, out);
    } else if (predicate(full, entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function parseFlowContent(content, sourcePath, frameworksRoot) {
  const parsed = parseYaml(content) || {};
  const rel = path.relative(frameworksRoot, sourcePath);
  const [framework] = rel.split(path.sep);
  const fileName = path.basename(sourcePath);
  const fileStem = fileName.replace(/\.playbook\.ya?ml$/, '');
  const metadata = parsed.metadata || {};
  const spec = parsed.spec || {};
  const steps = Array.isArray(spec.steps) ? spec.steps : [];
  const flowName = metadata.name || fileStem;
  const skillPath = path.join(frameworksRoot, framework, 'skills', flowName, 'SKILL.md');

  return {
    name: flowName,
    framework,
    apiVersion: parsed.apiVersion || null,
    kind: parsed.kind || null,
    labels: metadata.labels || {},
    step_count: steps.length,
    steps: steps.map((step) => ({
      id: step?.id || null,
      kind: step?.kind || null,
      capability: step?.capability || null,
      depends_on: step?.depends_on || [],
    })),
    path: sourcePath,
    relative_path: path.relative(path.dirname(frameworksRoot), sourcePath),
    wrapper_skill: {
      name: flowName,
      path: skillPath,
      exists: false,
    },
    content,
  };
}

export async function listFlows({ framework, filter } = {}) {
  const { frameworksRoot } = await findFrameworkRoot();
  const files = await walk(
    frameworksRoot,
    (full, name) => name.endsWith('.playbook.yaml') && full.includes(`${path.sep}flows${path.sep}`),
  );
  const flows = [];
  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    const flow = parseFlowContent(content, file, frameworksRoot);
    if (framework && flow.framework !== framework) continue;
    if (filter && !flow.name.includes(filter) && !flow.relative_path.includes(filter)) continue;
    flow.wrapper_skill.exists = await pathExists(flow.wrapper_skill.path);
    flows.push(flow);
  }
  flows.sort((a, b) => a.name.localeCompare(b.name));
  return flows;
}

async function findFlow(name, framework) {
  const flows = await listFlows({ framework });
  return flows.find((flow) => (
    flow.name === name ||
    path.basename(flow.path) === name ||
    path.basename(flow.path).replace(/\.playbook\.ya?ml$/, '') === name
  )) || null;
}

async function readMissionSkill() {
  for (const root of candidateAiwgRoots()) {
    const skillPath = path.join(root, 'agentic/code/addons/aiwg-utils/skills/aiwg-mission/SKILL.md');
    try {
      const content = await fs.readFile(skillPath, 'utf-8');
      return { path: skillPath, content };
    } catch {
      // try next root
    }
  }
  throw new Error('Could not locate aiwg-mission SKILL.md under AIWG_ROOT or current working directory.');
}

export function registerFlowToolset(server) {
  server.registerTool('flow-list', {
    title: 'List AIWG Flows',
    description: 'List declarative YAML Flows from the canonical framework corpus. Mirrors the Flow playbook source of truth rather than the deprecated workflow-run stub.',
    inputSchema: {
      framework: z.string().optional().describe('Restrict to one framework (e.g. sdlc-complete)'),
      filter: z.string().optional().describe('Substring filter on flow name or path'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ framework, filter }) => {
    try {
      const flows = await listFlows({ framework, filter });
      return mcpJson({
        count: flows.length,
        flows: flows.map(({ content, ...summary }) => summary),
      });
    } catch (err) {
      return mcpError(`flow-list: ${err.message}`);
    }
  });

  server.registerTool('flow-show', {
    title: 'Show AIWG Flow',
    description: 'Fetch a declarative Flow playbook by name, including parsed step summary and the wrapper skill path when present.',
    inputSchema: {
      name: z.string().describe('Flow name or playbook file name (e.g. flow-release)'),
      framework: z.string().optional().describe('Optional framework disambiguator'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ name, framework }) => {
    try {
      const flow = await findFlow(name, framework);
      if (!flow) return mcpError(`flow-show: flow not found: ${name}`);
      flow.wrapper_skill.exists = await pathExists(flow.wrapper_skill.path);
      return mcpJson(flow);
    } catch (err) {
      return mcpError(`flow-show: ${err.message}`);
    }
  });

  server.registerTool('flow-run', {
    title: 'Run AIWG Flow',
    description: 'Confirmation-gated Flow launch envelope. Returns the YAML playbook plus wrapper skill for the MCP host to execute; AIWG does not yet ship a separate flow executor CLI.',
    inputSchema: {
      name: z.string().describe('Flow name (e.g. flow-release)'),
      framework: z.string().optional().describe('Optional framework disambiguator'),
      project_dir: z.string().optional().describe('Project directory where the Flow should operate'),
      args: z.array(z.string()).default([]).describe('Operator arguments to pass conceptually to the wrapper skill'),
      confirmed: z.boolean().default(false).describe('Required because Flows can run shell commands and write artifacts'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ name, framework, project_dir, args, confirmed }) => {
    if (!confirmed) {
      return mcpError(
        'flow-run requires confirmed=true because Flow steps may run commands, mutate project artifacts, or cross provider boundaries.',
        { requiresConfirmation: true, remediation: 'Review flow-show output first, then re-invoke with confirmed=true.' },
      );
    }
    try {
      const flow = await findFlow(name, framework);
      if (!flow) return mcpError(`flow-run: flow not found: ${name}`);
      let wrapperSkill = null;
      if (await pathExists(flow.wrapper_skill.path)) {
        wrapperSkill = await fs.readFile(flow.wrapper_skill.path, 'utf-8');
        flow.wrapper_skill.exists = true;
      }
      return mcpJson({
        status: 'ready_for_host_execution',
        execution_model: 'MCP host executes the wrapper skill instructions against the YAML playbook; no standalone aiwg flow executor exists yet.',
        project_dir: project_dir || process.cwd(),
        args,
        flow,
        wrapper_skill_content: wrapperSkill,
      });
    } catch (err) {
      return mcpError(`flow-run: ${err.message}`);
    }
  });
}

export function registerMissionToolset(server) {
  server.registerTool('mission-guide', {
    title: 'Show AIWG Mission Primitive',
    description: 'Fetch the aiwg-mission kernel skill. This is the AIWG-owned Mission primitive; it is distinct from the lower-level mc-* Mission Control toolset.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      return mcpJson(await readMissionSkill());
    } catch (err) {
      return mcpError(`mission-guide: ${err.message}`);
    }
  });

  server.registerTool('mission-dispatch', {
    title: 'Dispatch AIWG Mission',
    description: 'Dispatch an AIWG Mission objective to an existing Mission Control session. Distinct from mc-dispatch: this tool applies the aiwg-mission completion-criterion contract and exposes the kernel primitive as first-class MCP.',
    inputSchema: {
      session_id: z.string().describe('Existing Mission Control session id from mc-start / mc-list'),
      objective: z.string().describe('Mission objective'),
      completion: z.string().describe('Measurable completion criterion'),
      max_iterations: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Ralph iteration cap'),
      max_total_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Hard cumulative token ceiling'),
      max_output_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Hard cumulative output-token ceiling'),
      max_tool_calls: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Hard cumulative tool-call ceiling'),
      max_total_cost: z.number().positive().finite().optional().describe('Hard cumulative provider-reported spend ceiling'),
      max_wall_clock_minutes: z.number().positive().finite().optional().describe('Hard cumulative runtime ceiling'),
      exploration_quota: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Require structural variant after this many flat cycles (off unless declared; no default K)'),
      budget_stop_policy: z.enum(['completion-wins', 'budget-wins']).optional().describe('Stop semantics when the completing iteration crosses a ceiling (default: completion-wins)'),
      project_dir: z.string().optional().describe('Project directory for CLI dispatch'),
      confirmed: z.boolean().default(false).describe('Required for durable/long-running mission dispatch'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({
    session_id,
    objective,
    completion,
    max_iterations,
    max_total_tokens,
    max_output_tokens,
    max_tool_calls,
    max_total_cost,
    max_wall_clock_minutes,
    exploration_quota,
    budget_stop_policy,
    project_dir,
    confirmed,
  }) => {
    if (!confirmed) {
      return mcpError(
        'mission-dispatch requires confirmed=true because Missions can launch long-running worker cycles.',
        { requiresConfirmation: true, remediation: 'Surface objective, completion, and target session to the operator before confirming.' },
      );
    }
    try {
      const cliArgs = ['mc', 'dispatch', session_id, objective, '--completion', completion];
      if (max_iterations) cliArgs.push('--max-iterations', String(max_iterations));
      if (max_total_tokens) cliArgs.push('--max-total-tokens', String(max_total_tokens));
      if (max_output_tokens) cliArgs.push('--max-output-tokens', String(max_output_tokens));
      if (max_tool_calls) cliArgs.push('--max-tool-calls', String(max_tool_calls));
      if (max_total_cost) cliArgs.push('--max-total-cost', String(max_total_cost));
      if (max_wall_clock_minutes) cliArgs.push('--max-wall-clock-minutes', String(max_wall_clock_minutes));
      if (exploration_quota) cliArgs.push('--exploration-quota', String(exploration_quota));
      if (budget_stop_policy) cliArgs.push('--budget-stop-policy', budget_stop_policy);
      const { stdout, stderr, code } = await runAiwgCli(
        cliArgs,
        { cwd: project_dir, timeoutMs: 30_000 },
      );
      return mcpJson({
        command: 'aiwg mc dispatch',
        exit_code: code,
        stdout,
        stderr,
        relationship_to_mc: 'AIWG Mission is the orchestration contract; mc is the durable dispatch/session substrate.',
      });
    } catch (err) {
      return mcpError(`mission-dispatch: ${err.message}`);
    }
  });

  server.registerTool('mission-status', {
    title: 'AIWG Mission Status',
    description: 'Read Mission status through the durable Mission Control substrate.',
    inputSchema: {
      session_id: z.string().optional().describe('Optional Mission Control session id'),
      project_dir: z.string().optional().describe('Project directory for CLI status lookup'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ session_id, project_dir }) => {
    try {
      const args = ['mc', 'status', '--json'];
      if (session_id) args.push('--session', session_id);
      const { stdout, stderr, code } = await runAiwgCli(args, { cwd: project_dir, timeoutMs: 30_000 });
      if (code !== 0) return mcpError(`mission-status failed (exit ${code}): ${stderr || stdout}`);
      try {
        return mcpJson(JSON.parse(stdout));
      } catch {
        return mcpJson({ stdout, stderr });
      }
    } catch (err) {
      return mcpError(`mission-status: ${err.message}`);
    }
  });
}
