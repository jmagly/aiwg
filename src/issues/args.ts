/** Shared issue/workflow flags: ordered sets for list values, no silent overwrites. */
export interface ParsedArgs {
  cwd?: string;
  raw: string[];
  positional: string[];
  flags: Map<string, string | boolean>;
}

const repeatable = new Set(['label', 'assignee', 'add-label', 'remove-label']);

export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (flags.has(key) && !repeatable.has(key)) throw new Error(`--${key} may only be specified once`);
    const next = args[i + 1];
    const value = inline !== undefined ? inline : next !== undefined && !next.startsWith('--') ? args[++i] : true;
    if (key === 'template' && (typeof value !== 'string' || !value.trim())) {
      throw new Error('--template requires a non-empty name or path');
    }
    if (repeatable.has(key)) {
      if (typeof value !== 'string' || !value.split(',').some(item => item.trim())) {
        throw new Error(`--${key} requires a non-empty value`);
      }
      const values = [...csvFlag({ flags }, key), ...value.split(',').map(item => item.trim()).filter(Boolean)];
      flags.set(key, [...new Set(values)].join(','));
    } else {
      flags.set(key, value);
    }
  }
  return { raw: args, positional, flags };
}

export function stringFlag(args: Pick<ParsedArgs, 'flags'>, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function csvFlag(args: Pick<ParsedArgs, 'flags'>, name: string): string[] {
  return [...new Set((stringFlag(args, name) ?? '').split(',').map(item => item.trim()).filter(Boolean))];
}
