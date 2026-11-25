// Add judge collection to the existing eval CLI without introducing a top-level AIWG command.
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflinePilot } from './pilot.js';
import { collectJudges } from './judge-collect.js';
import type { CalibrationStudy } from './calibration-types.js';
import type { JudgeConfiguration } from './judge-types.js';

export function registerJudgeCollector(program: Command) {
  program.command('judge-collect')
    .description('Collect blinded votes on the frozen offline pilot (explicit caps required)')
    .requiredOption('--run-dir <directory>', 'Run directory; reusing it resumes the same configuration')
    .requiredOption('--evaluators <file>', 'JSON array of declared CLI/OpenRouter judge configurations')
    .requiredOption('--tranche <name>', 'dev or heldout')
    .requiredOption('--max-calls <count>', 'Cumulative attempt cap, including retries', Number)
    .option('--max-usd <amount>', 'Cumulative HTTP spend cap; required for OpenRouter', Number)
    .option('--seed <number>', 'Option order seed', Number, 4240)
    .option('--max-attempts <count>', 'Maximum attempts per packet/criterion/configuration', Number, 2)
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
      }) }, null, 2));
    });
}
