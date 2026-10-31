// Inline the canonical context for Flue's cwd-only byte loader.
import fs from 'node:fs';
import path from 'node:path';
import { ensureCoreStartup } from '../../rules/core-startup.mjs';
import { PROVIDER_RULE_AUTHORITY } from './workspace-bootstrap.js';
import { writeContextFileSync } from './context-file-safety.js';

export function writeFlueContext(project: string): string {
  const read = (name: string) => fs.existsSync(path.join(project, name)) ? fs.readFileSync(path.join(project, name), 'utf8') : '';
  const start = '<!-- AIWG:flue-context:start -->', end = '<!-- AIWG:flue-context:end -->';
  const existing = read('AGENTS.md');
  const body = [read('WORKSPACE.md'), read('AIWG.md')].filter(Boolean).join('\n\n')
    .replace(/<!-- AIWG:provider-bootstrap:start -->[\s\S]*?<!-- AIWG:provider-bootstrap:end -->/g, '');
  const block = `${start}\n# Flue AIWG context (experimental)\n\n${PROVIDER_RULE_AUTHORITY.join('\n')}\n\n${ensureCoreStartup(body)}\n${end}`;
  const from = existing.indexOf(start), to = existing.indexOf(end);
  if ((from >= 0) !== (to >= 0) || from >= 0 && to < from) throw new Error('Malformed AIWG Flue context markers in AGENTS.md');
  const content = from >= 0 ? existing.slice(0, from) + block + existing.slice(to + end.length)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${block}\n`;
  writeContextFileSync(path.join(project, 'AGENTS.md'), content);
  return content;
}
