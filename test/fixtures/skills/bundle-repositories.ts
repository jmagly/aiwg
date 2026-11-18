// Build offline Git object fixtures without checking out or executing repository content.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function gitFixture(root: string, files: Record<string, string | Buffer>): string {
  fs.mkdirSync(root, { recursive: true });
  const git = (args: string[], input?: string | Buffer) => {
    const result = spawnSync('git', args, {
      cwd: root, input, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const existing = fs.existsSync(path.join(root, '.git'));
  if (!existing) git(['init', '--quiet', '--initial-branch=main']);
  const parent = existing ? git(['rev-parse', 'refs/heads/main']) : undefined;
  const chunks: Buffer[] = [];
  let mark = 1;
  for (const content of Object.values(files)) {
    const bytes = Buffer.from(content);
    chunks.push(Buffer.from(`blob\nmark :${mark++}\ndata ${bytes.length}\n`), bytes, Buffer.from('\n'));
  }
  chunks.push(Buffer.from('commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 7\nfixture\n'
    + (parent ? `from ${parent}\n` : '') + 'deleteall\n'));
  mark = 1;
  for (const name of Object.keys(files)) chunks.push(Buffer.from(`M 100644 :${mark++} ${name}\n`));
  chunks.push(Buffer.from('\ndone\n'));
  git(['fast-import', '--quiet', '--done'], Buffer.concat(chunks));
  return git(['rev-parse', 'refs/heads/main']);
}

export function repositorySkills(prefix: string, count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const name = index === 0 && prefix === 'marketing' ? 'sales-enablement' : `${prefix}-${index}`;
    return [`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Synthetic ${prefix} skill ${index}\n---\n\n# ${name}\n`];
  }));
}
