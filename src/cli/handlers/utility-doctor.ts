// Health diagnostics extracted from the utility handler collection.
import fsp from 'fs/promises';
import { diagnoseUserHookCommands } from '../../extensions/user-hook-diagnostics.js';
import { diagnoseHermesHookAcceptance } from '../../smiths/hook-bridge/hermes-trust.js';
import path from 'path';
import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { createScriptRunner } from './script-runner.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';
import { parsePublicDoctorFlags } from './doctor-args.js';
import { DOCTOR_HELP } from './doctor-help.js';
import { checkCollisions } from '../../smiths/skillsmith/collision-detector.js';
import { renderUseDeploymentResult, verifyConfiguredDeployments, type DeploymentScope } from '../services/deployment-verification.js';

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/**
 * A directory is a deployed skill only if it carries a SKILL.md manifest —
 * the same marker `isOwnedByNamespace()` in collision-detector.ts reads for
 * ownership. Harness container/bucket directories (e.g. Claude Code's own
 * `.claude/skills/synced/` sync storage, which holds UUID-named dirs with
 * `manifest.json`, not SKILL.md) have no manifest of their own and must
 * never be reported as a colliding skill (#278).
 *
 * A container directory without its own SKILL.md is still descended exactly
 * one level: a real skill nested inside it (`<container>/<skill>/SKILL.md`)
 * is reported as `<container>/<skill>`, while the container itself never is.
 */
