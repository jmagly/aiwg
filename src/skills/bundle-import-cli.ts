// Extend skills import with repository-to-addon and pinned refresh options.
import { importSkillBundle, type BundleImportOptions, type BundleImportPlan } from './bundle-import.js';

export async function handleBundleImport(args: string[]): Promise<void> {
  const options: BundleImportOptions = { projectDir: process.cwd() };
  const positional: string[] = [];
  const fields = { '--into': 'into', '--refresh': 'refresh', '--ref': 'ref', '--only': 'only' } as const;
  const json = args.includes('--json');
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (Object.hasOwn(fields, arg)) {
        const field = fields[arg as keyof typeof fields];
        const value = args[++index];
        if (!value || value.startsWith('-') || options[field] !== undefined) throw new Error(`${arg} requires one value`);
        options[field] = value;
      } else if (arg === '--dry-run') options.dryRun = true;
      else if (arg === '--json') continue;
      else if (arg.startsWith('-')) throw new Error(`Unknown bundle import option: ${arg}`);
      else positional.push(arg);
    }
    if (positional.length > 1) throw new Error('Provide exactly one repository source');
    options.source = positional[0];
    // The report is deliberately emitted before the importer can write any project files.
    options.report = (plan: BundleImportPlan) => {
      if (json) console.log(JSON.stringify({ phase: 'preflight', ...plan }));
      else {
        console.log(`${plan.dryRun ? '[DRY RUN] ' : ''}Skill bundle preflight: ${plan.manifest.id}`);
        for (const upstream of plan.manifest.upstream ?? []) console.log(`  ${upstream.repo} @ ${upstream.commit}`);
        for (const item of plan.diagnostics) console.log(`  ${item.code}: ${item.file}: ${item.message}`);
        for (const [kind, files] of Object.entries(plan.diff)) {
          for (const file of files) console.log(`  ${kind}: ${file}`);
        }
      }
    };
    const result = await importSkillBundle(options);
    if (json) console.log(JSON.stringify({ phase: 'result', ...result }));
    else console.log(`${result.dryRun ? 'Planned' : 'Indexed'} ${result.manifest.skills?.length ?? 0} skills; installed: false`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ phase: 'error', message }));
    else console.error(`Error: ${message}`);
    process.exit(1);
  }
}
