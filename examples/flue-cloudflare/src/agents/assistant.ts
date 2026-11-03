'use agent';
import { useModel, useMcpConnection, useSkill, useSubagent } from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';
import { sdlcQuickref as quickref } from '../aiwg/skills.ts';
import { codeReviewer } from '../aiwg/specialists.ts';
import { aiwgConnection, bindRemoteSpecialist } from '../aiwg/tools.ts';

export function Assistant() {
  const { env } = getCloudflareContext();
  const model = typeof env.FLUE_MODEL === 'string' ? env.FLUE_MODEL : 'openrouter/anthropic/claude-haiku-4.5';
  const connection = aiwgConnection();
  useModel(model);
  useMcpConnection(connection);
  useSkill(quickref);
  useSubagent(bindRemoteSpecialist({ ...codeReviewer, model }, connection));
  return `Help with software development. Discover sdlc-quickref and show its
rules with the remote AIWG tools. Activate the skill, delegate reviews to
code-reviewer, and save findings using mcp__aiwg__artifact-write.
Use remote AIWG tools for artifacts; the remote server owns the project.`;
}
// Durable storage identity survives function and file renames.
Assistant.agentName = 'aiwg-assistant';
