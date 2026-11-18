// Shares scaffold argument and target validation between the router and standalone tool.
import fs from 'node:fs';
import path from 'node:path';

export interface NewProjectOptions {
  name: string;
  withAgents: boolean;
  provider: string;
  /** Copy standard artifacts into provider directories (#4279); indexed discovery otherwise. */
  copy: boolean;
  mode: 'help' | 'list' | 'scaffold';
}

export function parseNewProjectArgs(args: string[], cwd: string): NewProjectOptions {
  const options: NewProjectOptions = {
    name: path.basename(cwd), withAgents: true, provider: 'claude', copy: false, mode: 'scaffold',
  };
  if (args.includes('--help') || args.includes('-h')) return { ...options, mode: 'help' };
  let target: string | undefined;
  let listTemplates = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' || arg === '--provider') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`${arg} requires a value`);
      const value = args[++i];
      if (arg === '--name') options.name = value;
      else options.provider = value.toLowerCase();
    } else if (arg === '--no-agents') options.withAgents = false;
    else if (arg === '--copy' || arg === '--copy-all') options.copy = true;
    else if (arg === '--list-templates') listTemplates = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (target !== undefined) throw new Error('Only one project target is allowed');
    else { target = arg; if (arg !== '.') options.name = arg; }
  }
  if (listTemplates) return { ...options, mode: 'list' };
  if (target !== '.' && fs.readdirSync(cwd).length > 0) {
    throw new Error('Current directory is not empty. Run aiwg new . to explicitly scaffold here.');
  }
  return options;
}
