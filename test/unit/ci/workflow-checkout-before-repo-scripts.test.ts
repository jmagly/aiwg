// Every CI job that runs a script from this repository must check the repository out first (#3806).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const REPO_SCRIPT = /(?:^|[\s;&|(])(?:node|bash|sh)\s+(?:\.\/)?(?:tools|scripts|ci|bin)\/[\w./-]+/m;

type Step = { name?: string; uses?: string; run?: string };
type Job = { steps?: Step[] };

function workflows() {
  return ['.gitea/workflows', '.github/workflows'].flatMap(dir =>
    readdirSync(join(root, dir)).filter(file => /\.ya?ml$/.test(file)).map(file => join(dir, file)));
}

function jobsMissingCheckout(file: string) {
  const parsed = parse(readFileSync(join(root, file), 'utf8')) as { jobs?: Record<string, Job> };
  const missing: string[] = [];
  for (const [id, job] of Object.entries(parsed?.jobs ?? {})) {
    const steps = job.steps ?? [];
    const firstScript = steps.findIndex(step => typeof step.run === 'string' && REPO_SCRIPT.test(step.run));
    if (firstScript < 0) continue;
    // actions/checkout, or a scripted git checkout of an exact revision (fortemi-shard-conformance).
    const checkout = steps.findIndex(step => (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
      || (typeof step.run === 'string' && /\bgit\s+(?:clone|checkout|fetch)\b/.test(step.run) && /checkout/i.test(step.name ?? '')));
    if (checkout < 0 || checkout > firstScript) missing.push(`${file}#${id} (step "${steps[firstScript].name ?? firstScript}")`);
  }
  return missing;
}

describe('CI jobs check out the repository before running its scripts', () => {
  it('finds the Gitea npm mirror verify job covered', () => {
    expect(jobsMissingCheckout('.gitea/workflows/npm-publish.yml')).toEqual([]);
  });

  it('holds for every workflow', () => {
    expect(workflows().flatMap(jobsMissingCheckout)).toEqual([]);
  });
});
