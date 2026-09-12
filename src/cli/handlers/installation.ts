import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { getPackageRoot } from '../../channel/manager.mjs';
import {
  adoptInstallation,
  inspectInstallation,
  loadInstallationIdentity,
  switchInstallation,
} from '../../installation/manager.mjs';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function display(status: ReturnType<typeof inspectInstallation>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log('\nCanonical AIWG Installation');
  console.log('===========================');
  console.log(`State:             ${status.state}`);
  console.log(`Canonical method:  ${status.identity?.method ?? '(unrecorded)'}`);
  console.log(`Canonical root:    ${status.identity?.root ?? '(unrecorded)'}`);
  console.log(`Manager:           ${status.identity?.managerExecutable ?? '(internal)'}`);
  console.log(`Update strategy:   ${status.identity?.updateStrategy ?? '(unrecorded)'}`);
  console.log(`Run mode:          ${status.identity?.runMode ?? '(unrecorded)'}`);
  console.log(`Release channel:   ${status.identity?.channel ?? '(unrecorded)'}`);
  console.log(`Actual method:     ${status.actualMethod}`);
  console.log(`Actual root:       ${status.actualRoot}`);
  console.log(`Framework root:    ${status.frameworkRoot}`);
  if (status.launcher) {
    console.log(`Launcher:          ${status.launcher.method} at ${status.launcher.root} (edge redirect — expected)`);
  }
  if (status.drift.length > 0) {
    console.log('Drift:');
    for (const item of status.drift) console.log(`  - ${item}`);
  }
  console.log('');
}

export const installationHandler: CommandHandler = {
  id: 'installation',
  name: 'Installation',
  description: 'Inspect, adopt, or deliberately switch the canonical global installation',
  category: 'maintenance',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const [action = 'show'] = ctx.args;
    const json = ctx.args.includes('--json');
    const actualRoot = getPackageRoot();
    const common = {
      actualRoot,
      configDir: valueAfter(ctx.args, '--config-dir'),
      managerExecutable: valueAfter(ctx.args, '--manager'),
      channel: valueAfter(ctx.args, '--channel'),
    };

    if (action === 'show') {
      const identity = loadInstallationIdentity({ ...common, createIfMissing: true });
      display(inspectInstallation({ ...common, identity, probeManager: true }), json);
      return { exitCode: 0 };
    }
    if (action === 'adopt') {
      const method = valueAfter(ctx.args, '--method');
      const status = adoptInstallation({
        ...common,
        method,
        runMode: valueAfter(ctx.args, '--run-mode'),
      });
      display(status, json);
      return { exitCode: 0 };
    }
    if (action === 'switch') {
      const root = valueAfter(ctx.args, '--root');
      const method = valueAfter(ctx.args, '--method');
      if (!root || !method) {
        return { exitCode: 2, message: 'Usage: aiwg installation switch --root <path> --method <npm|web|source> [--manager <absolute-path>]' };
      }
      const status = switchInstallation({
        ...common,
        root,
        method,
        runMode: valueAfter(ctx.args, '--run-mode'),
      });
      display(status, json);
      return { exitCode: 0 };
    }
    return { exitCode: 2, message: 'Usage: aiwg installation <show|adopt|switch> [options]' };
  },
};
