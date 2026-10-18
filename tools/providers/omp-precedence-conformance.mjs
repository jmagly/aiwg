#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploySkills, transformRule } from '../agents/providers/omp.mjs';
import { OmpRpcClient } from './omp-transport.mjs';
import { smokeEnvironment, verifyBinary } from './omp-live-smoke.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2); const option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const report = { schemaVersion: 1, status: 'failed', modelCalls: 0, checks: {}, unverified: [] };
let sandbox; let sourceTemp; let stagedToolViews; const stagedNative = [];
try {
  const binary = option('--binary'); const source = option('--source'); if (!binary || !source) throw Error('BINARY_AND_PINNED_SOURCE_REQUIRED');
  sandbox = await mkdtemp(join(tmpdir(), 'aiwg-omp-precedence-'));
  const env = smokeEnvironment(process.env, sandbox); Object.assign(report.checks, await verifyBinary(resolve(binary), process.env, sandbox));
  if (!report.checks.binaryPinned || !report.checks.versionMatched) throw Error('BINARY_PIN_MISMATCH');
  const manifest = JSON.parse(await readFile(join(root, 'test/fixtures/providers/omp-conformance/manifest.json'), 'utf8'));
  const revision = spawnSync('git', ['-C', resolve(source), 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  if (revision.status !== 0 || revision.stdout.trim() !== manifest.source.commit) throw Error('SOURCE_PIN_MISMATCH');
  const pristine = spawnSync('git', ['-C', resolve(source), 'diff', '--quiet', 'HEAD'], { timeout: 10000, killSignal: 'SIGKILL' }); if (pristine.status !== 0) throw Error('SOURCE_MODIFIED');
  report.checks.sourcePinned = true;
  // The upstream extension loader imports the HTML exporter, whose tool views
  // are generated at build time. Build missing output with the pinned generator.
  const toolViews = join(resolve(source), 'packages/coding-agent/src/export/html/tool-views.generated.js');
  try { await readFile(toolViews); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    stagedToolViews = toolViews;
    const generated = spawnSync(option('--bun') || 'bun', ['run', 'gen:tool-views'], { cwd: join(resolve(source), 'packages/collab-web'), env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
    if (generated.status !== 0) throw Error('PINNED_TOOL_VIEWS_BUILD_FAILED');
  }
  const project = join(sandbox, 'project'); const agent = join(sandbox, 'agent'); const foreign = join(sandbox, 'foreign-user');
  for (const dir of [join(project, '.omp'), join(project, '.claude'), agent, foreign]) await mkdir(dir, { recursive: true });
  await writeFile(join(project, '.omp/AGENTS.md'), '@../WORKSPACE.md\n@../AIWG.md\nNATIVE_PRECEDENCE_CONTEXT\n');
  await writeFile(join(project, 'WORKSPACE.md'), 'CANONICAL_WORKSPACE_PRECEDENCE\n');
  await writeFile(join(project, 'AIWG.md'), '@WORKSPACE.md\nCANONICAL_AIWG_PRECEDENCE\n');
  await writeFile(join(project, 'AGENTS.md'), '@WORKSPACE.md\n@AIWG.md\n');
  await mkdir(join(project, '.omp/rules'), { recursive: true });
  const ruleFiles = { always: '---\nalwaysApply: true\n---\nALWAYS_PRECEDENCE_RULE', disabled: '---\nenabled: false\nalwaysApply: true\n---\nDISABLED_PRECEDENCE_RULE', conditional: '---\ncondition: TRIGGER\nglobs: ["**/*.ts"]\nscope: ["tool:write"]\n---\nCONDITIONAL_PRECEDENCE_RULE' };
  for (const [name, content] of Object.entries(ruleFiles)) await writeFile(join(project, `.omp/rules/${name}.md`), transformRule(`${name}.md`, content));
  await writeFile(join(project, '.claude/CLAUDE.md'), 'FOREIGN_PROJECT_PRECEDENCE_CONTEXT\n');
  await writeFile(join(foreign, 'CLAUDE.md'), 'FOREIGN_USER_PRECEDENCE_CONTEXT\n');
  const skillSources = [];
  for (const [name, kernel] of [['kernel-fixture', true], ['standard-fixture', false]]) {
    const dir = join(sandbox, 'skill-sources', name); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${kernel ? 'NATIVE_KERNEL_SKILL_CANARY' : 'NATIVE_STANDARD_SKILL_CANARY'}\nkernel: ${kernel}\n---\nFixture.\n`); skillSources.push(dir);
  }
  deploySkills(skillSources, project, { copyStandardSkills: true, quiet: true });
  const probe = join(sandbox, 'probe.ts'); await copyFile(join(root, 'test/fixtures/providers/omp-precedence/probe.ts'), probe);
  const excluded = ['claude-md','claude-plugins','codex','gemini','windsurf','agent-plugins','vscode','cursor','ssh-json','opencode','omp-plugins','cline','mcp-json','github','agents','agents-md'];
  async function runCase(name, disabled, optIn = false, standalone = false) {
    await writeFile(join(agent, 'config.yml'), `disabledProviders: ${JSON.stringify([...excluded.filter(id => !standalone || !['agents-md','agents'].includes(id)), ...disabled])}\nmarketplace:\n  autoUpdate: false\n`);
    const output = join(sandbox, `${name}.json`);
    const client = new OmpRpcClient({ binary: resolve(binary), cwd: project, env: { ...env, AIWG_OMP_PRECEDENCE_REPORT: output, ...(optIn ? { CLAUDE_CONFIG_DIR: foreign } : {}) }, timeoutMs: 30000, eventLimit: 1024 * 1024,
      args: ['--model','openrouter/openai/gpt-4.1-mini','--tools','read','--no-lsp','--no-title','--no-session','--no-extensions','--extension',probe] });
    try { await client.connect(); await client.command('get_state'); return JSON.parse(await readFile(output, 'utf8')); }
    finally { await client.close(); }
  }
  const canonical = await runCase('canonical', [], false, true); report.checks.canonicalImportsExactlyOnce = canonical.workspaceOccurrences === 1 && canonical.aiwgOccurrences === 1; report.checks.deployedKernelAndStandardSkillsLoaded = canonical.kernelSkill && canonical.standardSkill;
  const baseline = await runCase('baseline', []); report.baseline = baseline; report.checks.nativeAlwaysAndDisabledRules = baseline.alwaysRule && !baseline.disabledRule; report.checks.nativeContextPrecedesForeignProject = baseline.nativeContext && !baseline.foreignProjectContext && !baseline.foreignUserContext;
  const nativeOff = await runCase('native-off', ['native']); report.checks.disabledNativeContext = !nativeOff.nativeContext && nativeOff.foreignProjectContext;
  const foreignOff = await runCase('foreign-off', ['claude']); report.checks.disabledForeignContext = foreignOff.nativeContext && !foreignOff.foreignProjectContext;
  const userOn = await runCase('user-on', [], true); report.checks.foreignUserExplicitDirectoryOptIn = userOn.foreignUserContext;
  const userOff = await runCase('user-off', ['claude'], true); report.checks.disabledForeignOverridesDirectoryOptIn = !userOff.foreignUserContext;
  // Stage only native modules extracted by the checksum-verified standalone binary.
  const extracted = join(sandbox, 'data/omp/natives', manifest.release.version);
  for (const filename of await readdir(extracted)) {
    if (!/^pi_natives\.[a-z0-9-]+\.node$/.test(filename)) continue;
    const destination = join(resolve(source), 'packages/natives/native', filename);
    let existing;
    try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.equals(await readFile(join(extracted, filename)))) throw Error('NATIVE_ADDON_PIN_MISMATCH');
    if (!existing) { await copyFile(join(extracted, filename), destination); stagedNative.push(destination); }
  }
  sourceTemp = await mkdtemp(join(resolve(source), '.aiwg-precedence-'));
  const sdk = join(sourceTemp, 'sdk.ts'); await copyFile(join(root, 'test/fixtures/providers/omp-precedence/sdk.ts'), sdk);
  const sdkReport = join(sandbox, 'sdk.json');
  const native = spawnSync(option('--bun') || 'bun', [sdk], { cwd: resolve(source), env: { ...env, AIWG_OMP_PINNED_SOURCE: resolve(source), AIWG_OMP_AIWG_ROOT: root, AIWG_OMP_PRECEDENCE_SANDBOX: sandbox, AIWG_OMP_RULE_PROJECT: project, AIWG_OMP_PRECEDENCE_REPORT: sdkReport }, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
  try { report.checks.nativeSdk = JSON.parse(await readFile(sdkReport, 'utf8')); } catch {}
  if (native.status !== 0) { report.sdkFailure = (native.stderr || '').replaceAll(resolve(source), '<source>').replaceAll(sandbox, '<sandbox>').slice(-2000); throw Error('NATIVE_SDK_PRECEDENCE_FAILED'); }
  report.checks.nativeSdk = JSON.parse(await readFile(sdkReport, 'utf8'));
  if (!Object.entries(report.checks).every(([key, value]) => key === 'nativeSdk' ? Object.values(value).every(Boolean) : value === true)) throw Error('PRECEDENCE_ASSERTION_FAILED');
  report.status = 'passed';
} catch (error) { report.reason = error.message; process.exitCode = 1; }
finally { for (const filename of stagedNative) await rm(filename, { force: true }); if (stagedToolViews) await rm(stagedToolViews, { force: true }); if (sandbox) await rm(sandbox, { recursive: true, force: true }); if (sourceTemp) await rm(sourceTemp, { recursive: true, force: true }); }
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (option('--output')) { const output = resolve(option('--output')); await mkdir(dirname(output), { recursive: true }); await writeFile(output, serialized); }
process.stdout.write(serialized);
