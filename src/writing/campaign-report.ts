// Render read-only campaign checks for the existing writing CLI entry point.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkCampaignSize } from './campaign-patterns.js';
import { diagnoseWritingBatch } from './contextual-diagnostics.js';

export async function campaignReport(cwd: string, args: string[]): Promise<string> {
  const files = new Set<string>();
  const json = args.includes('--json');
  const inputs = args.filter(a => !['--cross', '--json'].includes(a));
  if (!inputs.length || inputs.some(a => a.startsWith('-'))) throw new Error('Expected campaign files or directories');
  const visit = async (file: string): Promise<void> => {
    try {
      const entries = await readdir(file, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() || (entry.isFile() && /\.md$/i.test(entry.name))) await visit(path.join(file, entry.name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      files.add(file);
      checkCampaignSize(files.size);
    }
  };
  for (const input of inputs) await visit(path.resolve(cwd, input));
  const documents = await Promise.all([...files].sort().map(async id => ({ id, content: await readFile(id, 'utf8') })));
  const results = diagnoseWritingBatch(documents, { cross: true });
  if (json) return JSON.stringify(Object.fromEntries(results), null, 2);
  const lines: string[] = [];
  for (const d of documents) for (const f of results.get(d.id)!.diagnostics) {
    const line = d.content.slice(0, f.start).split('\n').length;
    lines.push(`${d.id}:${line}:${f.start - d.content.lastIndexOf('\n', f.start - 1)} [${f.tier ?? 'check'}] ${f.ruleId}: ${f.suggestion}`);
  }
  return lines.join('\n') || 'No editorial pattern findings in this campaign.';
}
