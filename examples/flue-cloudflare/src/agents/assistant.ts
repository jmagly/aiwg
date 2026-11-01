'use agent';
import { useModel, useMcpConnection, useSkill, useSubagent } from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';
import quickref from '@aiwg/flue/skills/sdlc-quickref/SKILL.md';
import { codeReviewer } from '@aiwg/flue/specialists';
import { aiwgConnection } from '../aiwg/tools.ts';

export function Assistant() {
  const { env } = getCloudflareContext();
  const model = typeof env.FLUE_MODEL === 'string' ? env.FLUE_MODEL : 'openrouter/anthropic/claude-haiku-4.5';
  const connection = aiwgConnection();
  useModel(model);
  useMcpConnection(connection);
  useSkill(quickref);
  useSubagent(codeReviewer({ model, connection }));
  return `Help with software development. Discover sdlc-quickref and show its
rules with the remote AIWG tools. Activate the skill, delegate reviews to
code-reviewer, and save findings using mcp__aiwg__artifact-write.
Use remote AIWG tools for artifacts; the remote server owns the project.`;
}
// Durable storage identity survives function and file renames.
Assistant.agentName = 'aiwg-assistant';
