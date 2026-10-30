// Focused subcommand handlers preserving the public facade.
const REMOVE_FLAGS_WITH_VALUES = new Set([
  '--provider',
  '--platform',
  '--scope',
  '--target',
  '--prefix',
]);

export function firstRemovePositional(args: ReadonlyArray<string>): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (REMOVE_FLAGS_WITH_VALUES.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

export function parseRemoveProvider(args: ReadonlyArray<string>): { provider?: string; error?: string } {
  const idx = args.findIndex(a => a === '--provider' || a === '--platform');
  if (idx < 0) return {};
  const provider = args[idx + 1];
  if (!provider || provider.startsWith('-')) {
    return { error: 'Error: --provider requires a provider name' };
  }
  return { provider };
}
