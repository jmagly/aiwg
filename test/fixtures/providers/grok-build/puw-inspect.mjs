#!/usr/bin/env node
// Offline inspect-only CLI fixture: no login, model calls or configuration writes.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const entries = dir => existsSync(dir) ? readdirSync(dir) : [];
const cwd = process.cwd();
if (process.argv[2] === '--version') console.log('grok 1.0.77 synthetic-puw');
else if (process.argv[2] === 'inspect') {
  console.log(JSON.stringify({
    projectInstructions: [
      ...(existsSync(join(cwd, 'AGENTS.md')) ? [{ path: join(cwd, 'AGENTS.md') }] : []),
      ...entries(join(cwd, '.grok/rules')).map(name => ({ path: join(cwd, '.grok/rules', name) })),
    ],
    skills: entries(join(cwd, '.grok/skills')).filter(name => existsSync(join(cwd, '.grok/skills', name, 'SKILL.md')))
      .map(name => ({ name, source: { type: 'project', path: join(cwd, '.grok/skills', name) } })),
    agents: entries(join(cwd, '.grok/agents')).filter(name => name.endsWith('.md'))
      .map(name => ({ name: name.slice(0, -3) })),
    configSources: { layers: [{ path: join(cwd, '.grok/config.toml') }] },
  }));
} else {
  console.error('Synthetic PUW fixture supports only --version and inspect');
  process.exitCode = 2;
}
