'use agent';
// Consume static package exports and exercise them with a local Pi provider.
import { setProvider, useModel, useSkill, useSubagent, useTool } from '@flue/runtime';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import skill from '@aiwg/flue/skills/sdlc-quickref/SKILL.md';
import { codeReviewer } from '@aiwg/flue/specialists';
import { createAiwgTools } from '@aiwg/flue/tools/node';
const fake = fauxProvider();
setProvider(fake.provider);
const call = (name: string, args: Record<string, string>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
fake.setResponses([
  call('activate_skill', { name: 'sdlc-quickref' }),
  context => {
    if (!JSON.stringify(context).includes('SDLC')) throw new Error('Skill was not activated');
    return call('task', { agent: 'code-reviewer', prompt: 'Review synthetic change' });
  },
  () => fauxAssistantMessage('Synthetic review complete'),
  context => {
    if (!JSON.stringify(context).includes('Synthetic review complete')) throw new Error('Specialist did not run');
    return fauxAssistantMessage('PASS package consumer');
  },
]);
export function Consumer() {
  const model = `${fake.provider.id}/${fake.getModel().id}`;
  useModel(model);
  const tools = Object.values(createAiwgTools());
  for (const tool of tools) useTool(tool);
  useSkill(skill);
  useSubagent(codeReviewer({ model, tools }));
  return 'Activate sdlc-quickref, then ask code-reviewer to review a synthetic change.';
}
