/**
 * Copilot hook translator — emits dual-format JSON: a workflow file at
 * `.github/hooks/<id>.json` plus an inline `hooks:` block embedded in the
 * agent .agent.md frontmatter when the hook targets a specific agent.
 *
 * Per the parity research, Copilot hook discovery is partially documented;
 * the emission here is conservative — produces the shape Copilot Chat is
 * known to consume, marks AIWG provenance, and stages behind the feature
 * flag handled by the orchestrator.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { HookSource, TranslateOptions, TranslateResult } from './types.js';
import { substituteEnvVars } from './shim.js';
import { PROMPT_DISCOVERY_GAPS } from './prompt-discovery-gaps.js';

const COPILOT_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  UserPromptSubmit: 'pre_chat',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'session_end',
};

export async function translateForCopilot(
  source: HookSource,
  options: TranslateOptions,
): Promise<TranslateResult> {
  const result: TranslateResult = {
    provider: 'copilot',
    emittedPaths: [],
    warnings: [],
    skipped: false,
  };

  if (source.degradeOn?.includes('copilot')) {
    result.skipped = true;
    result.skipReason = source.id === 'aiwg-prompt-discovery' ? PROMPT_DISCOVERY_GAPS.copilot : 'degrade-on declared copilot';
    return result;
  }

  const hooksDir = path.join(options.projectPath, '.github', 'hooks');
  const filePath = path.join(hooksDir, `${source.id}.json`);

  const events = source.events
    .map((e) => COPILOT_EVENT_MAP[e])
    .filter((e): e is string => Boolean(e));
  if (events.length === 0) {
    result.skipped = true;
    result.skipReason = 'no Copilot-mapped events';
    return result;
  }

  const subCommand = substituteEnvVars(source.command, 'copilot');
  const subArgs = (source.args || []).map((a) => substituteEnvVars(a, 'copilot'));

  const payload = {
    _aiwg_managed: true,
    _aiwg_id: source.id,
    description: source.description,
    events,
    command: subCommand,
    args: subArgs,
    safety_critical: !!source.safetyCritical,
  };

  if (options.dryRun) {
    result.emittedPaths.push(filePath + ' (dry-run)');
    return result;
  }

  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  result.emittedPaths.push(filePath);
  return result;
}
