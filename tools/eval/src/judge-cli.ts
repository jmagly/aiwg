// Add judge collection to the existing eval CLI without introducing a top-level AIWG command.
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflinePilot } from './pilot.js';
import { collectJudges } from './judge-collect.js';
import { setupJudgeProject } from './judge-project.js';
import type { CalibrationStudy } from './calibration-types.js';
import type { JudgeConfiguration } from './judge-types.js';

export function registerJudgeCollector(program: Command) {
  program.command('judge-setup')
    .description('Create a fresh judge project from declared native AIWG configuration and models policy')
    .requiredOption('--judge-project <directory>', 'New dedicated project directory')
    .requiredOption('--config <file>', 'Native aiwg.config with worker_dispatch and judge groups')
    .requiredOption('--models <file>', 'Native models.json with judge role guidance')
    .requiredOption('--evaluators <file>', 'JSON array of declared judges')
    .action(async options => {
      const project = path.resolve(options.judgeProject);
      await setupJudgeProject(project, path.resolve(options.config), path.resolve(options.models),
        JSON.parse(await readFile(path.resolve(options.evaluators), 'utf8')));
      console.log(JSON.stringify({ project, next: ['From the judge project: aiwg effect keys init',
        'From the judge project: aiwg doctor --probe-workers --qualify --yes'] }, null, 2));
    });
  program.command('judge-collect')
    .description('Collect blinded votes on the frozen offline pilot (explicit caps required)')
    .requiredOption('--run-dir <directory>', 'Run directory; reusing it resumes the same configuration')
    .requiredOption('--evaluators <file>', 'JSON array of declared CLI/OpenRouter judge configurations')
    .requiredOption('--tranche <name>', 'dev or heldout')
    .requiredOption('--max-calls <count>', 'Cumulative attempt cap, including retries', Number)
    .option('--judge-project <directory>', 'Dedicated qualified AIWG project; required for CLI judges')
    .option('--max-usd <amount>', 'Cumulative HTTP spend cap; required for OpenRouter', Number)
    .option('--seed <number>', 'Option order seed', Number, 4240)
    .option('--max-attempts <count>', 'Maximum attempts per packet/criterion/configuration', Number, 2)
    .option('--retry-blocked', 'Explicitly recheck a blocked resolver after correcting project configuration', false)
    .option('--dry-run', 'Print plan and estimated calls without launching or writing', false)
    .action(async options => {
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      const fixture = path.join(root, 'test/fixtures/eval-pilot');
      const study = JSON.parse(await readFile(path.join(fixture, 'calibration.v1.json'), 'utf8')) as CalibrationStudy;
      const evaluators = JSON.parse(await readFile(path.resolve(options.evaluators), 'utf8')) as JudgeConfiguration[];
      const records = (await runOfflinePilot(path.join(root, 'tools/eval/datasets/composition-pilot.json'), fixture)).pilot!.records;
      const result = await collectJudges({ ...options, runDir: path.resolve(options.runDir), study, evaluators, records });
      console.log(JSON.stringify({ plan: result.plan, ...(options.dryRun ? {} : {
        archive: path.join(path.resolve(options.runDir), 'study.json'), attempts: result.study.votes.length,
        stop_reason: result.study.collection!.stop_reason,
        diagnostics: result.study.votes.filter(v => v.critical_flags.includes('resolver-blocked')).map(v => v.rationale),
      }) }, null, 2));
      if (result.study.collection?.stop_reason === 'resolver-blocked') process.exitCode = 2;
    });
}
