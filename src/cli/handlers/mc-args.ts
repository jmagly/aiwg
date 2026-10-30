// Mission Control args operations, extracted from the shared handler.

export function parseFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      return i + 1 < args.length ? args[i + 1] : undefined;
    }
    // Support --flag=value — previously silently ignored, which for budget
    // flags meant an unbounded loop the operator believed was capped (#1770)
    if (args[i].startsWith(`${flag}=`)) {
      return args[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Parse a numeric flag. A flag that is PRESENT but not a positive number is a
 * usage error collected into `invalidSink` — silently dropping it used to
 * dispatch missions with no ceiling while the operator believed one applied
 * (#1770).
 */
export function parseNumberFlag(args: string[], flag: string, invalidSink?: string[], integer = false): number | undefined {
  if (!args.some(arg => arg === flag || arg.startsWith(`${flag}=`))) return undefined;
  const raw = parseFlag(args, flag);
  // Presence and validity are distinct: a trailing flag must not silently
  // disappear, and counter limits must not accept fractional/unsafe values.
  const decimal = typeof raw === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw);
  const value = decimal ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    invalidSink?.push(`${flag} (got '${raw}')`);
    return undefined;
  }
  return value;
}

export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      // Skip flag and its value if it has one
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    positional.push(args[i]);
  }
  return positional;
}
