// Keyless model script for the real workerd example; never calls a model service.
import { setProvider } from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';

const fake = fauxProvider({ provider: 'aiwg-cf-test', models: [{ id: 'scripted' }] });
setProvider(fake.provider);
const call = (name: string, args: Record<string, string | boolean>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function respond(context: TranscriptContext) {
  const user = context.messages.findLast(message => message.role === 'user');
  const prompt = JSON.stringify(user);
  if (prompt.includes('resume-state')) {
    const history = JSON.stringify(context);
    check(history.includes('PASS Cloudflare review') && history.includes('review-state-3127'), 'Prior conversation state missing');
    return fauxAssistantMessage('PASS resumed review-state-3127');
  }
  if (prompt.includes('specialist-review')) {
    const tools = context.messages.flatMap(message => message.role === 'system' ? message.toolsAdded || [] : []).map(tool => tool.name);
    for (const name of ['mcp__aiwg__discover', 'mcp__aiwg__skill-show', 'mcp__aiwg__artifact-write']) {
      check(tools.includes(name), `Specialist missing ${name}`);
    }
    for (const name of ['bash', 'read', 'write', 'edit']) check(!tools.includes(name), `Unexpected local tool ${name}`);
    return fauxAssistantMessage('Code Reviewer: use a + b.');
  }
  if (prompt.includes('__abort__')) return call('mcp__aiwg__discover', { phrase: '__wait_for_cancel__' });
  const last = context.messages.findLast(message => message.role === 'toolResult');
  if (!last || last.role !== 'toolResult') {
    const system = context.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message)).join('\n');
    check(/## Available Skills[\s\S]*sdlc-quickref/.test(system), 'Packaged skill absent from catalog');
    return call('mcp__aiwg__discover', { phrase: 'sdlc-quickref', type: 'skill' });
  }
  check(!last.isError, `Tool failed: ${JSON.stringify(last)}`);
  const text = last.content.map(block => block.type === 'text' ? block.text : '').join('\n');
  switch (last.toolName) {
    case 'mcp__aiwg__discover': {
      const discovery = JSON.parse(text);
      check(discovery.results.some((item: { name: string; type: string }) => item.name === 'sdlc-quickref' && item.type === 'skill'), 'Requested skill absent');
      return call('mcp__aiwg__skill-show', { name: 'sdlc-quickref', rules: true });
    }
    case 'mcp__aiwg__skill-show': {
      const card = JSON.parse(text);
      check(card.name === 'sdlc-quickref' && card.bound_rules.some((rule: { name: string }) => rule.name === 'sdlc-orchestration'), 'Governing rules absent');
      return call('activate_skill', { name: 'sdlc-quickref' });
    }
    case 'activate_skill':
      check(text.includes('SDLC Framework'), 'Packaged skill instructions missing');
      return call('task', { agent: 'code-reviewer', prompt: 'specialist-review: export const add = (a, b) => a - b;' });
    case 'task':
      check(text.includes('Code Reviewer: use a + b.'), 'Delegate result differs');
      return call('mcp__aiwg__artifact-write', { path: 'reviews/cloudflare.md', content: 'Code Reviewer: use a + b.\n' });
    case 'mcp__aiwg__artifact-write': {
      const written = JSON.parse(text);
      check(written.status === 'success' && written.path === getCloudflareContext().env.AIWG_EXPECTED_ARTIFACT, 'Write escaped bound project');
      return fauxAssistantMessage('PASS Cloudflare review review-state-3127');
    }
    default: throw new Error(`Unexpected tool ${last.toolName}`);
  }
}
fake.setResponses(Array.from({ length: 100 }, () => respond));
