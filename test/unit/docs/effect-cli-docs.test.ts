/**
 * `aiwg effect` documentation stays in step with the CLI (#2720): the help
 * text, docs/cli/reference.md and man/aiwg.1 list every subcommand and every
 * exit code, and the contract's exit-code table matches EFFECT_EXIT_CODES.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EFFECT_SUBCOMMANDS, effectUsage } from '../../../src/cli/handlers/effect.js';
import { EFFECT_EXIT_CODES } from '../../../src/effects/index.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const codes = [...new Set(Object.values(EFFECT_EXIT_CODES))].sort((a, b) => a - b);

describe('aiwg effect documentation', () => {
  const reference = read('docs/cli/reference.md');
  const section = reference.split('## Effect Ledger Commands')[1]?.split('\n## ')[0] ?? '';
  const man = read('man/aiwg.1');
  const help = effectUsage();

  it('lists every subcommand in the help text, the reference and the man page', () => {
    expect(section).not.toBe('');
    for (const sub of EFFECT_SUBCOMMANDS) {
      expect(help, `help: ${sub}`).toContain(`aiwg effect ${sub}`);
      expect(section, `reference: ${sub}`).toContain(`aiwg effect ${sub}`);
      expect(section, `reference table: ${sub}`).toContain(`| \`${sub}\` |`);
      expect(man, `man: ${sub}`).toMatch(new RegExp(`^\\.B effect ${sub.replace('-', '\\\\?-')}\\b`, 'm'));
    }
  });

  it('documents every exit code in the help text, the reference and the man page', () => {
    const manExit = man.split('.B aiwg effect')[1] ?? '';
    for (const code of codes) {
      expect(help, `help: ${code}`).toMatch(new RegExp(`\\b${code} [a-z]`));
      expect(section, `reference: ${code}`).toContain(`| \`${code}\` |`);
      expect(manExit, `man: ${code}`).toMatch(new RegExp(`^\\.B ${code}$`, 'm'));
    }
  });

  it('matches the contract exit-code table', () => {
    const contract = read('docs/contracts/effect-ledger.v1.md');
    const table = contract.split('<!-- effect-exit-codes:begin -->')[1]?.split('<!-- effect-exit-codes:end -->')[0] ?? '';
    const documented = [...table.matchAll(/^\| `(\d+)` \|/gm)].map(match => Number(match[1]));
    expect(documented).toEqual(codes);
  });
});
