// Render shipped session handoff documents and persist them beside their checkpoint record.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertCheckpointRecord, type Checkpoint } from './checkpoint-record.js';

interface HandoffInput {
  scope?: string;
  todos: string[];
  constraints: string[];
}

export async function writeCheckpointHandoff(
  frameworkRoot: string, checkpointsDir: string, record: Checkpoint, input: HandoffInput,
): Promise<void> {
  const template = await readFile(join(frameworkRoot,
    'agentic/code/addons/aiwg-utils/templates/checkpoint-handoff.md'), 'utf8');
  const dir = join(checkpointsDir, record.id);
  record.handoffPath = join(dir, 'handoff.md');
  record.nextSessionPromptPath = join(dir, 'next-session-prompt.md');
  assertCheckpointRecord(record, join(record.id, 'checkpoint.json'));
  const fields: Record<string, string> = {
    scope: input.scope ?? '[TODO: Define scope and ownership.]',
    state: [
      `Checkpoint: ${record.id}${record.name ? ` (${record.name})` : ''}`,
      `Created: ${record.createdAt}`,
      `Working directory: ${record.cwd}`,
      `Phase: ${record.phase ?? '[TODO: Record current phase.]'}`,
      `Step: ${record.step ?? '[TODO: Record current step.]'}`,
      ...(record.gitHead ? [`Git HEAD: ${record.gitHead}`] : []),
      record.note ?? '[TODO: Describe completed work, verification, and outstanding state.]',
    ].join('\n\n'),
    todos: input.todos.length ? input.todos.map((todo, i) => `${i + 1}. ${todo}`).join('\n')
      : '1. [TODO: List remaining work in execution order.]',
    constraints: input.constraints.length ? input.constraints.map(item => `- ${item}`).join('\n')
      : '- [TODO: Record binding constraints.]',
    links: record.artifacts.length ? record.artifacts.map(path => `- ${path}`).join('\n')
      : '- [TODO: Link relevant artifacts and references.]',
  };
  const body = template.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const handoff = body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => fields[key] ?? match);
  const prompt = [
    `Continue checkpoint ${record.id}${record.name ? ` (${record.name})` : ''} in ${record.cwd}.`,
    'Read WORKSPACE.md and AIWG.md if present, then read the handoff:',
    record.handoffPath,
    'Follow its binding constraints and ordered to-do list. Verify current state before continuing.',
    '',
  ].join('\n');
  await mkdir(dir);
  try {
    await writeFile(record.handoffPath, handoff, { flag: 'wx' });
    await writeFile(record.nextSessionPromptPath, prompt, { flag: 'wx' });
    await writeFile(join(dir, 'checkpoint.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