async function hasSkillManifest(dirPath: string): Promise<boolean> {
  try {
    await fsp.access(path.join(dirPath, 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}

async function collectDeployedSkillDirNames(skillsDir: string): Promise<string[]> {
  let topEntries;
  try {
    topEntries = await fsp.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(skillsDir, entry.name);
    if (await hasSkillManifest(dirPath)) {
      names.push(entry.name);
      continue;
    }
    let nestedEntries;
    try {
      nestedEntries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      const nestedPath = path.join(dirPath, nested.name);
      if (await hasSkillManifest(nestedPath)) {
        names.push(path.join(entry.name, nested.name));
      }
    }
  }
  return names;
}

/**
 * #1156 Phase 1 — Validate the per-user registry at `~/.aiwg/installed.json`.
 *
 * Checks each registered framework+provider deploy:
 *   - Registry entry parses correctly
 *   - Recorded artifact entries (Cycle 3 mirrors) still exist on disk
 *   - Per-artifact-type counts match the actual entry-name list length
 *   - Pre-Cycle-3 entries (no `entries` snapshot) are surfaced as "limited
 *     drift detection" rather than failures
 *
 * Returns exit 1 when drift is detected, exit 0 otherwise. Output is plain
 * text suitable for terminal consumption.
 */
async function runUserScopeDoctor(verbose: boolean): Promise<HandlerResult> {
  const { readUserRegistry, userRegistryPath } = await import('../../config/user-registry.js');
  const { USER_SCOPE_PATHS } = await import('../scope-resolver.js');
  const fsp2 = await import('node:fs/promises');
  const path2 = await import('node:path');

  const registry = await readUserRegistry();
  const frameworks = Object.entries(registry.installed);
  const lines: string[] = [];
  lines.push('');
  lines.push('── User-scope registry validation ──');
  lines.push(`Registry path: ${userRegistryPath()}`);
  lines.push('');

  const hookWarnings = await diagnoseUserHookCommands();
  lines.push(...hookWarnings.map(warning => `⚠ ${warning.message}`));
  const hermesAcceptance = await diagnoseHermesHookAcceptance();
  if (hermesAcceptance) lines.push(`⚠ ${hermesAcceptance.message}`);
  if (frameworks.length === 0) {
    lines.push('No frameworks deployed at user scope. Run `aiwg use <fw> --scope user` to install.');
    return { exitCode: hookWarnings.length ? 1 : 0, message: lines.join('\n') + '\n' };
  }

  let driftCount = hookWarnings.length;
  let limitedCount = 0;

  for (const [name, entry] of frameworks) {
    lines.push(`▸ ${name}  v${entry.version}  [${entry.source}]`);
    for (const [provider, providerDeployRaw] of Object.entries(entry.deployedTo)) {
      // Cast through unknown for the optional `entries` snapshot.
      const providerDeploy = providerDeployRaw as unknown as {
        agents: number; commands: number; skills: number; rules: number;
        entries?: { agents?: string[]; commands?: string[]; skills?: string[]; rules?: string[]; behaviors?: string[] };
      };
      const userPaths = USER_SCOPE_PATHS[provider];
      if (!userPaths) {
        lines.push(`    ${provider}: ⚠ no user-scope path map registered for this provider`);
        driftCount++;
        continue;
      }

      const recorded = providerDeploy.entries;
      if (!recorded) {
        lines.push(`    ${provider}: ⚠ pre-Cycle-3 entry — no per-artifact manifest, drift detection limited`);
        lines.push(`               counts: agents=${providerDeploy.agents} commands=${providerDeploy.commands} skills=${providerDeploy.skills} rules=${providerDeploy.rules}`);
        limitedCount++;
        continue;
      }

      // Walk the recorded entry names and check each one exists on disk.
      const checks: Array<[string, string, string[] | undefined, number]> = [
        ['agents', userPaths.agents, recorded.agents, providerDeploy.agents],
        ['commands', userPaths.commands, recorded.commands, providerDeploy.commands],
        ['skills', userPaths.skills, recorded.skills, providerDeploy.skills],
        ['rules', userPaths.rules, recorded.rules, providerDeploy.rules],
      ];

      const issues: string[] = [];
      for (const [type, dir, names, expectedCount] of checks) {
        if (!dir || !names) continue;
        let present = 0;
        const missing: string[] = [];
        for (const n of names) {
          const target = path2.join(dir, n);
          const stat = await fsp2.stat(target).catch(() => null);
          if (stat) present++;
          else missing.push(n);
        }
        if (names.length !== expectedCount) {
          issues.push(`count drift on ${type}: registry says ${expectedCount}, manifest lists ${names.length}`);
        }
        if (missing.length > 0) {
          issues.push(`${type}: ${missing.length}/${names.length} entries missing from ${dir}`);
          if (verbose) {
            for (const m of missing) issues.push(`    missing: ${path2.join(dir, m)}`);
          }
        } else if (verbose) {
          issues.push(`${type}: ${present}/${names.length} present at ${dir}`);
        }
      }

      if (issues.length === 0) {
        lines.push(`    ${provider}: ✓ all recorded artifacts present`);
      } else {
        const hasMissing = issues.some(i => i.includes('missing') || i.includes('drift'));
        const marker = hasMissing ? '✗' : 'ℹ';
        lines.push(`    ${provider}: ${marker}`);
        for (const i of issues) lines.push(`        ${i}`);
        if (hasMissing) driftCount++;
      }
    }
  }

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push(`Frameworks: ${frameworks.length}   Drift: ${driftCount}   Limited (pre-Cycle-3): ${limitedCount}`);
  if (driftCount > 0) {
    lines.push('');
    lines.push('Drift detected. To repair, re-run `aiwg use <framework> --scope user --provider <p>`.');
    lines.push('To remove a stale registry entry, run `aiwg remove <framework> --scope user`.');
  }

  return {
    exitCode: driftCount > 0 ? 1 : 0,
    message: lines.join('\n') + '\n',
  };
}

/**
 * Handler for doctor command
 *
 * Runs health diagnostics on the AIWG installation and workspace.
 *
 * Usage:
 *   aiwg doctor
 *   aiwg -doctor
 *   aiwg --doctor
 *   aiwg doctor --verbose
 *   aiwg doctor --scope user      # validate ~/.aiwg/installed.json
 */
export const doctorHandler: CommandHandler = {
  id: 'doctor',
  name: 'Doctor',
  description: 'Run health diagnostics',
  category: 'maintenance',
  aliases: ['-doctor', '--doctor'],

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, message: DOCTOR_HELP, rawOutput: true };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    // Validate before any early-return mode: deployment and user-scope doctor
    // never invoke doctor.mjs, so they must enforce the same flag contract.
    let flags: ReturnType<typeof parsePublicDoctorFlags>;
    try { flags = parsePublicDoctorFlags(ctx.args); }
    catch (error) {
      return { exitCode: 2, message: `${error instanceof Error ? error.message : String(error)}. See 'aiwg doctor --help'.` };
    }
    const { hasSwitch, values } = flags;
    if (hasSwitch('--help') || hasSwitch('-h')) {
      return { exitCode: 0, message: DOCTOR_HELP, rawOutput: true };
    }

    if (hasSwitch('--deployment')) {
      const scopeValue = values.get('--scope');
      if (scopeValue && scopeValue !== 'project' && scopeValue !== 'user') {
        return { exitCode: 2, message: `Invalid deployment verification scope: ${scopeValue}` };
      }
      const result = await verifyConfiguredDeployments(ctx.cwd || process.cwd(), {
        provider: values.get('--provider'),
        bundle: values.get('--bundle'),
        scope: scopeValue as DeploymentScope | undefined,
      }, ctx.frameworkRoot);
      const { rulePinState } = await import('../../rules/pin-state.js');
      const pins = rulePinState(ctx.cwd, ctx.frameworkRoot);
      return {
        exitCode: result.exitCode,
        message: hasSwitch('--json')
          ? JSON.stringify({ ...result, rule_pins: { rules: pins.rules, warnings: pins.warnings } }, null, 2)
          : renderUseDeploymentResult(result) + '\n' + pins.rules.map(rule => `${rule.name}: pinned kernel (canonical ${rule.canonical_activation})`).concat(pins.warnings).join('\n'),
        rawOutput: hasSwitch('--json'),
      };
    }

    // #1156 Phase 1 — `aiwg doctor --scope user` / `aiwg doctor --user`
    // validates the per-user registry (~/.aiwg/installed.json) without
    // running the project-scope diagnostics. Operators need this to verify
    // their user-scope deployments from any cwd, including shells with no
    // project at all.
    const userScopeRequested =
      hasSwitch('--user') || values.get('--scope') === 'user';
    if (userScopeRequested && !hasSwitch('--probe-workers')) {
      return await runUserScopeDoctor(hasSwitch('--verbose') || hasSwitch('-v'));
    }

    const frameworkRoot = (hasSwitch('--decision-offload') || hasSwitch('--resources')) ? ctx.frameworkRoot : await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    // Run core doctor diagnostics
    const result = await runner.run('tools/cli/doctor.mjs', ctx.args, { cwd: ctx.cwd });
    // Machine-readable worker probes (#3066): tools/cli/doctor.mjs already
    // printed exactly one JSON document (or a usage error) on its own
    // stdio — every section below writes human-readable text, so returning
    // here keeps stdout to the JSON document alone.
    if (hasSwitch('--resources') || hasSwitch('--list-approvals') || values.get('--forget-approval') || hasSwitch('--decision-offload') || hasSwitch('--json') || hasSwitch('--qualify') || hasSwitch('--cli') || hasSwitch('--dry-run') || result.exitCode === 2) return result;
    let agentSkillsFailure = false;

    try {
      const { inspectGrokBuildNative } = await import('../../mcp/grok-build-config.mjs');
      const native = await inspectGrokBuildNative({ projectDir: ctx.cwd || process.cwd() });
      console.log(`\n── Grok Build native extensions ──\n  MCP: ${native.mcp}\n  Hooks: ${native.hooks}`);
      for (const diagnostic of native.diagnostics) console.log(`  ⚠ ${diagnostic}`);
    } catch (error) {
      console.log(`\n── Grok Build native extensions ──\n  ⚠ unable to audit: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const projectDir = ctx.cwd || process.cwd();
      const provider = flagValue(ctx.args, '--provider');
      const requested = provider === 'muse' || ctx.args.includes('--all-providers');
      const { inspectMuseNative, isMuseDeployedProject } = await import('../../mcp/muse-native-config.mjs');
      if (requested || await isMuseDeployedProject(projectDir)) {
        const native = await inspectMuseNative({ projectDir });
        console.log(`\n── Muse Code native extensions ──\n  CLI: ${native.cli}\n  Hooks: ${native.hooks}\n  MCP: ${native.mcp}`);
      }
    } catch (error) {
      console.log(`\n── Muse Code native extensions ──\n  ⚠ unable to audit: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const { buildAgentSkillsDoctorSection } = await import('../../skills/doctor.js');
      const section = buildAgentSkillsDoctorSection(ctx.cwd || process.cwd());
      console.log(section.output);
      agentSkillsFailure = section.hasFailures;
    } catch (error) {
      console.log(`\n── Agent Skills conformance ──\n  ⚠ unable to audit: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Surface feedback escape hatch when doctor finds issues
    if (result.exitCode !== 0) {
      console.log(`
── Recovery options ──
  aiwg session --no-repair    — launch anyway (skip auto-repair)
  aiwg sync                   — sync to latest and redeploy
  aiwg feedback --type bug    — report this issue to GitHub
`);
    }

    // Append collision scan: check deployed skills dir for bad-state collisions
    // (platform built-ins and AIWG CLI command shadows)
    try {
      const projectDir = ctx.cwd || process.cwd();
      const skillsDir = path.join(projectDir, '.claude', 'skills');
      const deployedSkillNames = await collectDeployedSkillDirNames(skillsDir);

      if (deployedSkillNames.length > 0) {
        const collisions = await checkCollisions({
          platform: 'claude',
          projectPath: projectDir,
          skillNames: deployedSkillNames,
          namespace: 'aiwg',
          skillsBaseDir: skillsDir,
        });
        // Two distinct causes share this scan, and conflating them mislabels
        // one as the other: an `error` is a name that shadows a Claude
        // built-in; a `warn` is a deployed skill this namespace does not own
        // (#2504). Report each under its own heading with its own remedy.
        const builtinCollisions = collisions.filter(r => r.severity === 'error');
        const unownedCollisions = collisions.filter(r => r.severity === 'warn');
        if (builtinCollisions.length > 0 || unownedCollisions.length > 0) {
          console.log('\n── Skill collision scan ──');
          if (builtinCollisions.length > 0) {
            console.log('');
            console.log('⚠ Stale skills detected (names collide with Claude built-ins):');
            for (const r of builtinCollisions) {
              console.log(`  ✗ ${r.skillName}: ${r.reason}`);
            }
            console.log('');
            console.log('  Fix: run `aiwg use <framework>` to redeploy and auto-clean stale skill directories.');
          }
          if (unownedCollisions.length > 0) {
            console.log('');
            console.log("⚠ Deployed skills not owned by namespace 'aiwg' (a redeploy would overwrite them):");
            for (const r of unownedCollisions) {
              console.log(`  ✗ ${r.skillName}: ${r.reason}`);
            }
            console.log('');
            console.log("  Fix: if the skill is yours, move it out of the AIWG-managed skills directory");
            console.log("  or give it its own namespace. If AIWG generated it, re-run `aiwg use` to");
            console.log('  restore the ownership marker.');
          }
        }
      }
    } catch {
      // Collision scan is non-fatal for doctor
    }

    // #1037 / #1049 — Project-local artifacts section: per-type counts,
    // validation errors, shadows, denylist violations, drift detection,
    // and provider deployment matrix. Replaces the older inline shadow
    // scan with the richer section spec'd by design-doctor-log-promote.md.
    try {
      const projectDir = ctx.cwd || process.cwd();
      const fr = await getFrameworkRoot();
      const { readAiwgConfig } = await import('../../config/aiwg-config.js');
      const config = await readAiwgConfig(projectDir);
      const { buildProjectLocalDoctorSection } = await import(
        '../../extensions/project-local-doctor.js'
      );
      const onlyProjectLocal = ctx.args.includes('--project-local');
      const quiet = ctx.args.includes('--quiet');
      const section = await buildProjectLocalDoctorSection({
        projectDir, frameworkRoot: fr, config, quiet,
      });
      if (section.output) {
        console.log(section.output);
      }
      // When --project-local is requested as the only output and the rest
      // of doctor printed nothing project-local-specific, fold result exit
      // into our own findings.
      if (onlyProjectLocal && section.hasFailures) {
        return { exitCode: 1, message: '' };
      }
    } catch {
      // Project-local section is non-fatal for doctor
    }

    // Web-backed resource lock/cache diagnostics (#1850). Report lock source
    // mode, cold cache, and digest drift without requiring web mode to be in use.
    try {
      const { buildWebResourceDoctorSection } = await import('../../resources/doctor.js');
      const section = buildWebResourceDoctorSection(ctx.cwd || process.cwd(), {
        cacheRoot: process.env.AIWG_RESOURCE_CACHE_ROOT,
      });
      if (section.output) console.log(section.output);
      if (section.hasFailures) return { exitCode: 1, message: '' };
    } catch (error) {
      console.log(`\n── Web resource cache ──\n  ⚠ unable to audit: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Canonical workspace-context graph diagnostics (#1811). Legacy projects
    // remain valid; drift, loops, conflicts, and possible credentials fail.
    try {
      const { diagnoseWorkspaceContext } = await import('../../smiths/context-pipeline/workspace-context.js');
      const diagnostics = await diagnoseWorkspaceContext(ctx.cwd || process.cwd());
      console.log('\n── Workspace context graph ──');
      for (const diagnostic of diagnostics) {
        const mark = diagnostic.severity === 'error' ? '✗' : diagnostic.severity === 'warning' ? '⚠' : '✓';
        console.log(`  ${mark} ${diagnostic.message}`);
      }
      if (diagnostics.some((item) => item.severity === 'error')) return { exitCode: 1, message: '' };
    } catch (error) {
      console.log(`\n── Workspace context graph ──\n  ⚠ unable to audit: ${error instanceof Error ? error.message : String(error)}`);
    }

    return agentSkillsFailure
      ? { exitCode: 1, message: '' }
      : result;
  },
};
