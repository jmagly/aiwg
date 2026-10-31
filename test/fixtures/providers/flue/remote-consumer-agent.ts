'use agent';
// Exercise packed remote tools through Flue's real agent execution path.
import { setProvider, useModel, useMcpConnection } from '@flue/runtime';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { createAiwgConnection } from '@aiwg/flue/tools';

const fake = fauxProvider();
setProvider(fake.provider);
const call = (name: string, args: Record<string, string | boolean>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
function result(context: TranscriptContext, name: string) {
  const message = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === name);
  if (!message || message.role !== 'toolResult' || message.isError) throw new Error(`Missing successful ${name} result`);
  return JSON.parse(message.content.map(block => block.type === 'text' ? block.text : '').join('\n'));
}
fake.setResponses([
  call('mcp__aiwg__discover', { phrase: 'sdlc-quickref', type: 'skill' }),
  context => {
    const discovery = result(context, 'mcp__aiwg__discover');
    if (!discovery.results?.some((item: { name: string; type: string }) => item.name === 'sdlc-quickref' && item.type === 'skill')) {
      throw new Error('Discovery omitted the requested skill');
    }
    return call('mcp__aiwg__skill-show', { name: 'sdlc-quickref', rules: true });
  },
  context => {
    const card = result(context, 'mcp__aiwg__skill-show');
    if (card.name !== 'sdlc-quickref' || card.type !== 'skill'
      || !card.bound_rules?.some((rule: { name: string }) => rule.name === 'sdlc-orchestration')) {
      throw new Error('Skill card or governing rules differ');
    }
    return call('mcp__aiwg__artifact-write', { path: 'flue/remote.md', content: 'Packed remote Flue write\n' });
  },
  context => {
    const written = result(context, 'mcp__aiwg__artifact-write');
    if (written.status !== 'success' || written.path !== process.env.AIWG_REMOTE_ARTIFACT) {
      throw new Error('Artifact result differs from the bound project');
    }
    return fauxAssistantMessage('PASS packed remote consumer');
  },
]);

export function RemoteConsumer() {
  useModel(`${fake.provider.id}/${fake.getModel().id}`);
  useMcpConnection(createAiwgConnection({ url: process.env.AIWG_REMOTE_URL!, token: process.env.AIWG_REMOTE_TOKEN! }));
  return 'Discover sdlc-quickref, show its governing rules, and write the remote artifact.';
}
