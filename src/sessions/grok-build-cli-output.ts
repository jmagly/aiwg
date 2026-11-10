// Fail-closed parsers for the captured Grok Build 1.0.77 public CLI output.
import { SessionContractError } from './contracts.js';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const listRow = new RegExp(`^(${UUID})  \\d{4}-\\d{2}-\\d{2}  \\d{4}-\\d{2}-\\d{2}  local  .+$`, 'i');
const searchRow = new RegExp(`^(${UUID}) \\(score: \\d+\\.\\d+\\)  [A-Z][a-z]{2} \\d{2}, +\\d{1,2}:\\d{2}[ap]m$`, 'i');
const drift = (message: string): never => { throw new SessionContractError('SCHEMA_DRIFT', `unrecognized Grok Build ${message}; check CLI version and use a supported export`); };

export function parseGrokSessionIds(stdout: string, mode: 'list' | 'search'): string[] {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 1 && lines[0] === 'No sessions found.') return [];
  const ids: string[] = [];
  let header = false;
  let total: number | undefined;
  let label = false;
  for (const line of lines) {
    if (mode === 'list') {
      if (line === '(no label)' || /^Label: .+$/.test(line)) {
        if (label) drift('list label');
        label = true; header = false; continue;
      }
      if (/^SESSION ID +CREATED +UPDATED +STATUS +SUMMARY$/.test(line)) {
        if (header) drift('list header');
        header = true; label = false; continue;
      }
      const row = listRow.exec(line);
      if (!header || !row) drift('list row');
      ids.push(row![1].toLowerCase());
    } else {
      if (total !== undefined) drift('search trailer');
      const row = searchRow.exec(line);
      if (row) { ids.push(row[1].toLowerCase()); continue; }
      if (/^Total: \d+$/.test(line)) { total = Number(line.slice(7)); continue; }
      if (/^  \S/.test(line) && ids.length) continue;
      drift('search row');
    }
  }
  if (mode === 'list' ? !header || label : total !== ids.length) drift(`${mode} output`);
  if (new Set(ids).size !== ids.length) drift(`${mode} duplicate session IDs`);
  return ids;
}

const resultKeys = ['text', 'stopReason', 'sessionId', 'requestId', 'cwd', 'thought', 'usage', 'num_turns', 'total_cost_usd', 'total_cost_usd_ticks', 'modelUsage'];
const eventKeys: Record<string, string[]> = {
  text: ['type', 'data'], thought: ['type', 'data'],
  available_commands: ['type', 'tools', 'commands'],
  usage: ['type', 'usage', 'signature'],
  tool_call: ['type', 'toolCallId', 'title', 'kind', 'status', 'toolName', 'rawInput', 'content', 'locations'],
  tool_call_update: ['type', 'toolCallId', 'status', 'content', 'rawOutput', 'locations'],
  end: ['type', ...resultKeys.filter(k => k !== 'text' && k !== 'thought')],
};
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateGrokHeadlessEnvelope(value: Record<string, unknown>, format: 'json' | 'streaming-json'): void {
  const type = format === 'json' ? 'result' : String(value.type);
  const keys = type === 'result' ? resultKeys : eventKeys[type];
  if (!keys || Object.keys(value).some(key => !keys.includes(key))) drift('headless event');
  if (type === 'result' || type === 'end') {
    for (const key of ['sessionId', 'requestId', 'cwd', 'stopReason']) if (typeof value[key] !== 'string') drift('headless result');
    for (const key of ['usage', 'modelUsage']) if (!object(value[key])) drift('headless usage');
    for (const key of ['num_turns', 'total_cost_usd', 'total_cost_usd_ticks']) if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) drift('headless usage');
    if (type === 'result' && (typeof value.text !== 'string' || typeof value.thought !== 'string')) drift('headless result');
  } else if (type === 'text' || type === 'thought') {
    if (typeof value.data !== 'string') drift('headless text');
  } else if (type === 'available_commands') {
    if (!Array.isArray(value.tools) || !Array.isArray(value.commands)) drift('headless commands');
  } else if (type === 'usage') {
    if (!object(value.usage) || typeof value.signature !== 'string') drift('headless usage');
  } else {
    if (typeof value.toolCallId !== 'string' || !value.toolCallId || !Array.isArray(value.content) || !Array.isArray(value.locations)) drift('headless tool call');
    if (type === 'tool_call') {
      for (const key of ['title', 'kind', 'status', 'toolName']) if (typeof value[key] !== 'string') drift('headless tool call');
      if (!object(value.rawInput)) drift('headless tool call');
    } else if (!(value.status === null || typeof value.status === 'string') || !(value.rawOutput === null || object(value.rawOutput))) drift('headless tool update');
  }
}
