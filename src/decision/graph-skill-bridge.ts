import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveRoutableCapability } from '../artifacts/capability-resolver.js';
import { parseDecisionJson } from './entry.js';
import { DecisionGraphError, type DecisionGraph } from './graph.js';
import { assertDecisionFlowPins, assertUnknownCostBound, decisionFlowNode, decisionFlowResponse,
  type DecisionResultProjection } from './graph-decision-bridge.js';
import type { RulesetResult } from './types.js';
import type { GraphFlowRequest, GraphFlowResponse } from './graph-flow-adapter.js';

/** The shipped decision-evaluate skill as resolved from the capability catalog. */
export interface DecisionEvaluateSkill { id: `aiwg:skill:${string}`; scriptPath: string }

/** Resolve the packaged `decision-evaluate` skill: its stable catalog ID becomes the
 * Flow node ref, and its declared script entrypoint is the only program invoked.
 * Neither comes from graph evidence.
 */
export async function resolveDecisionEvaluateSkill(frameworkRoot: string): Promise<DecisionEvaluateSkill> {
  const skill = await resolveRoutableCapability(frameworkRoot, 'skill', 'decision-evaluate');
  if (!/^aiwg:skill:[a-f0-9]{16}$/.test(skill.id)) throw new DecisionGraphError('invalid decision-evaluate skill ID');
  const manifest = resolve(frameworkRoot, skill.source.path);
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(await readFile(manifest, 'utf8'))?.[1] ?? '';
  const entrypoint = /^\s+entrypoint:\s*(\S+)\s*$/m.exec(frontmatter)?.[1];
  const scriptPath = entrypoint ? resolve(dirname(manifest), entrypoint) : '';
  const inside = relative(dirname(manifest), scriptPath);
  if (!entrypoint || !inside || inside.startsWith('..') || isAbsolute(inside)) throw new DecisionGraphError('invalid decision-evaluate entrypoint');
  return { id: skill.id as DecisionEvaluateSkill['id'], scriptPath };
}

/** Host-authored dispatcher request fields, as documented by the skill. Paths are absolute.
 * The bridge adds `inputPath` for dependent nodes plus the Flow `runId`/`invocationId`.
 */
export interface DecisionSkillRequest {
  rulesetPath: string; bindingPath: string; definitionPaths: string[];
  /** Trusted host input; used only by the graph entry node. */
  inputPath?: string;
  adapterModules?: Record<string, string>;
  credentials?: Record<string, string>;
  receiptDirectory?: string; receiptIntegrityKeyRef?: string; receiptIntegrityKeyEncoding?: 'hex' | 'base64';
}
export interface DecisionSkillRun { scriptPath: string; requestPath: string; env: Record<string, string>; timeoutMs: number }

/** Default runner: executes the skill entrypoint with a minimal environment.
 * Only PATH, the opt-in flag and host-listed variables reach the child process.
 */
export function runDecisionEvaluateSkill(run: DecisionSkillRun): Promise<{ code: number; stdout: string }> {
  return new Promise(done => {
    execFile(process.execPath, [run.scriptPath, '--request', run.requestPath], {
      cwd: dirname(run.requestPath), timeout: run.timeoutMs, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '', ...run.env, AIWG_DECISION_ENABLED: '1' },
    }, (error, stdout) => done({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout }));
  });
}

/** Flow skill invoker that runs the shipped decision-evaluate skill for every graph node.
 * Each call writes a private dispatcher request (and, for a dependent node, only its
 * declared projected evidence as input), runs the skill script, and accepts only a
 * RulesetResult for the same Flow run/invocation and binding pin. The skill's own
 * stderr is never propagated into graph errors.
 */
export function decisionEvaluateSkillFlowInvoker(graph: DecisionGraph, host: DecisionResultProjection & {
  skill: DecisionEvaluateSkill;
  request: (nodeId: string) => DecisionSkillRequest;
  /** Existing private directory for per-invocation request documents. */
  workDirectory: string;
  /** Environment values the dispatcher request's credential mapping names. */
  env?: Record<string, string>;
  timeoutMs?: number;
  run?: (run: DecisionSkillRun) => Promise<{ code: number; stdout: string }>;
}): (request: GraphFlowRequest) => Promise<GraphFlowResponse> {
  assertUnknownCostBound(host);
  if (!isAbsolute(host.workDirectory)) throw new DecisionGraphError('skill work directory must be absolute');
  return async flow => {
    const { node, input } = decisionFlowNode(graph, flow);
    const base = host.request(node.id);
    const paths = [base.rulesetPath, base.bindingPath, ...base.definitionPaths,
      ...(base.inputPath === undefined ? [] : [base.inputPath]), ...Object.values(base.adapterModules ?? {}),
      ...(base.receiptDirectory === undefined ? [] : [base.receiptDirectory])];
    if (!base.definitionPaths.length || paths.some(path => typeof path !== 'string' || !isAbsolute(path)) ||
        (node.id === graph.entry && base.inputPath === undefined)) throw new DecisionGraphError('invalid decision-evaluate request');
    const load = async (path: string) => parseDecisionJson(await readFile(path, 'utf8')) as { metadata: { id: string; version: string } };
    assertDecisionFlowPins(node, await load(base.bindingPath), await Promise.all(base.definitionPaths.map(load)));
    const directory = await mkdtemp(join(host.workDirectory, 'decision-evaluate-'));
    try {
      await chmod(directory, 0o700);
      let inputPath = base.inputPath;
      if (node.id !== graph.entry) {
        inputPath = join(directory, 'input.json');
        await writeFile(inputPath, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
      }
      const requestPath = join(directory, 'request.json');
      await writeFile(requestPath, JSON.stringify({ ...base, inputPath, runId: flow.runId, invocationId: flow.invocationKey }),
        { mode: 0o600, flag: 'wx' });
      const outcome = await (host.run ?? runDecisionEvaluateSkill)({ scriptPath: host.skill.scriptPath, requestPath,
        env: { ...(host.env ?? {}) }, timeoutMs: host.timeoutMs ?? 60_000 });
      // Exit 1 still carries an error/cancelled RulesetResult; anything else is a failure.
      if (outcome.code !== 0 && outcome.code !== 1) throw new DecisionGraphError('decision-evaluate skill failed');
      let result: RulesetResult;
      try { result = parseDecisionJson(outcome.stdout) as RulesetResult; } catch { throw new DecisionGraphError('invalid decision-evaluate output'); }
      if (!result || result.kind !== 'RulesetResult' || !result.spec || result.spec.runId !== flow.runId ||
          result.spec.invocationId !== flow.invocationKey || result.spec.binding?.digest !== node.binding.digest ||
          !result.spec.evaluations || typeof result.spec.evaluations !== 'object') {
        throw new DecisionGraphError('decision-evaluate result does not match its Flow invocation');
      }
      return decisionFlowResponse(graph, node, result, host);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
